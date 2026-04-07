"""Provider-agnostic intercept functions for LLM calls.

Three module-level functions -- not a class:

* :func:`call` -- synchronous intercept
* :func:`call_async` -- asynchronous intercept
* :func:`call_stream` -- streaming intercept (returns :class:`GuardedStream`)

:class:`GuardedStream` is the only class in this module.
"""

from __future__ import annotations

import contextlib
import copy
import logging
import time
from typing import TYPE_CHECKING, Any

from flightdeck_sensor.core.exceptions import BudgetExceededError
from flightdeck_sensor.core.types import EventType, PolicyDecision, TokenUsage

if TYPE_CHECKING:
    from collections.abc import Iterator
    from types import TracebackType

    from flightdeck_sensor.core.session import Session
    from flightdeck_sensor.providers.protocol import Provider

_log = logging.getLogger("flightdeck_sensor.interceptor.base")


# ------------------------------------------------------------------
# Sync intercept
# ------------------------------------------------------------------


def call(
    real_fn: Any,
    kwargs: dict[str, Any],
    session: Session,
    provider: Provider,
) -> Any:
    """Synchronous call intercept.

    1. Estimate tokens, check policy (BLOCK/DEGRADE/WARN).
    2. Execute the real provider call.
    3. Extract actual usage, reconcile, post event.
    """
    estimated = provider.estimate_tokens(kwargs)
    call_kwargs = _pre_call(session, provider, kwargs, estimated)

    t0 = time.monotonic()
    response = real_fn(**call_kwargs)
    latency_ms = int((time.monotonic() - t0) * 1000)

    _post_call(session, provider, response, estimated, latency_ms)
    return response


# ------------------------------------------------------------------
# Async intercept
# ------------------------------------------------------------------


async def call_async(
    real_fn: Any,
    kwargs: dict[str, Any],
    session: Session,
    provider: Provider,
) -> Any:
    """Asynchronous call intercept -- same logic as :func:`call`, awaited."""
    estimated = provider.estimate_tokens(kwargs)
    call_kwargs = _pre_call(session, provider, kwargs, estimated)

    t0 = time.monotonic()
    response = await real_fn(**call_kwargs)
    latency_ms = int((time.monotonic() - t0) * 1000)

    _post_call(session, provider, response, estimated, latency_ms)
    return response


# ------------------------------------------------------------------
# Streaming intercept
# ------------------------------------------------------------------


def call_stream(
    real_fn: Any,
    kwargs: dict[str, Any],
    session: Session,
    provider: Provider,
) -> GuardedStream:
    """Streaming call intercept.

    Pre-call policy check runs *before* the context manager is returned.
    Token reconciliation runs on ``__exit__`` (including early exit).
    """
    estimated = provider.estimate_tokens(kwargs)
    call_kwargs = _pre_call(session, provider, kwargs, estimated)
    return GuardedStream(real_fn, call_kwargs, session, provider, estimated)


class GuardedStream:
    """Context manager wrapping a streaming LLM response.

    Reconciles token usage on exit, including early exit via ``break``
    or exception.  ``__exit__`` never raises.
    """

    def __init__(
        self,
        real_fn: Any,
        kwargs: dict[str, Any],
        session: Session,
        provider: Provider,
        estimated: int,
    ) -> None:
        self._real_fn = real_fn
        self._kwargs = kwargs
        self._session = session
        self._provider = provider
        self._estimated = estimated
        self._stream: Any = None
        self._ctx: Any = None
        self._t0: float = 0.0

    def __enter__(self) -> Any:
        self._t0 = time.monotonic()
        self._ctx = self._real_fn(**self._kwargs)
        self._stream = self._ctx.__enter__()
        return self._stream

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: TracebackType | None,
    ) -> None:
        try:
            if self._ctx is not None:
                self._ctx.__exit__(exc_type, exc_val, exc_tb)
        except Exception:
            _log.debug("Exception closing underlying stream", exc_info=True)

        latency_ms = int((time.monotonic() - self._t0) * 1000)

        try:
            _post_call(
                self._session,
                self._provider,
                self._stream,
                self._estimated,
                latency_ms,
            )
        except Exception:
            _log.warning("Failed to post stream reconciliation event", exc_info=True)

    def __iter__(self) -> Iterator[Any]:
        return iter(self._stream)


# ------------------------------------------------------------------
# Shared pre/post logic
# ------------------------------------------------------------------


def _pre_call(
    session: Session,
    provider: Provider,
    kwargs: dict[str, Any],
    estimated: int,
) -> dict[str, Any]:
    """Run policy check and return (possibly modified) kwargs.

    * BLOCK: raises :class:`BudgetExceededError` -- call never happens.
    * DEGRADE: returns a *copy* of kwargs with swapped model.
    * WARN: logs once, returns original kwargs.
    * ALLOW: returns original kwargs.
    """
    result = session.policy.check(session.tokens_used, estimated)
    decision = result.decision

    if decision == PolicyDecision.BLOCK:
        raise BudgetExceededError(
            session_id=session.config.session_id,
            tokens_used=session.tokens_used,
            token_limit=session.policy.token_limit or 0,
        )

    if decision == PolicyDecision.DEGRADE and session.policy.degrade_to:
        call_kwargs = copy.copy(kwargs)
        call_kwargs["model"] = session.policy.degrade_to
        _log.info(
            "Policy DEGRADE: swapping model to %s (session %s)",
            session.policy.degrade_to,
            session.config.session_id,
        )
        return call_kwargs

    if decision == PolicyDecision.WARN:
        _log.warning(
            "Token budget warning: %d tokens used of %s limit (session %s)",
            session.tokens_used,
            session.policy.token_limit,
            session.config.session_id,
        )

    return kwargs


def _post_call(
    session: Session,
    provider: Provider,
    response: Any,
    estimated: int,
    latency_ms: int,
) -> None:
    """Extract actual usage, reconcile with estimate, post event."""
    actual = provider.extract_usage(response)

    # Use actual if available, otherwise fall back to estimate
    if actual.total > 0:
        usage = actual
    else:
        usage = TokenUsage(input_tokens=estimated, output_tokens=0)
        _log.debug(
            "No usage in response, using estimate of %d tokens",
            estimated,
        )

    resp_model = provider.get_model({})
    # Try to get model from response
    with contextlib.suppress(Exception):
        resp_model = getattr(response, "model", "") or resp_model

    session.post_call_event(
        event_type=EventType.POST_CALL,
        usage=usage,
        model=resp_model,
        latency_ms=latency_ms,
    )
