"""litellm interceptor: streaming through the stream guard, the
re-entrancy mark that keeps a litellm call served by the OpenAI SDK
single-counted, and the extended usage litellm exposes.

Driven with litellm's real classes (``CustomStreamWrapper``,
``ModelResponse``, ``Usage``) over mocked transport: litellm's own
``mock_response`` for the litellm-served routes, and an
``httpx.MockTransport`` behind a real ``openai.OpenAI`` /
``AsyncOpenAI`` client handed to litellm for the route it serves
through the OpenAI SDK. No request leaves the process.
"""

from __future__ import annotations

import asyncio
import gc
import json
import threading
import types
from typing import Any
from unittest.mock import MagicMock

import httpx
import litellm
import openai
import pytest
from litellm.types.utils import PromptTokensDetailsWrapper, Usage

import flightdeck_sensor
from flightdeck_sensor.core.policy import PolicyCache
from flightdeck_sensor.core.session import Session
from flightdeck_sensor.core.types import SensorConfig, TokenUsage
from flightdeck_sensor.interceptor import base
from flightdeck_sensor.interceptor.anthropic import SensorMessages
from flightdeck_sensor.interceptor.litellm import (
    SensorLitellm,
    _is_usage_only_chunk,
    patch_litellm_functions,
    unpatch_litellm_functions,
)
from flightdeck_sensor.interceptor.openai import (
    SensorChat,
    SensorCompletions,
    patch_openai_classes,
    unpatch_openai_classes,
)
from flightdeck_sensor.providers.anthropic import AnthropicProvider
from flightdeck_sensor.providers.litellm import LitellmProvider
from flightdeck_sensor.providers.openai import OpenAIProvider
from flightdeck_sensor.transport.client import ControlPlaneClient

litellm.suppress_debug_info = True

MSG = [{"role": "user", "content": "hi"}]
MOCK_TEXT = "hello world"
# What the mocked OpenAI transport reports, so a post_call carrying these
# counts was metered from the provider's usage, not from the estimate.
SDK_PROMPT_TOKENS = 9
SDK_COMPLETION_TOKENS = 2
SDK_CACHED_TOKENS = 4


# ----- session + event helpers ---------------------------------------------


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
    session = Session(config=config, client=client, event_queue=MagicMock())
    session.policy = PolicyCache(token_limit=None, block_at_pct=100)
    return session


def _events_of(session: Session, event_type: str) -> list[dict[str, Any]]:
    queue = session.event_queue
    assert isinstance(queue, MagicMock)
    return [
        c.args[0] for c in queue.enqueue.call_args_list if c.args[0].get("event_type") == event_type
    ]


def _post_calls(session: Session) -> list[dict[str, Any]]:
    return _events_of(session, "post_call")


@pytest.fixture
def session(monkeypatch: pytest.MonkeyPatch) -> Any:
    """A session with a recording queue installed as the active one, with
    litellm and the OpenAI SDK patched the way ``flightdeck_sensor.patch``
    does -- both interceptors live, so a double count would show."""
    s = _session()
    monkeypatch.setattr(flightdeck_sensor, "_session", s)
    patch_litellm_functions(quiet=True)
    patch_openai_classes(quiet=True)
    yield s
    unpatch_litellm_functions(quiet=True)
    unpatch_openai_classes()


# ----- mocked OpenAI transport ---------------------------------------------


def _chat_completion_body() -> dict[str, Any]:
    return {
        "id": "chatcmpl-1",
        "object": "chat.completion",
        "created": 1,
        "model": "gpt-4o-mini",
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": "hello"},
                "finish_reason": "stop",
            }
        ],
        "usage": {
            "prompt_tokens": SDK_PROMPT_TOKENS,
            "completion_tokens": SDK_COMPLETION_TOKENS,
            "total_tokens": SDK_PROMPT_TOKENS + SDK_COMPLETION_TOKENS,
            "prompt_tokens_details": {"cached_tokens": SDK_CACHED_TOKENS},
        },
    }


