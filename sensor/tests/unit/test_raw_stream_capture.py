"""Content capture, tool calls and metering on every streaming path of the
OpenAI and Anthropic SDKs.

Raw event streams (``create(stream=True)``) are assembled with the SDK's
own accumulator, so the post_call stores the streamed response and a
streamed tool call becomes a ``tool_call`` event; OpenAI's ``.stream()``
helpers send their request through the stream guard; the
``with_raw_response`` / ``with_streaming_response`` views meter a body the
caller reads later; a Responses ``mcp_call`` names its MCP server.

Driven with the real ``anthropic`` / ``openai`` client classes over
respx-served server-sent events shaped as the APIs send them, so the SDK
parses every event the sensor sees. No request leaves the process.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any
from unittest.mock import MagicMock

import anthropic
import httpx
import openai
import pytest
import respx
from openai.lib.streaming.chat import ChatCompletionStream
from openai.lib.streaming.responses import ResponseStream

import flightdeck_sensor
from flightdeck_sensor.core.policy import PolicyCache
from flightdeck_sensor.core.session import Session
from flightdeck_sensor.core.types import SensorConfig
from flightdeck_sensor.interceptor import base, raw_views
from flightdeck_sensor.interceptor.anthropic import SensorMessages
from flightdeck_sensor.interceptor.openai import (
    SensorCompletions,
    SensorEmbeddings,
    SensorOpenAI,
    SensorResponses,
    patch_openai_classes,
    unpatch_openai_classes,
)
from flightdeck_sensor.providers.anthropic import AnthropicProvider
from flightdeck_sensor.providers.openai import OpenAIProvider
from flightdeck_sensor.transport.client import ControlPlaneClient

OPENAI_URL = "https://api.openai.com/v1"
ANTHROPIC_URL = "https://api.anthropic.com"
PROMPT = "SECRET-PROMPT-TEXT-91c2"
INSTRUCTIONS = "SECRET-INSTRUCTIONS-5e0d"
TOOL_MARKER = "SECRET-CITY-77ab"
MESSAGES = [{"role": "user", "content": PROMPT}]
WEATHER_TOOL = {
    "type": "function",
    "function": {
        "name": "get_weather",
        "parameters": {
            "type": "object",
            "properties": {"city": {"type": "string"}},
            "required": ["city"],
            "additionalProperties": False,
        },
        "strict": True,
    },
}
RESPONSES_WEATHER_TOOL = {
    "type": "function",
    "name": "get_weather",
    "parameters": WEATHER_TOOL["function"]["parameters"],  # type: ignore[index]
    "strict": True,
}
ANTHROPIC_TOOL = {
    "name": "get_weather",
    "description": "Weather for a city",
    "input_schema": {"type": "object", "properties": {"city": {"type": "string"}}},
}


# ----- session + events ------------------------------------------------------


def _session(capture: bool) -> Session:
    config = SensorConfig(
        server="http://localhost:9999",
        token="tok",
        agent_flavor="test",
        agent_type="production",
        quiet=True,
        capture_prompts=capture,
    )
    client = MagicMock(spec=ControlPlaneClient)
    client.post_event.return_value = (None, False)
    session = Session(config=config, client=client, event_queue=MagicMock())
    session.policy = PolicyCache(token_limit=None, block_at_pct=100)
    return session


def _all_events(session: Session) -> list[dict[str, Any]]:
    queue = session.event_queue
    assert isinstance(queue, MagicMock)
    return [c.args[0] for c in queue.enqueue.call_args_list]


def _events_of(session: Session, event_type: str) -> list[dict[str, Any]]:
    return [e for e in _all_events(session) if e.get("event_type") == event_type]


def _assert_nothing_captured(session: Session) -> None:
    """Capture off: no event carries content, and no prompt, instruction
    or tool-input text appears anywhere in any payload."""
    events = _all_events(session)
    assert events
    for event in events:
        assert not event.get("has_content")
        assert event.get("content") is None
    wire = json.dumps(events, default=str)
    for secret in (PROMPT, INSTRUCTIONS, TOOL_MARKER):
        assert secret not in wire


def _sse(frames: list[tuple[str | None, dict[str, Any]]], *, done: bool = False) -> httpx.Response:
    body = ""
    for name, data in frames:
        if name is not None:
            body += f"event: {name}\n"
        body += f"data: {json.dumps(data)}\n\n"
    if done:
        body += "data: [DONE]\n\n"
    return httpx.Response(
        200,
        headers={"content-type": "text/event-stream", "x-request-id": "req_stream_1"},
        content=body.encode(),
    )


def _run(coro: Any) -> Any:
    return asyncio.run(coro)


# ----- Anthropic wire events ---------------------------------------------------


def _anthropic_frames(*, tool: bool = True, fail_after: int | None = None) -> list[Any]:
    frames: list[tuple[str | None, dict[str, Any]]] = [
        (
            "message_start",
            {
                "type": "message_start",
                "message": {
                    "id": "msg_1",
                    "type": "message",
                    "role": "assistant",
                    "model": "claude-haiku-4-5",
                    "content": [],
                    "stop_reason": None,
                    "stop_sequence": None,
                    "usage": {"input_tokens": 11, "output_tokens": 1},
                },
            },
        ),
        (
            "content_block_start",
            {
                "type": "content_block_start",
                "index": 0,
                "content_block": {"type": "text", "text": ""},
            },
        ),
        (
            "content_block_delta",
            {
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "text_delta", "text": "Hello"},
            },
        ),
        (
            "content_block_delta",
            {
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "text_delta", "text": " there"},
            },
        ),
        ("content_block_stop", {"type": "content_block_stop", "index": 0}),
    ]
    if tool:
        frames += [
            (
                "content_block_start",
                {
                    "type": "content_block_start",
                    "index": 1,
                    "content_block": {
                        "type": "tool_use",
                        "id": "toolu_1",
                        "name": "get_weather",
                        "input": {},
                    },
                },
            ),
            (
                "content_block_delta",
                {
                    "type": "content_block_delta",
                    "index": 1,
                    "delta": {"type": "input_json_delta", "partial_json": '{"city": "'},
                },
            ),
            (
                "content_block_delta",
                {
                    "type": "content_block_delta",
                    "index": 1,
                    "delta": {"type": "input_json_delta", "partial_json": TOOL_MARKER + '"}'},
                },
            ),
            ("content_block_stop", {"type": "content_block_stop", "index": 1}),
        ]
    frames += [
        (
            "message_delta",
            {
                "type": "message_delta",
                "delta": {"stop_reason": "tool_use" if tool else "end_turn", "stop_sequence": None},
                "usage": {"output_tokens": 20},
            },
        ),
        ("message_stop", {"type": "message_stop"}),
    ]
    if fail_after is not None:
        frames = frames[:fail_after] + [
            (
                "error",
                {"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}},
            )
        ]
    return frames


def _anthropic_messages(capture: bool, session: Session, *, is_async: bool = False) -> Any:
    client: Any = (
        anthropic.AsyncAnthropic(api_key="sk-test", max_retries=0)
        if is_async
        else anthropic.Anthropic(api_key="sk-test", max_retries=0)
    )
    return SensorMessages(
        client.messages, session, AnthropicProvider(capture_prompts=capture), is_async=is_async
    )


_ANTHROPIC_KW: dict[str, Any] = {
    "model": "claude-haiku-4-5",
    "max_tokens": 64,
    "messages": MESSAGES,
    "tools": [ANTHROPIC_TOOL],
}


# ----- OpenAI wire events ------------------------------------------------------


def _chunk(delta: dict[str, Any] | None, finish: str | None = None, **extra: Any) -> dict[str, Any]:
    choices = [] if delta is None else [{"index": 0, "delta": delta, "finish_reason": finish}]
    return {
        "id": "chatcmpl_1",
        "object": "chat.completion.chunk",
        "created": 1,
        "model": "gpt-4o-mini",
        "choices": choices,
        **extra,
    }


def _chat_frames(*, tool: bool = True) -> list[Any]:
    chunks = [
        _chunk({"role": "assistant", "content": "Hi"}),
        _chunk({"content": " there"}),
    ]
    if tool:
        chunks += [
            _chunk(
                {
                    "tool_calls": [
                        {
                            "index": 0,
                            "id": "call_1",
                            "type": "function",
                            "function": {"name": "get_weather", "arguments": ""},
                        }
                    ]
                }
            ),
            _chunk(
                {
                    "tool_calls": [
                        {"index": 0, "function": {"arguments": '{"city": "' + TOOL_MARKER + '"}'}}
                    ]
                }
            ),
        ]
    chunks += [
        _chunk({}, "tool_calls" if tool else "stop"),
        _chunk(None, usage={"prompt_tokens": 9, "completion_tokens": 4, "total_tokens": 13}),
    ]
    return [(None, c) for c in chunks]


def _response_obj(status: str, output: list[Any], usage: bool) -> dict[str, Any]:
    obj: dict[str, Any] = {
        "id": "resp_1",
        "object": "response",
        "created_at": 1.0,
        "model": "gpt-4o-mini",
        "status": status,
        "output": output,
        "parallel_tool_calls": True,
        "tool_choice": "auto",
        "tools": [],
    }
    if usage:
        obj["usage"] = {
            "input_tokens": 7,
            "output_tokens": 3,
            "total_tokens": 10,
            "input_tokens_details": {"cached_tokens": 0, "cache_write_tokens": 0},
            "output_tokens_details": {"reasoning_tokens": 0},
        }
    return obj


MESSAGE_ITEM = {
    "id": "msg_1",
    "type": "message",
    "role": "assistant",
    "status": "completed",
    "content": [{"type": "output_text", "text": "Hi there", "annotations": []}],
}
FUNCTION_ITEM = {
    "id": "fc_1",
    "type": "function_call",
    "call_id": "call_1",
    "name": "get_weather",
    "arguments": '{"city": "' + TOOL_MARKER + '"}',
    "status": "completed",
}
MCP_ITEM = {
    "id": "mcp_1",
    "type": "mcp_call",
    "name": "list_issues",
    "server_label": "github",
    "arguments": '{"repo": "' + TOOL_MARKER + '"}',
    "output": "[]",
    "status": "completed",
}


def _responses_frames() -> list[Any]:
    seq = iter(range(100))

    def ev(kind: str, **fields: Any) -> tuple[str, dict[str, Any]]:
        return (kind, {"type": kind, "sequence_number": next(seq), **fields})

    return [
        ev("response.created", response=_response_obj("in_progress", [], usage=False)),
        ev(
            "response.output_item.added",
            output_index=0,
            item={**MESSAGE_ITEM, "status": "in_progress", "content": []},
        ),
        ev(
            "response.content_part.added",
            item_id="msg_1",
            output_index=0,
            content_index=0,
            part={"type": "output_text", "text": "", "annotations": []},
        ),
        ev(
            "response.output_text.delta",
            item_id="msg_1",
            output_index=0,
            content_index=0,
            delta="Hi there",
            logprobs=[],
        ),
        ev(
            "response.output_item.added",
            output_index=1,
            item={**FUNCTION_ITEM, "arguments": "", "status": "in_progress"},
        ),
        ev(
            "response.function_call_arguments.delta",
            item_id="fc_1",
            output_index=1,
            delta=FUNCTION_ITEM["arguments"],
        ),
        ev("response.output_item.added", output_index=2, item=MCP_ITEM),
        ev(
            "response.completed",
            response=_response_obj(
                "completed", [MESSAGE_ITEM, FUNCTION_ITEM, MCP_ITEM], usage=True
            ),
        ),
    ]


_RESPONSES_KW: dict[str, Any] = {
    "model": "gpt-4o-mini",
    "instructions": INSTRUCTIONS,
    "input": PROMPT,
    "tools": [RESPONSES_WEATHER_TOOL],
}


def _openai_client(is_async: bool) -> Any:
    if is_async:
        return openai.AsyncOpenAI(api_key="sk-test", max_retries=0)
    return openai.OpenAI(api_key="sk-test", max_retries=0)


def _completions(session: Session, capture: bool, *, is_async: bool = False) -> SensorCompletions:
    return SensorCompletions(
        _openai_client(is_async).chat.completions,
        session,
        OpenAIProvider(capture_prompts=capture, platform="openai"),
        is_async=is_async,
    )


def _responses(session: Session, capture: bool, *, is_async: bool = False) -> SensorResponses:
    return SensorResponses(
        _openai_client(is_async).responses,
        session,
        OpenAIProvider(capture_prompts=capture, platform="openai"),
        is_async=is_async,
    )


# ----- Anthropic raw stream --------------------------------------------------


@pytest.mark.parametrize("is_async", [False, True])
@pytest.mark.parametrize("capture", [True, False])
def test_anthropic_raw_stream_stores_the_assembled_message_and_emits_tool_calls(
    capture: bool, is_async: bool
) -> None:
    session = _session(capture)
    messages = _anthropic_messages(capture, session, is_async=is_async)
    with respx.mock(base_url=ANTHROPIC_URL) as router:
        router.post("/v1/messages").mock(return_value=_sse(_anthropic_frames()))
        if is_async:

            async def _read() -> list[str]:
                stream = await messages.create(stream=True, **_ANTHROPIC_KW)
                return [event.type async for event in stream]

            types_seen = _run(_read())
        else:
            types_seen = [e.type for e in messages.create(stream=True, **_ANTHROPIC_KW)]

    assert types_seen[0] == "message_start" and types_seen[-1] == "message_stop"
    (post_call,) = _events_of(session, "post_call")
    assert (post_call["tokens_input"], post_call["tokens_output"]) == (11, 20)
    assert post_call["streaming"]["final_outcome"] == "completed"
    assert post_call["model"] == "claude-haiku-4-5"
    (tool_call,) = _events_of(session, "tool_call")
    assert tool_call["tool_name"] == "get_weather"
    assert "server_name" not in tool_call
    if not capture:
        _assert_nothing_captured(session)
        return
    response = post_call["content"]["response"]
    assert response["content"][0]["text"] == "Hello there"
    assert response["content"][1]["type"] == "tool_use"
    assert response["content"][1]["input"] == {"city": TOOL_MARKER}
    assert response["stop_reason"] == "tool_use"
    assert post_call["content"]["messages"] == MESSAGES
    assert tool_call["content"]["tool_input"] == {"city": TOOL_MARKER}


def test_anthropic_raw_stream_yields_the_same_events_as_the_unguarded_sdk() -> None:
    session = _session(True)
    with respx.mock(base_url=ANTHROPIC_URL) as router:
        router.post("/v1/messages").mock(return_value=_sse(_anthropic_frames()))
        plain = anthropic.Anthropic(api_key="sk-test", max_retries=0).messages.create(
            stream=True, **_ANTHROPIC_KW
        )
        expected = [e.model_dump() for e in plain]
        guarded = _anthropic_messages(True, session).create(stream=True, **_ANTHROPIC_KW)
        with guarded as stream:
            seen = [e.model_dump() for e in stream]
    assert seen == expected


@pytest.mark.parametrize("capture", [True, False])
def test_anthropic_raw_stream_left_early_stores_the_partial_message_and_no_tool_call(
    capture: bool,
) -> None:
    session = _session(capture)
    with respx.mock(base_url=ANTHROPIC_URL) as router:
        router.post("/v1/messages").mock(return_value=_sse(_anthropic_frames()))
        with _anthropic_messages(capture, session).create(stream=True, **_ANTHROPIC_KW) as stream:
            for event in stream:
                if event.type == "content_block_delta":
                    break

    (post_call,) = _events_of(session, "post_call")
    assert post_call["streaming"]["final_outcome"] == "aborted"
    assert post_call["tokens_input"] == 11
    assert _events_of(session, "tool_call") == []
    if capture:
        assert post_call["content"]["response"]["content"][0]["text"] == "Hello"
    else:
        _assert_nothing_captured(session)


def test_anthropic_raw_stream_failing_mid_stream_reports_partial_tokens_only() -> None:
    session = _session(True)
    with respx.mock(base_url=ANTHROPIC_URL) as router:
        router.post("/v1/messages").mock(return_value=_sse(_anthropic_frames(fail_after=4)))
        with pytest.raises(anthropic.APIError):
            for _ in _anthropic_messages(True, session).create(stream=True, **_ANTHROPIC_KW):
                pass

    assert _events_of(session, "post_call") == []
    assert _events_of(session, "tool_call") == []
    (err,) = _events_of(session, "llm_error")
    assert err["error"]["error_type"] == "stream_error"
    assert err["error"]["abort_reason"] == "error_mid_stream"
    assert err["error"]["partial_tokens_input"] == 11
    assert err.get("content") is None


def test_anthropic_beta_raw_stream_is_assembled_with_the_beta_accumulator() -> None:
    session = _session(True)
    client = anthropic.Anthropic(api_key="sk-test", max_retries=0)
    beta = SensorMessages(client.beta.messages, session, AnthropicProvider(capture_prompts=True))
    with respx.mock(base_url=ANTHROPIC_URL) as router:
        router.post("/v1/messages").mock(return_value=_sse(_anthropic_frames()))
        for _ in beta.create(stream=True, **_ANTHROPIC_KW):
            pass

    (post_call,) = _events_of(session, "post_call")
    assert post_call["content"]["response"]["content"][1]["input"] == {"city": TOOL_MARKER}
    (tool_call,) = _events_of(session, "tool_call")
    assert tool_call["content"]["tool_input"] == {"city": TOOL_MARKER}


def test_a_failing_accumulator_is_dropped_and_metering_carries_on(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class _Broken:
        def add(self, chunk: Any) -> None:
            raise ValueError("bad event")

        def message(self) -> Any:
            raise AssertionError("never read once dropped")

    monkeypatch.setattr(AnthropicProvider, "stream_accumulator", lambda *_a: _Broken())
    session = _session(True)
    with respx.mock(base_url=ANTHROPIC_URL) as router:
        router.post("/v1/messages").mock(return_value=_sse(_anthropic_frames()))
        for _ in _anthropic_messages(True, session).create(stream=True, **_ANTHROPIC_KW):
            pass

    (post_call,) = _events_of(session, "post_call")
    assert (post_call["tokens_input"], post_call["tokens_output"]) == (11, 20)
    assert _events_of(session, "tool_call") == []


def test_the_anthropic_helper_stream_keeps_its_own_snapshot() -> None:
    """``messages.stream()`` assembles its own message; the guard asks for
    no accumulator, so the helper's snapshot is the one stored."""
    provider = AnthropicProvider(capture_prompts=True)
    client = anthropic.Anthropic(api_key="sk-test", max_retries=0)
    with respx.mock(base_url=ANTHROPIC_URL) as router:
        router.post("/v1/messages").mock(return_value=_sse(_anthropic_frames()))
        with client.messages.stream(**_ANTHROPIC_KW) as helper:
            assert provider.stream_accumulator(helper, _ANTHROPIC_KW) is None
            helper.until_done()


