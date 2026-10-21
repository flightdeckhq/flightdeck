"""OpenAI interceptor completeness: ``parse()`` on chat completions and
the Responses API, ``with_raw_response`` on the Responses API, ``tool_call``
emission for Responses output items (function, MCP, custom and hosted
tools), prompt-cache usage details, the three parse-time / OAuth
exception classes, and the request id the SDK stamps on parsed objects.

Driven with the real ``openai`` client classes over a respx-mocked
transport, so the shapes under test are the ones the SDK produces, not
hand-built stand-ins. No request leaves the process.
"""

from __future__ import annotations

import asyncio
from typing import Any
from unittest.mock import MagicMock

import httpx
import openai
import pytest
import respx
from openai.types.chat import ChatCompletion, ChatCompletionChunk
from openai.types.responses import Response
from pydantic import BaseModel

import flightdeck_sensor
from flightdeck_sensor.core.errors import ErrorType, classify_exception
from flightdeck_sensor.core.policy import PolicyCache
from flightdeck_sensor.core.session import Session
from flightdeck_sensor.core.types import SensorConfig, TokenUsage
from flightdeck_sensor.interceptor.openai import (
    SensorChat,
    SensorCompletions,
    SensorResponses,
    _SensorRawResponseWrapper,
    patch_openai_classes,
    unpatch_openai_classes,
)
from flightdeck_sensor.providers.openai import OpenAIProvider
from flightdeck_sensor.transport.client import ControlPlaneClient

BASE_URL = "https://api.openai.com/v1"
REQUEST_ID = "req_parse_7f3a"
MESSAGES = [{"role": "user", "content": "Capital of France?"}]


class City(BaseModel):
    city: str


# ----- session + event helpers ------------------------------------------------


def _session(capture_prompts: bool = False) -> Session:
    config = SensorConfig(
        server="http://localhost:9999",
        token="tok",
        agent_flavor="test",
        agent_type="production",
        quiet=True,
        capture_prompts=capture_prompts,
    )
    client = MagicMock(spec=ControlPlaneClient)
    client.post_event.return_value = (None, False)
    # Injected queue: no drain thread, every enqueue is inspectable.
    session = Session(config=config, client=client, event_queue=MagicMock())
    session.policy = PolicyCache(token_limit=None, block_at_pct=100)
    return session


def _events_of(session: Session, event_type: str) -> list[dict[str, Any]]:
    queue = session.event_queue
    assert isinstance(queue, MagicMock)
    return [
        c.args[0] for c in queue.enqueue.call_args_list if c.args[0].get("event_type") == event_type
    ]


def _sync_client() -> openai.OpenAI:
    return openai.OpenAI(api_key="sk-test", max_retries=0)


def _async_client() -> openai.AsyncOpenAI:
    return openai.AsyncOpenAI(api_key="sk-test", max_retries=0)


# ----- wire bodies the real API sends ----------------------------------------


def _chat_body(
    *,
    finish_reason: str = "stop",
    content: str | None = '{"city": "Paris"}',
    cached_tokens: int | None = None,
) -> dict[str, Any]:
    usage: dict[str, Any] = {"prompt_tokens": 40, "completion_tokens": 7, "total_tokens": 47}
    if cached_tokens is not None:
        usage["prompt_tokens_details"] = {"cached_tokens": cached_tokens, "audio_tokens": 0}
        usage["completion_tokens_details"] = {"reasoning_tokens": 3}
    return {
        "id": "chatcmpl_1",
        "object": "chat.completion",
        "created": 1,
        "model": "gpt-4o-mini",
        "choices": [
            {
                "index": 0,
                "finish_reason": finish_reason,
                "message": {"role": "assistant", "content": content},
            }
        ],
        "usage": usage,
    }


def _message_item(text: str = '{"city": "Paris"}') -> dict[str, Any]:
    return {
        "id": "msg_1",
        "type": "message",
        "role": "assistant",
        "status": "completed",
        "content": [{"type": "output_text", "text": text, "annotations": []}],
    }