def _sse_body() -> bytes:
    head = {"id": "c", "object": "chat.completion.chunk", "created": 1, "model": "gpt-4o-mini"}
    chunks = [
        {**head, "choices": [{"index": 0, "delta": {"content": "hel"}, "finish_reason": None}]},
        {**head, "choices": [{"index": 0, "delta": {"content": "lo"}, "finish_reason": None}]},
        {**head, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]},
        {
            **head,
            "choices": [],
            "usage": {
                "prompt_tokens": SDK_PROMPT_TOKENS,
                "completion_tokens": SDK_COMPLETION_TOKENS,
                "total_tokens": SDK_PROMPT_TOKENS + SDK_COMPLETION_TOKENS,
            },
        },
    ]
    body = "".join(f"data: {json.dumps(c)}\n\n" for c in chunks) + "data: [DONE]\n\n"
    return body.encode()


class _Transport:
    """Serves the chat completions endpoint from canned bodies and
    records every request, so a test can assert how many requests the
    SDK made for one litellm call."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        payload = json.loads(request.content or b"{}")
        if payload.get("stream"):
            return httpx.Response(
                200, content=_sse_body(), headers={"content-type": "text/event-stream"}
            )
        return httpx.Response(200, json=_chat_completion_body())


def _sdk_client(transport: _Transport) -> openai.OpenAI:
    return openai.OpenAI(
        api_key="test", http_client=httpx.Client(transport=httpx.MockTransport(transport))
    )


def _async_sdk_client(transport: _Transport) -> openai.AsyncOpenAI:
    return openai.AsyncOpenAI(
        api_key="test",
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(transport)),
    )


# ----- the re-entrancy mark --------------------------------------------------


def test_outer_intercept_mark_is_scoped_to_the_block() -> None:
    assert base.outer_intercept_active() is False
    with base.outer_intercept():
        assert base.outer_intercept_active() is True
        with base.outer_intercept():  # nesting keeps the mark
            assert base.outer_intercept_active() is True
        assert base.outer_intercept_active() is True
    assert base.outer_intercept_active() is False


def test_outer_intercept_mark_is_reset_when_the_call_raises() -> None:
    with pytest.raises(RuntimeError), base.outer_intercept():
        raise RuntimeError("provider down")
    assert base.outer_intercept_active() is False


def test_outer_intercept_mark_does_not_leak_to_another_thread() -> None:
    seen: list[bool] = []
    with base.outer_intercept():
        worker = threading.Thread(target=lambda: seen.append(base.outer_intercept_active()))
        worker.start()
        worker.join()
    assert seen == [False]


async def test_outer_intercept_mark_does_not_leak_to_another_task() -> None:
    entered = asyncio.Event()
    release = asyncio.Event()
    seen: list[bool] = []

    async def _sibling() -> None:
        await entered.wait()
        seen.append(base.outer_intercept_active())
        release.set()

    sibling = asyncio.create_task(_sibling())
    with base.outer_intercept():
        entered.set()
        await release.wait()
        assert base.outer_intercept_active() is True
    await sibling
    assert seen == [False]


def test_sensor_chat_resolves_the_raw_completions_under_the_mark() -> None:
    """The OpenAI interceptor's inner-side check: ``client.chat.completions``
    is the SDK's own resource while an outer interceptor makes the call,
    and the sensor proxy otherwise."""
    real_chat = MagicMock()
    chat = SensorChat(real_chat, _session(), OpenAIProvider())
    assert isinstance(chat.completions, SensorCompletions)
    with base.outer_intercept():
        assert chat.completions is real_chat.completions
    assert isinstance(chat.completions, SensorCompletions)


def test_sensor_messages_create_passes_through_under_the_mark() -> None:
    """The Anthropic interceptor's inner-side check: ``messages.create``
    reaches the SDK untouched and emits nothing while an outer
    interceptor makes the call."""
    session = _session()
    real = MagicMock()
    real.create.return_value = types.SimpleNamespace(
        model="claude-haiku-4-5",
        content=[],
        usage=types.SimpleNamespace(
            input_tokens=5,
            output_tokens=2,
            cache_read_input_tokens=0,
            cache_creation_input_tokens=0,
        ),
    )
    messages = SensorMessages(real, session, AnthropicProvider())
    kw = {"model": "claude-haiku-4-5", "messages": MSG, "max_tokens": 5}
    with base.outer_intercept():
        out = messages.create(**kw)
    assert out is real.create.return_value
    real.create.assert_called_once_with(**kw)
    assert _events_of(session, "pre_call") == []
    assert _post_calls(session) == []
    messages.create(**kw)  # outside the mark the same call is reported
    assert len(_post_calls(session)) == 1


# ----- a litellm call served through the OpenAI SDK is reported once -----


def test_litellm_to_openai_sdk_emits_exactly_one_post_call(session: Session) -> None:
    transport = _Transport()
    client = _sdk_client(transport)
    response = litellm.completion(model="gpt-4o-mini", messages=MSG, client=client)
    assert response.usage.prompt_tokens == SDK_PROMPT_TOKENS
    assert len(transport.requests) == 1
    # The OpenAI interceptor is installed on the client litellm used, so
    # the single count comes from the mark, not from an absent patch.
    assert isinstance(client.chat, SensorChat)
    assert len(_events_of(session, "pre_call")) == 1
    (pc,) = _post_calls(session)
    assert pc["model"] == "gpt-4o-mini"
    assert pc["tokens_input"] == SDK_PROMPT_TOKENS
    assert pc["tokens_output"] == SDK_COMPLETION_TOKENS
    assert pc["tokens_cache_read"] == SDK_CACHED_TOKENS
    assert "streaming" not in pc


def test_litellm_stream_to_openai_sdk_emits_exactly_one_post_call(session: Session) -> None:
    transport = _Transport()
    client = _sdk_client(transport)
    stream = litellm.completion(model="gpt-4o-mini", messages=MSG, client=client, stream=True)
    assert isinstance(stream, base.GuardedStream)
    seen = list(stream)
    assert [c.choices[0].finish_reason for c in seen] == [None, None, "stop"]
    assert len(transport.requests) == 1
    assert len(_events_of(session, "pre_call")) == 1
    (pc,) = _post_calls(session)
    assert pc["tokens_input"] == SDK_PROMPT_TOKENS
    assert pc["tokens_output"] == SDK_COMPLETION_TOKENS
    assert pc["streaming"]["final_outcome"] == "completed"
    assert pc["streaming"]["chunk_count"] == len(seen)


async def test_litellm_async_to_openai_sdk_emits_exactly_one_post_call(session: Session) -> None:
    transport = _Transport()
    client = _async_sdk_client(transport)
    response = await litellm.acompletion(model="gpt-4o-mini", messages=MSG, client=client)
    assert response.usage.completion_tokens == SDK_COMPLETION_TOKENS
    assert len(transport.requests) == 1
    assert isinstance(client.chat, SensorChat)
    (pc,) = _post_calls(session)
    assert pc["tokens_input"] == SDK_PROMPT_TOKENS
    assert len(_events_of(session, "pre_call")) == 1


async def test_litellm_async_stream_to_openai_sdk_emits_exactly_one_post_call(
    session: Session,
) -> None:
    transport = _Transport()
    client = _async_sdk_client(transport)
    stream = await litellm.acompletion(
        model="gpt-4o-mini", messages=MSG, client=client, stream=True
    )
    assert isinstance(stream, base.GuardedAsyncStream)
    seen = [c async for c in stream]
    assert [c.choices[0].finish_reason for c in seen] == [None, None, "stop"]
    assert len(transport.requests) == 1
    (pc,) = _post_calls(session)
    assert pc["tokens_output"] == SDK_COMPLETION_TOKENS
    assert pc["streaming"]["final_outcome"] == "completed"


# ----- streaming on litellm's own routes (mock_response) -------------------


def _stream_kwargs(**extra: Any) -> dict[str, Any]:
    return {"model": "gpt-4o-mini", "messages": MSG, "stream": True, "mock_response": MOCK_TEXT}


def test_litellm_completion_stream_meters_usage_and_hides_the_usage_chunk(
    session: Session,
) -> None:
    stream = litellm.completion(**_stream_kwargs())
    assert isinstance(stream, base.GuardedStream)
    seen = list(stream)
    assert seen, "the mocked stream delivered no chunks"
    assert all(getattr(c, "usage", None) is None for c in seen)  # the usage chunk is absorbed
    assert seen[-1].choices[0].finish_reason == "stop"
    assert "".join(c.choices[0].delta.content or "" for c in seen) == MOCK_TEXT
    (pc,) = _post_calls(session)
    assert pc["tokens_input"] > 0
    assert pc["tokens_output"] > 0
    assert pc["streaming"]["final_outcome"] == "completed"
    assert pc["streaming"]["chunk_count"] == len(seen)
    assert pc["streaming"]["ttft_ms"] is not None


def test_litellm_completion_stream_keeps_the_usage_chunk_for_a_caller_who_asked(
    session: Session,
) -> None:
    stream = litellm.completion(**_stream_kwargs(), stream_options={"include_usage": True})
    seen = list(stream)
    usage_chunks = [c for c in seen if getattr(c, "usage", None) is not None]
    assert len(usage_chunks) == 1
    assert seen[-1] is usage_chunks[0]
    (pc,) = _post_calls(session)
    assert pc["tokens_input"] == usage_chunks[0].usage.prompt_tokens
    assert pc["tokens_output"] == usage_chunks[0].usage.completion_tokens
    assert pc["streaming"]["chunk_count"] == len(seen)


async def test_litellm_acompletion_stream_meters_usage(session: Session) -> None:
    stream = await litellm.acompletion(**_stream_kwargs())
    assert isinstance(stream, base.GuardedAsyncStream)
    seen = [c async for c in stream]
    assert "".join(c.choices[0].delta.content or "" for c in seen) == MOCK_TEXT
    assert all(getattr(c, "usage", None) is None for c in seen)
    (pc,) = _post_calls(session)
    assert pc["tokens_output"] > 0
    assert pc["streaming"]["final_outcome"] == "completed"
    assert pc["streaming"]["chunk_count"] == len(seen)


def test_litellm_stream_left_early_is_reported_as_aborted_once_collected(
    session: Session,
) -> None:
    stream = litellm.completion(**_stream_kwargs())
    for _chunk in stream:
        break
    assert _post_calls(session) == []
    del stream
    gc.collect()
    base.drain_deferred_settles(session)  # what the next intercept would do
    (pc,) = _post_calls(session)
    assert pc["streaming"]["final_outcome"] == "aborted"
    assert pc["streaming"]["chunk_count"] == 1


def test_litellm_stream_that_fails_before_opening_emits_llm_error(session: Session) -> None:
    with pytest.raises(litellm.BadRequestError):
        litellm.completion(model="not-a-real-model", messages=MSG, stream=True)
    assert _post_calls(session) == []
    (err,) = _events_of(session, "llm_error")
    assert err["error"]["abort_reason"] == "error_before_stream"


def test_litellm_stream_with_capture_stores_a_serialisable_response(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A streamed call settles with litellm's stream wrapper as the
    response; the captured content must still be JSON (the wrapper's
    ``__dict__`` holds a logging object and the SDK stream)."""
    session = _session(capture_prompts=True)
    monkeypatch.setattr(flightdeck_sensor, "_session", session)
    patch_litellm_functions(quiet=True)
    try:
        list(litellm.completion(**_stream_kwargs()))
    finally:
        unpatch_litellm_functions(quiet=True)
    (pc,) = _post_calls(session)
    assert pc["has_content"] is True
    json.dumps(pc["content"])
    assert pc["content"]["messages"] == MSG


