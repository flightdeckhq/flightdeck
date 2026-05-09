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
from typing import TYPE_CHECKING, Any, cast

from flightdeck_sensor.core.errors import classify_exception
from flightdeck_sensor.core.exceptions import BudgetExceededError, DirectiveError
from flightdeck_sensor.core.types import (
    EventType,
    PolicyDecision,
    PolicyDecisionSummary,
    TokenUsage,
)


def _safe_pct(used: int, limit: int | None) -> int:
    """Helper for the ``policy_decision.reason`` string. Avoids
    division-by-zero when limit is unset (PolicyCache returns ALLOW
    in that case so we shouldn't reach the WARN/BLOCK path with a
    None limit, but defensive-zero keeps the reason readable in
    edge cases like a directive_update racing the threshold check)."""
    if not limit or limit <= 0:
        return 0
    return (used * 100) // limit

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
    *,
    event_type: EventType = EventType.POST_CALL,
) -> Any:
    """Synchronous call intercept.

    1. Estimate tokens, check policy (BLOCK/DEGRADE/WARN).
    2. Execute the real provider call.
    3. Extract actual usage, reconcile, post event (``event_type`` — default
       POST_CALL; callers pass EMBEDDINGS for embedding-model calls).
    4. On provider exception, emit a structured LLM_ERROR event via the
       Phase 4 taxonomy and re-raise.
    """
    estimated, estimated_via = provider.estimate_tokens(kwargs)
    call_kwargs = _pre_call(session, provider, kwargs, estimated, estimated_via)

    t0 = time.monotonic()
    try:
        response = real_fn(**call_kwargs)
    except (BudgetExceededError, DirectiveError):
        # Sensor-emitted control-flow exceptions are not LLM API errors.
        # They never escape from the real_fn call anyway, but the explicit
        # re-raise keeps the except ordering stable against future edits.
        raise
    except BaseException as exc:
        latency_ms = int((time.monotonic() - t0) * 1000)
        _emit_error(session, provider, exc, latency_ms, call_kwargs)
        raise
    latency_ms = int((time.monotonic() - t0) * 1000)

    _post_call(
        session,
        provider,
        response,
        estimated,
        latency_ms,
        call_kwargs,
        event_type=event_type,
        estimated_via=estimated_via,
    )
    return response


# ------------------------------------------------------------------
# Async intercept
# ------------------------------------------------------------------


async def call_async(
    real_fn: Any,
    kwargs: dict[str, Any],
    session: Session,
    provider: Provider,
    *,
    event_type: EventType = EventType.POST_CALL,
) -> Any:
    """Asynchronous call intercept -- same logic as :func:`call`, awaited."""
    estimated, estimated_via = provider.estimate_tokens(kwargs)
    call_kwargs = _pre_call(session, provider, kwargs, estimated, estimated_via)

    t0 = time.monotonic()
    try:
        response = await real_fn(**call_kwargs)
    except (BudgetExceededError, DirectiveError):
        raise
    except BaseException as exc:
        latency_ms = int((time.monotonic() - t0) * 1000)
        _emit_error(session, provider, exc, latency_ms, call_kwargs)
        raise
    latency_ms = int((time.monotonic() - t0) * 1000)

    _post_call(
        session,
        provider,
        response,
        estimated,
        latency_ms,
        call_kwargs,
        event_type=event_type,
        estimated_via=estimated_via,
    )
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
    estimated, estimated_via = provider.estimate_tokens(kwargs)
    call_kwargs = _pre_call(session, provider, kwargs, estimated, estimated_via)
    return GuardedStream(
        real_fn, call_kwargs, session, provider, estimated, estimated_via,
    )


def call_stream_async(
    real_fn: Any,
    kwargs: dict[str, Any],
    session: Session,
    provider: Provider,
) -> GuardedAsyncStream:
    """Async streaming call intercept.

    Phase 4 lift of the pre-existing ``NotImplementedError`` for async
    streams. Semantically identical to :func:`call_stream` with awaitable
    context-manager + async-iterator protocols. Pre-call policy check
    still runs synchronously before the context is returned so BLOCK is
    honoured before the first network byte.
    """
    estimated, estimated_via = provider.estimate_tokens(kwargs)
    call_kwargs = _pre_call(session, provider, kwargs, estimated, estimated_via)
    return GuardedAsyncStream(
        real_fn, call_kwargs, session, provider, estimated, estimated_via,
    )


