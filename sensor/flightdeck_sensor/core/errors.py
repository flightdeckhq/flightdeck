"""Error classification for LLM provider exceptions.

LLM API errors are first-class structured events: :func:`classify_exception`
maps a provider exception to a 14-entry taxonomy,
:func:`classify_stop_reason` maps the non-success stop reason of a
response the provider answered with HTTP 200 onto the same taxonomy, and
:class:`ErrorPayload` wraps a classification into the structured ``error``
sub-object attached to an :class:`EventType.LLM_ERROR` event.

The taxonomy is deliberately provider-agnostic. Each entry maps to the
recommended OTel ``gen_ai.error.type`` value so an OpenTelemetry exporter
can pass the classification through unchanged.

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
    """The 14-entry error taxonomy. Values are the wire-level strings."""

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

# Maximum length of provider exception text included in error_message
# when capture_prompts=True. Bounds the dashboard render width and the
# size of a payload row. Above this, the message is suffixed with "..."
# so the operator sees content was clipped.
_ERROR_MESSAGE_MAX_LEN = 200


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

# The classifier reads four signals: (a) the exception class name, which
# each SDK namespaces consistently; (b) the HTTP status if the exception
# exposes one; (c) the provider's error code; (d) the provider's message,
# used for a keyword match only and never stored. Class-name matching is
# deliberate -- we do NOT import the provider SDKs here because the sensor
# must stay install-optional (a user with ``openai`` but not ``anthropic``
# installed cannot pay a hard import cost).
#
# Exception class names (SDK, stdlib and httpx) that mean the request or
# the response timed out. Shared with the stream guard, which reports such
# a failure with ``abort_reason=timeout`` whatever its classification.
TIMEOUT_EXCEPTION_NAMES: tuple[str, ...] = (
    "APITimeoutError",
    "TimeoutError",
    "TimeoutException",
    "ConnectTimeout",
    "ReadTimeout",
    "WriteTimeout",
    "PoolTimeout",
)


class StreamOutcome(str, enum.Enum):
    """``payload.streaming.final_outcome`` of a streamed post_call. The
    dashboard keys its outcome badge off these exact strings."""

    COMPLETED = "completed"
    ABORTED = "aborted"


class AbortReason(str, enum.Enum):
    """``abort_reason`` of a streamed call: ``CLIENT_ABORTED`` on the
    post_call of a stream the caller left early, the others on the
    llm_error of a stream that failed."""

    CLIENT_ABORTED = "client_aborted"
    ERROR_BEFORE_STREAM = "error_before_stream"
    ERROR_MID_STREAM = "error_mid_stream"
    TIMEOUT = "timeout"


# Anthropic-specific exception classes, walked before the shared table so
# each keeps its own meaning instead of collapsing into the generic entry
# for its base class (all three derive from APIStatusError). The SDK's
# status mapping raises OverloadedError (529) and RequestTooLargeError
# (413) directly; DeadlineExceededError is declared for 504 but the
# mapping folds 504 into InternalServerError, so the 504 status override
# below is what classifies a real gateway timeout. A 402 billing_error
# arrives as a bare APIStatusError and is likewise caught by status.
_ANTHROPIC_CLASS_TO_TYPE: list[tuple[tuple[str, ...], ErrorType]] = [
    (("DeadlineExceededError",), ErrorType.TIMEOUT),
    (("OverloadedError",), ErrorType.OVERLOADED),
    (("RequestTooLargeError",), ErrorType.REQUEST_TOO_LARGE),
]

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
    (TIMEOUT_EXCEPTION_NAMES, ErrorType.TIMEOUT),
    (("APIConnectionError",), ErrorType.API_ERROR),
    (("APIStatusError",), ErrorType.API_ERROR),
    (("APIError",), ErrorType.API_ERROR),
]


# Phrases Anthropic uses when the account, not the request, is what
# failed: an organisation or per-user spend limit, an exhausted prepaid
# balance. Anthropic reports these under the generic error type of their
# status (429 rate_limit_error for the organisation spend cap, 400
# invalid_request_error for a user spend limit or a too-low credit
# balance), so the message is the only signal that separates them from a
# real rate limit or a malformed request. Multi-word phrases only: a
# single word such as "billing", "quota" or "monthly" also occurs in
# caller-supplied identifiers a 400 echoes back (a schema named
# monthly_report, a tool get_billing_info) and in per-minute quota
# messages that are genuine rate limits. Matched against the lower-cased
# message of Anthropic exceptions only; the text itself is never stored.
_BILLING_MESSAGE_HINTS: tuple[str, ...] = (
    "spend limit",
    "spending limit",
    "spend cap",
    "credit balance",
)

# Statuses under which Anthropic reports a billing condition with a
# generic error type, so the message is consulted; under every other
# status the class and status decide and the message is never read.
_MESSAGE_HINT_STATUSES: frozenset[int] = frozenset({400, 429})

# Only the first 2 KiB of a provider message is inspected for a billing
# phrase. The phrases open every known message, a provider message is
# normally well under 1 KiB, and the cap bounds the work the hot path
# does on a pathological multi-megabyte message: the slice is taken
# before lower-casing, so neither copy is larger than the cap.
_MESSAGE_HINT_MAX_CHARS = 2048

# The provider whose messages the billing-phrase match applies to.
_MESSAGE_HINT_PROVIDER = "anthropic"


def _mentions_billing(message_hint: str) -> bool:
    return any(hint in message_hint for hint in _BILLING_MESSAGE_HINTS)


# HTTP status overrides when the class alone is ambiguous. 429 could be
# rate_limit OR quota_exceeded -- Anthropic / OpenAI both surface billing
# caps as 429, distinguished by provider_error_code or, for Anthropic, the
# message. 503 is split between api_error and overloaded.
def _override_from_status_and_code(
    base: ErrorType,
    http_status: int | None,
    provider_error_code: str | None,
    message_hint: str = "",
) -> ErrorType:
    # 402 is Anthropic's billing_error: the account cannot be charged, so
    # a retry cannot help -- the quota entry carries that (non-retryable).
    if http_status == 402:
        return ErrorType.QUOTA_EXCEEDED
    # 504 is a gateway timeout whatever class the SDK wrapped it in
    # (Anthropic folds it into InternalServerError).
    if http_status == 504:
        return ErrorType.TIMEOUT
    if http_status == 429 and provider_error_code:
        code = provider_error_code.lower()
        if "quota" in code or "billing" in code or "monthly" in code:
            return ErrorType.QUOTA_EXCEEDED
    # Anthropic's organisation spend cap is a 429 rate_limit_error whose
    # message, not its type, says the cap was hit.
    if http_status == 429 and _mentions_billing(message_hint):
        return ErrorType.QUOTA_EXCEEDED
    if http_status == 413:
        return ErrorType.REQUEST_TOO_LARGE
    if http_status == 529:  # Anthropic-specific "overloaded"
        return ErrorType.OVERLOADED
    # OpenAI sometimes returns 503 "engine overloaded"; distinguish on
    # the message hint when present. The combined condition keeps ruff's
    # SIM102 happy without losing the 503-vs-500 branch clarity.
    if http_status == 503 and provider_error_code and "overload" in provider_error_code.lower():
        return ErrorType.OVERLOADED
    if http_status == 400 and provider_error_code:
        code = provider_error_code.lower()
        if "context_length" in code or "token" in code and "exceed" in code:
            return ErrorType.CONTEXT_OVERFLOW
        if "content_filter" in code or "content_policy" in code:
            return ErrorType.CONTENT_FILTER
    # A per-user spend limit or an exhausted credit balance is a 400
    # invalid_request_error on Anthropic; the request itself was fine.
    if http_status == 400 and _mentions_billing(message_hint):
        return ErrorType.QUOTA_EXCEEDED
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
    capture_prompts: bool = False,
) -> ErrorClassification:
    """Classify a live provider exception against the error taxonomy.

    ``provider_hint`` lets the caller override module-based inference (for
    cases where the exception type is re-raised across a wrapping layer and
    its ``__module__`` no longer reflects the original provider). When
    ``is_stream_error`` is True the classifier returns ``STREAM_ERROR``
    regardless of the underlying class -- mid-stream exceptions are not
    meaningfully distinguished by their HTTP-status-less class name.

    ``capture_prompts`` gates content inclusion in ``error_message``.
    When False (default), the message is the exception class name only —
    no provider-controlled string is forwarded. When True, the same
    redaction rule that applies to chat content applies here: the
    provider's exception ``str()`` is included (clipped to
    ``_ERROR_MESSAGE_MAX_LEN`` chars). Capture posture is enforced here:
    content_filter exceptions echo the offending prompt fragment in
    their string representation, so capture-off must NOT pass that
    string through.

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
            for names, etype in (*_ANTHROPIC_CLASS_TO_TYPE, *_CLASS_TO_TYPE):
                if cls_name in names:
                    base = etype
                    break
            # The message is read only where it can change the verdict:
            # an Anthropic 400 or 429. A status-less, foreign or huge
            # exception pays nothing for it.
            message_hint = ""
            if provider == _MESSAGE_HINT_PROVIDER and http_status in _MESSAGE_HINT_STATUSES:
                message_hint = _extract_message_hint(exc)
            base = _override_from_status_and_code(
                base,
                http_status,
                provider_error_code,
                message_hint,
            )

        message = _redacted_message(exc, cls_name, capture_prompts=capture_prompts)
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
# Non-success stop reasons. A provider can answer HTTP 200 with a stop
# reason that still means the call did not succeed: Anthropic's
# ``refusal`` (its safety classifiers declined) and
# ``model_context_window_exceeded`` (the context window ran out
# mid-response), OpenAI's and litellm's ``content_filter`` finish reason.
# None is a completed call from the operator's point of view, so the
# interceptor files an llm_error beside the post_call (the call was billed,
# so the post_call keeps its usage). A truncated response (``max_tokens``,
# ``length``, ``max_output_tokens``) is a success: the text is valid, just
# cut short, and the caller sees that on the response itself.
# ---------------------------------------------------------------------------

