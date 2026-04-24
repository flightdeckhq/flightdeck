"""Tests for interceptor: call, call_async, call_stream, GuardedStream."""

from __future__ import annotations

import asyncio
from typing import Any
from unittest.mock import MagicMock

import pytest

from flightdeck_sensor.core.exceptions import BudgetExceededError, DirectiveError
from flightdeck_sensor.core.policy import PolicyCache
from flightdeck_sensor.core.session import Session
from flightdeck_sensor.core.types import SensorConfig
from flightdeck_sensor.interceptor import base
from flightdeck_sensor.providers.anthropic import AnthropicProvider
from flightdeck_sensor.transport.client import ControlPlaneClient


class _Usage:
    def __init__(self, **kw: int) -> None:
        for k, v in kw.items():
            setattr(self, k, v)


class _Resp:
    def __init__(self, usage: _Usage, model: str, chunks: list[str] | None = None) -> None:
        self.usage = usage
        self.model = model
        self._chunks = chunks or []

    def __iter__(self) -> Any:
        return iter(self._chunks)


def _make_session_and_provider(
    token_limit: int | None = None,
    block_at_pct: int = 100,
) -> tuple[Session, AnthropicProvider]:
    config = SensorConfig(
        server="http://localhost:9999", token="tok",
        agent_flavor="test", agent_type="production", quiet=True,
    )
    client = MagicMock(spec=ControlPlaneClient)
    client.post_event.return_value = (None, False)
    session = Session(config=config, client=client)
    session.policy = PolicyCache(token_limit=token_limit, block_at_pct=block_at_pct)
    provider = AnthropicProvider()
    return session, provider


def test_block_raises_before_real_fn_called() -> None:
    session, provider = _make_session_and_provider(token_limit=100, block_at_pct=50)
    session._tokens_used = 90
    real_fn = MagicMock()
    kwargs = {"model": "claude-sonnet-4-20250514", "messages": [{"role": "user", "content": "hi"}]}
    with pytest.raises(BudgetExceededError):
        base.call(real_fn, kwargs, session, provider)
    assert real_fn.call_count == 0


def test_degrade_swaps_model_without_mutating_original() -> None:
    session, provider = _make_session_and_provider(token_limit=1000, block_at_pct=100)
    session.policy.degrade_at_pct = 50
    session.policy.degrade_to = "claude-haiku-4-5-20251001"
    session._tokens_used = 600

    original_kwargs = {"model": "claude-sonnet-4-20250514", "messages": [{"role": "user", "content": "hi"}]}
    original_model = original_kwargs["model"]

    mock_response = _Resp(
        usage=_Usage(input_tokens=10, output_tokens=5),
        model="claude-haiku-4-5-20251001",
    )
    real_fn = MagicMock(return_value=mock_response)

    base.call(real_fn, original_kwargs, session, provider)

    # Original kwargs must not be mutated
    assert original_kwargs["model"] == original_model
    # real_fn should have been called with the degraded model
    called_kwargs = real_fn.call_args[1]
    assert called_kwargs["model"] == "claude-haiku-4-5-20251001"


def test_post_call_reconciliation_fires() -> None:
    session, provider = _make_session_and_provider()
    mock_response = _Resp(
        usage=_Usage(input_tokens=50, output_tokens=20),
        model="test-model",
    )
    real_fn = MagicMock(return_value=mock_response)
    kwargs = {"model": "test-model", "messages": []}

    base.call(real_fn, kwargs, session, provider)
    assert session.tokens_used > 0


def test_streaming_pre_call_check_runs_before_context_manager() -> None:
    session, provider = _make_session_and_provider(token_limit=10, block_at_pct=50)
    session._tokens_used = 9
    real_fn = MagicMock()
    kwargs = {"model": "test", "messages": [{"role": "user", "content": "hi"}]}

    with pytest.raises(BudgetExceededError):
        base.call_stream(real_fn, kwargs, session, provider)