FUNCTION_CALL_ITEM = {
    "id": "fc_1",
    "type": "function_call",
    "call_id": "call_weather",
    "name": "get_weather",
    "arguments": '{"city": "Paris"}',
    "status": "completed",
}
MCP_CALL_ITEM = {
    "id": "mcp_1",
    "type": "mcp_call",
    "name": "list_issues",
    "server_label": "github",
    "arguments": '{"repo": "flightdeck"}',
    "output": "[]",
    "status": "completed",
}
WEB_SEARCH_ITEM = {
    "id": "ws_1",
    "type": "web_search_call",
    "status": "completed",
    "action": {"type": "search", "query": "eiffel tower height"},
}


def _response_body(
    output: list[dict[str, Any]],
    *,
    cached_tokens: int = 0,
) -> dict[str, Any]:
    return {
        "id": "resp_1",
        "object": "response",
        "created_at": 1.0,
        "model": "gpt-4o-mini",
        "status": "completed",
        "output": output,
        "parallel_tool_calls": True,
        "tool_choice": "auto",
        "tools": [],
        "usage": {
            "input_tokens": 31,
            "output_tokens": 9,
            "total_tokens": 40,
            "input_tokens_details": {"cached_tokens": cached_tokens},
            "output_tokens_details": {"reasoning_tokens": 2},
        },
    }


def _mock_route(
    router: respx.MockRouter,
    path: str,
    body: dict[str, Any],
    headers: dict[str, str] | None = None,
) -> None:
    router.post(path).mock(
        return_value=httpx.Response(
            200, json=body, headers={"x-request-id": REQUEST_ID, **(headers or {})}
        )
    )


# ----- provider: usage details ------------------------------------------------


def test_chat_usage_reads_cached_tokens_into_cache_read() -> None:
    completion = ChatCompletion.model_validate(_chat_body(cached_tokens=32))
    usage = OpenAIProvider().extract_usage(completion)
    assert usage == TokenUsage(input_tokens=40, output_tokens=7, cache_read_tokens=32)
    # OpenAI reports no cache-write count; reasoning tokens are part of
    # the output count already.
    assert usage.cache_creation_tokens == 0
    assert usage.total == 47


def test_responses_usage_reads_cached_tokens_into_cache_read() -> None:
    response = Response.model_validate(_response_body([_message_item()], cached_tokens=24))
    usage = OpenAIProvider().extract_usage(response)
    assert usage == TokenUsage(input_tokens=31, output_tokens=9, cache_read_tokens=24)


def test_usage_without_details_leaves_cache_read_zero() -> None:
    completion = ChatCompletion.model_validate(_chat_body())
    assert completion.usage is not None and completion.usage.prompt_tokens_details is None
    usage = OpenAIProvider().extract_usage(completion)
    assert usage == TokenUsage(input_tokens=40, output_tokens=7, cache_read_tokens=0)


def test_stream_usage_chunk_carries_cached_tokens() -> None:
    chunk = ChatCompletionChunk.model_validate(
        {
            "id": "chatcmpl_1",
            "object": "chat.completion.chunk",
            "created": 1,
            "model": "gpt-4o-mini",
            "choices": [],
            "usage": {
                "prompt_tokens": 1100,
                "completion_tokens": 5,
                "total_tokens": 1105,
                "prompt_tokens_details": {"cached_tokens": 1024},
            },
        }
    )
    usage = OpenAIProvider().usage_from_stream_chunk(chunk)
    assert usage == TokenUsage(input_tokens=1100, output_tokens=5, cache_read_tokens=1024)


# ----- provider: request id on parsed objects ---------------------------------


def test_request_id_read_from_parsed_object() -> None:
    completion = ChatCompletion.model_validate(_chat_body())
    openai._models.add_request_id(completion, REQUEST_ID)
    assert OpenAIProvider().extract_response_metadata(completion) == {"request_id": REQUEST_ID}


def test_no_request_id_when_parsed_object_was_not_stamped() -> None:
    completion = ChatCompletion.model_validate(_chat_body())
    assert OpenAIProvider().extract_response_metadata(completion) is None


