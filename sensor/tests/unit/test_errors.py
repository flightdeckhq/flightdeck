"""Unit tests for the Phase 4 error-classification taxonomy.

The classifier walks class name → taxonomy with HTTP status + provider error
code overrides. These tests pin every taxonomy mapping so a future SDK
version that renames an exception (or adds a new one) surfaces as a
concrete test failure rather than silent drift to ``error_type="other"``.
"""

from __future__ import annotations

from typing import Any

from flightdeck_sensor.core.errors import (
    OTEL_ERROR_TYPE,
    ErrorClassification,
    ErrorPayload,
    ErrorType,
    classify_exception,
)


# ---------------------------------------------------------------------------
# Synthetic exception factory. We do NOT import provider SDKs here so the
# test suite stays runnable with any subset of extras installed. The
# classifier walks ``type(exc).__name__`` + ``__module__`` so spoofing them
# is enough to cover every real path.
# ---------------------------------------------------------------------------


def _mk(
    cls_name: str,
    *,
    module: str = "anthropic",
    status: int | None = None,
    code: str | None = None,
    body: dict[str, Any] | None = None,
    request_id: str | None = None,
    headers: dict[str, str] | None = None,
    message: str = "",
) -> Exception:
    attrs: dict[str, Any] = {}
    if status is not None:
        attrs["status_code"] = status
    if code is not None:
        attrs["code"] = code
    if body is not None:
        attrs["body"] = body
    if request_id is not None:
        attrs["request_id"] = request_id
    if headers is not None:
        class _Resp:
            pass
        resp = _Resp()
        resp.status_code = status  # type: ignore[attr-defined]
        resp.headers = headers  # type: ignore[attr-defined]
        attrs["response"] = resp
    cls = type(cls_name, (Exception,), {"__module__": module})
    exc = cls(message)
    for k, v in attrs.items():
        setattr(exc, k, v)
    return exc  # type: ignore[return-value]


# ---------------------------------------------------------------------------
# Straight class-name → taxonomy mappings
# ---------------------------------------------------------------------------


def test_rate_limit_error_maps_to_rate_limit() -> None:
    exc = _mk("RateLimitError", status=429)
    c = classify_exception(exc)
    assert c.error_type is ErrorType.RATE_LIMIT
    assert c.http_status == 429
    assert c.is_retryable is True


def test_authentication_error_maps_to_authentication() -> None:
    c = classify_exception(_mk("AuthenticationError", status=401))
    assert c.error_type is ErrorType.AUTHENTICATION
    assert c.is_retryable is False


def test_permission_denied_error_maps_to_permission() -> None:
    # OpenAI names it PermissionDeniedError; anthropic uses PermissionError.
    # Both should resolve to the same taxonomy entry.
    assert classify_exception(_mk("PermissionDeniedError", module="openai", status=403)).error_type is ErrorType.PERMISSION
    assert classify_exception(_mk("PermissionError", module="anthropic", status=403)).error_type is ErrorType.PERMISSION


def test_not_found_error_maps_to_not_found() -> None:
    c = classify_exception(_mk("NotFoundError", status=404))
    assert c.error_type is ErrorType.NOT_FOUND


def test_bad_request_error_maps_to_invalid_request() -> None:
    c = classify_exception(_mk("BadRequestError", status=400))
    assert c.error_type is ErrorType.INVALID_REQUEST


def test_timeout_maps_to_timeout_and_is_retryable() -> None:
    c = classify_exception(_mk("APITimeoutError"))
    assert c.error_type is ErrorType.TIMEOUT
    assert c.is_retryable is True


def test_internal_server_error_maps_to_api_error() -> None:
    c = classify_exception(_mk("InternalServerError", status=500))
    assert c.error_type is ErrorType.API_ERROR
    assert c.is_retryable is True


def test_service_unavailable_maps_to_overloaded() -> None:
    # anthropic 503 commonly surfaces as ServiceUnavailableError.
    c = classify_exception(_mk("ServiceUnavailableError", status=503))
    assert c.error_type is ErrorType.OVERLOADED
    assert c.is_retryable is True


# ---------------------------------------------------------------------------
# HTTP status + code overrides
# ---------------------------------------------------------------------------


def test_429_with_quota_code_upgrades_to_quota_exceeded() -> None:
    exc = _mk("RateLimitError", status=429, code="billing_quota_exceeded")
    c = classify_exception(exc)
    assert c.error_type is ErrorType.QUOTA_EXCEEDED
    # Quota is NOT retryable -- the caller hit a billing cap, not a
    # short-term-rate limit.
    assert c.is_retryable is False


def test_400_with_context_length_code_upgrades_to_context_overflow() -> None:
    exc = _mk("BadRequestError", status=400, code="context_length_exceeded")
    c = classify_exception(exc)
    assert c.error_type is ErrorType.CONTEXT_OVERFLOW
    assert c.is_retryable is False


def test_400_with_content_filter_code_upgrades_to_content_filter() -> None:
    exc = _mk("BadRequestError", status=400, code="content_filter_violation")
    c = classify_exception(exc)
    assert c.error_type is ErrorType.CONTENT_FILTER


