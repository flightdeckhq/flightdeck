"""Token accounting on streamed calls, driven with the real SDK event
classes and, for the Anthropic helper, the real ``MessageStream`` /
``AsyncMessageStream`` over a fake raw stream, rather than mocks that
carry a ``usage`` attribute no real stream object has.

Covers the sync and async guards used with and without a ``with``
block, early exits (including a plain loop abandoned with ``break``),
mid-stream and pre-stream failures on both forms, the helper consumed
through ``text_stream`` or ``get_final_message``, the OpenAI chat and
Responses chunk shapes, attribute proxying, eager opening of
``create(stream=True)``, budget accounting across streams, capture-off
posture, and provider-protocol conformance.
"""

from __future__ import annotations

import asyncio
import gc
import json
from typing import Any
from unittest.mock import MagicMock

import pytest
from anthropic import NOT_GIVEN
from anthropic.lib.streaming import AsyncMessageStream, MessageStream
from anthropic.types import (
    Message,
    RawContentBlockDeltaEvent,
    RawContentBlockStartEvent,
    RawContentBlockStopEvent,
    RawMessageDeltaEvent,
    RawMessageStartEvent,
    RawMessageStopEvent,
)
from openai.types.chat import ChatCompletionChunk
from openai.types.responses import Response, ResponseCompletedEvent, ResponseUsage

from flightdeck_sensor.core.exceptions import BudgetExceededError
from flightdeck_sensor.core.policy import PolicyCache
from flightdeck_sensor.core.session import Session
from flightdeck_sensor.core.types import SensorConfig, TokenUsage
from flightdeck_sensor.interceptor import base
from flightdeck_sensor.interceptor.anthropic import SensorMessages
from flightdeck_sensor.interceptor.openai import SensorResponses
from flightdeck_sensor.providers.anthropic import AnthropicProvider
from flightdeck_sensor.providers.litellm import LitellmProvider
from flightdeck_sensor.providers.openai import OpenAIProvider
from flightdeck_sensor.providers.protocol import Provider
from flightdeck_sensor.transport.client import ControlPlaneClient

PROMPT = "SECRET-PROMPT-TEXT-7f3a"

# ----- real SDK events --------------------------------------------------


def _message(output_tokens: int, stop_reason: str | None) -> Message:
    return Message.model_validate(
        {
            "id": "msg_1",
            "type": "message",
            "role": "assistant",
            "model": "claude-haiku-4-5",
            "content": [{"type": "text", "text": "Hello"}] if stop_reason else [],
            "stop_reason": stop_reason,
            "stop_sequence": None,
            "usage": {
                "input_tokens": 12,
                "output_tokens": output_tokens,
                "cache_read_input_tokens": 4,
                "cache_creation_input_tokens": 0,
            },
        }
    )


def _anthropic_events(delta_usage: dict[str, Any] | None = None) -> list[Any]:
    """The event sequence a real stream delivers: message_start (input +
    cache + first output token), a text block, the cumulative
    message_delta, message_stop. Seven events."""
    return [
        RawMessageStartEvent.model_validate(
            {"type": "message_start", "message": _message(1, None).model_dump()}
        ),
        RawContentBlockStartEvent.model_validate(
            {
                "type": "content_block_start",
                "index": 0,
                "content_block": {"type": "text", "text": ""},
            }
        ),
        RawContentBlockDeltaEvent.model_validate(
            {
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "text_delta", "text": "He"},
            }
        ),
        RawContentBlockDeltaEvent.model_validate(
            {
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "text_delta", "text": "llo"},
            }
        ),
        RawContentBlockStopEvent.model_validate({"type": "content_block_stop", "index": 0}),
        RawMessageDeltaEvent.model_validate(
            {
                "type": "message_delta",
                "delta": {"stop_reason": "end_turn", "stop_sequence": None},
                "usage": delta_usage or {"output_tokens": 9},
            }
        ),
        RawMessageStopEvent.model_validate({"type": "message_stop"}),
    ]