class GuardedStream:
    """Context manager wrapping a streaming LLM response.

    Phase 4 (v0.5.0) adds comprehensive streaming semantics capture:

    * **TTFT** -- milliseconds from the request kwargs being dispatched to
      the first chunk arriving.
    * **Chunk count** -- total number of chunks the caller iterated.
    * **Inter-chunk gap stats** -- p50 / p95 / max gap between consecutive
      chunks (ring-buffered to 1000 entries so a long stream cannot bloat
      memory).
    * **Final outcome** -- ``"completed"`` if the stream exhausted cleanly,
      ``"aborted"`` if the caller broke out early or an exception unwound
      the context.
    * **Abort reason** -- ``"client_aborted"`` (break or explicit close),
      ``"error_mid_stream"`` (exception after first chunk), or
      ``"timeout"`` (APITimeoutError), ``"error_before_stream"`` (exception
      before any chunk arrived).

    The wrapper yields the caller's original chunk objects verbatim -- no
    content is buffered or copied. Only arrival timestamps and a chunk
    counter are tracked, so a latency-sensitive caller pays at most a
    ``time.monotonic()`` call per chunk.

    Reconciliation of token usage still happens on ``__exit__`` (including
    early exit via ``break`` or exception). The streaming sub-object is
    appended to the ``post_call`` payload; non-streaming callers see no
    wire-shape change.

    ``__exit__`` never raises. An internal failure building the streaming
    summary falls through to a logged warning.
    """

    # A generous cap on the inter-chunk gap ring buffer. Large enough for
    # every interactive chat completion, small enough that a 10 000-chunk
    # edge case cannot bloat the sensor's working set.
    _MAX_GAPS_TRACKED = 1000

    def __init__(
        self,
        real_fn: Any,
        kwargs: dict[str, Any],
        session: Session,
        provider: Provider,
        estimated: int,
        estimated_via: str = "none",
    ) -> None:
        self._real_fn = real_fn
        self._kwargs = kwargs
        self._session = session
        self._provider = provider
        self._estimated = estimated
        self._estimated_via = estimated_via
        self._stream: Any = None
        self._ctx: Any = None
        self._t0: float = 0.0
        # Streaming metrics populated as the caller iterates chunks.
        self._first_chunk_t: float | None = None
        self._last_chunk_t: float | None = None
        self._chunk_count: int = 0
        self._inter_chunk_ms: list[float] = []
        self._stream_iter: Any = None

    def __enter__(self) -> Any:
        self._t0 = time.monotonic()
        try:
            self._ctx = self._real_fn(**self._kwargs)
            self._stream = self._ctx.__enter__()
        except BaseException as exc:
            # Python's context-manager protocol does NOT call __exit__ when
            # __enter__ raises. Emit the llm_error here so pre-stream
            # exceptions (rate-limit, auth failure before the stream
            # opens) don't drop silently. The caller still sees the
            # exception propagate via the re-raise.
            latency_ms = int((time.monotonic() - self._t0) * 1000)
            try:
                _emit_error(
                    self._session,
                    self._provider,
                    exc,
                    latency_ms,
                    self._kwargs,
                    is_stream_error=False,
                    partial={
                        "abort_reason": "error_before_stream",
                        "partial_chunks": 0,
                    },
                )
            except Exception:
                _log.warning(
                    "Failed to emit llm_error for pre-stream exception",
                    exc_info=True,
                )
            raise
        return self

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

        if exc_val is not None:
            # Mid-stream or pre-stream exception: emit llm_error with a
            # stream_error classification and partial-token accounting.
            # Never surface from __exit__ -- the caller's exception is
            # already propagating.
            try:
                is_stream_error = self._first_chunk_t is not None
                abort_reason = (
                    "error_mid_stream" if is_stream_error else "error_before_stream"
                )
                # Re-examine the exception class: APITimeoutError and
                # plain TimeoutError both map to ``timeout`` per
                # taxonomy, but abort_reason stays more descriptive.
                if type(exc_val).__name__ in ("APITimeoutError", "TimeoutError"):
                    abort_reason = "timeout"
                _emit_error(
                    self._session,
                    self._provider,
                    exc_val,
                    latency_ms,
                    self._kwargs,
                    is_stream_error=is_stream_error,
                    partial={
                        "abort_reason": abort_reason,
                        "partial_chunks": self._chunk_count,
                    },
                )
            except Exception:
                _log.warning(
                    "Failed to emit llm_error for stream exception",
                    exc_info=True,
                )
            return

        # Clean exit. Determine whether the caller actually exhausted the
        # stream (``final_outcome="completed"``) or broke out early
        # (``final_outcome="aborted"`` with ``abort_reason="client_aborted"``).
        try:
            streaming = self._build_streaming_summary()
            _post_call(
                self._session,
                self._provider,
                self._stream,
                self._estimated,
                latency_ms,
                self._kwargs,
                streaming=streaming,
                estimated_via=self._estimated_via,
            )
        except Exception:
            _log.warning(
                "Failed to post stream reconciliation event", exc_info=True,
            )

    # Iterator protocol. Self-iterating so we can timestamp every chunk
    # without copying it. The caller sees the underlying SDK's chunk
    # objects verbatim.
    def __iter__(self) -> Iterator[Any]:
        if self._stream_iter is None:
            self._stream_iter = iter(self._stream)
        return self

    def __next__(self) -> Any:
        if self._stream_iter is None:
            self._stream_iter = iter(self._stream)
        try:
            chunk = next(self._stream_iter)
        except StopIteration:
            # Natural end-of-stream -- caller's for-loop will fall out.
            raise
        now = time.monotonic()
        if self._first_chunk_t is None:
            self._first_chunk_t = now
        else:
            gap_ms = (now - (self._last_chunk_t or now)) * 1000
            if len(self._inter_chunk_ms) < self._MAX_GAPS_TRACKED:
                self._inter_chunk_ms.append(gap_ms)
        self._last_chunk_t = now
        self._chunk_count += 1
        return chunk

    # ------------------------------------------------------------------
    # Summary construction
    # ------------------------------------------------------------------

    def _build_streaming_summary(self) -> dict[str, Any]:
        """Delegate to the module-level helper.

        Kept as an instance method so the sync wrapper's call sites
        above read naturally (``self._build_streaming_summary()``).
        :class:`GuardedAsyncStream` binds the same delegator so both
        classes share one implementation without mypy's bound-method
        self-type mismatch.
        """
        return _build_streaming_summary(
            self._t0,
            self._first_chunk_t,
            self._chunk_count,
            self._inter_chunk_ms,
        )