# ----- provider: Responses output items -> tool invocations -------------------


@pytest.mark.parametrize(
    ("item", "name", "tool_input", "tool_id"),
    [
        (FUNCTION_CALL_ITEM, "get_weather", {"city": "Paris"}, "call_weather"),
        (MCP_CALL_ITEM, "list_issues", {"repo": "flightdeck"}, "mcp_1"),
        (
            {
                "id": "ctc_1",
                "type": "custom_tool_call",
                "call_id": "call_sql",
                "name": "run_sql",
                "input": "SELECT 1",
            },
            "run_sql",
            {"input": "SELECT 1"},
            "call_sql",
        ),
        (
            WEB_SEARCH_ITEM,
            "web_search_call",
            {"type": "search", "query": "eiffel tower height"},
            "ws_1",
        ),
        (
            {
                "id": "fs_1",
                "type": "file_search_call",
                "status": "completed",
                "queries": ["q1", "q2"],
                "results": [{"text": "a large chunk"}],
            },
            "file_search_call",
            {"queries": ["q1", "q2"]},
            "fs_1",
        ),
        (
            {
                "id": "ci_1",
                "type": "code_interpreter_call",
                "status": "completed",
                "container_id": "cntr_1",
                "code": "print(1)",
                "outputs": [{"type": "logs", "logs": "1"}],
            },
            "code_interpreter_call",
            {"code": "print(1)"},
            "ci_1",
        ),
        (
            {
                "id": "ig_1",
                "type": "image_generation_call",
                "status": "completed",
                "result": "iVBORw0KGgo=",
            },
            "image_generation_call",
            {},
            "ig_1",
        ),
        (
            {
                "id": "cu_1",
                "type": "computer_call",
                "call_id": "call_cu",
                "status": "completed",
                "pending_safety_checks": [],
                "action": {"type": "click", "button": "left", "x": 1, "y": 2},
            },
            "computer_call",
            {"type": "click", "button": "left", "x": 1, "y": 2},
            "cu_1",
        ),
    ],
    ids=[
        "function_call",
        "mcp_call",
        "custom_tool_call",
        "web_search_call",
        "file_search_call",
        "code_interpreter_call",
        "image_generation_call",
        "computer_call",
    ],
)
def test_responses_output_item_becomes_tool_invocation(
    item: dict[str, Any], name: str, tool_input: dict[str, Any], tool_id: str
) -> None:
    response = Response.model_validate(_response_body([_message_item(), item]))
    (inv,) = OpenAIProvider().extract_tool_invocations(response)
    assert (inv.name, inv.tool_input, inv.tool_id) == (name, tool_input, tool_id)


def test_responses_items_that_are_not_calls_emit_no_invocation() -> None:
    response = Response.model_validate(
        _response_body(
            [
                _message_item(),
                {"id": "rs_1", "type": "reasoning", "summary": []},
                {"id": "mcpl_1", "type": "mcp_list_tools", "server_label": "github", "tools": []},
                {
                    "id": "mcpr_1",
                    "type": "mcp_approval_request",
                    "name": "delete_repo",
                    "server_label": "github",
                    "arguments": "{}",
                },
                {
                    "id": "mcpa_1",
                    "type": "mcp_approval_response",
                    "approval_request_id": "mcpr_1",
                    "approve": True,
                },
            ]
        )
    )
    assert OpenAIProvider().extract_tool_invocations(response) == []


def test_responses_output_with_undecodable_arguments_keeps_the_call() -> None:
    item = {**FUNCTION_CALL_ITEM, "arguments": "not json"}
    response = Response.model_validate(_response_body([item]))
    (inv,) = OpenAIProvider().extract_tool_invocations(response)
    assert (inv.name, inv.tool_input) == ("get_weather", {})


# ----- provider: pre-call estimate reads the Responses request -----------------


