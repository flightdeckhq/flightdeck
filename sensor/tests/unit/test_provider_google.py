"""The Google provider adapter (google-genai) and the classification of
its errors and finish reasons, on the SDK's own types.

Token mapping, stop reasons, the error taxonomy, call details, the
estimate, the stream assembly, tool calls and stored content, each read
from objects the installed google-genai builds (``types`` and
``errors``), so a release that renames a field fails here.
"""

from __future__ import annotations

import inspect
import json
from typing import Any

import pytest

pytest.importorskip("google.genai")

from google.genai import errors, types

from flightdeck_sensor.core.errors import (
    ErrorType,
    classify_exception,
    classify_stop_reason,
)
from flightdeck_sensor.core.types import EventType, TokenUsage
from flightdeck_sensor.providers import google
from flightdeck_sensor.providers.google import GoogleProvider, SentRequest

MODEL = "gemini-3.1-flash-lite"


def _response(**fields: Any) -> types.GenerateContentResponse:
    """A response as the SDK parses it from the API's JSON."""
    return types.GenerateContentResponse._from_response(response=fields, kwargs={})


def _usage(**counts: int) -> dict[str, int]:
    return counts


# ----- tokens -----------------------------------------------------------


@pytest.mark.parametrize(
    ("usage", "expected"),
    [
        (
            {"prompt_token_count": 16, "candidates_token_count": 3, "total_token_count": 19},
            TokenUsage(input_tokens=16, output_tokens=3),
        ),
        # Thinking is billed as output but not counted in the candidates:
        # it is added in, and reported as the reasoning share.
        (
            {"prompt_token_count": 16, "candidates_token_count": 3, "thoughts_token_count": 148},
            TokenUsage(input_tokens=16, output_tokens=151, reasoning_tokens=148),
        ),
        # A thinking model that answered with thoughts only (gemma on the
        # Gemini API reports no candidates count then).
        (
            {"prompt_token_count": 7, "thoughts_token_count": 17},
            TokenUsage(input_tokens=7, output_tokens=17, reasoning_tokens=17),
        ),
        # The cached content is part of the prompt count; tool-use prompt
        # tokens (results of tools the API ran) are input on top of it.
        (
            {
                "prompt_token_count": 1000,
                "cached_content_token_count": 800,
                "tool_use_prompt_token_count": 50,
                "candidates_token_count": 10,
            },
            TokenUsage(input_tokens=1050, output_tokens=10, cache_read_tokens=800),
        ),
        # A cached count over the input breaks the subset rule ingestion
        # checks; the split is left out rather than the event rejected.
        (
            {"prompt_token_count": 5, "cached_content_token_count": 9, "candidates_token_count": 1},
            TokenUsage(input_tokens=5, output_tokens=1),
        ),
    ],
)
def test_token_mapping(usage: dict[str, int], expected: TokenUsage) -> None:
    response = types.GenerateContentResponse(
        usage_metadata=types.GenerateContentResponseUsageMetadata(**usage)
    )
    assert GoogleProvider().extract_usage(response) == expected
    # A stream chunk carries the same object, the counts so far.
    assert GoogleProvider().usage_from_stream_chunk(response) == expected


def test_a_response_without_usage_reports_none() -> None:
    assert GoogleProvider().extract_usage(types.GenerateContentResponse()) == TokenUsage()
    assert GoogleProvider().usage_from_stream_chunk(types.GenerateContentResponse()) is None


def test_embedding_tokens_are_those_vertex_reports_and_none_otherwise() -> None:
    vertex = types.EmbedContentResponse(
        embeddings=[
            types.ContentEmbedding(
                values=[0.1], statistics=types.ContentEmbeddingStatistics(token_count=4.0)
            ),
            types.ContentEmbedding(
                values=[0.2], statistics=types.ContentEmbeddingStatistics(token_count=6.0)
            ),
        ]
    )
    assert GoogleProvider().extract_usage(vertex) == TokenUsage(input_tokens=10)
    # The Gemini API's batchEmbedContents answer, as the SDK parses it,
    # carries no count: nothing is made up (the call reports the estimate).
    gemini_api = types.EmbedContentResponse(embeddings=[types.ContentEmbedding(values=[0.1])])
    assert GoogleProvider().extract_usage(gemini_api) == TokenUsage()
    assert GoogleProvider().extract_output_dimensions(gemini_api) == {"count": 1, "dimension": 1}


