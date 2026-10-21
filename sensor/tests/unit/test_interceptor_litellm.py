"""litellm interceptor: streaming through the stream guard, the
outer-call mark that keeps a litellm call served by the OpenAI SDK
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
from unittest.mock import AsyncMock, MagicMock

import httpx
import litellm
import openai
import pytest
from litellm.llms.custom_httpx.http_handler import AsyncHTTPHandler, HTTPHandler
from litellm.types.utils import PromptTokensDetailsWrapper, Usage

import flightdeck_sensor
from flightdeck_sensor.core.exceptions import BudgetExceededError, DirectiveError
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
    records every request and whether the outer-call mark was set when
    it was sent, so a test can assert how many requests the SDK made for
    one litellm call and which interceptor was on the path."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.marks: list[bool] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        self.marks.append(base.outer_intercept_active())
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


# ----- the outer-call mark ---------------------------------------------------


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
    """A task created before the block first runs at the block's first
    await, while the mark is set in this task; awaiting it directly means
    a raising sibling fails the test instead of hanging it."""

    async def _sibling() -> bool:
        return base.outer_intercept_active()

    sibling = asyncio.create_task(_sibling())
    with base.outer_intercept():
        assert await sibling is False
        assert base.outer_intercept_active() is True


async def test_outer_intercept_mark_is_inherited_by_a_task_created_inside_the_block() -> None:
    """Documents the mark's scope: asyncio copies the context into a new
    task, so a task created inside the marked call (litellm's async
    callbacks run this way) carries the mark while the call is in flight
    and its SDK calls go unmetered."""

    async def _child() -> bool:
        return base.outer_intercept_active()

    with base.outer_intercept():
        assert await asyncio.create_task(_child()) is True
    assert base.outer_intercept_active() is False


async def test_a_task_that_outlives_the_call_reads_the_mark_inactive() -> None:
    """The flag object the ContextVar holds is cleared when the call ends,
    so a task created inside the call but run after it is over sees no
    mark, even though its copied context still references the flag."""

    async def _child() -> bool:
        return base.outer_intercept_active()

    with base.outer_intercept():
        child = asyncio.create_task(_child())  # first runs after the block
    assert await child is False


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


def _stream_kwargs() -> dict[str, Any]:
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


# ----- text_completion and responses: not patched, partly reported ------


def test_text_completion_on_an_openai_chat_model_is_reported_by_the_openai_interceptor(
    session: Session,
) -> None:
    """text_completion calls ``completion`` through the name bound in
    ``litellm.main``, which the package-attribute patch does not reach,
    so no mark is set when litellm makes the SDK call: the OpenAI
    interceptor reports it, once."""
    transport = _Transport()
    client = _sdk_client(transport)
    response = litellm.text_completion(model="gpt-4o-mini", prompt="hi", client=client)
    assert response.usage.prompt_tokens == SDK_PROMPT_TOKENS
    assert [r.url.path for r in transport.requests] == ["/v1/chat/completions"]
    assert transport.marks == [False]  # the litellm wrapper was not on the path
    assert len(_events_of(session, "pre_call")) == 1
    (pc,) = _post_calls(session)
    assert pc["model"] == "gpt-4o-mini"
    assert pc["tokens_input"] == SDK_PROMPT_TOKENS


def _anthropic_message_body() -> dict[str, Any]:
    return {
        "id": "msg_1",
        "type": "message",
        "role": "assistant",
        "model": "claude-3-5-haiku-20241022",
        "content": [{"type": "text", "text": "hello"}],
        "stop_reason": "end_turn",
        "stop_sequence": None,
        "usage": {"input_tokens": SDK_PROMPT_TOKENS, "output_tokens": SDK_COMPLETION_TOKENS},
    }


def _responses_body() -> dict[str, Any]:
    return {
        "id": "resp_1",
        "object": "response",
        "created_at": 1,
        "status": "completed",
        "model": "gpt-4o-mini",
        "output": [
            {
                "type": "message",
                "id": "m1",
                "status": "completed",
                "role": "assistant",
                "content": [{"type": "output_text", "text": "hello", "annotations": []}],
            }
        ],
        "usage": {"input_tokens": 9, "output_tokens": 2, "total_tokens": 11},
        "parallel_tool_calls": True,
        "tool_choice": "auto",
        "tools": [],
    }


class _LitellmHttpTransport:
    """Serves litellm's own httpx routes (its Anthropic handler and its
    Responses API handler) from canned bodies and records the paths."""

    def __init__(self) -> None:
        self.paths: list[str] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.paths.append(request.url.path)
        if request.url.path.endswith("/responses"):
            return httpx.Response(200, json=_responses_body())
        return httpx.Response(200, json=_anthropic_message_body())


def _litellm_http_handler(transport: _LitellmHttpTransport) -> HTTPHandler:
    handler = HTTPHandler()
    handler.client = httpx.Client(transport=httpx.MockTransport(transport))
    return handler


def _litellm_async_http_handler(transport: _LitellmHttpTransport) -> AsyncHTTPHandler:
    handler = AsyncHTTPHandler()
    handler.client = httpx.AsyncClient(transport=httpx.MockTransport(transport))
    return handler


def _litellm_responses_unavailable() -> str | None:
    """Why ``litellm.responses`` cannot run in this environment, or None.

    Recent litellm releases import their MCP gateway handler inside
    ``responses()``, and that handler needs a type that only mcp 2.x
    ships. The sensor caps mcp below 2 until its MCP interceptor is
    ported, so with such a litellm every ``responses()`` call fails
    inside litellm before any patch is reached; the sensor has nothing
    to report and the routing below cannot be observed."""
    import importlib
    import importlib.metadata

    try:
        importlib.import_module("litellm.responses.mcp.litellm_proxy_mcp_handler")
    except ModuleNotFoundError:
        return None
    except ImportError as exc:
        version = importlib.metadata.version("litellm")
        return f"litellm {version} responses() needs mcp 2.x: {exc}"
    return None


_RESPONSES_SKIP_REASON = _litellm_responses_unavailable()
requires_litellm_responses = pytest.mark.skipif(
    _RESPONSES_SKIP_REASON is not None, reason=_RESPONSES_SKIP_REASON or ""
)


@requires_litellm_responses
def test_responses_bridged_through_completion_is_reported_once_as_a_chat_call(
    session: Session,
) -> None:
    """A provider without a native Responses API (Anthropic) is bridged
    through the package-level ``litellm.completion`` -- the patched
    wrapper -- so the call is reported once, as a chat call."""
    transport = _LitellmHttpTransport()
    response = litellm.responses(
        model="anthropic/claude-3-5-haiku-20241022",
        input="hi",
        client=_litellm_http_handler(transport),
        api_key="test-key",
    )
    assert response.usage.input_tokens == SDK_PROMPT_TOKENS
    assert transport.paths == ["/v1/messages"]
    assert len(_events_of(session, "pre_call")) == 1
    (pc,) = _post_calls(session)
    assert pc["model"] == "claude-3-5-haiku-20241022"
    assert pc["tokens_input"] == SDK_PROMPT_TOKENS
    assert pc["tokens_output"] == SDK_COMPLETION_TOKENS


@requires_litellm_responses
async def test_aresponses_bridged_through_acompletion_is_reported_once(session: Session) -> None:
    transport = _LitellmHttpTransport()
    await litellm.aresponses(
        model="anthropic/claude-3-5-haiku-20241022",
        input="hi",
        client=_litellm_async_http_handler(transport),
        api_key="test-key",
    )
    assert transport.paths == ["/v1/messages"]
    (pc,) = _post_calls(session)
    assert pc["tokens_output"] == SDK_COMPLETION_TOKENS


@requires_litellm_responses
def test_responses_on_a_native_route_is_unobserved(session: Session) -> None:
    """On a provider with a native Responses API (OpenAI) litellm uses
    its own httpx handler: neither the litellm wrapper nor an SDK
    interceptor is on the path, so nothing is reported."""
    transport = _LitellmHttpTransport()
    response = litellm.responses(
        model="gpt-4o-mini",
        input="hi",
        client=_litellm_http_handler(transport),
        api_key="test-key",
    )
    assert response.usage.input_tokens == 9
    assert transport.paths == ["/v1/responses"]
    assert _events_of(session, "pre_call") == []
    assert _post_calls(session) == []


# ----- the mark's scope, policy and errors on the SDK route ----------------


def test_sdk_call_from_a_litellm_pre_call_hook_runs_under_the_mark_and_emits_nothing(
    session: Session,
) -> None:
    """Pins the stated limitation: a litellm callback runs inside the
    marked call, so an SDK call it makes is neither policed nor metered;
    only the litellm call itself is reported."""
    from litellm.integrations.custom_logger import CustomLogger

    hook_transport = _Transport()
    hook_client = _sdk_client(hook_transport)
    hook_marks: list[bool] = []

    class _Hook(CustomLogger):
        def log_pre_api_call(self, model: Any, messages: Any, kwargs: Any) -> None:
            hook_marks.append(base.outer_intercept_active())
            hook_client.chat.completions.create(model="gpt-4o-mini", messages=MSG)

    transport = _Transport()
    previous = litellm.callbacks
    litellm.callbacks = [_Hook()]
    try:
        litellm.completion(model="gpt-4o-mini", messages=MSG, client=_sdk_client(transport))
    finally:
        litellm.callbacks = previous
    assert hook_marks == [True]
    assert len(hook_transport.requests) == 1  # the hook's SDK request went out
    assert len(transport.requests) == 1
    assert len(_events_of(session, "pre_call")) == 1
    assert len(_post_calls(session)) == 1  # the hook's call added nothing


def test_litellm_stream_sends_the_request_at_the_call_before_iteration(
    session: Session,
) -> None:
    transport = _Transport()
    stream = litellm.completion(
        model="gpt-4o-mini", messages=MSG, client=_sdk_client(transport), stream=True
    )
    assert len(transport.requests) == 1  # sent inside completion(), as without the sensor
    assert _post_calls(session) == []  # metered only once the stream is read
    list(stream)
    assert len(_post_calls(session)) == 1


def test_block_on_the_litellm_call_stops_the_sdk_request(session: Session) -> None:
    """The outer litellm wrapper runs the policy check; with both
    interceptors patched a BLOCK raises before any request leaves."""
    session.policy = PolicyCache(token_limit=1, block_at_pct=100)
    transport = _Transport()
    with pytest.raises(BudgetExceededError):
        litellm.completion(model="gpt-4o-mini", messages=MSG, client=_sdk_client(transport))
    assert transport.requests == []
    assert len(_events_of(session, "policy_block")) == 1
    assert _post_calls(session) == []
    assert base.outer_intercept_active() is False


def test_kill_switch_on_the_litellm_call_stops_the_sdk_request(session: Session) -> None:
    session._shutdown_requested = True
    session._shutdown_reason = "operator"
    transport = _Transport()
    with pytest.raises(DirectiveError):
        litellm.completion(model="gpt-4o-mini", messages=MSG, client=_sdk_client(transport))
    assert transport.requests == []
    assert _post_calls(session) == []


async def test_a_failed_litellm_call_leaves_no_outer_mark_and_sdk_calls_still_metered(
    session: Session,
) -> None:
    """A litellm call that fails before any request (a model no provider
    owns) raises out of the marked block on the sync, async and
    stream-open paths; the mark is cleared each time, so a direct SDK
    call made afterwards is metered as usual."""
    bad = {"model": "not-a-real-model", "messages": MSG}
    with pytest.raises(litellm.BadRequestError):
        litellm.completion(**bad)
    assert base.outer_intercept_active() is False
    with pytest.raises(litellm.BadRequestError):
        await litellm.acompletion(**bad)
    assert base.outer_intercept_active() is False
    with pytest.raises(litellm.BadRequestError):
        litellm.completion(**bad, stream=True)
    assert base.outer_intercept_active() is False
    assert len(_events_of(session, "llm_error")) == 3

    transport = _Transport()
    _sdk_client(transport).chat.completions.create(model="gpt-4o-mini", messages=MSG)
    assert transport.marks == [False]
    assert len(_events_of(session, "pre_call")) == 4  # three litellm calls + the SDK call
    (pc,) = _post_calls(session)
    assert pc["tokens_input"] == SDK_PROMPT_TOKENS


def _anthropic_message() -> Any:
    return types.SimpleNamespace(
        model="claude-haiku-4-5",
        content=[],
        usage=types.SimpleNamespace(
            input_tokens=5,
            output_tokens=2,
            cache_read_input_tokens=0,
            cache_creation_input_tokens=0,
        ),
    )


ANTHROPIC_KW = {"model": "claude-haiku-4-5", "messages": MSG, "max_tokens": 5}


async def test_sensor_messages_async_create_passes_through_under_the_mark() -> None:
    session = _session()
    real = MagicMock()
    real.create = AsyncMock(return_value=_anthropic_message())
    messages = SensorMessages(real, session, AnthropicProvider(), is_async=True)
    with base.outer_intercept():
        out = await messages.create(**ANTHROPIC_KW)
    assert out is real.create.return_value
    real.create.assert_awaited_once_with(**ANTHROPIC_KW)
    assert _events_of(session, "pre_call") == []
    assert _post_calls(session) == []


def test_sensor_messages_create_stream_passes_through_under_the_mark() -> None:
    """Under the mark ``create(stream=True)`` returns the SDK's own stream,
    not the sensor's guard: the outer interceptor owns the stream."""
    session = _session()
    real = MagicMock()
    raw_stream = object()
    real.create.return_value = raw_stream
    messages = SensorMessages(real, session, AnthropicProvider())
    with base.outer_intercept():
        out = messages.create(stream=True, **ANTHROPIC_KW)
    assert out is raw_stream
    assert not isinstance(out, base.GuardedStream)
    real.create.assert_called_once_with(stream=True, **ANTHROPIC_KW)
    assert _events_of(session, "pre_call") == []


