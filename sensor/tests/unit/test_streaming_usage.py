"""Token accounting on streamed calls, driven with the real SDK event
classes rather than mocks that carry a ``usage`` attribute no real
stream object has.

Covers the sync and async guards used with and without a ``with``
block, early exits, the Anthropic helper stream consumed through
``text_stream``, the OpenAI chat and Responses chunk shapes, attribute
proxying, and the ``create(stream=True)`` routing in both interceptors.
"""

from __future__ import annotations

import asyncio
from typing import Any
from unittest.mock import MagicMock

import pytest
from anthropic.types import Message, RawMessageDeltaEvent, RawMessageStartEvent
from openai.types.chat import ChatCompletionChunk
from openai.types.responses import Response, ResponseCompletedEvent, ResponseUsage

from flightdeck_sensor.core.exceptions import BudgetExceededError
from flightdeck_sensor.core.policy import PolicyCache
from flightdeck_sensor.core.session import Session
from flightdeck_sensor.core.types import SensorConfig
from flightdeck_sensor.interceptor import base
from flightdeck_sensor.interceptor.anthropic import SensorMessages
from flightdeck_sensor.interceptor.openai import SensorResponses
from flightdeck_sensor.providers.anthropic import AnthropicProvider
from flightdeck_sensor.providers.openai import OpenAIProvider
from flightdeck_sensor.transport.client import ControlPlaneClient

# ----- real SDK events --------------------------------------------------


def _anthropic_start(input_tokens: int = 12, cache_read: int = 4) -> RawMessageStartEvent:
    return RawMessageStartEvent.model_validate(
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
                "usage": {
                    "input_tokens": input_tokens,
                    "output_tokens": 1,
                    "cache_read_input_tokens": cache_read,
                    "cache_creation_input_tokens": 0,
                },
            },
        }
    )


def _anthropic_delta(output_tokens: int) -> RawMessageDeltaEvent:
    return RawMessageDeltaEvent.model_validate(
        {
            "type": "message_delta",
            "delta": {"stop_reason": "end_turn", "stop_sequence": None},
            "usage": {"output_tokens": output_tokens},
        }
    )


def _anthropic_events() -> list[Any]:
    # message_start (input + cache), a content delta without usage, the
    # cumulative message_delta, message_stop.
    return [
        _anthropic_start(),
        MagicMock(type="content_block_delta", spec=["type"]),
        _anthropic_delta(9),
        MagicMock(type="message_stop", spec=["type"]),
    ]


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


class _FakeAsyncStream:
    def __init__(self, events: list[Any]) -> None:
        self._events = events
        self.closed = False

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


class _FakeMessageStreamManager:
    """Shape of ``messages.stream()``: a context manager yielding a
    helper stream that exposes ``text_stream`` and ``get_final_message``."""

    def __init__(self, events: list[Any], final: Message) -> None:
        self._stream = _FakeHelperStream(events, final)

    def __enter__(self) -> _FakeHelperStream:
        return self._stream

    def __exit__(self, *exc: Any) -> None:
        self._stream.close()


class _FakeHelperStream(_FakeStream):
    def __init__(self, events: list[Any], final: Message) -> None:
        super().__init__(events)
        self._final = final
        self.current_message_snapshot: Any = None
        self.final_message_reads = 0

    @property
    def text_stream(self) -> Any:
        # Consumes the events internally, exactly as the SDK helper does,
        # so the guard never sees them as chunks.
        for e in self._events:
            if getattr(e, "type", None) == "message_delta":
                self.current_message_snapshot = self._final
            yield "x"

    def get_final_message(self) -> Message:
        self.final_message_reads += 1
        return self._final


def _final_message(input_tokens: int = 12, output_tokens: int = 9) -> Message:
    return Message.model_validate(
        {
            "id": "msg_1",
            "type": "message",
            "role": "assistant",
            "model": "claude-haiku-4-5",
            "content": [{"type": "text", "text": "hello"}],
            "stop_reason": "end_turn",
            "stop_sequence": None,
            "usage": {
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "cache_read_input_tokens": 4,
                "cache_creation_input_tokens": 0,
            },
        }
    )