def test_sensor_litellm_wrapper_streams_through_the_guard() -> None:
    session = _session()
    stream = SensorLitellm(session).completion(**_stream_kwargs())
    assert isinstance(stream, base.GuardedStream)
    seen = list(stream)
    assert seen[-1].choices[0].finish_reason == "stop"
    (pc,) = _post_calls(session)
    assert pc["streaming"]["chunk_count"] == len(seen)


async def test_sensor_litellm_wrapper_streams_async_through_the_guard() -> None:
    session = _session()
    stream = await SensorLitellm(session).acompletion(**_stream_kwargs())
    assert isinstance(stream, base.GuardedAsyncStream)
    assert len([c async for c in stream]) > 0
    assert len(_post_calls(session)) == 1


def test_text_completion_is_not_intercepted(session: Session) -> None:
    """Documents the gap stated in the module docstring: text_completion
    calls ``completion`` through the name bound in ``litellm.main``,
    which the package-attribute patch does not reach."""
    litellm.text_completion(model="gpt-4o-mini", prompt="hi", mock_response=MOCK_TEXT)
    assert _post_calls(session) == []


# ----- the usage-only chunk test -------------------------------------------


def _chunk(usage: Any, *, content: str | None = None, finish_reason: str | None = None) -> Any:
    delta = types.SimpleNamespace(
        content=content, tool_calls=None, function_call=None, reasoning_content=None
    )
    choice = types.SimpleNamespace(delta=delta, finish_reason=finish_reason)
    return types.SimpleNamespace(usage=usage, choices=[choice])