def test_sensor_beta_messages_create_passes_through_under_the_mark() -> None:
    from flightdeck_sensor.interceptor.anthropic import SensorBeta

    session = _session()
    real_beta = MagicMock()
    real_beta.messages.create.return_value = _anthropic_message()
    beta = SensorBeta(real_beta, session, AnthropicProvider())
    with base.outer_intercept():
        out = beta.messages.create(**ANTHROPIC_KW)
    assert out is real_beta.messages.create.return_value
    real_beta.messages.create.assert_called_once_with(**ANTHROPIC_KW)
    assert _events_of(session, "pre_call") == []
    assert _post_calls(session) == []


def _embeddings_body() -> dict[str, Any]:
    return {
        "object": "list",
        "data": [{"object": "embedding", "index": 0, "embedding": [0.1, 0.2, 0.3]}],
        "model": "text-embedding-3-small",
        "usage": {"prompt_tokens": 5, "total_tokens": 5},
    }


class _EmbeddingsTransport(_Transport):
    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        self.marks.append(base.outer_intercept_active())
        return httpx.Response(200, json=_embeddings_body())


def test_litellm_embedding_through_the_openai_sdk_emits_exactly_one_embeddings_event(
    session: Session,
) -> None:
    transport = _EmbeddingsTransport()
    client = _sdk_client(transport)
    response = litellm.embedding(model="text-embedding-3-small", input="hi", client=client)
    assert response.usage.prompt_tokens == 5
    assert transport.marks == [True]  # the SDK call ran under the litellm wrapper's mark
    assert isinstance(client.chat, SensorChat)  # the OpenAI patch is installed on it
    assert _post_calls(session) == []
    (ev,) = _events_of(session, "embeddings")
    assert ev["tokens_input"] == 5
    assert ev["output_dimensions"] == {"count": 1, "dimension": 3}
    assert len(_events_of(session, "pre_call")) == 1