N_EVENTS = 7
# The real MessageStream helper yields a synthetic "text" event for each
# text delta on top of the raw events, so iterating it through the guard
# counts nine chunks for the same stream.
N_HELPER_EVENTS = N_EVENTS + 2


def _openai_chunk(usage: dict[str, int] | None) -> ChatCompletionChunk:
    return ChatCompletionChunk.model_validate(
        {
            "id": "chunk",
            "object": "chat.completion.chunk",
            "created": 1,
            "model": "gpt-5.5",
            "choices": []
            if usage
            else [{"index": 0, "delta": {"content": "hi"}, "finish_reason": None}],
            "usage": usage,
        }
    )


def _openai_chat_events() -> list[Any]:
    return [
        _openai_chunk(None),
        _openai_chunk(None),
        _openai_chunk({"prompt_tokens": 20, "completion_tokens": 7, "total_tokens": 27}),
    ]


def _responses_events() -> list[Any]:
    created = MagicMock(type="response.created", spec=["type", "response"])
    created.response = Response.model_construct(id="resp_1", model="gpt-5.5", usage=None)
    completed = ResponseCompletedEvent.model_construct(
        type="response.completed",
        sequence_number=3,
        response=Response.model_construct(
            id="resp_1",
            model="gpt-5.5",
            usage=ResponseUsage.model_construct(input_tokens=15, output_tokens=6, total_tokens=21),
        ),
    )
    return [created, completed]


# ----- SDK-shaped fake streams ---------------------------------------------


class _FakeStream:
    """Shape of ``anthropic.Stream`` / ``openai.Stream``: iterable, a
    context manager whose __enter__ returns itself, and ``close()``."""

    def __init__(self, events: list[Any]) -> None:
        self._events = events
        self.closed = False
        self.request_id = "req_fake"

    def __enter__(self) -> _FakeStream:
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    def __iter__(self) -> Any:
        return iter(self._events)

    def close(self) -> None:
        self.closed = True


class _ExplodingStream(_FakeStream):
    """Yields message_start, then fails mid-stream."""

    def __iter__(self) -> Any:
        yield self._events[0]
        raise RuntimeError("connection reset")


class _FakeAsyncStream:
    def __init__(self, events: list[Any]) -> None:
        self._events = events
        self.closed = False
        self.request_id = "req_async"

    async def __aenter__(self) -> _FakeAsyncStream:
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.close()

    def __aiter__(self) -> Any:
        async def _gen() -> Any:
            for e in self._events:
                yield e

        return _gen()

    async def close(self) -> None:
        self.closed = True


class _ExplodingAsyncStream(_FakeAsyncStream):
    def __aiter__(self) -> Any:
        async def _gen() -> Any:
            yield self._events[0]
            raise RuntimeError("connection reset")

        return _gen()


class _SyncManager:
    """What ``messages.stream()`` returns: a context manager yielding the
    real ``MessageStream`` built over a fake raw stream."""

    def __init__(self, events: list[Any]) -> None:
        self.raw = _FakeStream(events)
        self.helper = MessageStream(self.raw, output_format=NOT_GIVEN)  # type: ignore[arg-type]

    def __enter__(self) -> MessageStream:
        return self.helper

    def __exit__(self, *exc: Any) -> None:
        self.helper.close()


class _AsyncManager:
    def __init__(self, events: list[Any]) -> None:
        self.raw = _FakeAsyncStream(events)
        self.helper = AsyncMessageStream(self.raw, output_format=NOT_GIVEN)  # type: ignore[arg-type]

    async def __aenter__(self) -> AsyncMessageStream:
        return self.helper

    async def __aexit__(self, *exc: Any) -> None:
        await self.helper.close()


# ----- session fixture -----------------------------------------------------


def _session(
    token_limit: int | None = None, block_at_pct: int = 100, capture_prompts: bool = False
) -> Session:
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
    session = Session(config=config, client=client)
    session.policy = PolicyCache(token_limit=token_limit, block_at_pct=block_at_pct)
    session.event_queue = MagicMock()
    return session