# ----- OpenAI chat raw stream ------------------------------------------------


@pytest.mark.parametrize("is_async", [False, True])
@pytest.mark.parametrize("capture", [True, False])
def test_chat_raw_stream_stores_the_assembled_completion_and_emits_tool_calls(
    capture: bool, is_async: bool
) -> None:
    session = _session(capture)
    completions = _completions(session, capture, is_async=is_async)
    kwargs = {"model": "gpt-4o-mini", "messages": MESSAGES, "tools": [WEATHER_TOOL]}
    with respx.mock(base_url=OPENAI_URL) as router:
        router.post("/chat/completions").mock(return_value=_sse(_chat_frames(), done=True))
        if is_async:

            async def _read() -> list[Any]:
                stream = await completions.create(stream=True, **kwargs)
                return [c async for c in stream]

            chunks = _run(_read())
        else:
            chunks = list(completions.create(stream=True, **kwargs))

    # The usage chunk the sensor asked for stays hidden from the caller.
    assert all(c.choices for c in chunks)
    (post_call,) = _events_of(session, "post_call")
    assert (post_call["tokens_input"], post_call["tokens_output"]) == (9, 4)
    assert post_call["streaming"]["final_outcome"] == "completed"
    (tool_call,) = _events_of(session, "tool_call")
    assert tool_call["tool_name"] == "get_weather"
    if not capture:
        _assert_nothing_captured(session)
        return
    message = post_call["content"]["response"]["choices"][0]["message"]
    assert message["content"] == "Hi there"
    assert message["tool_calls"][0]["function"]["arguments"] == '{"city": "' + TOOL_MARKER + '"}'
    assert post_call["content"]["messages"] == MESSAGES
    assert tool_call["content"]["tool_input"] == {"city": TOOL_MARKER}