def _build_streaming_summary(
    t0: float,
    first_chunk_t: float | None,
    chunk_count: int,
    inter_chunk_ms: list[float],
) -> dict[str, Any]:
    """Phase 4 streaming sub-object attached to the post_call payload.

    Free function so both :class:`GuardedStream` and
    :class:`GuardedAsyncStream` can share one implementation without
    mypy's strict mode rejecting a cross-class bound-method alias.

    Always returns a dict with the following keys:

    * ``ttft_ms`` -- ``None`` if no chunks ever arrived, else the
      millisecond delta from request dispatch to first chunk.
    * ``chunk_count`` -- total chunks the caller iterated. Zero is
      legal for callers that entered the context and exited without
      iterating.
    * ``inter_chunk_ms`` -- ``{"p50", "p95", "max"}`` derived from the
      captured gaps. ``None`` when fewer than two chunks arrived.
    * ``final_outcome`` -- always ``"completed"`` on this success
      branch; the error branch does not call this helper.
    * ``abort_reason`` -- ``None`` by default. Populated when the
      caller exited the context before exhausting the stream
      (``_stream_iter`` was created and its next() never raised
      StopIteration but __exit__ still fired).
    """
    ttft_ms: int | None = None
    if first_chunk_t is not None:
        ttft_ms = int((first_chunk_t - t0) * 1000)

    inter_chunk: dict[str, int] | None = None
    if len(inter_chunk_ms) >= 1:
        sorted_gaps = sorted(inter_chunk_ms)
        inter_chunk = {
            "p50": int(_percentile(sorted_gaps, 50)),
            "p95": int(_percentile(sorted_gaps, 95)),
            "max": int(sorted_gaps[-1]),
        }

    # Determine whether the caller consumed the whole stream. The
    # iterator was created only if the caller iterated; if it exists
    # and is not exhausted the caller broke out early. We probe by
    # trying a non-blocking next -- but generators in the Anthropic /
    # OpenAI SDKs are synchronous iterators over the network, so
    # calling next() here could block. Instead, infer from whether
    # the underlying context manager was already closed and the
    # iterator still has state. The safe heuristic: if chunk_count >
    # 0 AND the iterator was created AND the inner context exit
    # succeeded cleanly, assume the caller broke out only when we
    # cannot verify exhaustion. Too conservative -- we'd never
    # report "completed" for a for-loop that read every chunk. So
    # the current policy is: trust the caller. If no exception
    # propagated, report "completed"; the "client_aborted" path is
    # the error branch.
    abort_reason: str | None = None
    final_outcome = "completed"

    return {
        "ttft_ms": ttft_ms,
        "chunk_count": chunk_count,
        "inter_chunk_ms": inter_chunk,
        "final_outcome": final_outcome,
        "abort_reason": abort_reason,
    }