def test_estimate_counts_responses_input_and_instructions() -> None:
    provider = OpenAIProvider()
    empty, _ = provider.estimate_tokens({"model": "gpt-4o-mini"})
    as_string, _ = provider.estimate_tokens(
        {"model": "gpt-4o-mini", "input": "word " * 200, "instructions": "Be terse."}
    )
    as_items, _ = provider.estimate_tokens(
        {
            "model": "gpt-4o-mini",
            "input": [{"role": "user", "content": "word " * 200}, "plain string item"],
        }
    )
    assert as_string > empty
    assert as_items > empty
    chat, _ = provider.estimate_tokens(
        {"model": "gpt-4o-mini", "messages": [{"role": "user", "content": "word " * 200}]}
    )
    # The same text estimates the same whichever API carries it.
    assert abs(as_items - chat) <= chat


# ----- classifier: the three exception classes --------------------------------


def _http_401() -> httpx.Response:
    return httpx.Response(
        401,
        headers={"x-request-id": REQUEST_ID},
        request=httpx.Request("POST", f"{BASE_URL}/chat/completions"),
    )


def test_oauth_error_classifies_as_authentication() -> None:
    exc = openai.OAuthError(
        response=_http_401(),
        body={"error": "invalid_token", "error_description": "token expired"},
    )
    classification = classify_exception(exc)
    assert classification.error_type is ErrorType.AUTHENTICATION
    assert classification.provider == "openai"
    assert classification.http_status == 401
    assert classification.request_id == REQUEST_ID
    assert classification.is_retryable is False
    assert "partial_tokens_input" not in classification.to_payload()


def test_length_finish_reason_classifies_as_context_overflow_with_partial_tokens() -> None:
    completion = ChatCompletion.model_validate(_chat_body(finish_reason="length"))
    exc = openai.LengthFinishReasonError(completion=completion)
    classification = classify_exception(exc)
    assert classification.error_type is ErrorType.CONTEXT_OVERFLOW
    assert classification.provider == "openai"
    assert classification.is_retryable is False
    payload = classification.to_payload()
    assert (payload["partial_tokens_input"], payload["partial_tokens_output"]) == (40, 7)
    # Capture off: the exception string (which quotes the usage) stays out.
    assert payload["error_message"] == "LengthFinishReasonError"


def test_content_filter_finish_reason_classifies_as_content_filter() -> None:
    classification = classify_exception(openai.ContentFilterFinishReasonError())
    assert classification.error_type is ErrorType.CONTENT_FILTER
    assert classification.provider == "openai"
    assert classification.is_retryable is False
    assert "partial_tokens_input" not in classification.to_payload()


# ----- interceptor: chat.completions.parse ------------------------------------


@respx.mock(base_url=BASE_URL)
def test_chat_parse_sync_is_metered_and_returns_the_parsed_completion(
    respx_mock: respx.MockRouter,
) -> None:
    _mock_route(respx_mock, "/chat/completions", _chat_body(cached_tokens=16))
    session = _session()
    completions = SensorCompletions(_sync_client().chat.completions, session, OpenAIProvider())

    result = completions.parse(model="gpt-4o-mini", messages=MESSAGES, response_format=City)

    assert result.choices[0].message.parsed == City(city="Paris")
    (pc,) = _events_of(session, "post_call")
    assert (pc["tokens_input"], pc["tokens_output"], pc["tokens_cache_read"]) == (40, 7, 16)
    assert pc["provider_metadata"] == {"request_id": REQUEST_ID}
    assert pc["model"] == "gpt-4o-mini"
    assert session.tokens_used == 47


@respx.mock(base_url=BASE_URL)
def test_chat_parse_async_is_metered(respx_mock: respx.MockRouter) -> None:
    _mock_route(respx_mock, "/chat/completions", _chat_body())
    session = _session()
    completions = SensorCompletions(
        _async_client().chat.completions, session, OpenAIProvider(), is_async=True
    )

    async def _run() -> Any:
        return await completions.parse(model="gpt-4o-mini", messages=MESSAGES, response_format=City)

    result = asyncio.run(_run())
    assert result.choices[0].message.parsed == City(city="Paris")
    (pc,) = _events_of(session, "post_call")
    assert (pc["tokens_input"], pc["tokens_output"]) == (40, 7)
    assert pc["provider_metadata"] == {"request_id": REQUEST_ID}


