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

from flightdeck_sensor.core.exceptions import BudgetExceededError, DirectiveError
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

    _post_call(session, provider, response, estimated, latency_ms, call_kwargs)
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

    _post_call(session, provider, response, estimated, latency_ms, call_kwargs)
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
                self._kwargs,
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
    with session._lock:
        shutdown = session._shutdown_requested
        reason = session._shutdown_reason
    if shutdown:
        raise DirectiveError("shutdown", reason)

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
    call_kwargs: dict[str, Any] | None = None,
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

    # Default to the model from the request kwargs (if known) so the
    # event is correctly labelled when the response object does not
    # expose ``.model`` directly. This matters for callers that route
    # through the SDK's raw-response wrapper -- e.g. langchain-openai
    # uses ``client.with_raw_response.create(**payload)`` which returns
    # a ``LegacyAPIResponse``; ``getattr(response, "model", "")`` then
    # returns ``""`` because the raw-response object does not surface
    # the parsed ``model`` field. The request kwargs always carry the
    # model the caller asked for, which is the right value to report
    # for those paths.
    resp_model = provider.get_model(call_kwargs or {})
    # Try to get model from response object as an override -- this
    # catches model substitutions (e.g. some providers may rewrite
    # the requested model to a deployment alias) when the response
    # object exposes ``.model`` as an attribute.
    with contextlib.suppress(Exception):
        resp_model = getattr(response, "model", "") or resp_model

    # Extract content when capture_prompts is enabled
    content_dict: dict[str, Any] | None = None
    has_content = False
    if session.config.capture_prompts and call_kwargs is not None:
        pc = provider.extract_content(call_kwargs, response)
        if pc is not None:
            pc.session_id = session.config.session_id
            has_content = True
            content_dict = {
                "system": pc.system,
                "messages": pc.messages,
                "tools": pc.tools,
                "response": pc.response,
                "provider": pc.provider,
                "model": pc.model,
                "session_id": pc.session_id,
                "event_id": pc.event_id,
                "captured_at": pc.captured_at,
            }

    # Atomically increment the session token counter and capture the
    # post-increment total in one critical section. The captured value
    # is then passed explicitly into _build_payload as
    # tokens_used_session so concurrent threads' contributions cannot
    # leak into this thread's reported running total. Without this
    # capture order, _build_payload would read self._tokens_used after
    # other threads' record_usage calls had already advanced it,
    # producing duplicate or skipped values on the dashboard token
    # curve. Phase 4.5 audit B-G fix.
    session_total = session.record_usage(usage)
    session.record_model(resp_model)

    payload = session._build_payload(
        EventType.POST_CALL,
        model=resp_model,
        tokens_input=usage.input_tokens,
        tokens_output=usage.output_tokens,
        tokens_total=usage.total,
        tokens_used_session=session_total,
        latency_ms=latency_ms,
    )
    if has_content:
        payload["has_content"] = True
        payload["content"] = content_dict
    session.event_queue.enqueue(payload)