def _events_of(session: Session, event_type: str) -> list[dict[str, Any]]:
    queue = session.event_queue
    assert isinstance(queue, MagicMock)
    return [
        c.args[0] for c in queue.enqueue.call_args_list if c.args[0].get("event_type") == event_type
    ]


def _post_calls(session: Session) -> list[dict[str, Any]]:
    return _events_of(session, "post_call")


def _llm_errors(session: Session) -> list[dict[str, Any]]:
    return _events_of(session, "llm_error")


KW = {"model": "claude-haiku-4-5", "messages": [{"role": "user", "content": PROMPT}]}
OPENAI_KW = {"model": "gpt-5.5", "messages": [{"role": "user", "content": PROMPT}], "stream": True}


def _stream(session: Session, events: list[Any], provider: Any = None) -> base.GuardedStream:
    provider = provider or AnthropicProvider()
    return base.call_stream(lambda **kw: _FakeStream(events), dict(KW), session, provider)


# ----- Anthropic raw stream -------------------------------------------------


def test_anthropic_with_block_meters_input_cache_and_cumulative_output() -> None:
    session = _session()
    stream = _FakeStream(_anthropic_events())
    guarded = base.call_stream(lambda **kw: stream, dict(KW), session, AnthropicProvider())
    with guarded as s:
        seen = list(s)
    assert len(seen) == N_EVENTS
    (pc,) = _post_calls(session)
    assert pc["tokens_input"] == 16  # 12 + 4 cache read
    assert pc["tokens_output"] == 9
    assert pc["tokens_cache_read"] == 4
    assert pc["streaming"]["chunk_count"] == N_EVENTS
    assert pc["streaming"]["final_outcome"] == "completed"
    assert pc["streaming"]["abort_reason"] is None
    assert stream.closed


def test_anthropic_plain_iteration_without_with_block() -> None:
    session = _session()
    guarded = _stream(session, _anthropic_events())
    assert len(list(guarded)) == N_EVENTS
    (pc,) = _post_calls(session)
    assert (pc["tokens_input"], pc["tokens_output"]) == (16, 9)
    # Exhaustion emitted it once; a later close() must not emit again.
    guarded.close()
    assert len(_post_calls(session)) == 1


def test_anthropic_early_break_reports_usage_seen_so_far_as_aborted() -> None:
    session = _session()
    with _stream(session, _anthropic_events()) as s:
        for _ in s:
            break  # only message_start consumed
    (pc,) = _post_calls(session)
    assert (pc["tokens_input"], pc["tokens_output"]) == (16, 1)
    assert pc["streaming"]["chunk_count"] == 1
    assert (pc["streaming"]["final_outcome"], pc["streaming"]["abort_reason"]) == (
        "aborted",
        "client_aborted",
    )


def test_close_after_plain_iteration_break_emits_one_post_call() -> None:
    session = _session()
    guarded = _stream(session, _anthropic_events())
    for _ in guarded:
        break
    assert _post_calls(session) == []
    guarded.close()
    guarded.close()
    (pc,) = _post_calls(session)
    assert (pc["tokens_input"], pc["tokens_output"]) == (16, 1)
    assert pc["streaming"]["final_outcome"] == "aborted"


def test_abandoned_plain_loop_settles_when_the_guard_is_collected() -> None:
    session = _session()
    guarded = _stream(session, _anthropic_events())
    for _ in guarded:
        break
    assert _post_calls(session) == []
    del guarded
    gc.collect()
    (pc,) = _post_calls(session)
    assert (pc["tokens_input"], pc["tokens_output"]) == (16, 1)
    assert pc["streaming"]["final_outcome"] == "aborted"


def test_close_on_a_never_iterated_guard_opens_nothing_and_emits_nothing() -> None:
    session = _session()
    real_fn = MagicMock()
    guarded = base.call_stream(real_fn, dict(KW), session, AnthropicProvider())
    guarded.close()
    real_fn.assert_not_called()
    assert _post_calls(session) == [] and _llm_errors(session) == []