@respx.mock(base_url=BASE_URL)
def test_chat_parse_length_failure_emits_llm_error_and_counts_the_tokens(
    respx_mock: respx.MockRouter,
) -> None:
    _mock_route(respx_mock, "/chat/completions", _chat_body(finish_reason="length"))
    session = _session()
    completions = SensorCompletions(_sync_client().chat.completions, session, OpenAIProvider())

    with pytest.raises(openai.LengthFinishReasonError):
        completions.parse(model="gpt-4o-mini", messages=MESSAGES, response_format=City)

    assert _events_of(session, "post_call") == []
    (err,) = _events_of(session, "llm_error")
    assert err["error"]["error_type"] == "context_overflow"
    assert err["error"]["provider"] == "openai"
    assert (err["error"]["partial_tokens_input"], err["error"]["partial_tokens_output"]) == (40, 7)
    assert err["terminal"] is True
    # The provider billed the call: it counts against the session budget.
    assert session.tokens_used == 47


@respx.mock(base_url=BASE_URL)
def test_async_chat_parse_length_failure_counts_the_tokens(respx_mock: respx.MockRouter) -> None:
    _mock_route(respx_mock, "/chat/completions", _chat_body(finish_reason="length"))
    session = _session()
    completions = SensorCompletions(
        _async_client().chat.completions, session, OpenAIProvider(), is_async=True
    )

    async def _run() -> None:
        await completions.parse(model="gpt-4o-mini", messages=MESSAGES, response_format=City)

    with pytest.raises(openai.LengthFinishReasonError):
        asyncio.run(_run())
    (err,) = _events_of(session, "llm_error")
    assert err["error"]["error_type"] == "context_overflow"
    assert session.tokens_used == 47


@respx.mock(base_url=BASE_URL)
def test_chat_parse_content_filter_failure_emits_llm_error(respx_mock: respx.MockRouter) -> None:
    _mock_route(respx_mock, "/chat/completions", _chat_body(finish_reason="content_filter"))
    session = _session()
    completions = SensorCompletions(_sync_client().chat.completions, session, OpenAIProvider())

    with pytest.raises(openai.ContentFilterFinishReasonError):
        completions.parse(model="gpt-4o-mini", messages=MESSAGES, response_format=City)

    (err,) = _events_of(session, "llm_error")
    assert err["error"]["error_type"] == "content_filter"
    assert "partial_tokens_input" not in err["error"]
    assert session.tokens_used == 0


@respx.mock(base_url=BASE_URL)
def test_chat_with_raw_response_parse_is_metered(respx_mock: respx.MockRouter) -> None:
    _mock_route(
        respx_mock,
        "/chat/completions",
        _chat_body(),
        headers={"x-ratelimit-remaining-tokens": "1999"},
    )
    session = _session()
    completions = SensorCompletions(_sync_client().chat.completions, session, OpenAIProvider())

    raw = completions.with_raw_response.parse(
        model="gpt-4o-mini", messages=MESSAGES, response_format=City
    )

    assert raw.headers["x-request-id"] == REQUEST_ID
    assert raw.parse().choices[0].message.parsed == City(city="Paris")
    (pc,) = _events_of(session, "post_call")
    assert (pc["tokens_input"], pc["tokens_output"]) == (40, 7)
    assert pc["provider_metadata"]["request_id"] == REQUEST_ID
    assert pc["provider_metadata"]["ratelimit_remaining_tokens"] == 1999


# ----- interceptor: responses.parse -------------------------------------------


@respx.mock(base_url=BASE_URL)
def test_responses_parse_sync_is_metered_and_returns_the_parsed_response(
    respx_mock: respx.MockRouter,
) -> None:
    _mock_route(respx_mock, "/responses", _response_body([_message_item()], cached_tokens=8))
    session = _session()
    responses = SensorResponses(_sync_client().responses, session, OpenAIProvider())

    result = responses.parse(model="gpt-4o-mini", input="Capital of France?", text_format=City)

    assert result.output_parsed == City(city="Paris")
    (pc,) = _events_of(session, "post_call")
    assert (pc["tokens_input"], pc["tokens_output"], pc["tokens_cache_read"]) == (31, 9, 8)
    assert pc["provider_metadata"] == {"request_id": REQUEST_ID}
    assert _events_of(session, "tool_call") == []


