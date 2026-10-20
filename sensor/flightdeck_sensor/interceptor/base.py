"""Provider-agnostic intercept functions for LLM calls.

Four module-level entry points:

* :func:`call` -- synchronous intercept
* :func:`call_async` -- asynchronous intercept
* :func:`call_stream` -- streaming intercept (returns :class:`GuardedStream`)
* :func:`call_stream_async` -- async streaming intercept (returns
  :class:`GuardedAsyncStream`)

The two stream guards meter token usage from the events that pass through
them and emit the ``post_call`` once the stream settles.
"""

from __future__ import annotations

import collections
import contextlib
import copy
import inspect
import logging
import time
import weakref
from typing import TYPE_CHECKING, Any, cast

from flightdeck_sensor.core.errors import (
    TIMEOUT_EXCEPTION_NAMES,
    AbortReason,
    StreamOutcome,
    classify_exception,
)
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
    from collections.abc import AsyncIterator, Callable, Iterator
    from types import TracebackType

    from flightdeck_sensor.core.session import Session
    from flightdeck_sensor.providers.protocol import Provider

_log = logging.getLogger("flightdeck_sensor.interceptor.base")

# Keys of the stream fields a failed stream's llm_error carries under
# payload.error, next to the classification fields.
_KEY_ABORT_REASON = "abort_reason"
_KEY_PARTIAL_CHUNKS = "partial_chunks"
_KEY_PARTIAL_TOKENS_INPUT = "partial_tokens_input"
_KEY_PARTIAL_TOKENS_OUTPUT = "partial_tokens_output"

# Settles queued by guards' finalizers (see _GuardCore._defer_settle),
# drained at the next intercept and when the session ends. deque.append
# is atomic under the GIL, so the finalizer itself takes no lock.
_DEFERRED_SETTLES: collections.deque[Callable[[], None]] = collections.deque()


def drain_deferred_settles() -> None:
    """Run the settles that guards' finalizers queued."""
    while _DEFERRED_SETTLES:
        try:
            _DEFERRED_SETTLES.popleft()()
        except BaseException:
            _log.debug("Deferred stream settle failed", exc_info=True)


# Every guard that has sent its request and not yet settled, so a session
# ending with streams still open reports them before its queue closes.
_OPEN_GUARDS: weakref.WeakSet[_GuardCore] = weakref.WeakSet()