def test_chat_raw_stream_yields_the_same_chunks_as_the_unguarded_sdk() -> None:
    session = _session(True)
    kwargs = {"model": "gpt-4o-mini", "messages": MESSAGES, "tools": [WEATHER_TOOL]}
    with respx.mock(base_url=OPENAI_URL) as router:
        router.post("/chat/completions").mock(return_value=_sse(_chat_frames()[:-1], done=True))
        expected = [
            c.model_dump()
            for c in _openai_client(False).chat.completions.create(stream=True, **kwargs)
        ]
    with respx.mock(base_url=OPENAI_URL) as router:
        router.post("/chat/completions").mock(return_value=_sse(_chat_frames(), done=True))
        seen = [c.model_dump() for c in _completions(session, True).create(stream=True, **kwargs)]
    assert seen == expected


def test_chat_raw_stream_left_early_stores_the_partial_completion() -> None:
    session = _session(True)
    kwargs = {"model": "gpt-4o-mini", "messages": MESSAGES, "tools": [WEATHER_TOOL]}
    with respx.mock(base_url=OPENAI_URL) as router:
        router.post("/chat/completions").mock(return_value=_sse(_chat_frames(), done=True))
        with _completions(session, True).create(stream=True, **kwargs) as stream:
            next(iter(stream))

    (post_call,) = _events_of(session, "post_call")
    assert post_call["streaming"]["final_outcome"] == "aborted"
    assert post_call["content"]["response"]["choices"][0]["message"]["content"] == "Hi"
    assert _events_of(session, "tool_call") == []