def test_529_maps_to_overloaded_regardless_of_class() -> None:
    # Anthropic's 529 "Overloaded" commonly surfaces as APIStatusError.
    c = classify_exception(_mk("APIStatusError", status=529))
    assert c.error_type is ErrorType.OVERLOADED
    assert c.is_retryable is True


def test_413_maps_to_request_too_large() -> None:
    c = classify_exception(_mk("APIStatusError", status=413))
    assert c.error_type is ErrorType.REQUEST_TOO_LARGE


# ---------------------------------------------------------------------------
# Mid-stream error override
# ---------------------------------------------------------------------------


def test_is_stream_error_flag_forces_stream_error_type() -> None:
    # Even an explicit RateLimitError becomes stream_error when the caller
    # flags the classification as mid-stream. The dashboard treats this as
    # a distinct failure mode.
    c = classify_exception(_mk("RateLimitError", status=429), is_stream_error=True)
    assert c.error_type is ErrorType.STREAM_ERROR


# ---------------------------------------------------------------------------
# Fallback and robustness
# ---------------------------------------------------------------------------


def test_unknown_exception_falls_through_to_other() -> None:
    c = classify_exception(_mk("WeirdUnknownException", module="some.vendor"))
    assert c.error_type is ErrorType.OTHER
    assert c.is_retryable is False


def test_classifier_never_raises_on_garbage_exception() -> None:
    class Busted:
        def __getattr__(self, _name: str) -> Any:
            raise RuntimeError("detonate")
    # Should not raise; should produce an ``other`` classification.
    # We have to construct via _mk() for __module__, so bolt Busted's
    # __getattr__ on after.
    exc = _mk("APIError", status=500)
    object.__setattr__(exc, "__getattr__", lambda _: (_ for _ in ()).throw(RuntimeError("detonate")))
    c = classify_exception(exc)
    assert c.error_type in {ErrorType.API_ERROR, ErrorType.OTHER}


# ---------------------------------------------------------------------------
# Extraction of auxiliary fields
# ---------------------------------------------------------------------------


def test_extracts_request_id_from_attribute() -> None:
    exc = _mk("APIError", status=500, request_id="req_abc123")
    c = classify_exception(exc)
    assert c.request_id == "req_abc123"


def test_extracts_request_id_from_response_headers() -> None:
    exc = _mk("APIError", status=500, headers={"x-request-id": "req_from_header"})
    c = classify_exception(exc)
    assert c.request_id == "req_from_header"


def test_extracts_retry_after_header() -> None:
    exc = _mk("RateLimitError", status=429, headers={"retry-after": "30"})
    c = classify_exception(exc)
    assert c.retry_after == 30.0


def test_extracts_provider_error_code_from_body_error_dict() -> None:
    # OpenAI / Anthropic stash structured body on the exception.
    exc = _mk("BadRequestError", status=400, body={"error": {"code": "context_length_exceeded"}})
    c = classify_exception(exc)
    assert c.provider_error_code == "context_length_exceeded"
    assert c.error_type is ErrorType.CONTEXT_OVERFLOW


def test_provider_inferred_from_module_name() -> None:
    assert classify_exception(_mk("APIError", module="anthropic.errors", status=500)).provider == "anthropic"
    assert classify_exception(_mk("APIError", module="openai._exceptions", status=500)).provider == "openai"
    assert classify_exception(_mk("APIError", module="litellm.exceptions", status=500)).provider == "litellm"


def test_provider_hint_overrides_module_inference() -> None:
    # Wrapping layers (e.g. litellm re-raising an Anthropic error) can
    # mis-attribute the provider. The hint gives callers an override.
    exc = _mk("APIError", module="anthropic", status=500)
    c = classify_exception(exc, provider_hint="litellm")
    assert c.provider == "litellm"


# ---------------------------------------------------------------------------
# Redaction
# ---------------------------------------------------------------------------


def test_error_message_includes_class_name_and_clip() -> None:
    """When capture_prompts=True, error_message includes the
    exception's str() (clipped). With capture_prompts=False (the
    default), see test_classify_capture_off_omits_provider_message_text
    below — class name only."""
    big = "x" * 500
    c = classify_exception(
        _mk("APIError", status=500, message=big), capture_prompts=True,
    )
    assert c.error_message.startswith("APIError:")
    # Clipped to 200-char summary + ellipsis.
    assert len(c.error_message) <= 210


def test_error_message_replaces_newlines_for_single_line_render() -> None:
    c = classify_exception(
        _mk("APIError", status=500, message="line1\nline2\r\nline3"),
        capture_prompts=True,
    )
    assert "\n" not in c.error_message
    assert "\r" not in c.error_message


# ---------------------------------------------------------------------------
# Wire-shape + OTel mapping
# ---------------------------------------------------------------------------