async def test_litellm_aembedding_through_the_openai_sdk_emits_exactly_one_embeddings_event(
    session: Session,
) -> None:
    transport = _EmbeddingsTransport()
    client = _async_sdk_client(transport)
    await litellm.aembedding(model="text-embedding-3-small", input="hi", client=client)
    assert transport.marks == [True]
    (ev,) = _events_of(session, "embeddings")
    assert ev["tokens_input"] == 5
    assert len(_events_of(session, "pre_call")) == 1


def test_sensor_embeddings_create_passes_through_under_the_mark() -> None:
    from flightdeck_sensor.interceptor.openai import SensorEmbeddings

    session = _session()
    real = MagicMock()
    real.create.return_value = types.SimpleNamespace(
        model="text-embedding-3-small",
        data=[],
        usage=types.SimpleNamespace(prompt_tokens=5, completion_tokens=0),
    )
    embeddings = SensorEmbeddings(real, session, OpenAIProvider())
    kw = {"model": "text-embedding-3-small", "input": "hi"}
    with base.outer_intercept():
        out = embeddings.create(**kw)
    assert out is real.create.return_value
    assert _events_of(session, "embeddings") == []
    embeddings.create(**kw)  # outside the mark the same call is reported
    assert len(_events_of(session, "embeddings")) == 1


