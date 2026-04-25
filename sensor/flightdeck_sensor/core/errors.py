"""Error classification for LLM provider exceptions.

Phase 4 (v0.5.0) upgrades LLM API errors to first-class structured events. The
sensor no longer lets every provider exception escape the interceptor
unrecorded -- instead :func:`classify_exception` maps the exception to a
14-entry taxonomy and :func:`build_error_payload` constructs the structured
``error`` sub-object attached to an :class:`EventType.LLM_ERROR` event.

The taxonomy is deliberately provider-agnostic. Each entry maps to the
recommended OTel ``gen_ai.error.type`` value so a future OpenTelemetry
exporter can pass the classification through unchanged; see the audit
matrix in ``audit-phase-4.md`` for the full mapping.

Design rules baked in here:

* The classifier **never raises**. Unknown exceptions fall through to
  ``error_type="other"`` so a broken mapping cannot itself break the hot
  path.
* ``error_message`` is redacted to the exception class name plus an
  optional short summary. The sensor never logs prompt content through
  an error event -- this module does not receive the prompt and does not
  need to.
* ``is_retryable`` is set from the taxonomy, not from the provider's
  ``retry_after`` header. Retry strategy lives with the caller; this
  flag is a hint to operators viewing the error on the dashboard.
"""

from __future__ import annotations

import enum
from dataclasses import dataclass, field
from typing import Any


class ErrorType(str, enum.Enum):
    """14-entry Phase 4 taxonomy. Values are the wire-level strings."""

    RATE_LIMIT = "rate_limit"
    QUOTA_EXCEEDED = "quota_exceeded"
    CONTEXT_OVERFLOW = "context_overflow"
    CONTENT_FILTER = "content_filter"
    INVALID_REQUEST = "invalid_request"
    AUTHENTICATION = "authentication"
    PERMISSION = "permission"
    NOT_FOUND = "not_found"
    REQUEST_TOO_LARGE = "request_too_large"
    API_ERROR = "api_error"
    OVERLOADED = "overloaded"
    TIMEOUT = "timeout"
    STREAM_ERROR = "stream_error"
    OTHER = "other"


# Retryable-by-default per taxonomy. Operators may still want to retry
# ``stream_error`` case-by-case (depends on whether the stream had emitted
# tokens), so it flips to False here and the dashboard expandable flags it
# as "case-by-case".
_RETRYABLE: dict[ErrorType, bool] = {
    ErrorType.RATE_LIMIT: True,
    ErrorType.OVERLOADED: True,
    ErrorType.TIMEOUT: True,
    ErrorType.API_ERROR: True,
    # everything else: False (explicit fall-through via ``.get``)
}


# OTel ``gen_ai.error.type`` mapping. Kept here (not in a docstring) so a
# future exporter can import the dict rather than re-parsing documentation.
OTEL_ERROR_TYPE: dict[ErrorType, str] = {
    ErrorType.RATE_LIMIT: "rate_limit_error",
    ErrorType.QUOTA_EXCEEDED: "quota_exceeded_error",
    ErrorType.CONTEXT_OVERFLOW: "context_length_exceeded",
    ErrorType.CONTENT_FILTER: "content_filter_error",
    ErrorType.INVALID_REQUEST: "invalid_request_error",
    ErrorType.AUTHENTICATION: "authentication_error",
    ErrorType.PERMISSION: "permission_error",
    ErrorType.NOT_FOUND: "not_found_error",
    ErrorType.REQUEST_TOO_LARGE: "request_too_large_error",
    ErrorType.API_ERROR: "api_error",
    ErrorType.OVERLOADED: "overloaded_error",
    ErrorType.TIMEOUT: "timeout_error",
    ErrorType.STREAM_ERROR: "stream_error",
    ErrorType.OTHER: "other",
}


@dataclass(frozen=True)
class ErrorClassification:
    """Structured result of :func:`classify_exception`."""

    error_type: ErrorType
    provider: str
    http_status: int | None
    provider_error_code: str | None
    error_message: str
    request_id: str | None
    retry_after: float | None
    is_retryable: bool

    def to_payload(self) -> dict[str, Any]:
        """Shape emitted on the wire under the event's ``error`` key."""
        return {
            "error_type": self.error_type.value,
            "provider": self.provider,
            "http_status": self.http_status,
            "provider_error_code": self.provider_error_code,
            "error_message": self.error_message,
            "request_id": self.request_id,
            "retry_after": self.retry_after,
            "is_retryable": self.is_retryable,
        }


# ---------------------------------------------------------------------------
# Classifier
# ---------------------------------------------------------------------------