def test_chat_raw_stream_without_capture_or_tools_assembles_nothing() -> None:
    """Nothing reads the assembled completion of a stream that cannot
    carry a tool call when capture is off, so the SDK's per-chunk
    re-serialisation is not paid for it."""
    session = _session(False)
    kwargs = {"model": "gpt-4o-mini", "messages": MESSAGES}
    with respx.mock(base_url=OPENAI_URL) as router:
        router.post("/chat/completions").mock(
            return_value=_sse(_chat_frames(tool=False), done=True)
        )
        guard = _completions(session, False).create(stream=True, **kwargs)
        assert isinstance(guard, base.GuardedStream)
        assert guard._accumulator is None
        list(guard)
    (post_call,) = _events_of(session, "post_call")
    assert post_call["tokens_output"] == 4
    assert _events_of(session, "tool_call") == []


# ----- OpenAI Responses raw stream ------------------------------------------


@pytest.mark.parametrize("is_async", [False, True])
@pytest.mark.parametrize("capture", [True, False])
def test_responses_raw_stream_stores_request_and_response_and_emits_tool_calls(
    capture: bool, is_async: bool
) -> None:
    session = _session(capture)
    responses = _responses(session, capture, is_async=is_async)
    with respx.mock(base_url=OPENAI_URL) as router:
        router.post("/responses").mock(return_value=_sse(_responses_frames()))
        if is_async:

            async def _read() -> list[str]:
                stream = await responses.create(stream=True, **_RESPONSES_KW)
                return [e.type async for e in stream]

            kinds = _run(_read())
        else:
            kinds = [e.type for e in responses.create(stream=True, **_RESPONSES_KW)]

    assert kinds[-1] == "response.completed"
    (post_call,) = _events_of(session, "post_call")
    assert (post_call["tokens_input"], post_call["tokens_output"]) == (7, 3)
    function_call, mcp_call = _events_of(session, "tool_call")
    assert function_call["tool_name"] == "get_weather"
    assert "server_name" not in function_call
    assert mcp_call["tool_name"] == "list_issues"
    assert mcp_call["server_name"] == "github"
    if not capture:
        _assert_nothing_captured(session)
        return
    content = post_call["content"]
    assert content["input"] == PROMPT
    assert content["system"] == INSTRUCTIONS
    assert content["messages"] == []
    assert content["tools"] == [RESPONSES_WEATHER_TOOL]
    assert content["response"]["output"][0]["content"][0]["text"] == "Hi there"
    assert function_call["content"]["tool_input"] == {"city": TOOL_MARKER}
    assert mcp_call["content"]["tool_input"] == {"repo": TOOL_MARKER}