# ----- stop reasons -----------------------------------------------------


@pytest.mark.parametrize(
    ("reason", "error_type"),
    [
        ("STOP", None),
        ("MAX_TOKENS", None),
        ("CONTINUATION", None),
        ("MALFORMED_FUNCTION_CALL", None),
        ("SAFETY", ErrorType.CONTENT_FILTER),
        ("PROHIBITED_CONTENT", ErrorType.CONTENT_FILTER),
        ("BLOCKLIST", ErrorType.CONTENT_FILTER),
        ("RECITATION", ErrorType.CONTENT_FILTER),
        ("SPII", ErrorType.CONTENT_FILTER),
        ("IMAGE_SAFETY", ErrorType.CONTENT_FILTER),
    ],
)
def test_finish_reasons(reason: str, error_type: ErrorType | None) -> None:
    response = _response(candidates=[{"content": {"parts": []}, "finishReason": reason}])
    provider = GoogleProvider()
    assert provider.response_stop_reason(response) == reason
    assert provider.chunk_completes_stream(response) is True
    classification = classify_stop_reason(reason, provider=provider.name)
    assert (classification and classification.error_type) == error_type


def test_a_blocked_prompt_reports_its_block_reason() -> None:
    response = _response(promptFeedback={"blockReason": "PROHIBITED_CONTENT"})
    assert GoogleProvider().response_stop_reason(response) == "PROHIBITED_CONTENT"
    classification = classify_stop_reason("PROHIBITED_CONTENT", provider="google")
    assert classification is not None
    assert classification.error_type is ErrorType.CONTENT_FILTER


def test_a_chunk_without_a_finish_reason_does_not_end_the_stream() -> None:
    chunk = _response(candidates=[{"content": {"role": "model", "parts": [{"text": "Hel"}]}}])
    assert GoogleProvider().chunk_completes_stream(chunk) is False
    assert GoogleProvider().stop_reason_from_stream_chunk(chunk) is None


# ----- errors -----------------------------------------------------------


def _error(code: int, status: str, *details: dict[str, Any]) -> errors.APIError:
    body = {"error": {"code": code, "message": "provider text", "status": status}}
    if details:
        body["error"]["details"] = list(details)
    try:
        errors.APIError.raise_error(code, body, None)
    except errors.APIError as exc:
        return exc
    raise AssertionError("raise_error raised nothing")


_RATE = {"@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": "13s"}


def _quota(quota_id: str) -> dict[str, Any]:
    return {
        "@type": "type.googleapis.com/google.rpc.QuotaFailure",
        "violations": [{"quotaId": quota_id, "quotaValue": "250000"}],
    }