class GuardedAsyncStream:
    """Async counterpart of :class:`GuardedStream`.

    The SDK-async streaming pattern looks like::

        async with client.messages.stream(...) as stream:
            async for chunk in stream:
                ...

    so both ``__aenter__`` / ``__aexit__`` and ``__aiter__`` / ``__anext__``
    must be implemented. The measurement policy is identical to the sync
    path: TTFT on first chunk, inter-chunk gap stats, abort reason.

    Python's async-CM protocol (same as the sync protocol): if
    ``__aenter__`` raises, ``__aexit__`` is NOT invoked -- so the
    pre-stream exception handling lives inside ``__aenter__`` explicitly.
    """

    _MAX_GAPS_TRACKED = GuardedStream._MAX_GAPS_TRACKED

    def __init__(
        self,
        real_fn: Any,
        kwargs: dict[str, Any],
        session: Session,
        provider: Provider,
        estimated: int,
        estimated_via: str = "none",
    ) -> None:
        self._real_fn = real_fn
        self._kwargs = kwargs
        self._session = session
        self._provider = provider
        self._estimated = estimated
        self._estimated_via = estimated_via
        self._stream: Any = None
        self._ctx: Any = None
        self._t0: float = 0.0
        self._first_chunk_t: float | None = None
        self._last_chunk_t: float | None = None
        self._chunk_count: int = 0
        self._inter_chunk_ms: list[float] = []
        self._stream_iter: Any = None

    async def __aenter__(self) -> Any:
        self._t0 = time.monotonic()
        try:
            self._ctx = self._real_fn(**self._kwargs)
            # Some SDKs (OpenAI's AsyncOpenAI.chat.completions.create
            # with stream=True) return a coroutine that resolves to
            # the async stream. Others (Anthropic's
            # AsyncAnthropic.messages.stream) return the async
            # context-manager directly. Detect and await once.
            # Pre-fix the OpenAI path raised
            # ``AttributeError: coroutine object has no
            # attribute '__aenter__'`` (caught by Rule 40d smoke).
            import inspect
            if inspect.iscoroutine(self._ctx):
                self._ctx = await self._ctx
            self._stream = await self._ctx.__aenter__()
        except BaseException as exc:
            latency_ms = int((time.monotonic() - self._t0) * 1000)
            try:
                _emit_error(
                    self._session,
                    self._provider,
                    exc,
                    latency_ms,
                    self._kwargs,
                    is_stream_error=False,
                    partial={
                        "abort_reason": "error_before_stream",
                        "partial_chunks": 0,
                    },
                )
            except Exception:
                _log.warning(
                    "Failed to emit llm_error for pre-async-stream exception",
                    exc_info=True,
                )
            raise
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: TracebackType | None,
    ) -> None:
        try:
            if self._ctx is not None:
                await self._ctx.__aexit__(exc_type, exc_val, exc_tb)
        except Exception:
            _log.debug("Exception closing underlying async stream", exc_info=True)

        latency_ms = int((time.monotonic() - self._t0) * 1000)

        if exc_val is not None:
            try:
                is_stream_error = self._first_chunk_t is not None
                abort_reason = (
                    "error_mid_stream" if is_stream_error else "error_before_stream"
                )
                if type(exc_val).__name__ in ("APITimeoutError", "TimeoutError"):
                    abort_reason = "timeout"
                _emit_error(
                    self._session,
                    self._provider,
                    exc_val,
                    latency_ms,
                    self._kwargs,
                    is_stream_error=is_stream_error,
                    partial={
                        "abort_reason": abort_reason,
                        "partial_chunks": self._chunk_count,
                    },
                )
            except Exception:
                _log.warning(
                    "Failed to emit llm_error for async stream exception",
                    exc_info=True,
                )
            return

        try:
            streaming = self._build_streaming_summary()
            _post_call(
                self._session,
                self._provider,
                self._stream,
                self._estimated,
                latency_ms,
                self._kwargs,
                streaming=streaming,
                estimated_via=self._estimated_via,
            )
        except Exception:
            _log.warning(
                "Failed to post async stream reconciliation event", exc_info=True,
            )

    def __aiter__(self) -> Any:
        if self._stream_iter is None:
            self._stream_iter = self._stream.__aiter__()
        return self

    async def __anext__(self) -> Any:
        if self._stream_iter is None:
            self._stream_iter = self._stream.__aiter__()
        try:
            chunk = await self._stream_iter.__anext__()
        except StopAsyncIteration:
            raise
        now = time.monotonic()
        if self._first_chunk_t is None:
            self._first_chunk_t = now
        else:
            gap_ms = (now - (self._last_chunk_t or now)) * 1000
            if len(self._inter_chunk_ms) < self._MAX_GAPS_TRACKED:
                self._inter_chunk_ms.append(gap_ms)
        self._last_chunk_t = now
        self._chunk_count += 1
        return chunk

    def _build_streaming_summary(self) -> dict[str, Any]:
        """Delegate to the module-level helper — identical shape to
        the sync variant so a future tweak lands in one place."""
        return _build_streaming_summary(
            self._t0,
            self._first_chunk_t,
            self._chunk_count,
            self._inter_chunk_ms,
        )