NON_SUCCESS_STOP_REASONS: dict[str, ErrorType] = {
    # Anthropic stop_reason; also an OpenAI structured-output refusal
    # (message.refusal), which the OpenAI adapter reports under this key.
    "refusal": ErrorType.CONTENT_FILTER,
    # Anthropic stop_reason.
    "model_context_window_exceeded": ErrorType.CONTEXT_OVERFLOW,
    # OpenAI chat and litellm finish_reason, and the reason of an OpenAI
    # Responses call left incomplete by the content filter.
    "content_filter": ErrorType.CONTENT_FILTER,
}

# The HTTP status recorded on a stop-reason classification. The provider
# answered the request, so the failure is in the response body, not the
# transport; an operator reading 200 on the error row knows to look at
# ``provider_error_code`` (the stop reason) rather than at a status error.
STOP_REASON_HTTP_STATUS = 200


def classify_stop_reason(
    stop_reason: Any,
    *,
    provider: str,
    request_id: str | None = None,
) -> ErrorClassification | None:
    """Classify a provider's stop reason.

    Returns ``None`` for every reason that is not in
    :data:`NON_SUCCESS_STOP_REASONS` (``end_turn``, ``max_tokens``,
    ``tool_use``, a missing reason, a non-string) so the caller emits
    nothing. ``error_message`` names the reason only -- no response
    content -- so the result is safe under capture-off. Never raises.
    """
    try:
        if not isinstance(stop_reason, str):
            return None
        error_type = NON_SUCCESS_STOP_REASONS.get(stop_reason)
        if error_type is None:
            return None
        return ErrorClassification(
            error_type=error_type,
            provider=provider,
            http_status=STOP_REASON_HTTP_STATUS,
            provider_error_code=stop_reason,
            error_message=f"stop_reason={stop_reason}",
            request_id=request_id,
            retry_after=None,
            is_retryable=_RETRYABLE.get(error_type, False),
        )
    except Exception:  # pragma: no cover — defence in depth
        return None