# ----- session fixture -----------------------------------------------------


def _session(token_limit: int | None = None, block_at_pct: int = 100) -> Session:
    config = SensorConfig(
        server="http://localhost:9999",
        token="tok",
        agent_flavor="test",
        agent_type="production",
        quiet=True,
    )
    client = MagicMock(spec=ControlPlaneClient)
    client.post_event.return_value = (None, False)
    session = Session(config=config, client=client)
    session.policy = PolicyCache(token_limit=token_limit, block_at_pct=block_at_pct)
    session.event_queue = MagicMock()
    return session


def _post_calls(session: Session) -> list[dict[str, Any]]:
    queue = session.event_queue
    assert isinstance(queue, MagicMock)
    return [
        c.args[0]
        for c in queue.enqueue.call_args_list
        if c.args[0].get("event_type") == "post_call"
    ]


def _llm_errors(session: Session) -> list[dict[str, Any]]:
    queue = session.event_queue
    assert isinstance(queue, MagicMock)
    return [
        c.args[0]
        for c in queue.enqueue.call_args_list
        if c.args[0].get("event_type") == "llm_error"
    ]


KW = {"model": "claude-haiku-4-5", "messages": [{"role": "user", "content": "hi"}]}


# ----- Anthropic raw stream -------------------------------------------------


def test_anthropic_with_block_meters_input_cache_and_cumulative_output() -> None:
    session = _session()
    stream = _FakeStream(_anthropic_events())
    guarded = base.call_stream(lambda **kw: stream, dict(KW), session, AnthropicProvider())
    with guarded as s:
        seen = list(s)
    assert len(seen) == 4
    (pc,) = _post_calls(session)
    assert pc["tokens_input"] == 16  # 12 + 4 cache read
    assert pc["tokens_output"] == 9
    assert pc["tokens_cache_read"] == 4
    assert pc["streaming"]["chunk_count"] == 4
    assert stream.closed


def test_anthropic_plain_iteration_without_with_block() -> None:
    session = _session()
    guarded = base.call_stream(
        lambda **kw: _FakeStream(_anthropic_events()), dict(KW), session, AnthropicProvider()
    )
    chunks = [c for c in guarded]
    assert len(chunks) == 4
    (pc,) = _post_calls(session)
    assert (pc["tokens_input"], pc["tokens_output"]) == (16, 9)
    # Exhaustion emitted it once; a later close() must not emit again.
    guarded.close()
    assert len(_post_calls(session)) == 1


def test_anthropic_early_break_reports_usage_seen_so_far() -> None:
    session = _session()
    guarded = base.call_stream(
        lambda **kw: _FakeStream(_anthropic_events()), dict(KW), session, AnthropicProvider()
    )
    with guarded as s:
        for _ in s:
            break  # only message_start consumed
    (pc,) = _post_calls(session)
    assert pc["tokens_input"] == 16
    assert pc["tokens_output"] == 1  # the first output token message_start reports
    assert pc["streaming"]["chunk_count"] == 1


def test_anthropic_helper_stream_consumed_via_text_stream_uses_final_message() -> None:
    session = _session()
    manager = _FakeMessageStreamManager(_anthropic_events(), _final_message())
    guarded = base.call_stream(lambda **kw: manager, dict(KW), session, AnthropicProvider())
    with guarded as s:
        text = "".join(s.text_stream)  # proxied attribute; guard sees no chunks
    assert text == "xxxx"
    (pc,) = _post_calls(session)
    assert (pc["tokens_input"], pc["tokens_output"]) == (16, 9)
    assert pc["streaming"]["chunk_count"] == 0