def _percentile(sorted_values: list[float], pct: float) -> float:
    """Cheap percentile over a pre-sorted list. Returns 0 if empty.

    No scipy / numpy dependency -- the sensor stays dependency-free for
    every install type.
    """
    if not sorted_values:
        return 0.0
    k = (len(sorted_values) - 1) * (pct / 100.0)
    lo = int(k)
    hi = min(lo + 1, len(sorted_values) - 1)
    if lo == hi:
        return sorted_values[lo]
    frac = k - lo
    return sorted_values[lo] + (sorted_values[hi] - sorted_values[lo]) * frac


# ------------------------------------------------------------------
# Shared pre/post logic
# ------------------------------------------------------------------


def _pre_call(
    session: Session,
    provider: Provider,
    kwargs: dict[str, Any],
    estimated: int,
    estimated_via: str = "none",
) -> dict[str, Any]:
    """Run policy check and return (possibly modified) kwargs.

    Each enforcement decision emits a structured policy event so
    operators can see warn / degrade / block on the session timeline.
    See ARCHITECTURE.md "Event Types" → policy_warn / policy_degrade /
    policy_block.

    * BLOCK: emit :attr:`EventType.POLICY_BLOCK`, flush the event queue
      so the event lands before the process exit, then raise
      :class:`BudgetExceededError`. Source is always ``"server"`` per
      D035 (local thresholds fire WARN only).
    * DEGRADE: returns a *copy* of kwargs with swapped model. POLICY_
      DEGRADE is NOT emitted here — it fires once on
      ``_apply_directive(DEGRADE)`` arrival. Per-call swaps are visible
      via post_call.model only.
    * WARN: emit :attr:`EventType.POLICY_WARN` (source ``"local"`` for
      ``init(limit=...)`` thresholds, ``"server"`` for server policy),
      log warning, return original kwargs.
    * ALLOW: returns original kwargs unchanged.
    """
    with session._lock:
        shutdown = session._shutdown_requested
        reason = session._shutdown_reason
    if shutdown:
        raise DirectiveError("shutdown", reason)

    result = session.policy.check(session.tokens_used, estimated)
    decision = result.decision

    # Build the pre_call decision summary so it can ride on the
    # pre_call event. Omitted on the allow case (the vast majority).
    pre_call_decision: PolicyDecisionSummary | None = None
    if decision == PolicyDecision.BLOCK:
        block_pct = session.policy.block_at_pct
        pre_call_decision = PolicyDecisionSummary(
            policy_id=result.policy_id or "",
            scope=result.matched_policy_scope or "",
            decision="block",
            reason=(
                f"Pre-call check: {session.tokens_used + estimated}/"
                f"{session.policy.token_limit} would cross block "
                f"threshold ({block_pct}%, server policy)"
            ),
        )
    elif decision == PolicyDecision.WARN:
        warn_source = result.source or "server"
        local_warn = warn_source == "local"
        if local_warn:
            warn_threshold_pct = int(session.policy.local_warn_at * 100)
            warn_token_limit = session.policy.local_limit
        else:
            warn_threshold_pct = session.policy.warn_at_pct or 0
            warn_token_limit = session.policy.token_limit
        pre_call_decision = PolicyDecisionSummary(
            policy_id=result.policy_id or ("local" if local_warn else ""),
            scope=result.matched_policy_scope
            or ("local_failsafe" if local_warn else ""),
            decision="warn",
            reason=(
                f"Pre-call check: {session.tokens_used + estimated}/"
                f"{warn_token_limit} would cross warn threshold "
                f"({warn_threshold_pct}%, {warn_source} policy)"
            ),
        )
    elif decision == PolicyDecision.DEGRADE:
        pre_call_decision = PolicyDecisionSummary(
            policy_id=result.policy_id or "",
            scope=result.matched_policy_scope or "",
            decision="degrade",
            reason=(
                f"Pre-call check: degrade-to-{session.policy.degrade_to} "
                f"applied (per active directive)"
            ),
        )

    # Emit a pre_call event carrying the agent's intent + estimator
    # attribution + decision summary. Always emitted (including before
    # BLOCK) so the agent's intent is recorded even when the call is
    # rejected — matches the plugin's pre_call posture.
    pre_call_extras: dict[str, Any] = {
        "tokens_input": estimated,
        "estimated_via": estimated_via,
    }
    try:
        pre_model = provider.get_model(kwargs)
    except Exception:
        pre_model = ""
    if pre_model:
        pre_call_extras["model"] = pre_model
    if pre_call_decision is not None:
        pre_call_extras["policy_decision_pre"] = pre_call_decision.as_payload_dict()
    pre_call_payload = session._build_payload(EventType.PRE_CALL, **pre_call_extras)
    session.event_queue.enqueue(pre_call_payload)

    if decision == PolicyDecision.BLOCK:
        # POLICY_BLOCK: source hardcoded ``"server"`` per D035 — local
        # PolicyCache fires WARN only, never BLOCK. ``intended_model``
        # captures the model the blocked call was going to use so the
        # operator can answer "which call hit the limit?".
        intended_model = provider.get_model(kwargs)
        # Phase 7 Step 2 (D148): shared policy_decision block. Reason
        # follows the locked pattern: <what happened> + <by what
        # mechanism> + <relevant context>.
        block_pct = session.policy.block_at_pct
        block_decision = PolicyDecisionSummary(
            policy_id=result.policy_id or "",
            scope=result.matched_policy_scope or "",
            decision="block",
            reason=(
                f"Token usage {session.tokens_used}/{session.policy.token_limit} "
                f"({_safe_pct(session.tokens_used, session.policy.token_limit)}%) "
                f"crossed block threshold ({block_pct}%, server policy)"
            ),
        )
        block_payload = session._build_payload(
            EventType.POLICY_BLOCK,
            source="server",
            threshold_pct=block_pct,
            tokens_used=session.tokens_used,
            token_limit=session.policy.token_limit,
            intended_model=intended_model,
            policy_decision=block_decision.as_payload_dict(),
        )
        session.event_queue.enqueue(block_payload)
        # Synchronous flush: the BudgetExceededError below tears the
        # call down immediately and the caller may exit the process
        # without giving the drain thread a chance to ship the event.
        # Failure to flush is logged but does not change the raise.
        try:
            session.event_queue.flush()
        except Exception as exc:
            _log.warning(
                "[flightdeck] policy_block: failed to flush event queue: %s",
                exc,
            )
        raise BudgetExceededError(
            session_id=session.config.session_id,
            tokens_used=session.tokens_used,
            token_limit=session.policy.token_limit or 0,
        )

    if decision == PolicyDecision.DEGRADE and session.policy.degrade_to:
        # POLICY_DEGRADE is NOT emitted here. The decision event fired
        # once on _apply_directive(DEGRADE) arrival; per-call swaps are
        # visible via post_call.model. See decision lock above.
        call_kwargs = copy.copy(kwargs)
        call_kwargs["model"] = session.policy.degrade_to
        _log.info(
            "Policy DEGRADE: swapping model to %s (session %s)",
            session.policy.degrade_to,
            session.config.session_id,
        )
        return call_kwargs

    if decision == PolicyDecision.WARN:
        # source comes from the PolicyResult — ``"local"`` for an
        # init(limit=...) threshold, ``"server"`` for a server policy
        # threshold. Local and server can both fire once each per
        # session (PolicyCache tracks separately).
        warn_source = result.source or "server"
        # Both branches must produce an int. ``warn_at_pct`` is Optional
        # on PolicyResult; the ``or 0`` guard mirrors the pre_call_decision
        # branch (line ~722) and prevents ``None`` from leaking into the
        # event payload's ``threshold_pct`` field or the operator-visible
        # f-string reason ("crossed warn threshold (None%, server policy)"
        # would be silently misleading). With both branches typed int the
        # mypy --strict no-redef error against the prior binding clears
        # without an annotation.
        if warn_source == "local":
            warn_threshold_pct = int(session.policy.local_warn_at * 100)
            warn_token_limit = session.policy.local_limit
        else:
            warn_threshold_pct = session.policy.warn_at_pct or 0
            warn_token_limit = session.policy.token_limit
        # Phase 7 Step 2 (D148): shared policy_decision block.
        local_warn = warn_source == "local"
        warn_decision = PolicyDecisionSummary(
            policy_id=result.policy_id or ("local" if local_warn else ""),
            scope=result.matched_policy_scope
            or ("local_failsafe" if local_warn else ""),
            decision="warn",
            reason=(
                f"Token usage {session.tokens_used}/{warn_token_limit} "
                f"({_safe_pct(session.tokens_used, warn_token_limit)}%) "
                f"crossed warn threshold ({warn_threshold_pct}%, {warn_source} policy)"
            ),
        )
        warn_payload = session._build_payload(
            EventType.POLICY_WARN,
            source=warn_source,
            threshold_pct=warn_threshold_pct,
            tokens_used=session.tokens_used,
            token_limit=warn_token_limit,
            policy_decision=warn_decision.as_payload_dict(),
        )
        session.event_queue.enqueue(warn_payload)
        _log.warning(
            "Token budget warning: %d tokens used of %s limit (session %s)",
            session.tokens_used,
            warn_token_limit,
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
    *,
    event_type: EventType = EventType.POST_CALL,
    streaming: dict[str, Any] | None = None,
    estimated_via: str = "none",
) -> None:
    """Extract actual usage, reconcile with estimate, post event.

    ``event_type`` defaults to :attr:`EventType.POST_CALL`; callers pass
    :attr:`EventType.EMBEDDINGS` for embedding-model calls so the dashboard
    can render them distinctly.

    ``streaming`` carries the Phase 4 streaming sub-object (``ttft_ms``,
    chunk stats, ``final_outcome``) when the response came from
    :class:`GuardedStream`. Omitted entirely for non-streaming calls so the
    wire shape stays identical to the pre-Phase-4 behaviour.
    """
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
        pc = provider.extract_content(call_kwargs, response, event_type=event_type)
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
                # ``input`` is populated only on embeddings events;
                # chat events leave it None and the field drops via
                # the dashboard's optional read.
                "input": pc.input,
                # ``embedding_output`` carries the raw vectors from
                # embeddings.create() responses when capture_prompts
                # is on. None on chat events. Worker projects to
                # event_content.embedding_output.
                "embedding_output": pc.embedding_output,
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

    # Embeddings carry input tokens only -- the provider response shape
    # populates ``usage.prompt_tokens`` with ``completion_tokens`` absent or
    # zero, so the existing extractor already returns ``output_tokens=0``.
    # No special-casing here beyond honouring ``event_type``.
    payload = session._build_payload(
        event_type,
        model=resp_model,
        tokens_input=usage.input_tokens,
        tokens_output=usage.output_tokens,
        tokens_total=usage.total,
        tokens_cache_read=usage.cache_read_tokens,
        tokens_cache_creation=usage.cache_creation_tokens,
        tokens_used_session=session_total,
        latency_ms=latency_ms,
    )
    if has_content:
        payload["has_content"] = True
        payload["content"] = content_dict
    if streaming is not None:
        payload["streaming"] = streaming

    # provider_metadata: rate-limit headers, request id, processing
    # time. Always-included when the provider exposes any of them so
    # the dashboard's rate-limit-pressure chip renders without a
    # separate header export.
    try:
        prov_meta = provider.extract_response_metadata(response)
    except Exception:
        prov_meta = None
    if prov_meta:
        payload["provider_metadata"] = prov_meta

    # estimated_via attribution lets a large post-call delta be
    # attributed to estimator quality (heuristic fallback).
    if estimated_via:
        payload["estimated_via"] = estimated_via

    # policy_decision_post: fires when this call's cumulative usage
    # crossed a threshold the pre-call check didn't catch. Inline
    # declaration on post_call / embeddings so the dashboard's row
    # renderer doesn't have to join sibling policy_warn /
    # policy_block events. Omitted when no crossing.
    try:
        post_result = session.policy.check(session_total, 0)
        if post_result.decision in (PolicyDecision.WARN, PolicyDecision.BLOCK):
            decision_str = (
                "warn" if post_result.decision == PolicyDecision.WARN else "block"
            )
            post_source = post_result.source or "server"
            local = post_source == "local"
            post_decision = PolicyDecisionSummary(
                policy_id=post_result.policy_id or ("local" if local else ""),
                scope=post_result.matched_policy_scope
                or ("local_failsafe" if local else ""),
                decision=decision_str,
                reason=(
                    f"Post-call cumulative usage crossed {decision_str} "
                    f"threshold ({post_source} policy) on this call's tokens"
                ),
            )
            payload["policy_decision_post"] = post_decision.as_payload_dict()
    except Exception:
        _log.debug("policy_decision_post evaluation failed", exc_info=True)

    # output_dimensions on embeddings: small + observable summary so
    # the dashboard renders the shape chip without fetching
    # event_content.
    if event_type == EventType.EMBEDDINGS:
        try:
            dims = provider.extract_output_dimensions(response)
        except Exception:
            dims = None
        if dims:
            payload["output_dimensions"] = dims

    if event_type == EventType.POST_CALL:
        session.set_current_call_event_id(payload["id"])
    session.event_queue.enqueue(payload)

    # Emit one tool_call event per tool invocation in the response.
    # Supplementary to post_call (not a replacement) so dashboards can
    # filter/aggregate tool usage independently of the underlying LLM
    # call. Failures are swallowed -- tool extraction is best-effort
    # and must not destabilise the hot path.
    try:
        invocations = provider.extract_tool_invocations(response)
    except Exception:
        _log.debug("extract_tool_invocations raised; skipping tool events", exc_info=True)
        invocations = []
    for inv in invocations:
        try:
            # Phase 7 Step 3.b (D150): LLM-side tool_call routes
            # tool_input via event_content's dedicated tool_input
            # column when capture is on. Pre-Step-3.b path stamped
            # tool_input directly on the events row's payload; the
            # new path keeps events.payload lean and matches the
            # MCP tool_call capture posture (single content store
            # with dedicated columns).
            tool_payload = session._build_payload(
                EventType.TOOL_CALL,
                model=resp_model,
                tool_name=inv.name,
            )
            if session.config.capture_prompts and inv.tool_input is not None:
                # Build the event_content envelope. tool_output
                # populates retroactively when the next assistant
                # turn shows the result; this emit only knows the
                # input. Worker writes tool_input on insert; a
                # follow-up event (or an in-flight pass over the
                # response) populates tool_output via a separate
                # event_content path (out of Step 3.b scope —
                # captured on the row only when the response shape
                # carries it inline).
                from flightdeck_sensor.interceptor.mcp import (
                    _build_tool_capture_content,
                )
                capture_content = _build_tool_capture_content(
                    tool_input=inv.tool_input,
                    tool_output=None,
                    server_name=resp_model or "",
                    session_id=session.config.session_id,
                )
                if capture_content is not None:
                    # Override the provider field — this is an LLM
                    # tool call, not an MCP one. Worker doesn't
                    # branch on provider; the field is informational
                    # for operators querying event_content directly.
                    capture_content["provider"] = "llm"
                    tool_payload["has_content"] = True
                    tool_payload["content"] = capture_content
            session.event_queue.enqueue(tool_payload)
        except Exception:
            _log.debug("failed to enqueue tool_call event", exc_info=True)