def test_streaming_reconciliation_on_normal_exit() -> None:
    session, provider = _make_session_and_provider()
    mock_stream = _Resp(
        usage=_Usage(input_tokens=30, output_tokens=10),
        model="test",
    )

    ctx = MagicMock()
    ctx.__enter__ = MagicMock(return_value=mock_stream)
    ctx.__exit__ = MagicMock(return_value=False)
    real_fn = MagicMock(return_value=ctx)

    kwargs = {"model": "test", "messages": []}
    guarded = base.call_stream(real_fn, kwargs, session, provider)
    with guarded:
        pass
    assert session.tokens_used > 0


def test_streaming_reconciliation_on_early_exit() -> None:
    session, provider = _make_session_and_provider()
    mock_stream = _Resp(
        usage=_Usage(input_tokens=30, output_tokens=10),
        model="test",
        chunks=["chunk1", "chunk2", "chunk3"],
    )

    ctx = MagicMock()
    ctx.__enter__ = MagicMock(return_value=mock_stream)
    ctx.__exit__ = MagicMock(return_value=False)
    real_fn = MagicMock(return_value=ctx)

    kwargs = {"model": "test", "messages": []}
    guarded = base.call_stream(real_fn, kwargs, session, provider)
    with guarded as stream:
        for _ in stream:
            break  # early exit
    assert session.tokens_used > 0


def test_async_call_intercept() -> None:
    session, provider = _make_session_and_provider()
    mock_response = _Resp(
        usage=_Usage(input_tokens=40, output_tokens=15),
        model="test",
    )

    async def mock_fn(**_kwargs: object) -> _Resp:
        return mock_response

    kwargs = {"model": "test", "messages": []}
    result = asyncio.run(
        base.call_async(mock_fn, kwargs, session, provider)
    )
    assert result is mock_response
    assert session.tokens_used > 0


def test_shutdown_flag_raises_on_next_call() -> None:
    """When shutdown flag is set, _pre_call raises DirectiveError."""
    session, provider = _make_session_and_provider()
    session._shutdown_requested = True
    session._shutdown_reason = "test kill"

    real_fn = MagicMock()
    kwargs = {"model": "claude-sonnet-4-6", "messages": [{"role": "user", "content": "hi"}]}

    with pytest.raises(DirectiveError, match="test kill"):
        base.call(real_fn, kwargs, session, provider)

    assert real_fn.call_count == 0


# ---------------------------------------------------------------------------
# Phase 4 — structured LLM_ERROR emission + event_type promotion
# ---------------------------------------------------------------------------


# Classifier keys on the exact class ``__name__``, so the stand-in must BE
# ``RateLimitError`` at the type level -- can't just wrap it. We build the
# class via ``type()`` so Python uses the given name verbatim.
RateLimitError = type(
    "RateLimitError",
    (Exception,),
    {"__module__": "anthropic"},
)


def _mk_rate_limit(message: str = "rate limited") -> Exception:
    exc = RateLimitError(message)
    exc.status_code = 429  # type: ignore[attr-defined]
    return exc


def _captured_events(session: Session) -> list[dict[str, Any]]:
    """Collect every event the session POSTed to the mock control plane.

    The event queue has a background drain thread that pulls events off the
    internal queue as soon as ``enqueue`` is called, so a direct
    ``_queue.get_nowait()`` race is unreliable. We instead read the mocked
    ``post_event`` call args -- the drain thread always routes there,
    regardless of timing.
    """
    import time as _time
    # The drain is a daemon thread; wait briefly for it to drain what we
    # just enqueued before reading the mock's call history.
    deadline = _time.monotonic() + 1.0
    while _time.monotonic() < deadline:
        if session.client.post_event.call_count > 0:  # type: ignore[attr-defined]
            # Let the mock absorb a couple more events if there are any
            # queued behind the first.
            _time.sleep(0.05)
            break
        _time.sleep(0.01)
    out: list[dict[str, Any]] = []
    for call in session.client.post_event.call_args_list:  # type: ignore[attr-defined]
        # post_event(payload) -- positional first arg.
        if call.args:
            out.append(call.args[0])
        elif "payload" in call.kwargs:
            out.append(call.kwargs["payload"])
    return out