@pytest.mark.parametrize(
    ("error", "error_type", "retry_after"),
    [
        (_error(400, "INVALID_ARGUMENT"), ErrorType.INVALID_REQUEST, None),
        # The Gemini API answers a bad key with 400 and the reason.
        (
            _error(
                400,
                "INVALID_ARGUMENT",
                {"@type": "type.googleapis.com/google.rpc.ErrorInfo", "reason": "API_KEY_INVALID"},
            ),
            ErrorType.AUTHENTICATION,
            None,
        ),
        (_error(401, "UNAUTHENTICATED"), ErrorType.AUTHENTICATION, None),
        (_error(403, "PERMISSION_DENIED"), ErrorType.PERMISSION, None),
        (_error(404, "NOT_FOUND"), ErrorType.NOT_FOUND, None),
        (_error(413, "INVALID_ARGUMENT"), ErrorType.REQUEST_TOO_LARGE, None),
        (
            _error(
                429,
                "RESOURCE_EXHAUSTED",
                _quota("GenerateContentInputTokensPerModelPerMinute-FreeTier"),
                _RATE,
            ),
            ErrorType.RATE_LIMIT,
            13.0,
        ),
        (
            _error(
                429,
                "RESOURCE_EXHAUSTED",
                _quota("GenerateRequestsPerDayPerProjectPerModel-FreeTier"),
            ),
            ErrorType.QUOTA_EXCEEDED,
            None,
        ),
        (_error(500, "INTERNAL"), ErrorType.API_ERROR, None),
        (_error(503, "UNAVAILABLE"), ErrorType.OVERLOADED, None),
        (_error(504, "DEADLINE_EXCEEDED"), ErrorType.TIMEOUT, None),
    ],
)
def test_api_errors_by_code(
    error: errors.APIError, error_type: ErrorType, retry_after: float | None
) -> None:
    classification = classify_exception(error, provider_hint="google")
    assert classification.error_type is error_type
    assert classification.provider == "google"
    assert classification.http_status == error.code
    assert classification.provider_error_code == error.status
    assert classification.retry_after == retry_after
    # Capture off: the provider's text never leaves (it can echo a prompt).
    assert classification.error_message == type(error).__name__


@pytest.mark.parametrize(
    ("quota_id", "error_type"),
    [
        ("GenerateRequestsPerMinutePerProjectPerModel-FreeTier", ErrorType.RATE_LIMIT),
        ("GenerateRequestsPerDayPerProjectPerModel-FreeTier", ErrorType.QUOTA_EXCEEDED),
    ],
)
def test_an_error_body_the_sdk_kept_as_text_is_read(quota_id: str, error_type: ErrorType) -> None:
    # google-genai's async stream over aiohttp gets its error responses
    # typed as an event stream, so the SDK keeps the JSON body as text
    # under "message", with the HTTP reason phrase as the status.
    body = {
        "error": {
            "code": 429,
            "message": "You exceeded your current quota",
            "status": "RESOURCE_EXHAUSTED",
            "details": [_quota(quota_id), _RATE],
        }
    }
    try:
        errors.APIError.raise_error(
            429, {"message": json.dumps(body, indent=2), "status": "Too Many Requests"}, None
        )
    except errors.APIError as exc:
        error = exc
    assert error.status == "Too Many Requests"
    classification = classify_exception(error, provider_hint="google")
    assert classification.error_type is error_type
    assert classification.provider_error_code == "RESOURCE_EXHAUSTED"
    assert classification.retry_after == 13.0
    assert classification.http_status == 429


def test_an_error_body_that_is_not_json_falls_back_to_the_status() -> None:
    try:
        errors.APIError.raise_error(
            503,
            {"message": "<html>Service Unavailable</html>", "status": "Service Unavailable"},
            None,
        )
    except errors.APIError as exc:
        error = exc
    classification = classify_exception(error, provider_hint="google")
    assert classification.error_type is ErrorType.OVERLOADED
    assert classification.provider_error_code == "Service Unavailable"
    assert classification.retry_after is None


def test_the_provider_is_inferred_from_the_exception_module() -> None:
    assert classify_exception(_error(404, "NOT_FOUND")).provider == "google"


# ----- call details and metadata ----------------------------------------


@pytest.mark.parametrize(
    "header",
    # The sync client keeps the headers lower-cased, the async one as sent.
    ["x-gemini-service-tier", "X-Gemini-Service-Tier"],
)
def test_call_details_and_platform(header: str) -> None:
    response = _response(modelVersion="gemini-3.5-flash-lite")
    response.sdk_http_response = types.HttpResponse(headers={header: "flex"})
    provider = GoogleProvider(platform="gemini-api")
    details = provider.call_details(response)
    assert details is not None
    assert (details.model_served, details.service_tier) == ("gemini-3.5-flash-lite", "flex")
    assert provider.extract_response_metadata(response) == {"platform": "gemini-api"}
    assert provider.vendor == "google"