# The classifier walks two signals: (a) the exception class name, which each
# SDK namespaces consistently; (b) the HTTP status if the exception exposes
# one. Class-name matching is deliberate -- we do NOT import the provider
# SDKs here because the sensor must stay install-optional (a user with
# ``openai`` but not ``anthropic`` installed cannot pay a hard import cost).
#
# Class names to error types. First-match wins; order matters for subclasses
# (put more-specific entries first).
_CLASS_TO_TYPE: list[tuple[tuple[str, ...], ErrorType]] = [
    (("RateLimitError",), ErrorType.RATE_LIMIT),
    (("PermissionDeniedError", "PermissionError"), ErrorType.PERMISSION),
    (("AuthenticationError",), ErrorType.AUTHENTICATION),
    (("NotFoundError",), ErrorType.NOT_FOUND),
    (("UnprocessableEntityError",), ErrorType.INVALID_REQUEST),
    (("BadRequestError",), ErrorType.INVALID_REQUEST),
    (("ConflictError",), ErrorType.INVALID_REQUEST),
    (("ServiceUnavailableError",), ErrorType.OVERLOADED),
    (("InternalServerError",), ErrorType.API_ERROR),
    (("APITimeoutError", "TimeoutError"), ErrorType.TIMEOUT),
    (("APIConnectionError",), ErrorType.API_ERROR),
    (("APIStatusError",), ErrorType.API_ERROR),
    (("APIError",), ErrorType.API_ERROR),
]


# HTTP status overrides when the class alone is ambiguous. 429 could be
# rate_limit OR quota_exceeded -- Anthropic / OpenAI both surface billing
# caps as 429, distinguished by provider_error_code. 503 is split between
# api_error and overloaded.
def _override_from_status_and_code(
    base: ErrorType,
    http_status: int | None,
    provider_error_code: str | None,
) -> ErrorType:
    if http_status == 429 and provider_error_code:
        code = provider_error_code.lower()
        if "quota" in code or "billing" in code or "monthly" in code:
            return ErrorType.QUOTA_EXCEEDED
    if http_status == 413:
        return ErrorType.REQUEST_TOO_LARGE
    if http_status == 529:  # Anthropic-specific "overloaded"
        return ErrorType.OVERLOADED
    # OpenAI sometimes returns 503 "engine overloaded"; distinguish on
    # the message hint when present. The combined condition keeps ruff's
    # SIM102 happy without losing the 503-vs-500 branch clarity.
    if (
        http_status == 503
        and provider_error_code
        and "overload" in provider_error_code.lower()
    ):
        return ErrorType.OVERLOADED
    if http_status == 400 and provider_error_code:
        code = provider_error_code.lower()
        if "context_length" in code or "token" in code and "exceed" in code:
            return ErrorType.CONTEXT_OVERFLOW
        if "content_filter" in code or "content_policy" in code:
            return ErrorType.CONTENT_FILTER
    return base


# Provider inference from exception module. Keeps ``provider`` field honest
# without importing the SDKs.
def _provider_from_module(module_name: str) -> str:
    m = module_name.lower()
    if m.startswith("anthropic"):
        return "anthropic"
    if m.startswith("openai"):
        return "openai"
    if m.startswith("litellm"):
        return "litellm"
    if m.startswith("voyageai") or m.startswith("voyage"):
        return "voyage"
    return "unknown"


def classify_exception(
    exc: BaseException,
    *,
    provider_hint: str | None = None,
    is_stream_error: bool = False,
) -> ErrorClassification:
    """Classify a live provider exception against the Phase 4 taxonomy.

    ``provider_hint`` lets the caller override module-based inference (for
    cases where the exception type is re-raised across a wrapping layer and
    its ``__module__`` no longer reflects the original provider). When
    ``is_stream_error`` is True the classifier returns ``STREAM_ERROR``
    regardless of the underlying class -- mid-stream exceptions are not
    meaningfully distinguished by their HTTP-status-less class name.

    Never raises. An internal failure falls through to
    ``error_type="other"``.
    """
    try:
        cls_name = type(exc).__name__
        module = type(exc).__module__
        provider = provider_hint or _provider_from_module(module)

        http_status = _extract_http_status(exc)
        provider_error_code = _extract_provider_error_code(exc)
        request_id = _extract_request_id(exc)
        retry_after = _extract_retry_after(exc)

        if is_stream_error:
            base = ErrorType.STREAM_ERROR
        else:
            base = ErrorType.OTHER
            for names, etype in _CLASS_TO_TYPE:
                if cls_name in names:
                    base = etype
                    break
            base = _override_from_status_and_code(base, http_status, provider_error_code)

        message = _redacted_message(exc, cls_name)
        retryable = _RETRYABLE.get(base, False)

        return ErrorClassification(
            error_type=base,
            provider=provider,
            http_status=http_status,
            provider_error_code=provider_error_code,
            error_message=message,
            request_id=request_id,
            retry_after=retry_after,
            is_retryable=retryable,
        )
    except Exception:  # pragma: no cover — defence in depth
        return ErrorClassification(
            error_type=ErrorType.OTHER,
            provider=provider_hint or "unknown",
            http_status=None,
            provider_error_code=None,
            error_message=type(exc).__name__,
            request_id=None,
            retry_after=None,
            is_retryable=False,
        )