# ---------------------------------------------------------------------------
# Extraction helpers — each returns ``None`` on any failure rather than
# raising. Provider SDKs expose request IDs / status codes under varying
# attribute names; these helpers try the common ones in a safe order.
#
# M-9 note: every helper below uses bare ``except Exception:`` blocks
# intentionally. The classifier is defence-in-depth — provider SDKs
# evolve their attribute shapes between releases (e.g. a future
# anthropic SDK may rename ``response.headers`` to a different
# accessor), and an extractor that raises on access pattern drift
# would propagate up through ``classify_exception``'s outer try/except
# and degrade the entire error event to ``error_type="other"``.
# Returning ``None`` per-helper localises the degradation to that one
# field while keeping the classification accurate. Do NOT narrow the
# excepts to specific classes without auditing every supported SDK
# version's attribute access pattern.
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


def _extract_message_hint(exc: BaseException) -> str:
    """The first ``_MESSAGE_HINT_MAX_CHARS`` of the provider message,
    lower-cased, for phrase matching only. It is never stored:
    ``error_message`` goes through :func:`_redacted_message`, which keeps
    the capture-off posture. Empty string on any failure."""
    try:
        body = getattr(exc, "body", None)
        if isinstance(body, dict):
            err = body.get("error")
            if isinstance(err, dict):
                msg = err.get("message")
                if isinstance(msg, str) and msg:
                    return msg[:_MESSAGE_HINT_MAX_CHARS].lower()
        msg = getattr(exc, "message", None)
        if isinstance(msg, str) and msg:
            return msg[:_MESSAGE_HINT_MAX_CHARS].lower()
        return str(exc)[:_MESSAGE_HINT_MAX_CHARS].lower()
    except Exception:
        return ""


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


def _redacted_message(
    exc: BaseException,
    cls_name: str,
    *,
    capture_prompts: bool = False,
) -> str:
    """Class name plus optionally the exception's clipped string repr.

    ``capture_prompts`` gates the inclusion of ``str(exc)`` (the capture
    posture). When False, returns ``cls_name`` only — provider
    exceptions can echo the user's prompt fragment in their string
    (notably content_filter rejections), and that fragment is
    user-prompt content that capture-off must not forward to events.
    When True, returns ``f"{cls_name}: {str(exc)[:200]}"`` with newlines
    replaced so the dashboard renders inline.
    """
    if not capture_prompts:
        return cls_name
    try:
        raw = str(exc)
    except Exception:
        raw = ""
    if not raw:
        return cls_name
    clipped = raw.replace("\n", " ").replace("\r", " ")
    if len(clipped) > _ERROR_MESSAGE_MAX_LEN:
        clipped = clipped[: _ERROR_MESSAGE_MAX_LEN - 3] + "..."
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
    # N-2: mutable default by design. ErrorPayload is intentionally
    # NOT frozen — callers (interceptor / GuardedStream / async
    # variants) construct it once and append type-specific extras
    # (e.g. abort_reason for stream aborts) before serialisation.
    # Using ``default_factory=dict`` (not the bare-mutable-default
    # antipattern) so each instance gets its own dict.
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