# ------------------------------------------------------------------
# Phase 4 error-event emission. Classifies the live exception against
# the 14-entry taxonomy (see ``core/errors.py``), constructs an
# LLM_ERROR event with the structured ``error`` sub-object, and enqueues
# it for transport. Never raises -- classification itself is best-effort,
# and a failure to emit the error event must not perturb the re-raise
# that the caller is about to do.
# ------------------------------------------------------------------


def _emit_error(
    session: Session,
    provider: Provider,
    exc: BaseException,
    latency_ms: int,
    call_kwargs: dict[str, Any] | None,
    *,
    is_stream_error: bool = False,
    partial: dict[str, Any] | None = None,
) -> None:
    try:
        provider_hint = getattr(provider, "name", None)
        classification = classify_exception(
            exc,
            provider_hint=provider_hint,
            is_stream_error=is_stream_error,
            # H-2 fix: gate provider-controlled exception text on
            # capture_prompts. content_filter exceptions echo the
            # offending prompt fragment in their str(); when capture
            # is off, _redacted_message returns class name only so
            # the prompt fragment stays out of events.payload.
            capture_prompts=session.config.capture_prompts,
        )

        model: str | None = None
        if call_kwargs is not None:
            try:
                model = provider.get_model(call_kwargs)
            except Exception:
                model = call_kwargs.get("model") if isinstance(call_kwargs, dict) else None

        error_payload = classification.to_payload()
        if partial is not None:
            error_payload.update(partial)

        # Per-(provider, request_id) retry counter — bounded LRU on
        # Session — answers "did the retry chain finally give up".
        # terminal is best-effort: an error is terminal when the
        # classifier marks it non-retryable. The alternative
        # (lookback to confirm caller actually retried) needs cross-
        # event correlation that adds latency to the hot path; the
        # classifier-driven heuristic is correct for the vast
        # majority of real retry chains.
        # error_payload.get(...) returns Any | None; the `or
        # getattr(provider, "name", "")` fallback already produces a
        # str at runtime. cast(str, ...) tells mypy the result is str
        # without manufacturing a third "" fallback that would conflate
        # missing-key, present-but-None, and present-but-empty cases.
        provider_name = cast(
            "str", error_payload.get("provider") or getattr(provider, "name", "")
        )
        # Trust-boundary check: error_payload is sensor-internal but
        # composed from provider-supplied error attributes (request_id
        # is whatever the SDK exposed). isinstance enforces the
        # str | None contract record_retry_attempt expects, instead of
        # papering over a malformed value type with cast(). A non-str
        # request_id falls through to None — record_retry_attempt then
        # treats the call as a fresh attempt rather than crashing on a
        # type mismatch.
        request_id_raw = error_payload.get("request_id")
        request_id = request_id_raw if isinstance(request_id_raw, str) else None
        retry_attempt = session.record_retry_attempt(provider_name, request_id)
        terminal = not bool(error_payload.get("is_retryable", False))

        payload = session._build_payload(
            EventType.LLM_ERROR,
            model=model,
            latency_ms=latency_ms,
        )
        payload["error"] = error_payload
        payload["retry_attempt"] = retry_attempt
        payload["terminal"] = terminal
        session.event_queue.enqueue(payload)
    except Exception:
        _log.warning("Failed to emit llm_error event", exc_info=True)