def test_responses_raw_stream_left_early_stores_the_partial_response() -> None:
    session = _session(True)
    with respx.mock(base_url=OPENAI_URL) as router:
        router.post("/responses").mock(return_value=_sse(_responses_frames()))
        with _responses(session, True).create(stream=True, **_RESPONSES_KW) as stream:
            for event in stream:
                if event.type == "response.output_text.delta":
                    break

    (post_call,) = _events_of(session, "post_call")
    assert post_call["streaming"]["final_outcome"] == "aborted"
    output = post_call["content"]["response"]["output"]
    assert output[0]["content"][0]["text"] == "Hi there"
    assert post_call["content"]["input"] == PROMPT
    assert _events_of(session, "tool_call") == []


def test_responses_event_the_partial_state_cannot_fold_keeps_the_terminal_response() -> None:
    """A delta for an item the stream never announced ends the partial
    snapshot, not the assembly: the terminal event still carries the
    whole response, which is stored and yields the tool calls."""
    session = _session(True)
    frames = [f for f in _responses_frames() if f[0] != "response.output_item.added"]
    with respx.mock(base_url=OPENAI_URL) as router:
        router.post("/responses").mock(return_value=_sse(frames))
        for _ in _responses(session, True).create(stream=True, **_RESPONSES_KW):
            pass

    (post_call,) = _events_of(session, "post_call")
    assert post_call["content"]["response"]["output"][0]["content"][0]["text"] == "Hi there"
    assert [t["tool_name"] for t in _events_of(session, "tool_call")] == [
        "get_weather",
        "list_issues",
    ]


# ----- Responses request capture and the MCP server name, non-streamed ------


@respx.mock(base_url=OPENAI_URL)
def test_responses_create_stores_its_input_items_verbatim(respx_mock: respx.MockRouter) -> None:
    """A Responses ``input`` list often carries the previous response's
    output items, which are SDK models; they are stored as the JSON the
    SDK sends."""
    respx_mock.post("/responses").mock(
        return_value=httpx.Response(
            200, json=_response_obj("completed", [MESSAGE_ITEM, MCP_ITEM], usage=True)
        )
    )
    session = _session(True)
    previous = openai.types.responses.Response.model_validate(
        _response_obj("completed", [FUNCTION_ITEM], usage=True)
    )
    items: list[Any] = [
        {"role": "user", "content": PROMPT},
        *previous.output,
        {"type": "function_call_output", "call_id": "call_1", "output": "sunny"},
    ]
    _responses(session, True).create(model="gpt-4o-mini", input=items)

    (post_call,) = _events_of(session, "post_call")
    stored = post_call["content"]["input"]
    assert stored[0] == {"role": "user", "content": PROMPT}
    assert stored[1]["type"] == "function_call"
    assert stored[1]["arguments"] == FUNCTION_ITEM["arguments"]
    assert stored[2]["output"] == "sunny"
    assert post_call["content"]["system"] is None
    json.dumps(post_call)  # the event is wire-safe
    (mcp_call,) = _events_of(session, "tool_call")
    assert mcp_call["server_name"] == "github"


@respx.mock(base_url=OPENAI_URL)
def test_mcp_call_server_name_is_cut_to_the_shared_bound(respx_mock: respx.MockRouter) -> None:
    long_label = "s" * 300
    respx_mock.post("/responses").mock(
        return_value=httpx.Response(
            200,
            json=_response_obj("completed", [{**MCP_ITEM, "server_label": long_label}], usage=True),
        )
    )
    session = _session(False)
    _responses(session, False).create(model="gpt-4o-mini", input="hi")
    (mcp_call,) = _events_of(session, "tool_call")
    assert mcp_call["server_name"] == "s" * base._MAX_SERVER_NAME_CHARS


# ----- OpenAI .stream() helpers ----------------------------------------------


@pytest.mark.parametrize("capture", [True, False])
def test_chat_stream_helper_is_metered_and_keeps_the_sdk_stream(capture: bool) -> None:
    session = _session(capture)
    with respx.mock(base_url=OPENAI_URL) as router:
        route = router.post("/chat/completions").mock(return_value=_sse(_chat_frames(), done=True))
        with _completions(session, capture).stream(
            model="gpt-4o-mini", messages=MESSAGES, tools=[WEATHER_TOOL]
        ) as stream:
            assert isinstance(stream, ChatCompletionStream)
            kinds = [event.type for event in stream]
            final = stream.get_final_completion()

    assert "content.delta" in kinds
    assert final.choices[0].message.content == "Hi there"
    assert final.choices[0].message.tool_calls[0].function.parsed_arguments == {"city": TOOL_MARKER}
    sent = json.loads(route.calls.last.request.content)
    assert sent["stream"] is True
    assert sent["stream_options"] == {"include_usage": True}
    assert "audio" not in sent  # the helper's unset parameters stay unset
    (post_call,) = _events_of(session, "post_call")
    assert (post_call["tokens_input"], post_call["tokens_output"]) == (9, 4)
    assert post_call["streaming"]["final_outcome"] == "completed"
    (tool_call,) = _events_of(session, "tool_call")
    assert tool_call["tool_name"] == "get_weather"
    if capture:
        assert post_call["content"]["response"]["choices"][0]["message"]["content"] == "Hi there"
    else:
        _assert_nothing_captured(session)


def test_async_chat_stream_helper_is_metered() -> None:
    session = _session(True)
    completions = _completions(session, True, is_async=True)

    async def _read() -> str:
        async with completions.stream(
            model="gpt-4o-mini", messages=MESSAGES, tools=[WEATHER_TOOL]
        ) as stream:
            async for _ in stream:
                pass
            final = await stream.get_final_completion()
        return str(final.choices[0].message.content)

    with respx.mock(base_url=OPENAI_URL) as router:
        router.post("/chat/completions").mock(return_value=_sse(_chat_frames(), done=True))
        assert _run(_read()) == "Hi there"

    (post_call,) = _events_of(session, "post_call")
    assert post_call["streaming"]["final_outcome"] == "completed"
    assert post_call["content"]["response"]["choices"][0]["message"]["content"] == "Hi there"
    assert len(_events_of(session, "tool_call")) == 1


def test_chat_stream_helper_left_early_settles_at_the_manager_exit() -> None:
    session = _session(True)
    with respx.mock(base_url=OPENAI_URL) as router:
        router.post("/chat/completions").mock(return_value=_sse(_chat_frames(), done=True))
        with _completions(session, True).stream(model="gpt-4o-mini", messages=MESSAGES) as stream:
            for event in stream:
                if event.type == "content.delta":
                    break
        # Reported at the exit, not left to the guard's finalizer.
        (post_call,) = _events_of(session, "post_call")
    assert post_call["streaming"]["final_outcome"] == "aborted"
    assert post_call["content"]["response"]["choices"][0]["message"]["content"] == "Hi"