def test_call_emits_llm_error_event_on_exception_and_re_raises() -> None:
    session, provider = _make_session_and_provider()
    real_fn = MagicMock(side_effect=_mk_rate_limit("slow down"))
    kwargs = {"model": "claude-sonnet-4-6", "messages": [{"role": "user", "content": "hi"}]}

    with pytest.raises(RateLimitError):
        base.call(real_fn, kwargs, session, provider)

    events = _captured_events(session)
    # One and only one llm_error event. No post_call because the call failed.
    llm_errors = [e for e in events if e["event_type"] == "llm_error"]
    post_calls = [e for e in events if e["event_type"] == "post_call"]
    assert len(llm_errors) == 1
    assert post_calls == []
    err = llm_errors[0]["error"]
    assert err["error_type"] == "rate_limit"
    assert err["http_status"] == 429
    assert err["is_retryable"] is True
    # Model on the outer payload comes from the request kwargs so the
    # dashboard can show which model the user was targeting when it failed.
    assert llm_errors[0]["model"] == "claude-sonnet-4-6"


def test_call_async_emits_llm_error_event_on_exception_and_re_raises() -> None:
    session, provider = _make_session_and_provider()

    async def boom(**_kwargs: object) -> Any:
        raise _mk_rate_limit("async slow down")

    kwargs = {"model": "claude-sonnet-4-6", "messages": []}
    with pytest.raises(RateLimitError):
        asyncio.run(base.call_async(boom, kwargs, session, provider))

    events = _captured_events(session)
    llm_errors = [e for e in events if e["event_type"] == "llm_error"]
    assert len(llm_errors) == 1
    assert llm_errors[0]["error"]["error_type"] == "rate_limit"


def test_call_with_event_type_embeddings_emits_embeddings_event() -> None:
    # Embeddings path: same call shape, different event_type. Payload still
    # carries token counts (input only).
    session, provider = _make_session_and_provider()
    mock_response = _Resp(
        usage=_Usage(input_tokens=50, output_tokens=0),
        model="voyage-2",
    )
    real_fn = MagicMock(return_value=mock_response)

    from flightdeck_sensor.core.types import EventType
    base.call(real_fn, {"model": "voyage-2", "input": ["hi"]}, session, provider, event_type=EventType.EMBEDDINGS)

    events = _captured_events(session)
    embeddings = [e for e in events if e["event_type"] == "embeddings"]
    post_calls = [e for e in events if e["event_type"] == "post_call"]
    assert len(embeddings) == 1
    assert post_calls == []
    assert embeddings[0]["tokens_input"] == 50
    assert embeddings[0]["tokens_output"] == 0


def test_call_async_with_event_type_embeddings_emits_embeddings_event() -> None:
    # Async path mirrors the sync promotion.
    session, provider = _make_session_and_provider()
    mock_response = _Resp(
        usage=_Usage(input_tokens=42, output_tokens=0),
        model="text-embedding-3-small",
    )

    async def mock_fn(**_kwargs: object) -> _Resp:
        return mock_response

    from flightdeck_sensor.core.types import EventType
    asyncio.run(
        base.call_async(
            mock_fn,
            {"model": "text-embedding-3-small", "input": ["hi"]},
            session,
            provider,
            event_type=EventType.EMBEDDINGS,
        )
    )
    events = _captured_events(session)
    assert any(e["event_type"] == "embeddings" and e["tokens_input"] == 42 for e in events)


def test_streaming_populates_ttft_and_chunk_count_on_post_call() -> None:
    # Happy path streaming: caller enters the context, iterates every
    # chunk, exits cleanly. Reconciliation posts a post_call with the
    # Phase 4 streaming sub-object populated.
    session, provider = _make_session_and_provider()
    mock_stream = _Resp(
        usage=_Usage(input_tokens=20, output_tokens=30),
        model="claude-sonnet-4-6",
        chunks=[{"chunk": i} for i in range(5)],
    )
    ctx = MagicMock()
    ctx.__enter__ = MagicMock(return_value=mock_stream)
    ctx.__exit__ = MagicMock(return_value=False)
    real_fn = MagicMock(return_value=ctx)

    kwargs = {"model": "claude-sonnet-4-6", "messages": []}
    guarded = base.call_stream(real_fn, kwargs, session, provider)
    with guarded as stream:
        for _ in stream:
            pass

    events = _captured_events(session)
    post_calls = [e for e in events if e["event_type"] == "post_call"]
    assert len(post_calls) == 1
    s = post_calls[0].get("streaming")
    assert s is not None, f"streaming sub-object missing from post_call: {post_calls[0]!r}"
    assert s["chunk_count"] == 5
    # TTFT is measured on the first chunk arrival -- mocked streams are
    # consumed near-instantly so we only assert it is numeric (a real
    # provider would show 10-500ms here).
    assert s["ttft_ms"] is not None
    assert s["final_outcome"] == "completed"
    # Five chunks = four inter-chunk gaps. Summary carries the three stats.
    assert s["inter_chunk_ms"] is not None
    assert set(s["inter_chunk_ms"].keys()) == {"p50", "p95", "max"}