def test_mark_is_reset_after_a_provider_error_on_the_sdk_route(session: Session) -> None:
    def _fail(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={"error": {"message": "boom"}})

    client = openai.OpenAI(
        api_key="test",
        max_retries=0,
        http_client=httpx.Client(transport=httpx.MockTransport(_fail)),
    )
    with pytest.raises(Exception, match="boom"):
        litellm.completion(model="gpt-4o-mini", messages=MSG, client=client)
    assert base.outer_intercept_active() is False
    assert _post_calls(session) == []
    (err,) = _events_of(session, "llm_error")
    assert err["model"] == "gpt-4o-mini"


# ----- what a streamed call stores with capture on -------------------------

PROMPT_SENTINEL = "PROMPT-SENTINEL-5e2d"
PASSWORD_SENTINEL = "SECRET-PW-7f1a"
QUERY_SENTINEL = "SECRET-QS-TOKEN-3b9c"
HEADER_SENTINEL = "HDR-SENTINEL-9c1e"


COOKIE_SENTINEL = "COOKIE-SENTINEL-1d4f"
ORG_SENTINEL = "ORG-SENTINEL-8a2b"


class _SentinelTransport(_Transport):
    """The SSE route with sentinels in the provider's response headers:
    a rate-limit header, ``Set-Cookie`` and the organisation / project
    headers OpenAI sends."""

    def __call__(self, request: httpx.Request) -> httpx.Response:
        response = super().__call__(request)
        response.headers["x-ratelimit-probe"] = HEADER_SENTINEL
        response.headers["set-cookie"] = f"__cf_bm={COOKIE_SENTINEL}; Path=/"
        response.headers["openai-organization"] = ORG_SENTINEL
        response.headers["openai-project"] = ORG_SENTINEL
        return response