def test_mid_stream_failure_inside_with_reports_partial_tokens_once() -> None:
    session = _session()
    guarded = base.call_stream(
        lambda **kw: _ExplodingStream(_anthropic_events()), dict(KW), session, AnthropicProvider()
    )
    with pytest.raises(RuntimeError), guarded as s:
        for _ in s:
            pass
    assert _post_calls(session) == []
    (err,) = _llm_errors(session)  # one, not one from __next__ and one from __exit__
    assert err["error"]["abort_reason"] == "error_mid_stream"
    assert err["error"]["partial_chunks"] == 1
    assert err["error"]["partial_tokens_input"] == 16
    assert err["error"]["partial_tokens_output"] == 1
    assert session.tokens_used == 17


def test_mid_stream_failure_on_plain_iteration_emits_llm_error() -> None:
    session = _session()
    guarded = base.call_stream(
        lambda **kw: _ExplodingStream(_anthropic_events()), dict(KW), session, AnthropicProvider()
    )
    with pytest.raises(RuntimeError):
        for _ in guarded:
            pass
    assert _post_calls(session) == []
    (err,) = _llm_errors(session)
    assert err["error"]["abort_reason"] == "error_mid_stream"
    assert err["error"]["partial_chunks"] == 1


def test_pre_stream_failure_emits_llm_error_on_plain_iteration() -> None:
    session = _session()

    def _boom(**kw: Any) -> Any:
        raise RuntimeError("connection refused")

    guarded = base.call_stream(_boom, dict(KW), session, AnthropicProvider())
    with pytest.raises(RuntimeError):
        for _ in guarded:
            pass
    assert _post_calls(session) == []
    (err,) = _llm_errors(session)
    assert err["error"]["abort_reason"] == "error_before_stream"
    assert err["error"]["partial_chunks"] == 0


def test_timeout_classification_of_stream_failure() -> None:
    timeout_cls = type("APITimeoutError", (Exception,), {})
    assert base._abort_reason_for(timeout_cls(), True) == (True, "timeout")
    assert base._abort_reason_for(RuntimeError(), False) == (False, "error_before_stream")


# ----- Anthropic helper stream (real MessageStream classes) ------------------


def test_sync_helper_text_stream_is_metered_through_the_guard() -> None:
    session = _session()
    manager = _SyncManager(_anthropic_events())
    guarded = base.call_stream(lambda **kw: manager, dict(KW), session, AnthropicProvider())
    with guarded as s:
        text = "".join(s.text_stream)
    assert text == "Hello"
    (pc,) = _post_calls(session)
    assert (pc["tokens_input"], pc["tokens_output"]) == (16, 9)
    assert pc["streaming"]["chunk_count"] == N_HELPER_EVENTS
    assert pc["streaming"]["final_outcome"] == "completed"


def test_sync_helper_early_exit_uses_snapshot_usage_and_is_aborted() -> None:
    session = _session()
    manager = _SyncManager(_anthropic_events())
    guarded = base.call_stream(lambda **kw: manager, dict(KW), session, AnthropicProvider())
    with guarded as s:
        next(iter(s))  # message_start only
    (pc,) = _post_calls(session)
    assert (pc["tokens_input"], pc["tokens_output"]) == (16, 1)
    assert pc["streaming"]["final_outcome"] == "aborted"


def test_sync_helper_get_final_message_is_the_captured_response() -> None:
    session = _session(capture_prompts=True)
    manager = _SyncManager(_anthropic_events())
    # The adapter carries the capture flag the interceptor passes it at
    # patch()/wrap() time; construct it the way production does.
    guarded = base.call_stream(
        lambda **kw: manager, dict(KW), session, AnthropicProvider(capture_prompts=True)
    )
    with guarded as s:
        final = s.get_final_message()
    assert final.usage.output_tokens == 9 and final.content[0].text == "Hello"  # type: ignore[union-attr]
    (pc,) = _post_calls(session)
    assert (pc["tokens_input"], pc["tokens_output"]) == (16, 9)
    assert pc["has_content"] is True
    assert pc["content"]["response"]["content"][0]["text"] == "Hello"