@pytest.mark.parametrize("is_async", [False, True])
def test_responses_stream_helper_is_metered(is_async: bool) -> None:
    session = _session(True)
    responses = _responses(session, True, is_async=is_async)
    with respx.mock(base_url=OPENAI_URL) as router:
        router.post("/responses").mock(return_value=_sse(_responses_frames()))
        if is_async:

            async def _read() -> Any:
                async with responses.stream(**_RESPONSES_KW) as stream:
                    async for _ in stream:
                        pass
                    return await stream.get_final_response()

            final = _run(_read())
        else:
            with responses.stream(**_RESPONSES_KW) as stream:
                assert isinstance(stream, ResponseStream)
                for _ in stream:
                    pass
                final = stream.get_final_response()

    assert final.output_text == "Hi there"
    (post_call,) = _events_of(session, "post_call")
    assert (post_call["tokens_input"], post_call["tokens_output"]) == (7, 3)
    assert post_call["content"]["input"] == PROMPT
    assert post_call["content"]["system"] == INSTRUCTIONS
    assert [t["tool_name"] for t in _events_of(session, "tool_call")] == [
        "get_weather",
        "list_issues",
    ]


def test_responses_stream_helper_failing_mid_stream_reports_one_llm_error() -> None:
    session = _session(True)
    frames = _responses_frames()[:4] + [
        ("error", {"error": {"type": "server_error", "code": "server_error", "message": "boom"}}),
    ]
    with respx.mock(base_url=OPENAI_URL) as router:
        router.post("/responses").mock(return_value=_sse(frames))
        with (
            pytest.raises(openai.APIError),
            _responses(session, True).stream(**_RESPONSES_KW) as stream,
        ):
            for _ in stream:
                pass

    assert _events_of(session, "post_call") == []
    (err,) = _events_of(session, "llm_error")
    assert err["error"]["abort_reason"] == "error_mid_stream"


# ----- with_raw_response(stream=True) ----------------------------------------


@pytest.mark.parametrize("is_async", [False, True])
def test_chat_raw_response_stream_is_metered_from_the_stream(is_async: bool) -> None:
    session = _session(True)
    completions = _completions(session, True, is_async=is_async)
    kwargs = {"model": "gpt-4o-mini", "messages": MESSAGES, "tools": [WEATHER_TOOL]}
    with respx.mock(base_url=OPENAI_URL) as router:
        router.post("/chat/completions").mock(return_value=_sse(_chat_frames(), done=True))
        if is_async:

            async def _read() -> tuple[Any, list[Any]]:
                raw = await completions.with_raw_response.create(stream=True, **kwargs)
                stream = raw.parse()
                async with stream:
                    return raw, [c async for c in stream]

            raw, chunks = _run(_read())
        else:
            raw = completions.with_raw_response.create(stream=True, **kwargs)
            assert _events_of(session, "post_call") == []  # owed until the stream is read
            with raw.parse() as stream:
                chunks = list(stream)

    assert raw.headers["x-request-id"] == "req_stream_1"
    assert all(c.choices for c in chunks)
    (post_call,) = _events_of(session, "post_call")
    assert (post_call["tokens_input"], post_call["tokens_output"]) == (9, 4)
    assert post_call["streaming"]["final_outcome"] == "completed"
    assert post_call["streaming"]["chunk_count"] == len(chunks)
    assert post_call["content"]["response"]["choices"][0]["message"]["content"] == "Hi there"
    (tool_call,) = _events_of(session, "tool_call")
    assert tool_call["tool_name"] == "get_weather"


@pytest.mark.parametrize("is_async", [False, True])
def test_responses_raw_response_stream_is_metered_from_the_stream(is_async: bool) -> None:
    session = _session(False)
    responses = _responses(session, False, is_async=is_async)
    with respx.mock(base_url=OPENAI_URL) as router:
        router.post("/responses").mock(return_value=_sse(_responses_frames()))
        if is_async:

            async def _read() -> None:
                raw = await responses.with_raw_response.create(stream=True, **_RESPONSES_KW)
                async for _ in raw.parse():
                    pass

            _run(_read())
        else:
            raw = responses.with_raw_response.create(stream=True, **_RESPONSES_KW)
            for _ in raw.parse():
                pass

    (post_call,) = _events_of(session, "post_call")
    assert (post_call["tokens_input"], post_call["tokens_output"]) == (7, 3)
    assert post_call["streaming"]["final_outcome"] == "completed"
    assert [t.get("server_name") for t in _events_of(session, "tool_call")] == [None, "github"]
    _assert_nothing_captured(session)


def test_raw_response_stream_never_parsed_is_reported_at_session_end() -> None:
    session = _session(False)
    with respx.mock(base_url=OPENAI_URL) as router:
        router.post("/chat/completions").mock(return_value=_sse(_chat_frames(), done=True))
        raw = _completions(session, False).with_raw_response.create(
            stream=True, model="gpt-4o-mini", messages=MESSAGES
        )
        assert isinstance(raw, raw_views.DeferredResponse)
        base.settle_open_guards(session)
    (post_call,) = _events_of(session, "post_call")
    assert "streaming" not in post_call  # nothing was read; the estimate stands


# ----- with_streaming_response -----------------------------------------------


@pytest.mark.parametrize("is_async", [False, True])
def test_chat_streaming_view_stream_is_metered(is_async: bool) -> None:
    session = _session(True)
    completions = _completions(session, True, is_async=is_async)
    kwargs = {"model": "gpt-4o-mini", "messages": MESSAGES}
    with respx.mock(base_url=OPENAI_URL) as router:
        route = router.post("/chat/completions").mock(
            return_value=_sse(_chat_frames(tool=False), done=True)
        )
        if is_async:

            async def _read() -> list[Any]:
                async with completions.with_streaming_response.create(
                    stream=True, **kwargs
                ) as response:
                    stream = await response.parse()
                    return [c async for c in stream]

            chunks = _run(_read())
        else:
            with completions.with_streaming_response.create(stream=True, **kwargs) as response:
                chunks = list(response.parse())

    assert len(chunks) == 3  # the usage chunk stays hidden
    sent = json.loads(route.calls.last.request.content)
    assert sent["stream_options"] == {"include_usage": True}
    (post_call,) = _events_of(session, "post_call")
    assert post_call["tokens_output"] == 4
    assert post_call["streaming"]["final_outcome"] == "completed"
    assert post_call["content"]["response"]["choices"][0]["message"]["content"] == "Hi there"