@respx.mock(base_url=BASE_URL)
def test_responses_parse_async_is_metered(respx_mock: respx.MockRouter) -> None:
    _mock_route(respx_mock, "/responses", _response_body([_message_item()]))
    session = _session()
    responses = SensorResponses(_async_client().responses, session, OpenAIProvider(), is_async=True)

    async def _run() -> Any:
        return await responses.parse(model="gpt-4o-mini", input="hi", text_format=City)

    result = asyncio.run(_run())
    assert result.output_parsed == City(city="Paris")
    (pc,) = _events_of(session, "post_call")
    assert (pc["tokens_input"], pc["tokens_output"]) == (31, 9)


# ----- interceptor: responses.with_raw_response -------------------------------


@respx.mock(base_url=BASE_URL)
def test_responses_with_raw_response_create_is_metered(respx_mock: respx.MockRouter) -> None:
    _mock_route(
        respx_mock,
        "/responses",
        _response_body([_message_item("hello")]),
        headers={"openai-processing-ms": "123"},
    )
    session = _session()
    responses = SensorResponses(_sync_client().responses, session, OpenAIProvider())

    raw = responses.with_raw_response.create(model="gpt-4o-mini", input="hi")

    assert raw.headers["x-request-id"] == REQUEST_ID
    assert raw.parse().output_text == "hello"
    (pc,) = _events_of(session, "post_call")
    assert (pc["tokens_input"], pc["tokens_output"]) == (31, 9)
    assert pc["provider_metadata"] == {"request_id": REQUEST_ID, "processing_ms": 123}
    assert pc["model"] == "gpt-4o-mini"


@respx.mock(base_url=BASE_URL)
def test_responses_with_raw_response_create_async_is_metered(
    respx_mock: respx.MockRouter,
) -> None:
    _mock_route(respx_mock, "/responses", _response_body([_message_item("hello")]))
    session = _session()
    responses = SensorResponses(_async_client().responses, session, OpenAIProvider(), is_async=True)

    async def _run() -> Any:
        return await responses.with_raw_response.create(model="gpt-4o-mini", input="hi")

    raw = asyncio.run(_run())
    assert raw.parse().output_text == "hello"
    (pc,) = _events_of(session, "post_call")
    assert (pc["tokens_input"], pc["tokens_output"]) == (31, 9)


@respx.mock(base_url=BASE_URL)
def test_responses_with_raw_response_parse_is_metered(respx_mock: respx.MockRouter) -> None:
    _mock_route(respx_mock, "/responses", _response_body([_message_item()]))
    session = _session()
    responses = SensorResponses(_sync_client().responses, session, OpenAIProvider())

    raw = responses.with_raw_response.parse(model="gpt-4o-mini", input="hi", text_format=City)

    assert raw.parse().output_parsed == City(city="Paris")
    (pc,) = _events_of(session, "post_call")
    assert (pc["tokens_input"], pc["tokens_output"]) == (31, 9)


def test_responses_raw_wrapper_passes_other_methods_through() -> None:
    session = _session()
    responses = SensorResponses(_sync_client().responses, session, OpenAIProvider())
    raw = responses.with_raw_response
    assert isinstance(raw, _SensorRawResponseWrapper)
    assert callable(raw.retrieve)
    assert callable(raw.cancel)


# ----- interceptor: Responses tool_call events --------------------------------