def test_usage_only_chunk_is_the_trailing_chunk_with_an_empty_delta() -> None:
    usage = Usage(prompt_tokens=8, completion_tokens=2)
    assert _is_usage_only_chunk(_chunk(usage)) is True
    assert _is_usage_only_chunk(_chunk(None)) is False
    assert _is_usage_only_chunk(_chunk(usage, content="text")) is False
    assert _is_usage_only_chunk(_chunk(usage, finish_reason="stop")) is False
    assert _is_usage_only_chunk(types.SimpleNamespace(usage=usage, choices=[])) is True


# ----- extended usage --------------------------------------------------------


def test_litellm_extract_usage_reads_the_cache_breakdown() -> None:
    usage = Usage(
        prompt_tokens=30,
        completion_tokens=5,
        prompt_tokens_details=PromptTokensDetailsWrapper(cached_tokens=12, cache_creation_tokens=3),
    )
    response = types.SimpleNamespace(usage=usage)
    assert LitellmProvider().extract_usage(response) == TokenUsage(
        input_tokens=30, output_tokens=5, cache_read_tokens=12, cache_creation_tokens=3
    )
    # prompt_tokens already includes the cache counts: total is not inflated
    assert LitellmProvider().extract_usage(response).total == 35


def test_litellm_extract_usage_reads_anthropic_named_cache_attributes() -> None:
    usage = types.SimpleNamespace(
        prompt_tokens=30,
        completion_tokens=5,
        prompt_tokens_details=None,
        cache_read_input_tokens=12,
        cache_creation_input_tokens=3,
    )
    assert LitellmProvider().extract_usage(types.SimpleNamespace(usage=usage)) == TokenUsage(
        input_tokens=30, output_tokens=5, cache_read_tokens=12, cache_creation_tokens=3
    )


def test_litellm_extract_usage_without_details_reports_no_cache() -> None:
    usage = Usage(prompt_tokens=10, completion_tokens=4)
    assert LitellmProvider().extract_usage(types.SimpleNamespace(usage=usage)) == TokenUsage(
        input_tokens=10, output_tokens=4
    )


def test_litellm_stream_chunk_usage_carries_the_cache_breakdown() -> None:
    usage = Usage(
        prompt_tokens=30,
        completion_tokens=5,
        prompt_tokens_details=PromptTokensDetailsWrapper(cached_tokens=12),
    )
    found = LitellmProvider().usage_from_stream_chunk(types.SimpleNamespace(usage=usage))
    assert found == TokenUsage(input_tokens=30, output_tokens=5, cache_read_tokens=12)