def test_async_helper_text_stream_is_metered_and_captures_the_final_message() -> None:
    session = _session(capture_prompts=True)
    manager = _AsyncManager(_anthropic_events())
    guarded = base.call_stream_async(
        lambda **kw: manager, dict(KW), session, AnthropicProvider(capture_prompts=True)
    )

    async def _run() -> str:
        async with guarded as s:
            return "".join([t async for t in s.text_stream])

    assert asyncio.run(_run()) == "Hello"
    (pc,) = _post_calls(session)
    assert (pc["tokens_input"], pc["tokens_output"]) == (16, 9)
    assert pc["streaming"]["chunk_count"] == N_HELPER_EVENTS
    assert pc["streaming"]["final_outcome"] == "completed"
    assert pc["content"]["response"]["content"][0]["text"] == "Hello"
    assert manager.raw.closed


def test_async_helper_awaited_final_message_is_metered() -> None:
    session = _session()
    manager = _AsyncManager(_anthropic_events())
    guarded = base.call_stream_async(lambda **kw: manager, dict(KW), session, AnthropicProvider())

    async def _run() -> Message:
        async with guarded as s:
            return await s.get_final_message()

    assert asyncio.run(_run()).usage.output_tokens == 9
    (pc,) = _post_calls(session)
    assert (pc["tokens_input"], pc["tokens_output"]) == (16, 9)
    assert pc["streaming"]["final_outcome"] == "completed"


def test_async_helper_early_exit_is_aborted_with_snapshot_usage() -> None:
    session = _session()
    manager = _AsyncManager(_anthropic_events())
    guarded = base.call_stream_async(lambda **kw: manager, dict(KW), session, AnthropicProvider())

    async def _run() -> None:
        async with guarded as s:
            async for _ in s:
                break

    asyncio.run(_run())
    (pc,) = _post_calls(session)
    assert (pc["tokens_input"], pc["tokens_output"]) == (16, 1)
    assert pc["streaming"]["final_outcome"] == "aborted"


# ----- attribute proxying ------------------------------------------------------


def test_sync_guard_proxies_sdk_attributes_and_private_probes_do_not_open() -> None:
    session = _session()
    real_fn = MagicMock(return_value=_FakeStream(_anthropic_events()))
    guarded = base.call_stream(real_fn, dict(KW), session, AnthropicProvider())
    assert not hasattr(guarded, "_not_a_real_attribute")
    assert not hasattr(guarded, "__aiter__")
    real_fn.assert_not_called()
    assert guarded.request_id == "req_fake"  # public names open and proxy
    real_fn.assert_called_once()
    guarded.close()


def test_async_guard_proxies_attributes_only_after_the_stream_is_open() -> None:
    session = _session()
    guarded = base.call_stream_async(
        lambda **kw: _FakeAsyncStream(_anthropic_events()), dict(KW), session, AnthropicProvider()
    )
    with pytest.raises(AttributeError):
        _ = guarded.request_id

    async def _run() -> str:
        async with guarded as s:
            return str(s.request_id)

    assert asyncio.run(_run()) == "req_async"


# ----- OpenAI chat and Responses -----------------------------------------


def test_openai_chat_final_usage_chunk_is_metered() -> None:
    session = _session()
    guarded = base.call_stream(
        lambda **kw: _FakeStream(_openai_chat_events()), dict(OPENAI_KW), session, OpenAIProvider()
    )
    for _ in guarded:
        pass
    (pc,) = _post_calls(session)
    assert (pc["tokens_input"], pc["tokens_output"]) == (20, 7)
    assert pc["streaming"]["chunk_count"] == 3
    assert pc["streaming"]["final_outcome"] == "completed"


def test_openai_responses_completed_event_is_metered() -> None:
    session = _session()
    guarded = base.call_stream(
        lambda **kw: _FakeStream(_responses_events()),
        {"model": "gpt-5.5", "input": PROMPT, "stream": True},
        session,
        OpenAIProvider(),
    )
    with guarded as s:
        for _ in s:
            pass
    (pc,) = _post_calls(session)
    assert (pc["tokens_input"], pc["tokens_output"]) == (15, 6)