def test_to_payload_carries_all_taxonomy_fields() -> None:
    exc = _mk(
        "RateLimitError",
        module="openai",
        status=429,
        code="rate_limit_exceeded",
        request_id="req_1",
        headers={"retry-after": "5"},
        message="slow down",
    )
    # capture_prompts=True so the provider's str(exc) lands in
    # error_message; this test verifies the wire-shape fields including
    # the message-content path. See
    # test_classify_capture_off_omits_provider_message_text for the
    # capture-off behaviour.
    payload = classify_exception(exc, capture_prompts=True).to_payload()
    assert payload["error_type"] == "rate_limit"
    assert payload["provider"] == "openai"
    assert payload["http_status"] == 429
    assert payload["provider_error_code"] == "rate_limit_exceeded"
    assert payload["request_id"] == "req_1"
    assert payload["retry_after"] == 5.0
    assert payload["is_retryable"] is True
    assert "slow down" in payload["error_message"]


def test_otel_mapping_covers_every_taxonomy_entry() -> None:
    # Regression guard: every ErrorType must have an OTel counterpart so the
    # future exporter never hits a KeyError.
    for et in ErrorType:
        assert et in OTEL_ERROR_TYPE, f"OTel mapping missing for {et!r}"


# ---------------------------------------------------------------------------
# ErrorPayload wrapper (mid-stream partial tokens + abort reason)
# ---------------------------------------------------------------------------


def test_error_payload_adds_partial_tokens_and_abort_reason() -> None:
    c = classify_exception(_mk("APIError", status=500), is_stream_error=True)
    wrapped = ErrorPayload(
        classification=c,
        partial_tokens_input=120,
        partial_tokens_output=37,
        abort_reason="error_mid_stream",
    )
    out = wrapped.to_payload()
    assert out["error_type"] == "stream_error"
    assert out["partial_tokens_input"] == 120
    assert out["partial_tokens_output"] == 37
    assert out["abort_reason"] == "error_mid_stream"


def test_error_payload_omits_optional_fields_when_none() -> None:
    c = classify_exception(_mk("APIError", status=500))
    out = ErrorPayload(classification=c).to_payload()
    assert "partial_tokens_input" not in out
    assert "partial_tokens_output" not in out
    assert "abort_reason" not in out


# ---------------------------------------------------------------------------
# ErrorClassification is hashable/frozen so downstream code can cache it
# if needed (e.g. deduplicating repeated emissions).
# ---------------------------------------------------------------------------


def test_error_classification_is_frozen() -> None:
    c = classify_exception(_mk("APIError", status=500))
    try:
        c.error_type = ErrorType.OTHER  # type: ignore[misc]
    except Exception:
        return
    raise AssertionError("ErrorClassification should be frozen")


# ---------------------------------------------------------------------------
# H-2 regression — Rule 18 leak via _redacted_message
# ---------------------------------------------------------------------------
#
# Provider exceptions (notably content_filter rejections) echo the
# offending prompt fragment in their str() representation. Pre-fix,
# _redacted_message included str(exc) verbatim regardless of
# capture_prompts. classify_exception now accepts capture_prompts and
# threads it through so capture-off returns class-name only.


def test_classify_capture_off_omits_provider_message_text() -> None:
    """H-2 fix: capture_prompts=False MUST NOT include str(exc) in
    error_message. Provider content_filter exceptions echo the
    offending prompt fragment in their string; that fragment is
    user-prompt content that capture-off must not forward.
    """
    sensitive = (
        "BadRequestError: Your prompt contains text that is not "
        "allowed: 'how to do something sensitive that should never "
        "land in the events table'"
    )
    exc = _mk("BadRequestError", module="openai", status=400, message=sensitive)
    c = classify_exception(exc, capture_prompts=False)
    # Class name only. No prompt fragment.
    assert c.error_message == "BadRequestError"
    assert "sensitive" not in c.error_message
    assert "prompt" not in c.error_message


def test_classify_capture_on_includes_clipped_provider_message() -> None:
    """When capture_prompts=True, error_message includes the
    exception's clipped str repr — same redaction rule as chat
    content."""
    exc = _mk(
        "RateLimitError",
        module="anthropic",
        status=429,
        message="rate limit exceeded; retry-after 30s",
    )
    c = classify_exception(exc, capture_prompts=True)
    assert c.error_message.startswith("RateLimitError: ")
    assert "rate limit" in c.error_message


def test_classify_capture_on_clips_message_to_max_length() -> None:
    """Long provider strings clip at _ERROR_MESSAGE_MAX_LEN (200)
    with a trailing ellipsis so the dashboard renders inline and a
    runaway message can't bloat the events row."""
    long = "x" * 1000
    exc = _mk("APIError", status=500, message=long)
    c = classify_exception(exc, capture_prompts=True)
    assert len(c.error_message) <= 200 + len("APIError: ")
    assert c.error_message.endswith("...")


def test_classify_capture_off_default_value() -> None:
    """capture_prompts defaults to False so a caller that forgets to
    pass the flag gets safe (capture-off) behaviour, not the leaky
    default."""
    exc = _mk("BadRequestError", module="openai", status=400, message="prompt content")
    c = classify_exception(exc)  # no capture_prompts argument
    assert c.error_message == "BadRequestError"