def _streamed_capture_post_call(capture: bool, monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    session = _session(capture_prompts=capture)
    monkeypatch.setattr(flightdeck_sensor, "_session", session)
    patch_litellm_functions(quiet=True)
    patch_openai_classes(quiet=True)
    try:
        api_base = f"https://user:{PASSWORD_SENTINEL}@example.invalid/v1?token={QUERY_SENTINEL}"
        client = openai.OpenAI(
            api_key="test",
            base_url=api_base,
            http_client=httpx.Client(transport=httpx.MockTransport(_SentinelTransport())),
        )
        list(
            litellm.completion(
                model="gpt-4o-mini",
                messages=[{"role": "user", "content": PROMPT_SENTINEL}],
                client=client,
                api_base=api_base,
                stream=True,
            )
        )
    finally:
        unpatch_litellm_functions(quiet=True)
        unpatch_openai_classes()
    (pc,) = _post_calls(session)
    return pc


def test_streamed_capture_stores_only_the_response_allowlist(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The stream wrapper's own state (the request messages again,
    ``_hidden_params`` with the caller's ``api_base``, the provider's
    response headers, ``stream_options``) never reaches
    ``event_content``; the stored response is the allowlist."""
    pc = _streamed_capture_post_call(True, monkeypatch)
    assert pc["has_content"] is True
    content = pc["content"]
    blob = json.dumps(content)
    for sentinel in (PASSWORD_SENTINEL, QUERY_SENTINEL, HEADER_SENTINEL, COOKIE_SENTINEL):
        assert sentinel not in blob
    assert ORG_SENTINEL not in blob
    assert blob.count(PROMPT_SENTINEL) == 1  # once, in the request's messages
    assert content["messages"] == [{"role": "user", "content": PROMPT_SENTINEL}]
    response = content["response"]
    # The assembled response: the assistant message plus model and usage.
    assert {"choices", "model", "usage"} <= set(response)
    assert not any("header" in key.lower() or key.startswith("_") for key in response)
    for forbidden in ("messages", "stream_options", "api_base", "logging_obj", "make_call"):
        assert forbidden not in response
    assert response["model"] == "gpt-4o-mini"
    (choice,) = response["choices"]
    assert choice["message"]["role"] == "assistant"
    assert choice["message"]["content"] == "hello"
    assert choice["finish_reason"] == "stop"
    assert response["usage"]["prompt_tokens"] == SDK_PROMPT_TOKENS
    assert response["usage"]["completion_tokens"] == SDK_COMPLETION_TOKENS


def test_streamed_call_with_capture_off_carries_no_content(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pc = _streamed_capture_post_call(False, monkeypatch)
    assert pc.get("has_content") is not True
    assert pc.get("content") is None
    assert pc["tokens_output"] == SDK_COMPLETION_TOKENS


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