def test_streaming_emits_llm_error_on_mid_stream_exception() -> None:
    # The stream yields two chunks then raises a RateLimitError while
    # the caller iterates. The wrapper must emit llm_error with
    # error_type=stream_error + abort_reason=error_mid_stream, and NOT
    # emit a normal post_call.
    session, provider = _make_session_and_provider()

    class _BoomStream:
        def __iter__(self):
            return self
        _count = 0
        def __next__(self):
            self._count += 1
            if self._count <= 2:
                return {"chunk": self._count}
            raise _mk_rate_limit("mid-stream limit")

    ctx = MagicMock()
    ctx.__enter__ = MagicMock(return_value=_BoomStream())
    ctx.__exit__ = MagicMock(return_value=False)
    real_fn = MagicMock(return_value=ctx)

    kwargs = {"model": "claude-sonnet-4-6", "messages": []}
    guarded = base.call_stream(real_fn, kwargs, session, provider)
    with pytest.raises(RateLimitError):
        with guarded as stream:
            for _ in stream:
                pass

    events = _captured_events(session)
    post_calls = [e for e in events if e["event_type"] == "post_call"]
    llm_errors = [e for e in events if e["event_type"] == "llm_error"]
    assert post_calls == []
    assert len(llm_errors) == 1
    err = llm_errors[0]["error"]
    assert err["error_type"] == "stream_error"
    assert err["abort_reason"] == "error_mid_stream"
    # Two chunks were yielded before the exception.
    assert err["partial_chunks"] == 2


def test_streaming_emits_error_before_stream_when_context_enter_raises() -> None:
    # Exception during __enter__ (before any chunk yielded) classifies
    # with abort_reason=error_before_stream and NOT as stream_error.
    session, provider = _make_session_and_provider()

    ctx = MagicMock()
    ctx.__enter__ = MagicMock(side_effect=_mk_rate_limit("pre-stream"))
    ctx.__exit__ = MagicMock(return_value=False)
    real_fn = MagicMock(return_value=ctx)

    kwargs = {"model": "claude-sonnet-4-6", "messages": []}
    guarded = base.call_stream(real_fn, kwargs, session, provider)
    with pytest.raises(RateLimitError):
        with guarded:
            pass

    events = _captured_events(session)
    llm_errors = [e for e in events if e["event_type"] == "llm_error"]
    assert len(llm_errors) == 1
    err = llm_errors[0]["error"]
    # No chunks ever arrived -> taxonomy falls back to its native class
    # (rate_limit), abort_reason=error_before_stream.
    assert err["error_type"] == "rate_limit"
    assert err["abort_reason"] == "error_before_stream"


def test_budget_and_directive_errors_are_not_classified_as_llm_errors() -> None:
    # BudgetExceededError is emitted by the sensor's own policy layer in
    # _pre_call, BEFORE real_fn is called. It must NOT generate an
    # llm_error event.
    session, provider = _make_session_and_provider(token_limit=100, block_at_pct=50)
    session._tokens_used = 90
    real_fn = MagicMock()
    kwargs = {"model": "claude-sonnet-4-6", "messages": [{"role": "user", "content": "hi"}]}
    with pytest.raises(BudgetExceededError):
        base.call(real_fn, kwargs, session, provider)
    assert real_fn.call_count == 0

    events = _captured_events(session)
    llm_errors = [e for e in events if e["event_type"] == "llm_error"]
    assert llm_errors == []