# ----- the estimate ------------------------------------------------------


def test_the_estimate_counts_characters_and_prices_inline_data_at_an_allowance() -> None:
    provider = GoogleProvider()
    text = "x" * 400
    tokens, source = provider.estimate_tokens({"model": MODEL, "contents": text})
    assert (tokens, source) == (100, "heuristic")
    image = types.Part.from_bytes(data=b"\x89PNG" * 500_000, mime_type="image/png")
    with_image, _ = provider.estimate_tokens({"model": MODEL, "contents": [text, image]})
    # Two megabytes of image cost the allowance (plus the characters of
    # the part's other fields), not half a million tokens.
    assert 1_000 <= with_image - tokens <= 1_050


def test_the_estimate_never_calls_the_network() -> None:
    # The unit suite refuses every connection off the machine; the
    # estimate is local whatever the request.
    config = types.GenerateContentConfig(system_instruction="Be brief", tools=[get_weather])
    tokens, source = GoogleProvider().estimate_tokens(
        {"model": MODEL, "contents": "hi", "config": config}
    )
    assert (tokens > 0, source) == (True, "heuristic")


# ----- the stream assembly ----------------------------------------------


def test_a_stream_is_assembled_into_the_response_a_call_returns() -> None:
    provider = GoogleProvider(capture_prompts=True)
    accumulator = provider.stream_accumulator(object(), {"model": MODEL})
    assert accumulator is not None
    chunks = [
        {"candidates": [{"content": {"role": "model", "parts": [{"text": "a", "thought": True}]}}]},
        {"candidates": [{"content": {"role": "model", "parts": [{"text": "b", "thought": True}]}}]},
        {"candidates": [{"content": {"role": "model", "parts": [{"text": "Hel"}]}}]},
        {"candidates": [{"content": {"role": "model", "parts": [{"text": "lo"}]}}]},
        {
            "candidates": [
                {
                    "content": {
                        "role": "model",
                        "parts": [
                            {"functionCall": {"name": "get_weather", "args": {"city": "Paris"}}},
                            {"text": "", "thoughtSignature": "c2ln"},
                        ],
                    },
                    "finishReason": "STOP",
                }
            ],
            "usageMetadata": {"promptTokenCount": 3, "candidatesTokenCount": 4},
            "modelVersion": MODEL,
        },
    ]
    for chunk in chunks:
        accumulator.add(_response(**chunk))
    message = accumulator.message()
    assert message["candidates"] == [
        {
            "content": {
                "role": "model",
                "parts": [
                    {"text": "ab", "thought": True},
                    {"text": "Hello"},
                    {"function_call": {"name": "get_weather", "args": {"city": "Paris"}}},
                    {"text": "", "thought_signature": "c2ln"},
                ],
            },
            "finish_reason": "STOP",
        }
    ]
    assert message["usage_metadata"] == {"prompt_token_count": 3, "candidates_token_count": 4}
    assert provider.response_stop_reason(message) == "STOP"
    assert [t.name for t in provider.extract_tool_invocations(message)] == ["get_weather"]


def test_a_stream_is_assembled_only_when_something_reads_it() -> None:
    request: dict[str, Any] = {"model": MODEL, "contents": "hi"}
    assert GoogleProvider().stream_accumulator(object(), request) is None
    offers_tools = {**request, "config": types.GenerateContentConfig(tools=[get_weather])}
    assert GoogleProvider().stream_accumulator(object(), offers_tools) is not None


# ----- tool calls ---------------------------------------------------------