def test_stream_without_any_usage_falls_back_to_estimate_input_only() -> None:
    session = _session()
    guarded = base.call_stream(
        lambda **kw: _FakeStream([_openai_chunk(None), _openai_chunk(None)]),
        dict(OPENAI_KW),
        session,
        OpenAIProvider(),
    )
    list(guarded)
    (pc,) = _post_calls(session)
    assert pc["tokens_output"] == 0
    assert pc["tokens_input"] > 0  # the pre-call estimate


def test_openai_early_exit_is_aborted() -> None:
    session = _session()
    guarded = base.call_stream(
        lambda **kw: _FakeStream(_openai_chat_events()), dict(OPENAI_KW), session, OpenAIProvider()
    )
    with guarded as s:
        next(iter(s))
    (pc,) = _post_calls(session)
    assert (pc["streaming"]["final_outcome"], pc["streaming"]["abort_reason"]) == (
        "aborted",
        "client_aborted",
    )


# ----- async guard ----------------------------------------------------------


def test_async_for_without_async_with_meters_anthropic_stream() -> None:
    session = _session()

    async def _run() -> int:
        guarded = base.call_stream_async(
            lambda **kw: _FakeAsyncStream(_anthropic_events()),
            dict(KW),
            session,
            AnthropicProvider(),
        )
        n = 0
        async for _ in guarded:
            n += 1
        return n

    assert asyncio.run(_run()) == N_EVENTS
    (pc,) = _post_calls(session)
    assert (pc["tokens_input"], pc["tokens_output"]) == (16, 9)


def test_async_close_after_break_emits_a_single_aborted_post_call() -> None:
    session = _session()
    stream = _FakeAsyncStream(_anthropic_events())

    async def _run() -> None:
        guarded = base.call_stream_async(
            lambda **kw: stream, dict(KW), session, AnthropicProvider()
        )
        async for _ in guarded:
            break
        assert _post_calls(session) == []
        await guarded.close()
        await guarded.close()

    asyncio.run(_run())
    assert stream.closed
    (pc,) = _post_calls(session)
    assert (pc["tokens_input"], pc["tokens_output"]) == (16, 1)
    assert pc["streaming"]["final_outcome"] == "aborted"


def test_async_with_early_break_on_a_coroutine_returning_stream() -> None:
    session = _session()
    stream = _FakeAsyncStream(_openai_chat_events())

    async def _create(**kw: Any) -> _FakeAsyncStream:
        return stream

    async def _run() -> None:
        guarded = base.call_stream_async(_create, dict(OPENAI_KW), session, OpenAIProvider())
        async with guarded as s:
            async for _ in s:
                break

    asyncio.run(_run())
    assert stream.closed
    (pc,) = _post_calls(session)
    assert pc["streaming"]["chunk_count"] == 1
    assert pc["streaming"]["final_outcome"] == "aborted"


def test_async_mid_stream_failure_on_plain_iteration_emits_llm_error() -> None:
    session = _session()

    async def _run() -> None:
        guarded = base.call_stream_async(
            lambda **kw: _ExplodingAsyncStream(_anthropic_events()),
            dict(KW),
            session,
            AnthropicProvider(),
        )
        async for _ in guarded:
            pass

    with pytest.raises(RuntimeError):
        asyncio.run(_run())
    (err,) = _llm_errors(session)
    assert err["error"]["abort_reason"] == "error_mid_stream"
    assert err["error"]["partial_tokens_input"] == 16


def test_async_pre_stream_failure_emits_llm_error() -> None:
    session = _session()

    def _boom(**kw: Any) -> Any:
        raise RuntimeError("connection refused")

    async def _run() -> None:
        guarded = base.call_stream_async(_boom, dict(KW), session, AnthropicProvider())
        async for _ in guarded:
            pass

    with pytest.raises(RuntimeError):
        asyncio.run(_run())
    (err,) = _llm_errors(session)
    assert err["error"]["abort_reason"] == "error_before_stream"
    assert err["error"]["partial_chunks"] == 0