@respx.mock(base_url=OPENAI_URL)
def test_responses_streaming_view_plain_call_is_metered_at_parse(
    respx_mock: respx.MockRouter,
) -> None:
    respx_mock.post("/responses").mock(
        return_value=httpx.Response(200, json=_response_obj("completed", [MCP_ITEM], usage=True))
    )
    session = _session(True)
    with _responses(session, True).with_streaming_response.create(
        model="gpt-4o-mini", input=PROMPT
    ) as response:
        assert _events_of(session, "post_call") == []
        parsed = response.parse()
    assert parsed.output[0].type == "mcp_call"
    (post_call,) = _events_of(session, "post_call")
    assert (post_call["tokens_input"], post_call["tokens_output"]) == (7, 3)
    assert post_call["content"]["input"] == PROMPT
    (mcp_call,) = _events_of(session, "tool_call")
    assert mcp_call["server_name"] == "github"


@respx.mock(base_url=OPENAI_URL)
def test_embeddings_streaming_view_lands_an_embeddings_event(
    respx_mock: respx.MockRouter,
) -> None:
    respx_mock.post("/embeddings").mock(
        return_value=httpx.Response(
            200,
            json={
                "object": "list",
                "model": "text-embedding-3-small",
                "data": [{"object": "embedding", "index": 0, "embedding": [0.1, 0.2]}],
                "usage": {"prompt_tokens": 3, "total_tokens": 3},
            },
        )
    )
    session = _session(False)
    embeddings = SensorEmbeddings(
        _openai_client(False).embeddings, session, OpenAIProvider(platform="openai")
    )
    with embeddings.with_streaming_response.create(
        model="text-embedding-3-small", input="hi"
    ) as response:
        response.parse()
    (event,) = _events_of(session, "embeddings")
    assert event["tokens_input"] == 3
    assert _events_of(session, "post_call") == []


# ----- client-level views: patch() and wrap() --------------------------------