def test_function_calls_are_tool_invocations() -> None:
    response = _response(
        candidates=[
            {
                "content": {
                    "role": "model",
                    "parts": [
                        {"text": "Looking it up."},
                        {
                            "functionCall": {
                                "id": "c1",
                                "name": "get_weather",
                                "args": {"city": "a"},
                            }
                        },
                        {"functionCall": {"name": "get_time", "args": {}}},
                    ],
                },
                "finishReason": "STOP",
            }
        ]
    )
    invocations = GoogleProvider().extract_tool_invocations(response)
    assert [(i.name, i.tool_input, i.tool_id) for i in invocations] == [
        ("get_weather", {"city": "a"}, "c1"),
        ("get_time", {}, None),
    ]


# ----- stored content -----------------------------------------------------


def get_weather(city: str) -> str:
    """The weather in a city."""
    return city


def _sent(request: dict[str, Any], body: dict[str, Any] | None = None) -> SentRequest:
    """What the SDK handed its API client for one call (see SentRequest)."""
    sent = SentRequest()
    sent.keep(("post", "models/m:generateContent", {"_url": {"model": MODEL}, **request}), {})
    if body is not None:
        sent.body = json.dumps(body)
    return sent


# A request body as google-genai 2.x builds it for the Gemini API: the
# REST API's names for most fields, the SDK's own for some (a blob's
# ``mime_type``, a declaration's ``parameters_json_schema``).
WIRE_REQUEST: dict[str, Any] = {
    "contents": [
        {"parts": [{"text": "a plain string"}], "role": "user"},
        {
            "parts": [{"text": "hi", "thoughtSignature": "AP8gc2lnbmF0dXJl"}],
            "role": "model",
        },
        {"parts": [{"inlineData": {"data": "iVBORw==", "mime_type": "image/png"}}], "role": "user"},
    ],
    "systemInstruction": {"parts": [{"text": "Be brief"}], "role": "user"},
    "tools": [
        {"functionDeclarations": [{"name": "get_weather", "parameters_json_schema": {}}]},
        {"googleSearch": {}},
    ],
    "generationConfig": {"temperature": 0.1},
}
WIRE_RESPONSE: dict[str, Any] = {
    "candidates": [
        {
            "content": {"role": "model", "parts": [{"text": "ok", "thoughtSignature": "+/8="}]},
            "finishReason": "STOP",
            "fieldTheSdkDoesNotModel": 1,
        }
    ],
    "usageMetadata": {"promptTokenCount": 3, "candidatesTokenCount": 1},
    "modelVersion": MODEL,
}


def test_content_is_the_request_and_response_as_sent_and_received() -> None:
    provider = GoogleProvider(
        capture_prompts=True, platform="gemini-api", sent=_sent(WIRE_REQUEST, WIRE_RESPONSE)
    )
    # The caller's arguments are not read for content: the request is.
    content = provider.extract_content(
        {"model": MODEL, "contents": "ignored", "config": None}, _response(modelVersion=MODEL)
    )
    assert content is not None
    assert content.provider == "google"
    assert content.messages == []
    assert content.input == WIRE_REQUEST["contents"]
    # The system instruction's parts: the content's system is text or a list.
    assert content.system == [{"text": "Be brief"}]
    assert content.tools == WIRE_REQUEST["tools"]
    # The response body as received, once parsed: fields the SDK does not
    # model and the wire's base64 alphabet included.
    assert content.response == WIRE_RESPONSE


def test_a_request_without_system_or_tools_stores_none_for_them() -> None:
    sent = _sent({"contents": [{"parts": [{"text": "hi"}], "role": "user"}]}, WIRE_RESPONSE)
    content = GoogleProvider(capture_prompts=True, sent=sent).extract_content(
        {"model": MODEL}, _response()
    )
    assert content is not None
    assert (content.system, content.tools) == (None, None)