# ----- accounting across calls and capture posture ----------------------------


def test_two_consecutive_streams_accumulate_the_session_total() -> None:
    session = _session()
    list(_stream(session, _anthropic_events()))
    list(_stream(session, _anthropic_events()))
    first, second = _post_calls(session)
    assert (first["tokens_used_session"], second["tokens_used_session"]) == (25, 50)
    assert session.tokens_used == 50


def test_streamed_usage_crossing_the_limit_blocks_the_next_call() -> None:
    session = _session(token_limit=30, block_at_pct=80)
    list(_stream(session, _anthropic_events()))  # 25 of 30 tokens: past 80%
    (pc,) = _post_calls(session)
    assert pc["policy_decision_post"]["decision"] == "block"
    with pytest.raises(BudgetExceededError):
        _stream(session, _anthropic_events())


@pytest.mark.parametrize("shape", ["raw", "helper", "responses"])
def test_streamed_post_call_carries_no_content_when_capture_is_off(shape: str) -> None:
    session = _session(capture_prompts=False)
    if shape == "raw":
        guarded = _stream(session, _anthropic_events())
    elif shape == "helper":
        guarded = base.call_stream(
            lambda **kw: _SyncManager(_anthropic_events()), dict(KW), session, AnthropicProvider()
        )
    else:
        guarded = base.call_stream(
            lambda **kw: _FakeStream(_responses_events()),
            {"model": "gpt-5.5", "input": PROMPT, "stream": True},
            session,
            OpenAIProvider(),
        )
    with guarded as s:
        list(s)
    (pc,) = _post_calls(session)
    assert not pc.get("has_content")
    assert pc.get("content") is None
    assert PROMPT not in json.dumps(pc)


# ----- usage merging ------------------------------------------------------------


def test_message_delta_with_cumulative_input_and_cache_supersedes_message_start() -> None:
    session = _session()
    events = _anthropic_events(
        {
            "input_tokens": 100,
            "cache_read_input_tokens": 4,
            "cache_creation_input_tokens": 0,
            "output_tokens": 9,
        }
    )
    list(_stream(session, events))
    (pc,) = _post_calls(session)
    assert (pc["tokens_input"], pc["tokens_output"], pc["tokens_cache_read"]) == (104, 9, 4)


def test_message_delta_without_cache_fields_keeps_the_start_input_total() -> None:
    provider = AnthropicProvider()
    delta = _anthropic_events({"input_tokens": 100, "output_tokens": 9})[5]
    usage = provider.usage_from_stream_chunk(delta)
    assert usage == TokenUsage(input_tokens=0, output_tokens=9)
    merged = base._merge_usage(
        TokenUsage(input_tokens=16, output_tokens=1, cache_read_tokens=4), usage
    )
    assert (merged.input_tokens, merged.output_tokens, merged.cache_read_tokens) == (16, 9, 4)


def test_provider_that_raises_while_reading_a_chunk_never_breaks_the_stream() -> None:
    session = _session()
    provider = AnthropicProvider()
    provider.usage_from_stream_chunk = MagicMock(side_effect=RuntimeError("bad chunk"))  # type: ignore[method-assign]
    assert len(list(_stream(session, _anthropic_events(), provider))) == N_EVENTS
    (pc,) = _post_calls(session)
    assert pc["tokens_input"] > 0  # the estimate; the caller never saw the failure


def test_litellm_provider_reads_usage_from_the_final_chunk_only() -> None:
    provider = LitellmProvider()
    assert provider.usage_from_stream_chunk(MagicMock(usage=None)) is None
    final = MagicMock(usage=MagicMock(prompt_tokens=8, completion_tokens=3))
    assert provider.usage_from_stream_chunk(final) == TokenUsage(input_tokens=8, output_tokens=3)
    assert provider.usage_from_finished_stream(final) is None
    assert provider.stream_completed(final) is None