def test_anthropic_helper_stream_early_exit_never_reads_final_message() -> None:
    session = _session()
    helper = _FakeHelperStream(_anthropic_events(), _final_message())
    manager = MagicMock()
    manager.__enter__ = MagicMock(return_value=helper)
    manager.__exit__ = MagicMock(return_value=None)
    guarded = base.call_stream(lambda **kw: manager, dict(KW), session, AnthropicProvider())
    with guarded as s:
        next(iter(s))  # message_start only; snapshot has no stop_reason yet
    assert helper.final_message_reads == 0
    (pc,) = _post_calls(session)
    assert (pc["tokens_input"], pc["tokens_output"]) == (16, 1)


def test_guard_proxies_sdk_stream_attributes() -> None:
    session = _session()
    guarded = base.call_stream(
        lambda **kw: _FakeStream(_anthropic_events()), dict(KW), session, AnthropicProvider()
    )
    assert guarded.request_id == "req_fake"
    assert not hasattr(guarded, "__aiter__")
    with pytest.raises(AttributeError):
        guarded._not_a_real_attribute  # noqa: B018


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


# ----- OpenAI chat and Responses -----------------------------------------


def test_openai_chat_final_usage_chunk_is_metered() -> None:
    session = _session()
    guarded = base.call_stream(
        lambda **kw: _FakeStream(_openai_chat_events()),
        {"model": "gpt-5.5", "messages": [{"role": "user", "content": "hi"}], "stream": True},
        session,
        OpenAIProvider(),
    )
    for _ in guarded:
        pass
    (pc,) = _post_calls(session)
    assert (pc["tokens_input"], pc["tokens_output"]) == (20, 7)
    assert pc["streaming"]["chunk_count"] == 3


def test_openai_responses_completed_event_is_metered() -> None:
    session = _session()
    guarded = base.call_stream(
        lambda **kw: _FakeStream(_responses_events()),
        {"model": "gpt-5.5", "input": "hi", "stream": True},
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
        {"model": "gpt-5.5", "messages": [{"role": "user", "content": "hi"}], "stream": True},
        session,
        OpenAIProvider(),
    )
    list(guarded)
    (pc,) = _post_calls(session)
    assert pc["tokens_output"] == 0
    assert pc["tokens_input"] > 0  # the pre-call estimate


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

    assert asyncio.run(_run()) == 4
    (pc,) = _post_calls(session)
    assert (pc["tokens_input"], pc["tokens_output"]) == (16, 9)


def test_async_with_early_break_and_coroutine_returning_stream() -> None:
    session = _session()
    stream = _FakeAsyncStream(_openai_chat_events())

    async def _create(**kw: Any) -> _FakeAsyncStream:
        return stream

    async def _run() -> None:
        guarded = base.call_stream_async(
            _create, {"model": "gpt-5.5", "messages": [], "stream": True}, session, OpenAIProvider()
        )
        async with guarded as s:
            async for _ in s:
                break

    asyncio.run(_run())
    assert stream.closed
    (pc,) = _post_calls(session)
    assert pc["tokens_output"] == 0 and pc["streaming"]["chunk_count"] == 1


# ----- interceptor routing ---------------------------------------------------


def test_sensor_messages_create_stream_true_returns_guard() -> None:
    session = _session()
    real = MagicMock()
    real.create = MagicMock(return_value=_FakeStream(_anthropic_events()))
    messages = SensorMessages(real, session, AnthropicProvider())
    guarded = messages.create(stream=True, **KW)
    assert isinstance(guarded, base.GuardedStream)
    real.create.assert_not_called()  # lazy until iterated
    list(guarded)
    real.create.assert_called_once()
    (pc,) = _post_calls(session)
    assert pc["tokens_output"] == 9


def test_async_sensor_messages_create_stream_true_returns_coroutine_to_guard() -> None:
    session = _session()
    real = MagicMock()
    real.create = MagicMock(return_value=_FakeAsyncStream(_anthropic_events()))
    messages = SensorMessages(real, session, AnthropicProvider(), is_async=True)

    async def _run() -> None:
        guarded = await messages.create(stream=True, **KW)
        assert isinstance(guarded, base.GuardedAsyncStream)
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
    guarded = responses.create(model="gpt-5.5", input="hi", stream=True)
    assert isinstance(guarded, base.GuardedStream)
    with guarded as s:
        list(s)
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