def test_patched_client_level_raw_view_streams_and_parses_through_the_sensor(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    session = _session(True)
    monkeypatch.setattr(flightdeck_sensor, "_session", session)
    patch_openai_classes(quiet=True)
    try:
        client = _openai_client(False)
        with respx.mock(base_url=OPENAI_URL) as router:
            router.post("/chat/completions").mock(return_value=_sse(_chat_frames(), done=True))
            raw = client.with_raw_response.chat.completions.create(
                stream=True, model="gpt-4o-mini", messages=MESSAGES
            )
            chunks = list(raw.parse())
        with respx.mock(base_url=OPENAI_URL) as router:
            router.post("/chat/completions").mock(
                return_value=httpx.Response(
                    200,
                    json={
                        "id": "chatcmpl_2",
                        "object": "chat.completion",
                        "created": 1,
                        "model": "gpt-4o-mini",
                        "choices": [
                            {
                                "index": 0,
                                "finish_reason": "stop",
                                "message": {"role": "assistant", "content": "ok"},
                            }
                        ],
                        "usage": {"prompt_tokens": 5, "completion_tokens": 1, "total_tokens": 6},
                    },
                )
            )
            parsed_raw = client.with_raw_response.chat.completions.parse(
                model="gpt-4o-mini", messages=MESSAGES
            )
    finally:
        unpatch_openai_classes()

    assert all(c.choices for c in chunks)
    # The raw view's parse() hands back the raw response, as the SDK does.
    assert parsed_raw.parse().choices[0].message.content == "ok"
    streamed, parsed = _events_of(session, "post_call")
    assert streamed["streaming"]["final_outcome"] == "completed"
    assert (streamed["tokens_input"], streamed["tokens_output"]) == (9, 4)
    assert (parsed["tokens_input"], parsed["tokens_output"]) == (5, 1)


def test_wrapped_client_level_views_reach_the_sensor() -> None:
    session = _session(False)
    wrapped = SensorOpenAI(_openai_client(False), session)
    with respx.mock(base_url=OPENAI_URL) as router:
        router.post("/responses").mock(return_value=_sse(_responses_frames()))
        raw = wrapped.with_raw_response.responses.create(stream=True, **_RESPONSES_KW)
        for _ in raw.parse():
            pass
    with respx.mock(base_url=OPENAI_URL) as router:
        router.post("/chat/completions").mock(return_value=_sse(_chat_frames(), done=True))
        with wrapped.with_streaming_response.chat.completions.create(
            stream=True, model="gpt-4o-mini", messages=MESSAGES, tools=[WEATHER_TOOL]
        ) as response:
            for _ in response.parse():
                pass

    responses_pc, chat_pc = _events_of(session, "post_call")
    assert (responses_pc["tokens_input"], responses_pc["tokens_output"]) == (7, 3)
    assert (chat_pc["tokens_input"], chat_pc["tokens_output"]) == (9, 4)
    assert all(pc["streaming"]["final_outcome"] == "completed" for pc in (responses_pc, chat_pc))
    assert [t["tool_name"] for t in _events_of(session, "tool_call")] == [
        "get_weather",
        "list_issues",
        "get_weather",
    ]
    _assert_nothing_captured(session)


def test_raw_view_header_spelling_matches_the_openai_sdk() -> None:
    from openai import _constants

    assert _constants.RAW_RESPONSE_HEADER == raw_views.RAW_RESPONSE_HEADER


# ----- review fixes: view close, repeated parse, 1.x state, logs, helpers ----


@pytest.mark.parametrize("capture", [True, False])
def test_streaming_view_stream_left_early_is_reported_at_the_view_exit(capture: bool) -> None:
    session = _session(capture)
    completions = _completions(session, capture)
    with respx.mock(base_url=OPENAI_URL) as router:
        router.post("/chat/completions").mock(return_value=_sse(_chat_frames(), done=True))
        with completions.with_streaming_response.create(
            stream=True, model="gpt-4o-mini", messages=MESSAGES
        ) as r:
            s = r.parse()
            for _ in s:
                break
        (post_call,) = _events_of(session, "post_call")
    assert post_call["streaming"]["final_outcome"] == "aborted"
    assert post_call["streaming"]["chunk_count"] == 1
    assert _events_of(session, "tool_call") == []
    if capture:
        assert post_call["content"]["response"]["choices"][0]["message"]["content"] == "Hi"
    else:
        _assert_nothing_captured(session)


def test_async_streaming_view_stream_left_early_is_reported_at_the_view_exit() -> None:
    session = _session(True)
    completions = _completions(session, True, is_async=True)

    async def _read() -> None:
        async with completions.with_streaming_response.create(
            stream=True, model="gpt-4o-mini", messages=MESSAGES
        ) as r:
            s = await r.parse()
            async for _ in s:
                break

    with respx.mock(base_url=OPENAI_URL) as router:
        router.post("/chat/completions").mock(return_value=_sse(_chat_frames(), done=True))
        _run(_read())
        (post_call,) = _events_of(session, "post_call")
    assert post_call["streaming"]["final_outcome"] == "aborted"
    assert post_call["content"]["response"]["choices"][0]["message"]["content"] == "Hi"


def test_streaming_view_read_to_the_end_reports_once_at_exit() -> None:
    session = _session(False)
    with respx.mock(base_url=OPENAI_URL) as router:
        router.post("/chat/completions").mock(return_value=_sse(_chat_frames(), done=True))
        with _completions(session, False).with_streaming_response.create(
            stream=True, model="gpt-4o-mini", messages=MESSAGES
        ) as r:
            list(r.parse())
    (post_call,) = _events_of(session, "post_call")
    assert post_call["streaming"]["final_outcome"] == "completed"


@pytest.mark.parametrize("view", ["with_raw_response", "with_streaming_response"])
def test_a_second_parse_returns_the_same_guard(view: str) -> None:
    session = _session(False)
    completions = _completions(session, False)
    with respx.mock(base_url=OPENAI_URL) as router:
        router.post("/chat/completions").mock(return_value=_sse(_chat_frames(), done=True))
        if view == "with_raw_response":
            raw = completions.with_raw_response.create(
                stream=True, model="gpt-4o-mini", messages=MESSAGES
            )
            first, second = raw.parse(), raw.parse()
            chunks = list(second)
        else:
            with completions.with_streaming_response.create(
                stream=True, model="gpt-4o-mini", messages=MESSAGES
            ) as r:
                first, second = r.parse(), r.parse()
                chunks = list(second)
    assert first is second
    assert isinstance(second, base.GuardedStream)
    assert all(c.choices for c in chunks)  # the injected usage chunk stays hidden
    (post_call,) = _events_of(session, "post_call")
    assert post_call["streaming"]["chunk_count"] == len(chunks)
    assert post_call["tokens_output"] == 4


def test_chat_stream_state_is_built_with_the_arguments_openai_1x_requires(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """openai 1.x requires ``input_tools`` and ``response_format`` and
    exports the state only from its ``_completions`` module."""
    import openai.lib.streaming.chat as chat_pkg
    from openai.lib.streaming.chat import _completions as chat_module

    from flightdeck_sensor.providers import openai as openai_provider

    seen: dict[str, Any] = {}
    real_state: Any = chat_module.ChatCompletionStreamState

    class _Strict(real_state):  # type: ignore[misc,valid-type]
        def __init__(self, *, input_tools: Any, response_format: Any) -> None:
            seen.update(input_tools=input_tools, response_format=response_format)
            super().__init__(input_tools=input_tools, response_format=response_format)

    monkeypatch.delattr(chat_pkg, "ChatCompletionStreamState")
    monkeypatch.setattr(chat_module, "ChatCompletionStreamState", _Strict)
    state = openai_provider._chat_stream_state()
    assert isinstance(state, _Strict)
    assert seen == {"input_tools": openai.NOT_GIVEN, "response_format": openai.NOT_GIVEN}


def test_an_accumulator_failure_logs_the_class_name_only(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    class _Leaky:
        def add(self, chunk: Any) -> None:
            raise ValueError(f"bad arguments {TOOL_MARKER}")

        def message(self) -> Any:
            return None

    monkeypatch.setattr(AnthropicProvider, "stream_accumulator", lambda *_a: _Leaky())
    session = _session(False)
    with (
        caplog.at_level("DEBUG", logger="flightdeck_sensor"),
        respx.mock(base_url=ANTHROPIC_URL) as router,
    ):
        router.post("/v1/messages").mock(return_value=_sse(_anthropic_frames()))
        for _ in _anthropic_messages(False, session).create(stream=True, **_ANTHROPIC_KW):
            pass
    assert "stream_accumulator hook raised (ValueError)" in caplog.text
    assert TOOL_MARKER not in caplog.text
    assert all(r.exc_info is None for r in caplog.records if "stream_accumulator" in r.message)


def test_chat_stream_helper_is_assembled_once_by_the_helper(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from flightdeck_sensor.providers import openai as openai_provider

    built: list[int] = []
    real = openai_provider._chat_stream_state

    def _counting() -> Any:
        built.append(1)
        return real()

    monkeypatch.setattr(openai_provider, "_chat_stream_state", _counting)
    session = _session(True)
    with respx.mock(base_url=OPENAI_URL) as router:
        router.post("/chat/completions").mock(return_value=_sse(_chat_frames(), done=True))
        with _completions(session, True).stream(
            model="gpt-4o-mini", messages=MESSAGES, tools=[WEATHER_TOOL]
        ) as stream:
            stream.until_done()
    # The SDK's helper keeps its own state; the sensor built none.
    assert built == []
    (post_call,) = _events_of(session, "post_call")
    assert post_call["content"]["response"]["choices"][0]["message"]["content"] == "Hi there"
    assert len(_events_of(session, "tool_call")) == 1


def test_responses_stream_helper_left_early_stores_the_helpers_snapshot() -> None:
    session = _session(True)
    with respx.mock(base_url=OPENAI_URL) as router:
        router.post("/responses").mock(return_value=_sse(_responses_frames()))
        with _responses(session, True).stream(**_RESPONSES_KW) as stream:
            for event in stream:
                if event.type == "response.output_text.delta":
                    break
    (post_call,) = _events_of(session, "post_call")
    assert post_call["streaming"]["final_outcome"] == "aborted"
    assert post_call["content"]["response"]["output"][0]["content"][0]["text"] == "Hi there"
    assert _events_of(session, "tool_call") == []