# ----- interceptor routing ---------------------------------------------------


def test_sensor_messages_create_stream_true_opens_eagerly_and_meters() -> None:
    session = _session()
    real = MagicMock()
    real.create = MagicMock(return_value=_FakeStream(_anthropic_events()))
    messages = SensorMessages(real, session, AnthropicProvider())
    guarded = messages.create(stream=True, **KW)
    assert isinstance(guarded, base.GuardedStream)
    real.create.assert_called_once()  # the request is sent at create(), as on the SDK
    list(guarded)
    (pc,) = _post_calls(session)
    assert pc["tokens_output"] == 9


def test_sensor_messages_create_stream_true_raises_provider_errors_at_the_call() -> None:
    session = _session()
    real = MagicMock()
    real.create = MagicMock(side_effect=RuntimeError("401 unauthorized"))
    messages = SensorMessages(real, session, AnthropicProvider())
    with pytest.raises(RuntimeError):
        messages.create(stream=True, **KW)
    (err,) = _llm_errors(session)
    assert err["error"]["abort_reason"] == "error_before_stream"


def test_async_sensor_messages_create_stream_true_returns_coroutine_to_guard() -> None:
    session = _session()
    real = MagicMock()
    real.create = MagicMock(return_value=_FakeAsyncStream(_anthropic_events()))
    messages = SensorMessages(real, session, AnthropicProvider(), is_async=True)

    async def _run() -> None:
        guarded = await messages.create(stream=True, **KW)
        assert isinstance(guarded, base.GuardedAsyncStream)
        real.create.assert_called_once()
        async for _ in guarded:
            pass

    asyncio.run(_run())
    (pc,) = _post_calls(session)
    assert pc["tokens_output"] == 9


def test_sensor_responses_create_stream_true_returns_guard() -> None:
    session = _session()
    real = MagicMock()
    real.create = MagicMock(return_value=_FakeStream(_responses_events()))
    responses = SensorResponses(real, session, OpenAIProvider())
    guarded = responses.create(model="gpt-5.5", input=PROMPT, stream=True)
    assert isinstance(guarded, base.GuardedStream)
    with guarded as s:
        list(s)
    (pc,) = _post_calls(session)
    assert (pc["tokens_input"], pc["tokens_output"]) == (15, 6)


def test_async_sensor_responses_create_stream_true_returns_coroutine_to_guard() -> None:
    session = _session()
    real = MagicMock()
    real.create = MagicMock(return_value=_FakeAsyncStream(_responses_events()))
    responses = SensorResponses(real, session, OpenAIProvider(), is_async=True)

    async def _run() -> None:
        guarded = await responses.create(model="gpt-5.5", input=PROMPT, stream=True)
        assert isinstance(guarded, base.GuardedAsyncStream)
        async for _ in guarded:
            pass

    asyncio.run(_run())
    (pc,) = _post_calls(session)
    assert (pc["tokens_input"], pc["tokens_output"]) == (15, 6)


def test_budget_block_raises_before_the_stream_is_opened() -> None:
    session = _session(token_limit=10, block_at_pct=50)
    session._tokens_used = 9
    real = MagicMock()
    messages = SensorMessages(real, session, AnthropicProvider())
    with pytest.raises(BudgetExceededError):
        messages.create(stream=True, **KW)
    real.create.assert_not_called()


# ----- protocol conformance ----------------------------------------------------


@pytest.mark.parametrize("adapter", [AnthropicProvider, OpenAIProvider, LitellmProvider])
def test_every_adapter_implements_every_provider_method(adapter: type) -> None:
    # A missing stream hook would be swallowed inside the guard's
    # try/except and silently drop every streamed post_call.
    members = [n for n in dir(Provider) if not n.startswith("_")]
    assert {"usage_from_stream_chunk", "stream_completed", "final_message"} <= set(members)
    for name in members:
        assert callable(getattr(adapter, name, None)), f"{adapter.__name__} lacks {name}"