@respx.mock(base_url=BASE_URL)
def test_responses_create_emits_one_tool_call_per_call_item(respx_mock: respx.MockRouter) -> None:
    _mock_route(
        respx_mock,
        "/responses",
        _response_body([FUNCTION_CALL_ITEM, MCP_CALL_ITEM, WEB_SEARCH_ITEM, _message_item()]),
    )
    session = _session()
    responses = SensorResponses(_sync_client().responses, session, OpenAIProvider())

    responses.create(model="gpt-4o-mini", input="weather?")

    (pc,) = _events_of(session, "post_call")
    tool_calls = _events_of(session, "tool_call")
    assert [t["tool_name"] for t in tool_calls] == ["get_weather", "list_issues", "web_search_call"]
    for t in tool_calls:
        assert t["model"] == "gpt-4o-mini"
        assert t["originating_event_id"] == pc["id"]
        # Capture off: no tool input leaves the process.
        assert t["has_content"] is False
        assert t["content"] is None


@respx.mock(base_url=BASE_URL)
def test_responses_tool_call_carries_tool_input_when_capture_is_on(
    respx_mock: respx.MockRouter,
) -> None:
    _mock_route(respx_mock, "/responses", _response_body([FUNCTION_CALL_ITEM, WEB_SEARCH_ITEM]))
    session = _session(capture_prompts=True)
    responses = SensorResponses(_sync_client().responses, session, OpenAIProvider())

    responses.create(model="gpt-4o-mini", input="weather?")

    function_call, web_search = _events_of(session, "tool_call")
    assert function_call["has_content"] is True
    assert function_call["content"]["tool_input"] == {"city": "Paris"}
    assert function_call["content"]["tool_output"] is None
    assert function_call["content"]["provider"] == "llm"
    assert web_search["content"]["tool_input"]["query"] == "eiffel tower height"


@respx.mock(base_url=BASE_URL)
def test_responses_parse_emits_tool_call_for_parsed_function_call(
    respx_mock: respx.MockRouter,
) -> None:
    _mock_route(respx_mock, "/responses", _response_body([FUNCTION_CALL_ITEM]))
    session = _session()
    responses = SensorResponses(_sync_client().responses, session, OpenAIProvider())

    result = responses.parse(
        model="gpt-4o-mini",
        input="weather?",
        tools=[
            {
                "type": "function",
                "name": "get_weather",
                "parameters": {"type": "object", "properties": {"city": {"type": "string"}}},
                "strict": False,
            }
        ],
    )

    assert result.output[0].type == "function_call"
    (tc,) = _events_of(session, "tool_call")
    assert tc["tool_name"] == "get_weather"


# ----- class-level patch covers the new surfaces ------------------------------


@respx.mock(base_url=BASE_URL)
def test_patched_client_routes_parse_and_raw_response_through_the_sensor(
    respx_mock: respx.MockRouter, monkeypatch: pytest.MonkeyPatch
) -> None:
    _mock_route(respx_mock, "/chat/completions", _chat_body())
    _mock_route(respx_mock, "/responses", _response_body([FUNCTION_CALL_ITEM]))
    session = _session()
    monkeypatch.setattr(flightdeck_sensor, "_session", session)
    patch_openai_classes(quiet=True)
    try:
        client = _sync_client()
        assert isinstance(client.chat, SensorChat)
        assert isinstance(client.responses, SensorResponses)
        assert isinstance(client.responses.with_raw_response, _SensorRawResponseWrapper)
        assert isinstance(client.chat.completions.with_raw_response, _SensorRawResponseWrapper)

        parsed = client.chat.completions.parse(
            model="gpt-4o-mini", messages=MESSAGES, response_format=City
        )
        raw = client.responses.with_raw_response.create(model="gpt-4o-mini", input="weather?")
    finally:
        unpatch_openai_classes()

    assert parsed.choices[0].message.parsed == City(city="Paris")
    assert raw.parse().output[0].type == "function_call"
    chat_pc, responses_pc = _events_of(session, "post_call")
    assert (chat_pc["tokens_input"], chat_pc["tokens_output"]) == (40, 7)
    assert (responses_pc["tokens_input"], responses_pc["tokens_output"]) == (31, 9)
    (tc,) = _events_of(session, "tool_call")
    assert tc["tool_name"] == "get_weather"
    assert session.tokens_used == 47 + 40