def test_a_stream_stores_its_chunks_assembled_by_alias() -> None:
    sent = _sent({"contents": [{"parts": [{"text": "hi"}], "role": "user"}]})
    provider = GoogleProvider(capture_prompts=True, sent=sent)
    accumulator = provider.stream_accumulator(object(), {"model": MODEL})
    assert accumulator is not None
    accumulator.add(
        _response(candidates=[{"content": {"role": "model", "parts": [{"text": "He"}]}}])
    )
    accumulator.add(
        _response(
            candidates=[
                {"content": {"role": "model", "parts": [{"text": "llo"}]}, "finishReason": "STOP"}
            ],
            usageMetadata={"promptTokenCount": 3, "candidatesTokenCount": 2},
        )
    )
    content = provider.extract_content({"model": MODEL}, accumulator.message())
    assert content is not None
    assert content.response == {
        "candidates": [
            {"content": {"role": "model", "parts": [{"text": "Hello"}]}, "finishReason": "STOP"}
        ],
        "usageMetadata": {"promptTokenCount": 3, "candidatesTokenCount": 2},
    }


def test_a_call_whose_request_was_not_recorded_stores_no_content(
    caplog: pytest.LogCaptureFixture,
) -> None:
    google._WARNED.clear()
    for sent in (None, SentRequest()):
        content = GoogleProvider(capture_prompts=True, sent=sent).extract_content(
            {"model": MODEL, "contents": "SECRET-CONTENTS"}, _response()
        )
        # Never another shape (the caller's arguments): no content at all.
        assert content is None
    warnings = [r.getMessage() for r in caplog.records if r.levelname == "WARNING"]
    assert len(warnings) == 1
    assert "without its content" in warnings[0]
    assert "SECRET-CONTENTS" not in warnings[0]


def test_the_record_drops_the_sdk_url_keys_and_keeps_the_body() -> None:
    sent = SentRequest()
    request = {"_url": {"model": "m"}, "_query": {"alt": "sse"}, "contents": []}
    sent.keep((), {"request_dict": request})
    assert sent.request == {"contents": []}
    # The client drops the URL keys from its own dict afterwards.
    del request["_url"]
    assert sent.request == {"contents": []}
    nothing = SentRequest()
    nothing.keep(("post", "path"), {})
    assert nothing.request is None


@pytest.mark.parametrize(
    ("request_body", "stored"),
    [
        # The Gemini API's batch: each request's content.
        (
            {
                "requests": [
                    {"content": {"parts": [{"text": "a"}], "role": "user"}, "model": "models/m"},
                    {"content": {"parts": [{"text": "b"}], "role": "user"}, "model": "models/m"},
                ]
            },
            [
                {"parts": [{"text": "a"}], "role": "user"},
                {"parts": [{"text": "b"}], "role": "user"},
            ],
        ),
        # Vertex AI's predict: each instance's content.
        ({"instances": [{"content": "a"}, {"content": "b"}]}, ["a", "b"]),
        # Vertex AI's embedContent: the request's own content.
        ({"content": {"parts": [{"text": "a"}]}}, {"parts": [{"text": "a"}]}),
    ],
    ids=["batch", "predict", "embedContent"],
)
def test_embeddings_content_is_the_contents_as_sent(
    request_body: dict[str, Any], stored: Any
) -> None:
    provider = GoogleProvider(capture_prompts=True, sent=_sent(request_body))
    response = types.EmbedContentResponse(embeddings=[types.ContentEmbedding(values=[0.5, 0.25])])
    content = provider.extract_content(
        {"model": "gemini-embedding-001", "contents": ["ignored"]},
        response,
        event_type=EventType.EMBEDDINGS,
    )
    assert content is not None
    assert (content.input, content.embedding_output) == (stored, [[0.5, 0.25]])


def test_capture_off_stores_nothing() -> None:
    sent = _sent(WIRE_REQUEST, WIRE_RESPONSE)
    assert GoogleProvider(sent=sent).extract_content({"model": MODEL}, None) is None


def test_the_adapter_matches_the_provider_protocol() -> None:
    from flightdeck_sensor.providers.protocol import Provider

    members = {
        name
        for name, value in inspect.getmembers(Provider)
        if not name.startswith("_") and (callable(value) or isinstance(value, property))
    }
    assert members <= set(dir(GoogleProvider))
