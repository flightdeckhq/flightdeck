"""Tests for interceptor: call, call_async, call_stream, GuardedStream."""

from __future__ import annotations

import asyncio
from typing import Any
from unittest.mock import MagicMock

import pytest

from flightdeck_sensor.core.exceptions import BudgetExceededError
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
        agent_flavor="test", agent_type="autonomous", quiet=True,
    )
    client = MagicMock(spec=ControlPlaneClient)
    client.post_event.return_value = None
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
    result = asyncio.get_event_loop().run_until_complete(
        base.call_async(mock_fn, kwargs, session, provider)
    )
    assert result is mock_response
    assert session.tokens_used > 0