# ---------------------------------------------------------------------------
# Extraction helpers — each returns ``None`` on any failure rather than
# raising. Provider SDKs expose request IDs / status codes under varying
# attribute names; these helpers try the common ones in a safe order.
# ---------------------------------------------------------------------------


def _extract_http_status(exc: BaseException) -> int | None:
    for attr in ("status_code", "http_status", "code"):
        try:
            v = getattr(exc, attr, None)
            if isinstance(v, int) and 100 <= v < 600:
                return v
        except Exception:
            continue
    # Some SDKs stash the response on ``response``: try response.status_code.
    try:
        resp = getattr(exc, "response", None)
        if resp is not None:
            v = getattr(resp, "status_code", None)
            if isinstance(v, int) and 100 <= v < 600:
                return v
    except Exception:
        pass
    return None


def _extract_provider_error_code(exc: BaseException) -> str | None:
    for attr in ("error_code", "code", "type"):
        try:
            v = getattr(exc, attr, None)
            if isinstance(v, str) and v:
                return v
        except Exception:
            continue
    # ``.body`` on openai/anthropic often holds {"error": {"code": "..."}}.
    try:
        body = getattr(exc, "body", None)
        if isinstance(body, dict):
            err = body.get("error")
            if isinstance(err, dict):
                code = err.get("code") or err.get("type")
                if isinstance(code, str) and code:
                    return code
    except Exception:
        pass
    return None


def _extract_request_id(exc: BaseException) -> str | None:
    for attr in ("request_id", "x_request_id"):
        try:
            v = getattr(exc, attr, None)
            if isinstance(v, str) and v:
                return v
        except Exception:
            continue
    try:
        resp = getattr(exc, "response", None)
        if resp is not None:
            headers = getattr(resp, "headers", None)
            if headers is not None:
                for key in ("x-request-id", "X-Request-ID", "request-id"):
                    try:
                        v = headers.get(key)
                    except Exception:
                        v = None
                    if isinstance(v, str) and v:
                        return v
    except Exception:
        pass
    return None


def _extract_retry_after(exc: BaseException) -> float | None:
    try:
        resp = getattr(exc, "response", None)
        if resp is None:
            return None
        headers = getattr(resp, "headers", None)
        if headers is None:
            return None
        for key in ("retry-after", "Retry-After"):
            try:
                v = headers.get(key)
            except Exception:
                v = None
            if v is None:
                continue
            try:
                return float(v)
            except (TypeError, ValueError):
                continue
    except Exception:
        return None
    return None


def _redacted_message(exc: BaseException, cls_name: str) -> str:
    """Class name plus a short safe summary. Never returns prompt content."""
    try:
        raw = str(exc)
    except Exception:
        raw = ""
    if not raw:
        return cls_name
    # Clip to 200 chars, replace newlines so the dashboard can render inline.
    clipped = raw.replace("\n", " ").replace("\r", " ")
    if len(clipped) > 200:
        clipped = clipped[:197] + "..."
    return f"{cls_name}: {clipped}"


# ---------------------------------------------------------------------------
# Payload builder -- called by the interceptor after classification.
# Kept separate so tests can exercise the wire shape without constructing a
# Session.
# ---------------------------------------------------------------------------


@dataclass
class ErrorPayload:
    """Structured payload added to an LLM_ERROR event's ``error`` field."""

    classification: ErrorClassification
    # Populated when the error is a mid-stream abort so the dashboard can
    # show partial token accounting alongside the error.
    partial_tokens_input: int | None = None
    partial_tokens_output: int | None = None
    abort_reason: str | None = None
    fields: dict[str, Any] = field(default_factory=dict)

    def to_payload(self) -> dict[str, Any]:
        payload = self.classification.to_payload()
        if self.partial_tokens_input is not None:
            payload["partial_tokens_input"] = self.partial_tokens_input
        if self.partial_tokens_output is not None:
            payload["partial_tokens_output"] = self.partial_tokens_output
        if self.abort_reason is not None:
            payload["abort_reason"] = self.abort_reason
        payload.update(self.fields)
        return payload