def settle_open_guards(session: Session) -> None:
    """Settle every open stream guard of ``session``; the session calls
    this as it ends, before its event queue closes, because a guard
    collected after that could no longer report."""
    for guard in list(_OPEN_GUARDS):
        try:
            if guard._session is session and guard._entered and not guard._finalized:
                guard._settle_now()
        except BaseException:
            _log.debug("Settling an open stream at session end failed", exc_info=True)


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
       error taxonomy and re-raise.
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

    Pre-call policy check runs *before* the guard is returned. Token
    reconciliation runs once the stream is exhausted, closed, or its
    ``with`` block exits (including early exit).
    """
    estimated, estimated_via = provider.estimate_tokens(kwargs)
    call_kwargs = _pre_call(session, provider, kwargs, estimated, estimated_via)
    return GuardedStream(
        real_fn,
        call_kwargs,
        session,
        provider,
        estimated,
        estimated_via,
    )


def call_stream_async(
    real_fn: Any,
    kwargs: dict[str, Any],
    session: Session,
    provider: Provider,
) -> GuardedAsyncStream:
    """Async streaming call intercept.

    Semantically identical to :func:`call_stream` with awaitable
    context-manager + async-iterator protocols. Pre-call policy check
    still runs synchronously before the context is returned so BLOCK is
    honoured before the first network byte.
    """
    estimated, estimated_via = provider.estimate_tokens(kwargs)
    call_kwargs = _pre_call(session, provider, kwargs, estimated, estimated_via)
    return GuardedAsyncStream(
        real_fn,
        call_kwargs,
        session,
        provider,
        estimated,
        estimated_via,
    )


def _merge_usage(current: TokenUsage | None, new: TokenUsage) -> TokenUsage:
    """Fold a usage snapshot read from a chunk into the running total.

    The counters are cumulative, so the larger value wins field by field:
    a later ``message_delta`` output count supersedes the first one, while
    a delta that carries a smaller or no input count leaves the input read
    from ``message_start`` untouched.
    """
    if current is None:
        return new
    return TokenUsage(
        input_tokens=max(new.input_tokens, current.input_tokens),
        output_tokens=max(new.output_tokens, current.output_tokens),
        cache_read_tokens=max(new.cache_read_tokens, current.cache_read_tokens),
        cache_creation_tokens=max(new.cache_creation_tokens, current.cache_creation_tokens),
    )


def _is_provider_failure(exc_val: BaseException | None) -> bool:
    """Whether an exception leaving a ``with`` block is the stream failing,
    as opposed to the caller leaving it: cancellations and interrupts are
    not ``Exception`` subclasses, and the sensor's own policy exceptions
    come from another intercepted call inside the block."""
    return (
        exc_val is not None
        and isinstance(exc_val, Exception)
        and not isinstance(exc_val, (BudgetExceededError, DirectiveError))
    )


def _abort_reason_for(exc: BaseException, saw_chunk: bool) -> str:
    """``abort_reason`` of a failed stream: where it failed, or ``timeout``
    whatever the position when the exception is a timeout."""
    if type(exc).__name__ in TIMEOUT_EXCEPTION_NAMES:
        return AbortReason.TIMEOUT.value
    if saw_chunk:
        return AbortReason.ERROR_MID_STREAM.value
    return AbortReason.ERROR_BEFORE_STREAM.value


def _text_deltas(guard: Any) -> Iterator[str]:
    """Text deltas read through the guard; the provider knows the event
    shape, the guard only meters."""
    for event in guard:
        text = guard._provider.text_from_stream_chunk(event)
        if text is not None:
            yield text


async def _async_text_deltas(guard: Any) -> AsyncIterator[str]:
    async for event in guard:
        text = guard._provider.text_from_stream_chunk(event)
        if text is not None:
            yield text


class _GuardCore:
    """State and provider-facing helpers shared by :class:`GuardedStream`
    and :class:`GuardedAsyncStream`. Everything here is synchronous; the
    subclasses add the sync or async lifecycle and iteration protocol."""

    # Inter-chunk gaps are kept for the p50 / p95 / max stats. 1000
    # entries is plenty for those percentiles on any realistic stream
    # and bounds memory on a very long one (the first 1000 gaps are kept).
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
        self._first_chunk_t: float | None = None
        self._last_chunk_t: float | None = None
        self._chunk_count: int = 0
        self._inter_chunk_ms: list[float] = []
        self._stream_iter: Any = None
        self._usage: TokenUsage | None = None
        self._entered = False
        self._exhausted = False
        self._finalized = False
        self._saw_terminal_chunk = False
        self._hook_failure_logged = False
        self._open_error: BaseException | None = None
        drain_deferred_settles()

    def _hook_failed(self, hook: str) -> None:
        """A provider stream hook raised. The guard carries on without it
        (metering falls back to what the other hooks and the estimate
        give) and says so once per stream rather than per chunk."""
        if not self._hook_failure_logged:
            self._hook_failure_logged = True
            _log.debug("Provider %s hook raised; stream metering degraded", hook, exc_info=True)

    def _require_stream(self) -> Any:
        """The SDK stream once the call succeeded; a guard whose call
        raised stays unusable and says why instead of failing on None."""
        if self._stream is None:
            raise RuntimeError("the stream never opened") from self._open_error
        return self._stream

    def _settle_now(self) -> None:
        """Settle synchronously with what the guard holds; the sync guard
        finalizes, the async guard settles on the snapshot usage."""
        raise NotImplementedError

    def _defer_settle(self) -> None:
        """Queue the settle for the next intercept or the session's end.

        A finalizer never settles inline: the cyclic collector can run it
        on any thread at any allocation, including inside a critical
        section of the session, its policy cache or its event queue, and
        none of those locks is re-entrant. The settle path takes all
        three, so running it from ``__del__`` could deadlock the sensor;
        a deque append takes no lock.
        """
        _DEFERRED_SETTLES.append(self._settle_now)

    def _emit_pre_stream_error(self, exc: BaseException) -> None:
        # The context-manager protocol does not call __exit__ when
        # __enter__ raises, and a plain iterator has no __exit__ at all,
        # so pre-stream failures (rate limit, auth) are reported here
        # before the exception reaches the caller.
        self._finalized = True
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
                    _KEY_ABORT_REASON: AbortReason.ERROR_BEFORE_STREAM.value,
                    _KEY_PARTIAL_CHUNKS: 0,
                },
            )
        except Exception as emit_exc:
            # No exc_info: the provider exception is the active context and
            # may echo prompt text; the failure class is enough.
            _log.warning(
                "Failed to emit llm_error for pre-stream exception (%s)", type(emit_exc).__name__
            )

    def _record_chunk(self, chunk: Any) -> None:
        now = time.monotonic()
        if self._first_chunk_t is None:
            self._first_chunk_t = now
        else:
            gap_ms = (now - (self._last_chunk_t or now)) * 1000
            if len(self._inter_chunk_ms) < self._MAX_GAPS_TRACKED:
                self._inter_chunk_ms.append(gap_ms)
        self._last_chunk_t = now
        self._chunk_count += 1
        try:
            found = self._provider.usage_from_stream_chunk(chunk)
        except Exception:
            self._hook_failed("usage_from_stream_chunk")
            found = None
        if found is not None:
            self._usage = _merge_usage(self._usage, found)
        try:
            if self._provider.chunk_completes_stream(chunk):
                self._saw_terminal_chunk = True
        except Exception:
            self._hook_failed("chunk_completes_stream")

    def _merge_settled_usage(self) -> None:
        """Fold in the usage the SDK stream object holds at settle time
        (a helper's accumulated snapshot); safe on every path because the
        provider never reads further from the stream here."""
        try:
            settled = self._provider.usage_from_finished_stream(self._stream)
        except Exception:
            self._hook_failed("usage_from_finished_stream")
            settled = None
        if settled is not None:
            self._usage = _merge_usage(self._usage, settled)

    def _is_complete(self) -> bool:
        """Whether the response was read in full: the SDK iterator ended, a
        terminal event passed through the guard (a consumer that stops at
        it has read the whole response), or a helper stream reports its
        message complete."""
        if self._exhausted or self._saw_terminal_chunk:
            return True
        try:
            return bool(self._provider.stream_completed(self._stream))
        except Exception:
            self._hook_failed("stream_completed")
            return False

    def _emit_stream_error(self, exc_val: BaseException) -> None:
        if self._finalized:
            return
        self._finalized = True
        latency_ms = int((time.monotonic() - self._t0) * 1000)
        try:
            # A helper consumed through get_final_message() bypasses the
            # guard's iterator, so whether data had arrived is judged by
            # the chunks the guard saw or the usage the stream object had
            # accumulated by the time it failed.
            self._merge_settled_usage()
            saw_data = self._first_chunk_t is not None or (
                self._usage is not None and self._usage.total > 0
            )
            _emit_error(
                self._session,
                self._provider,
                exc_val,
                latency_ms,
                self._kwargs,
                is_stream_error=saw_data,
                partial=self._partial_block(exc_val, saw_data),
            )
        except Exception as emit_exc:
            # No exc_info: the provider exception is the active context and
            # may echo prompt text; the failure class is enough.
            _log.warning(
                "Failed to emit llm_error for stream exception (%s)", type(emit_exc).__name__
            )

    def _partial_block(self, exc_val: BaseException, saw_data: bool) -> dict[str, Any]:
        """The llm_error partial block for a failed stream: abort reason,
        chunks read, and the tokens the provider had already delivered
        (which it bills, so they also count against the session)."""
        abort_reason = _abort_reason_for(exc_val, saw_data)
        partial: dict[str, Any] = {
            _KEY_ABORT_REASON: abort_reason,
            _KEY_PARTIAL_CHUNKS: self._chunk_count,
        }
        if self._usage is not None and self._usage.total > 0:
            partial[_KEY_PARTIAL_TOKENS_INPUT] = self._usage.input_tokens
            partial[_KEY_PARTIAL_TOKENS_OUTPUT] = self._usage.output_tokens
            with contextlib.suppress(Exception):
                self._session.record_usage(self._usage)
        return partial

    def _settle(self, message: Any | None, completed: bool) -> None:
        """Emit the post_call once. ``message`` is the helper's assembled
        final message when one is available; it then stands in for the
        stream as the response so content capture and tool-call
        extraction see the full response."""
        if self._finalized or not self._entered:
            return
        self._finalized = True
        # An aborted stream is timed to its last chunk: a settle that runs
        # at close() or collection long after the caller stopped reading
        # would otherwise report idle time as latency.
        end_t = time.monotonic()
        if not completed and self._last_chunk_t is not None:
            end_t = self._last_chunk_t
        latency_ms = int((end_t - self._t0) * 1000)
        try:
            self._merge_settled_usage()
            _post_call(
                self._session,
                self._provider,
                self._stream if message is None else message,
                self._estimated,
                latency_ms,
                self._kwargs,
                streaming=_build_streaming_summary(
                    self._t0,
                    self._first_chunk_t,
                    self._chunk_count,
                    self._inter_chunk_ms,
                    completed,
                ),
                estimated_via=self._estimated_via,
                usage_override=self._usage,
            )
        except Exception as emit_exc:
            # No exc_info: the provider exception is the active context and
            # may echo prompt text; the failure class is enough.
            _log.warning("Failed to post stream reconciliation event (%s)", type(emit_exc).__name__)


class GuardedStream(_GuardCore):
    """Guard around a streaming LLM response.

    Works as a context manager (``with guard as s: for chunk in s``) and
    as a plain iterator (``for chunk in guard``) because the SDKs
    document both patterns. As chunks pass through, the provider reads
    any token usage they carry (``usage_from_stream_chunk``) and the
    guard keeps the merged result, so ``post_call`` reports the counts
    the provider sent inside the stream rather than the pre-call
    estimate. The event is emitted exactly once, at the first of: the
    stream being read to its end, ``close()``, leaving the ``with``
    block, or the guard being garbage-collected; a failure emits
    ``llm_error`` instead. Every other attribute (``get_final_message``,
    ``response``, ``request_id``) is proxied to the SDK stream, and
    ``text_stream`` is re-implemented on top of the guard so it is
    metered too.
    """

    def _enter_stream(self) -> None:
        """Make the underlying call once. ``self._stream`` is the SDK
        object the caller iterates; ``self._ctx`` is whatever the call
        returned (a context manager for ``messages.stream()``, the
        stream itself for ``create(stream=True)``)."""
        if self._entered:
            return
        self._entered = True
        self._t0 = time.monotonic()
        try:
            self._ctx = self._real_fn(**self._kwargs)
            if hasattr(self._ctx, "__enter__"):
                self._stream = self._ctx.__enter__()
            else:
                self._stream = self._ctx
            _OPEN_GUARDS.add(self)
        except BaseException as exc:
            self._open_error = exc
            self._emit_pre_stream_error(exc)
            raise

    def open(self) -> GuardedStream:
        """Send the request now instead of on first use. ``create(stream=True)``
        calls this so provider errors surface at the call, as they do on
        the unguarded SDK; ``messages.stream()`` stays lazy like the SDK's
        own context manager."""
        self._enter_stream()
        return self

    def __enter__(self) -> GuardedStream:
        self._enter_stream()
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: TracebackType | None,
    ) -> None:
        if exc_val is not None and _is_provider_failure(exc_val):
            self._close_underlying(exc_type, exc_val, exc_tb)
            self._emit_stream_error(exc_val)
            return
        # No exception, a cancellation / interrupt (GeneratorExit,
        # KeyboardInterrupt) or the sensor's own policy exception: the
        # caller left the stream, which is an aborted post_call, not a
        # provider failure.
        self._finalize()
        self._close_underlying(exc_type, exc_val, exc_tb)

    def close(self) -> None:
        """Settle the accounting and close the SDK stream. Lets callers
        that iterate without a ``with`` block stop early and still get
        their ``post_call`` promptly."""
        self._finalize()
        self._close_underlying(None, None, None)

    def _close_underlying(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: TracebackType | None,
    ) -> None:
        try:
            if self._ctx is not None and hasattr(self._ctx, "__exit__"):
                self._ctx.__exit__(exc_type, exc_val, exc_tb)
            elif self._stream is not None and hasattr(self._stream, "close"):
                self._stream.close()
        except Exception:
            _log.debug("Exception closing underlying stream", exc_info=True)

    def _finalize(self) -> None:
        if self._finalized or not self._entered:
            return
        completed = self._is_complete()
        message: Any = None
        if completed:
            # A complete helper stream hands over its assembled message.
            # An awaitable here cannot be used on this sync path; the
            # snapshot usage still applies.
            try:
                message = self._provider.final_message(self._stream)
            except Exception:
                self._hook_failed("final_message")
                message = None
            if inspect.isawaitable(message):
                with contextlib.suppress(Exception):
                    message.close()  # type: ignore[attr-defined]
                message = None
        self._settle(message, completed)

    def __del__(self) -> None:
        # A plain loop abandoned with ``break`` reaches neither close()
        # nor __exit__; queue the settle when the guard is collected so
        # the call is still reported. Everything is suppressed: __del__
        # can run at interpreter shutdown or inside another thread's
        # collection.
        try:
            if self._entered and not self._finalized:
                self._defer_settle()
        except BaseException:
            pass

    def _settle_now(self) -> None:
        self._finalize()

    # -- iteration -----------------------------------------------------

    def __iter__(self) -> Iterator[Any]:
        self._enter_stream()
        if self._stream_iter is None:
            self._stream_iter = iter(self._require_stream())
        return self

    def __next__(self) -> Any:
        self._enter_stream()
        if self._stream_iter is None:
            self._stream_iter = iter(self._require_stream())
        try:
            chunk = next(self._stream_iter)
        except StopIteration:
            self._exhausted = True
            self._finalize()
            raise
        except Exception as exc:
            # A provider error raised while reading (an error event, a
            # connection reset) is reported here so a caller iterating
            # without a with block, whose __exit__ never runs, still gets
            # the llm_error; the with form is idempotent through
            # _finalized.
            self._emit_stream_error(exc)
            raise
        self._record_chunk(chunk)
        return chunk

    @property
    def text_stream(self) -> Iterator[str]:
        """Text deltas of a helper stream, iterated through the guard so
        chunk stats and usage are recorded; the SDK's own ``text_stream``
        would bypass the guard. Absent, as on the SDK object, when the
        stream has no ``text_stream`` of its own."""
        # The SDK helpers set ``text_stream`` on the instance in __init__
        # (the class carries only the annotation), so probe the object.
        self._enter_stream()
        if not hasattr(self._stream, "text_stream"):
            raise AttributeError("text_stream")
        return _text_deltas(self)

    def __getattr__(self, name: str) -> Any:
        # Reached only for names the guard itself does not define. Keep
        # private / dunder lookups local so hasattr() probes and copy /
        # pickle machinery never trigger the underlying call.
        if name.startswith("_"):
            raise AttributeError(name)
        self._enter_stream()
        if self._stream is None:
            raise AttributeError(name)
        return getattr(self._stream, name)


def _build_streaming_summary(
    t0: float,
    first_chunk_t: float | None,
    chunk_count: int,
    inter_chunk_ms: list[float],
    completed: bool,
) -> dict[str, Any]:
    """Streaming sub-object attached to the post_call payload.

    * ``ttft_ms`` -- ``None`` if no chunks ever arrived, else the
      millisecond delta from request dispatch to first chunk.
    * ``chunk_count`` -- chunks the caller iterated through the guard.
      Zero is legal (the caller entered the context and never iterated).
    * ``inter_chunk_ms`` -- ``{"p50", "p95", "max"}`` over the captured
      gaps; ``None`` when fewer than two chunks arrived.
    * ``final_outcome`` -- ``"completed"`` when the stream was read to
      its end (the SDK iterator ended, a terminal event passed through
      the guard, or a helper stream reports its message complete), else
      ``"aborted"``.
    * ``abort_reason`` -- ``"client_aborted"`` on an aborted stream, else
      ``None``. Provider failures never reach this helper: they emit
      ``llm_error`` with their own abort reason.
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

    return {
        "ttft_ms": ttft_ms,
        "chunk_count": chunk_count,
        "inter_chunk_ms": inter_chunk,
        "final_outcome": (StreamOutcome.COMPLETED if completed else StreamOutcome.ABORTED).value,
        "abort_reason": None if completed else AbortReason.CLIENT_ABORTED.value,
    }


class GuardedAsyncStream(_GuardCore):
    """Async counterpart of :class:`GuardedStream`.

    Supports ``async with client.messages.stream(...) as s: async for
    chunk in s`` as well as ``async for chunk in await
    client.chat.completions.create(..., stream=True)`` with no ``async
    with``. Metering, emission and attribute proxying follow the sync
    guard; the underlying call may return a coroutine that resolves to
    the stream, which is awaited once, and a complete helper's final
    message is awaited at settle time so content capture sees the full
    response. Attributes of the SDK stream are reachable only once the
    guard has been entered (``async with`` or the first ``async for``),
    since entering requires an ``await``.
    """

    async def _enter_stream(self) -> None:
        if self._entered:
            return
        self._entered = True
        self._t0 = time.monotonic()
        try:
            self._ctx = self._real_fn(**self._kwargs)
            # AsyncOpenAI.chat.completions.create(stream=True) returns a
            # coroutine resolving to the async stream; AsyncAnthropic's
            # messages.stream() returns the async context manager
            # directly. Await once, then enter if it is a context manager.
            if inspect.iscoroutine(self._ctx):
                self._ctx = await self._ctx
            if hasattr(self._ctx, "__aenter__"):
                self._stream = await self._ctx.__aenter__()
            else:
                self._stream = self._ctx
            _OPEN_GUARDS.add(self)
        except BaseException as exc:
            self._open_error = exc
            self._emit_pre_stream_error(exc)
            raise

    async def open(self) -> GuardedAsyncStream:
        """Send the request now (see :meth:`GuardedStream.open`)."""
        await self._enter_stream()
        return self

    async def __aenter__(self) -> GuardedAsyncStream:
        await self._enter_stream()
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: TracebackType | None,
    ) -> None:
        if exc_val is not None and _is_provider_failure(exc_val):
            await self._close_underlying(exc_type, exc_val, exc_tb)
            self._emit_stream_error(exc_val)
            return
        # No exception, a cancellation (asyncio.CancelledError,
        # GeneratorExit) or the sensor's own policy exception: the caller
        # left the stream.
        await self._finalize()
        await self._close_underlying(exc_type, exc_val, exc_tb)

    async def close(self) -> None:
        """Settle the accounting and close the SDK stream (mirrors the
        SDKs' ``await stream.close()``)."""
        await self._finalize()
        await self._close_underlying(None, None, None)

    async def _close_underlying(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: TracebackType | None,
    ) -> None:
        try:
            if self._ctx is not None and hasattr(self._ctx, "__aexit__"):
                await self._ctx.__aexit__(exc_type, exc_val, exc_tb)
            elif self._stream is not None and hasattr(self._stream, "close"):
                result = self._stream.close()
                if inspect.isawaitable(result):
                    await result
        except Exception:
            _log.debug("Exception closing underlying async stream", exc_info=True)

    async def _finalize(self) -> None:
        if self._finalized or not self._entered:
            return
        completed = self._is_complete()
        message: Any = None
        if completed:
            try:
                message = self._provider.final_message(self._stream)
                if inspect.isawaitable(message):
                    message = await message
            except Exception:
                self._hook_failed("final_message")
                message = None
        self._settle(message, completed)

    def _settle_now(self) -> None:
        # An awaitable final message cannot be awaited here, so the settle
        # uses the snapshot usage and the complete snapshot when there is
        # one.
        self._settle(None, self._is_complete())

    def __del__(self) -> None:
        # See GuardedStream.__del__.
        try:
            if self._entered and not self._finalized:
                self._defer_settle()
        except BaseException:
            pass

    def __aiter__(self) -> GuardedAsyncStream:
        return self

    async def __anext__(self) -> Any:
        await self._enter_stream()
        if self._stream_iter is None:
            self._stream_iter = self._require_stream().__aiter__()
        try:
            chunk = await self._stream_iter.__anext__()
        except StopAsyncIteration:
            self._exhausted = True
            await self._finalize()
            raise
        except Exception as exc:
            self._emit_stream_error(exc)
            raise
        self._record_chunk(chunk)
        return chunk

    @property
    def text_stream(self) -> AsyncIterator[str]:
        """Async text deltas of a helper stream, iterated through the guard
        (see :attr:`GuardedStream.text_stream`); reachable once the stream
        is open, like every other proxied attribute."""
        if self._stream is None or not hasattr(self._stream, "text_stream"):
            raise AttributeError("text_stream")
        return _async_text_deltas(self)

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_") or self._stream is None:
            raise AttributeError(name)
        return getattr(self._stream, name)


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
      :class:`BudgetExceededError`. Source is always ``"server"``
      (local thresholds fire WARN only).
    * DEGRADE: returns a *copy* of kwargs with swapped model. POLICY_
      DEGRADE is NOT emitted here — it fires once on
      ``_apply_directive(DEGRADE)`` arrival. Per-call swaps are visible
      via post_call.model only.
    * WARN: emit :attr:`EventType.POLICY_WARN` (source ``"local"`` for
      ``init(limit=...)`` thresholds, ``"server"`` for server policy),
      log warning, return original kwargs.
    * ALLOW: returns original kwargs unchanged.
    """
    drain_deferred_settles()
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
            scope=result.matched_policy_scope or ("local_failsafe" if local_warn else ""),
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
        # POLICY_BLOCK: source hardcoded ``"server"`` — local
        # PolicyCache fires WARN only, never BLOCK. ``intended_model``
        # captures the model the blocked call was going to use so the
        # operator can answer "which call hit the limit?".
        intended_model = provider.get_model(kwargs)
        # Shared policy_decision block. Reason
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
        # Shared policy_decision block.
        local_warn = warn_source == "local"
        warn_decision = PolicyDecisionSummary(
            policy_id=result.policy_id or ("local" if local_warn else ""),
            scope=result.matched_policy_scope or ("local_failsafe" if local_warn else ""),
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
    usage_override: TokenUsage | None = None,
) -> None:
    """Extract actual usage, reconcile with estimate, post event.

    ``event_type`` defaults to :attr:`EventType.POST_CALL`; callers pass
    :attr:`EventType.EMBEDDINGS` for embedding-model calls so the dashboard
    can render them distinctly.

    ``streaming`` carries the streaming sub-object (``ttft_ms``,
    chunk stats, ``final_outcome``) when the response came from
    :class:`GuardedStream`. Omitted entirely for non-streaming calls so the
    wire shape stays identical for non-streaming calls.
    """
    # ``usage_override`` carries the counts a stream guard read from the
    # provider's in-stream usage events; stream objects themselves expose
    # no usage, so without it every streamed call would fall back to the
    # estimate.
    if usage_override is not None and usage_override.total > 0:
        actual = usage_override
    else:
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
    # curve.
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
            decision_str = "warn" if post_result.decision == PolicyDecision.WARN else "block"
            post_source = post_result.source or "server"
            local = post_source == "local"
            post_decision = PolicyDecisionSummary(
                policy_id=post_result.policy_id or ("local" if local else ""),
                scope=post_result.matched_policy_scope or ("local_failsafe" if local else ""),
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
            # LLM-side tool_call routes tool_input via event_content's
            # dedicated tool_input column when capture is on, which keeps
            # events.payload lean and matches the MCP tool_call capture
            # posture (single content store with dedicated columns).
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
                # event_content path (out of scope here —
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
# Error-event emission. Classifies the live exception against
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
            # Provider-controlled exception text is gated on
            # capture_prompts: content_filter exceptions echo the
            # offending prompt fragment in their str(); when capture
            # is off, _redacted_message returns the class name only so
            # the fragment stays out of events.payload.
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
        provider_name = cast("str", error_payload.get("provider") or getattr(provider, "name", ""))
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
    except Exception as emit_exc:
        # No exc_info: the provider exception is the active context and
        # may echo prompt text; the failure class is enough.
        _log.warning("Failed to emit llm_error event (%s)", type(emit_exc).__name__)
