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
import contextvars
import copy
import inspect
import logging
import time
import types
import weakref
from typing import TYPE_CHECKING, Any, cast

from flightdeck_sensor.core.errors import (
    REQUEST_ID_MAX_LEN,
    TIMEOUT_EXCEPTION_NAMES,
    AbortReason,
    ErrorType,
    StreamOutcome,
    classify_exception,
    classify_stop_reason,
)
from flightdeck_sensor.core.exceptions import (
    BudgetExceededError,
    DirectiveError,
    MCPPolicyBlocked,
)
from flightdeck_sensor.core.types import (
    CallDetails,
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


# ------------------------------------------------------------------
# Outer-call mark: an outer interceptor and the SDK interceptors it
# reaches report one call once
# ------------------------------------------------------------------
#
# litellm serves its OpenAI route by calling the OpenAI SDK, whose
# ``chat.completions`` the sensor also intercepts. Without coordination
# that one call is reported twice: by the litellm wrapper, and again by
# the SDK interceptor the wrapper ends up calling. So the outer
# interceptor runs the underlying call inside ``outer_intercept()``, and
# an SDK interceptor that finds ``outer_intercept_active()`` true hands
# the call to the SDK untouched -- no pre_call, no policy check, no
# stream guard, no post_call -- because the outer interceptor already
# does all of that for the same call.
#
# The mark lives in a ContextVar and is a small per-call flag object:
# another thread, or a task created before the call, never sees it, so
# an SDK call they make at the same time is still reported; a task
# created inside the call inherits a copy of the context (asyncio copies
# it into new tasks) and reads the mark active while the call is in
# flight and inactive once it has ended, because the flag is cleared
# when the call ends rather than only reset in the creating context.
# (litellm's executor hop for sync-only providers copies the context,
# so the mark follows that too.) Reading the mark costs one ContextVar
# lookup and one attribute read per intercepted call.
#
# Scope, stated as a limitation: the mark covers the whole outer call,
# so an SDK call made from inside it while it is in flight -- by a
# litellm callback, guardrail or custom provider, or by a task created
# inside the call -- is neither policed nor metered. Narrowing the mark
# to the one SDK call the outer interceptor serves (a per-call client
# identity) was judged not worth the complexity for now. Pinned by
# test_sdk_call_from_a_litellm_pre_call_hook_runs_under_the_mark_and_emits_nothing
# in tests/unit/test_interceptor_litellm.py.
#
# Opting in:
# * Outer side: wrap the function handed to call / call_async /
#   call_stream / call_stream_async so it runs under
#   ``with outer_intercept():`` (see ``_as_outer_call`` in litellm.py).
#   The mark covers the call only; a stream's chunks are read later,
#   outside the block, which is fine because the SDK request itself is
#   sent inside the call.
# * Inner side: at the point where the SDK wrapper would otherwise enter
#   the sensor, ``if outer_intercept_active(): return <the raw path>``.
#   openai.py does this where ``client.chat.completions`` is resolved
#   (SensorChat.completions) and in SensorEmbeddings.create; anthropic.py
#   in the patched resource methods (_intercepting_method) and, for a
#   wrap()-built client, in SensorMessages.create / stream / parse.


class _OuterCall:
    """The mark of one outer call: ``active`` is cleared when the call
    ends, so every context that copied a reference (a task created inside
    the call) reads the call as over, not only the context that set it."""

    __slots__ = ("active",)

    def __init__(self) -> None:
        self.active = True


_OUTER_INTERCEPT: contextvars.ContextVar[_OuterCall | None] = contextvars.ContextVar(
    "flightdeck_outer_intercept", default=None
)


@contextlib.contextmanager
def outer_intercept() -> Iterator[None]:
    """Mark the provider call made inside the block as already metered by
    the interceptor running it, so an SDK interceptor the call reaches
    passes it through. Nesting is safe: the outer mark stays active until
    the outermost block exits."""
    mark = _OuterCall()
    token = _OUTER_INTERCEPT.set(mark)
    try:
        yield
    finally:
        mark.active = False
        _OUTER_INTERCEPT.reset(token)


def outer_intercept_active() -> bool:
    """Whether an outer interceptor is making the current call (see
    :func:`outer_intercept`); an SDK interceptor that sees ``True`` hands
    the call to the SDK untouched."""
    mark = _OUTER_INTERCEPT.get()
    return mark is not None and mark.active


def drain_deferred_settles(session: Session) -> None:
    """Run the settles that guards' finalizers queued on ``session``
    (see _GuardCore._defer_settle); called at every intercept on that
    session and when it ends. deque.append and popleft are atomic under
    the GIL, so neither the finalizer nor the drain takes a lock."""
    queue = getattr(session, "queued_stream_settles", None)
    if not isinstance(queue, collections.deque):
        return
    while True:
        try:
            settle = queue.popleft()
        except IndexError:  # empty, or another thread drained it first
            return
        try:
            settle()
        except Exception:
            _log.debug("Deferred stream settle failed", exc_info=True)


def settle_open_guards(session: Session) -> None:
    """Settle every open stream guard of ``session``; the session calls
    this as it ends, before its event queue closes, because a guard
    collected after that could no longer report. Registration and this
    snapshot share the session's lock, because a weak set cannot be
    iterated while another thread adds to it."""
    guards_set = getattr(session, "open_stream_guards", None)
    lock = getattr(session, "open_stream_guards_lock", None)
    if not isinstance(guards_set, weakref.WeakSet) or lock is None:
        return
    with lock:
        guards = list(guards_set)
    for guard in guards:
        try:
            if guard._session is session and guard._entered and not guard._finalized:
                guard._settle_now()
        except Exception:
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
    *,
    hide_chunk: Callable[[Any], bool] | None = None,
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
        hide_chunk=hide_chunk,
    )


def call_stream_async(
    real_fn: Any,
    kwargs: dict[str, Any],
    session: Session,
    provider: Provider,
    *,
    hide_chunk: Callable[[Any], bool] | None = None,
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
        hide_chunk=hide_chunk,
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
        reasoning_tokens=_max_reported(new.reasoning_tokens, current.reasoning_tokens),
        cache_creation_1h_tokens=_max_reported(
            new.cache_creation_1h_tokens, current.cache_creation_1h_tokens
        ),
    )


def _max_reported(a: int | None, b: int | None) -> int | None:
    """The larger of two optional cumulative counters; ``None`` only when
    neither was reported."""
    if a is None:
        return b
    if b is None:
        return a
    return max(a, b)


# Billing modes the sensor stamps (ARCHITECTURE.md, Cost estimation): a
# call to a model server on this machine is local, every other call is
# paid per token unless init(billing_mode=) / FLIGHTDECK_BILLING_MODE
# says otherwise.
BILLING_METERED = "metered"
BILLING_LOCAL = "local"

# The ingestion API's cap on the free-form strings of the token and cost
# fields (model ids, tier, speed, residency, stop reason), in UTF-8 bytes;
# a longer value would get the whole event rejected, so it is cut to fit
# instead.
_MAX_DETAIL_BYTES = 256

# Set on an exception once an intercept has reported it, so a stream's
# with-exit does not report the same failure of a nested call again.
_REPORTED_ATTR = "_flightdeck_reported"


def _mark_reported(exc: BaseException) -> None:
    with contextlib.suppress(Exception):
        setattr(exc, _REPORTED_ATTR, True)


def _is_provider_failure(exc_val: BaseException | None) -> bool:
    """Whether an exception leaving a ``with`` block is the stream failing.

    SDK errors raised while reading through the guard are reported in
    ``__next__`` / ``__anext__``; an exception reaching ``__exit__`` came
    from the caller's own body or from a helper method that read the
    stream itself. It is a provider failure only when no intercept has
    reported it already and either the error classifier knows its class
    or it comes from a transport or SDK module (or is a ConnectionError),
    whoever raised it. Cancellations and interrupts are not ``Exception``
    subclasses, the sensor's own policy exceptions come from another
    intercepted call inside the block, and the caller's own bugs are the
    caller leaving.
    """
    if exc_val is None or not isinstance(exc_val, Exception):
        return False
    if getattr(exc_val, _REPORTED_ATTR, False):
        return False
    if isinstance(exc_val, (BudgetExceededError, DirectiveError, MCPPolicyBlocked)):
        return False
    if classify_exception(exc_val, provider_hint=None).error_type is not ErrorType.OTHER:
        return True
    # The SDKs wrap only the request: a response body that dies raises the
    # transport's own classes (httpx.ReadTimeout, RemoteProtocolError, a
    # reset) through helper methods such as get_final_message().
    module = type(exc_val).__module__.partition(".")[0]
    return module in _TRANSPORT_MODULES or isinstance(exc_val, ConnectionError)


# Modules whose exceptions mean the stream or its transport failed.
# httpx2 / httpcore2 are the transport of the anthropic 2.x and openai
# 3.x SDKs; h2 raises for HTTP/2 connections on either transport.
_TRANSPORT_MODULES = frozenset(
    {"httpx", "httpcore", "httpx2", "httpcore2", "anyio", "h11", "h2", "anthropic", "openai"}
)


# Stands in for a stream the finalizer dropped: it has no attributes, so
# content capture stores an empty response rather than a placeholder.
_DROPPED_STREAM = types.SimpleNamespace()


def _abort_reason_for(exc: BaseException, saw_chunk: bool) -> str:
    """``abort_reason`` of a failed stream: where it failed, or ``timeout``
    whatever the position when the exception is a timeout."""
    if type(exc).__name__ in TIMEOUT_EXCEPTION_NAMES:
        return AbortReason.TIMEOUT.value
    if saw_chunk:
        return AbortReason.ERROR_MID_STREAM.value
    return AbortReason.ERROR_BEFORE_STREAM.value


def _text_of(guard: Any, event: Any) -> str | None:
    """The provider's text for one event; a failing hook degrades the
    text stream to empty rather than breaking the caller's loop."""
    try:
        text = guard._provider.text_from_stream_chunk(event)
    except Exception:
        guard._hook_failed("text_from_stream_chunk")
        return None
    return text if isinstance(text, str) else None


def _text_deltas(guard: Any) -> Iterator[str]:
    """Text deltas read through the guard; the provider knows the event
    shape, the guard only meters."""
    for event in guard:
        text = _text_of(guard, event)
        if text is not None:
            yield text


async def _async_text_deltas(guard: Any) -> AsyncIterator[str]:
    async for event in guard:
        text = _text_of(guard, event)
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
        hide_chunk: Callable[[Any], bool] | None = None,
    ) -> None:
        self._real_fn = real_fn
        self._kwargs = kwargs
        self._session = session
        self._provider = provider
        self._estimated = estimated
        self._estimated_via = estimated_via
        # Chunks the guard absorbs instead of handing to the caller (the
        # usage chunk the sensor asked OpenAI for); None hides nothing.
        self._hide_chunk = hide_chunk
        self._stream: Any = None
        self._ctx: Any = None
        self._t0: float = 0.0
        self._opened_t: float | None = None
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
        # The stop reason a streamed event announced (a raw
        # stream has no final message to read it from at settle time).
        self._stop_reason: str | None = None
        # Call details the streamed events reported (served model, tier,
        # server-tool counters), folded event by event.
        self._details: CallDetails | None = None
        self._hooks_failed: set[str] = set()
        self._open_error: BaseException | None = None
        drain_deferred_settles(session)

    def _hook_failed(self, hook: str) -> None:
        """A provider stream hook raised. The guard carries on without it
        (metering falls back to what the other hooks and the estimate
        give) and says so once per hook and stream rather than per chunk."""
        if hook not in self._hooks_failed:
            self._hooks_failed.add(hook)
            _log.debug("Provider %s hook raised; stream metering degraded", hook, exc_info=True)

    def _register_open(self) -> None:
        guards = getattr(self._session, "open_stream_guards", None)
        lock = getattr(self._session, "open_stream_guards_lock", None)
        if isinstance(guards, weakref.WeakSet) and lock is not None:
            with lock:
                guards.add(self)

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

    def _plain_final_message(self) -> Any | None:
        """The provider's final message when it is a plain object; an
        awaitable (an async helper's coroutine) is closed and dropped,
        because the callers of this helper have no event loop."""
        try:
            message = self._provider.final_message(self._stream)
        except Exception:
            self._hook_failed("final_message")
            return None
        if inspect.isawaitable(message):
            with contextlib.suppress(Exception):
                message.close()  # type: ignore[attr-defined]
            return None
        return message

    def _hidden(self, chunk: Any) -> bool:
        if self._hide_chunk is None:
            return False
        try:
            return bool(self._hide_chunk(chunk))
        except Exception:
            self._hook_failed("hide_chunk")
            return False

    def _defer_settle(self) -> None:
        """Queue the settle for the next intercept or the session's end.

        A finalizer never settles inline: the cyclic collector can run it
        on any thread at any allocation, including inside a critical
        section of the session, its policy cache or its event queue, and
        none of those locks is re-entrant. The settle path takes all
        three, so running it from ``__del__`` could deadlock the sensor;
        a deque append takes no lock.

        Everything the settle needs is read here with plain attribute
        reads (the merged usage, whether the response completed, a
        complete helper's snapshot), then the SDK stream and the call are
        dropped, so the collection frees the stream, and with it its HTTP
        connection, at once; a stream kept until the drain would keep the
        provider generating. Closing it here is not an option either, as
        the SDK's close takes the connection pool's lock.
        """
        self._merge_settled_usage()
        completed = self._is_complete()
        message = self._plain_final_message() if completed else None
        self._saw_terminal_chunk = completed  # the stream can no longer be asked
        self._stream = None
        self._ctx = None
        self._stream_iter = None
        self._real_fn = None
        queue = getattr(self._session, "queued_stream_settles", None)
        if isinstance(queue, collections.deque):
            queue.append(lambda: self._settle(message, completed))

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

    def _record_chunk(self, chunk: Any, *, visible: bool = True) -> None:
        """Meter one chunk. A hidden chunk (one the guard absorbs instead of
        handing to the caller) contributes usage and completion but no
        count or timing, so the stats describe what the caller saw."""
        if visible:
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
        try:
            reason = self._provider.stop_reason_from_stream_chunk(chunk)
        except Exception:
            self._hook_failed("stop_reason_from_stream_chunk")
            reason = None
        if isinstance(reason, str):
            self._stop_reason = reason
        try:
            details = self._provider.call_details_from_stream_chunk(chunk)
        except Exception:
            self._hook_failed("call_details_from_stream_chunk")
            details = None
        # Chat chunks repeat the same model and tier on every chunk; fold
        # only a chunk that reports something new.
        if details is not None and details != self._details:
            self._details = details if self._details is None else self._details.merged(details)

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
        # A settle may run long after the caller stopped reading (close(),
        # collection, session end, a stop at the terminal event), so only a
        # stream the guard read to its end, or a helper the caller read to
        # completion itself, is timed to the settle; otherwise latency runs
        # to the last chunk delivered, or to the moment the response opened
        # when no chunk was.
        end_t = time.monotonic()
        if not self._exhausted and not (completed and self._last_chunk_t is None):
            end_t = self._last_chunk_t or self._opened_t or end_t
        latency_ms = int((end_t - self._t0) * 1000)
        try:
            self._merge_settled_usage()
            _post_call(
                self._session,
                self._provider,
                message
                if message is not None
                else (self._stream if self._stream is not None else _DROPPED_STREAM),
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
                stop_reason=self._stop_reason,
                details_override=self._details,
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
            self._register_open()
            self._opened_t = time.monotonic()
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
        if exc_val is not None and not self._is_complete() and _is_provider_failure(exc_val):
            self._close_underlying(exc_type, exc_val, exc_tb)
            self._emit_stream_error(exc_val)
            return
        # No exception, a response already read in full, a cancellation /
        # interrupt, the sensor's own policy exception or the caller's own
        # exception: the caller left the stream, which is a post_call
        # (completed when the response was read in full, else aborted),
        # not a provider failure.
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
        except Exception as exc:
            # No exc_info: a provider error may be the active context and
            # echo prompt text.
            _log.debug("Exception closing underlying stream (%s)", type(exc).__name__)

    def _finalize(self) -> None:
        if self._finalized or not self._entered:
            return
        completed = self._is_complete()
        # A complete helper stream hands over its assembled message; an
        # awaitable cannot be used on this sync path, the snapshot usage
        # still applies.
        self._settle(self._plain_final_message() if completed else None, completed)

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
        while True:
            try:
                chunk = next(self._stream_iter)
            except StopIteration:
                self._exhausted = True
                self._finalize()
                raise
            except Exception as exc:
                # A provider error raised while reading (an error event, a
                # connection reset) is reported here so a caller iterating
                # without a with block, whose __exit__ never runs, still
                # gets the llm_error; the with form is idempotent through
                # _finalized.
                self._emit_stream_error(exc)
                raise
            if self._hidden(chunk):
                self._record_chunk(chunk, visible=False)
                continue
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
            self._register_open()
            self._opened_t = time.monotonic()
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
        if exc_val is not None and not self._is_complete() and _is_provider_failure(exc_val):
            await self._close_underlying(exc_type, exc_val, exc_tb)
            self._emit_stream_error(exc_val)
            return
        # No exception, a response already read in full, a cancellation,
        # the sensor's own policy exception or the caller's own exception:
        # the caller left the stream (see GuardedStream.__exit__).
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
        except Exception as exc:
            _log.debug("Exception closing underlying async stream (%s)", type(exc).__name__)

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
        # No event loop here: the provider's final message is taken only
        # when it is a plain object (the Anthropic snapshot).
        completed = self._is_complete()
        self._settle(self._plain_final_message() if completed else None, completed)

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
        while True:
            try:
                chunk = await self._stream_iter.__anext__()
            except StopAsyncIteration:
                self._exhausted = True
                await self._finalize()
                raise
            except Exception as exc:
                self._emit_stream_error(exc)
                raise
            if self._hidden(chunk):
                self._record_chunk(chunk, visible=False)
                continue
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
    drain_deferred_settles(session)
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
    stop_reason: str | None = None,
    details_override: CallDetails | None = None,
) -> None:
    """Extract actual usage, reconcile with estimate, post event.

    ``event_type`` defaults to :attr:`EventType.POST_CALL`; callers pass
    :attr:`EventType.EMBEDDINGS` for embedding-model calls so the dashboard
    can render them distinctly.

    ``streaming`` carries the streaming sub-object (``ttft_ms``,
    chunk stats, ``final_outcome``) when the response came from
    :class:`GuardedStream`. Omitted entirely for non-streaming calls so the
    wire shape stays identical for non-streaming calls.

    ``stop_reason`` is the stop reason a stream guard read from
    the streamed events; when ``None`` the provider is asked to read it
    from the response. A reason that means the call did not succeed files
    an llm_error beside the post_call.

    ``details_override`` carries the call details a stream guard folded
    from the streamed events; the response's own details (a helper
    stream's final message) are laid over them.
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
    _add_token_cost_fields(
        payload,
        session,
        provider,
        response,
        call_kwargs,
        usage,
        details_override,
        stop_reason,
    )

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

    # A provider can answer 200 with a stop reason that still means the
    # call did not succeed (Anthropic's refusal or context-window
    # overrun). File an llm_error beside the post_call so error views and
    # the session's terminal-error flag see it; the post_call stays
    # because the call was billed and its usage must count.
    if event_type == EventType.POST_CALL:
        _emit_stop_reason_error(
            session, provider, response, resp_model, latency_ms, stop_reason, prov_meta
        )

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
    _mark_reported(exc)
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
        _enqueue_error_event(session, provider, error_payload, model, latency_ms)
    except Exception as emit_exc:
        # No exc_info: the provider exception is the active context and
        # may echo prompt text; the failure class is enough.
        _log.warning("Failed to emit llm_error event (%s)", type(emit_exc).__name__)


def _enqueue_error_event(
    session: Session,
    provider: Provider,
    error_payload: dict[str, Any],
    model: str | None,
    latency_ms: int,
) -> None:
    """Build and enqueue the LLM_ERROR event around a finished ``error``
    sub-object, whether it came from an exception or a stop reason."""
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


def _provider_name(provider: Provider) -> str:
    """The adapter's wire name; ``unknown`` for an adapter that carries
    none (a stop reason has no exception module to infer it from)."""
    name = getattr(provider, "name", None)
    return name if isinstance(name, str) and name else "unknown"


def _response_request_id(response: Any, prov_meta: dict[str, Any] | None) -> str | None:
    """The provider's request id of a 200 response, capped at
    ``REQUEST_ID_MAX_LEN`` characters: the SDK stamps it on the parsed
    object as ``_request_id``; a raw-response wrapper exposes it through
    the headers the provider metadata already read."""
    with contextlib.suppress(Exception):
        stamped = getattr(response, "_request_id", None)
        if isinstance(stamped, str) and stamped:
            return stamped[:REQUEST_ID_MAX_LEN]
    if prov_meta:
        from_headers = prov_meta.get("request_id")
        if isinstance(from_headers, str) and from_headers:
            return from_headers[:REQUEST_ID_MAX_LEN]
    return None


def _add_token_cost_fields(
    payload: dict[str, Any],
    session: Session,
    provider: Provider,
    response: Any,
    call_kwargs: dict[str, Any] | None,
    usage: TokenUsage,
    details_override: CallDetails | None,
    stop_reason: str | None,
) -> None:
    """Add the token, model and cost fields of the event contract
    (ARCHITECTURE.md, POST /v1/events) to an LLM call's payload. A field
    is sent only when known, so the wire stays as before for whatever a
    provider does not report. Never raises."""
    try:
        details = details_override
        try:
            own = provider.call_details(response)
        except Exception:
            own = None
        if own is not None:
            details = own if details is None else details.merged(own)

        fields: dict[str, Any] = {
            "model_requested": provider.get_model(call_kwargs or {}) or None,
            "provider": provider.vendor,
            "billing_mode": session.config.billing_mode
            or (BILLING_LOCAL if provider.local else BILLING_METERED),
            "inference_scope": provider.inference_scope,
            # Each share must fit inside its total, or ingestion rejects
            # the whole event; a share that does not is left out.
            "tokens_reasoning": _share(usage.reasoning_tokens, usage.output_tokens),
            "tokens_cache_creation_1h": _share(
                usage.cache_creation_1h_tokens, usage.cache_creation_tokens
            ),
        }
        reason = stop_reason
        if reason is None:
            with contextlib.suppress(Exception):
                reason = provider.response_stop_reason(response)
        if isinstance(reason, str) and reason:
            fields["stop_reason"] = reason
        if details is not None:
            fields.update(
                model_served=details.model_served,
                service_tier=details.service_tier,
                speed=details.speed,
                inference_geo=details.inference_geo,
                server_tool_use=details.server_tool_use,
                cost_reported=details.cost_reported,
                cost_source=details.cost_source,
            )
        for key, value in fields.items():
            if value is None:
                continue
            if isinstance(value, str):
                value = _clip_utf8(value, _MAX_DETAIL_BYTES)
            payload[key] = value
    except Exception:
        _log.debug("token and cost fields failed", exc_info=True)


def _clip_utf8(value: str, max_bytes: int) -> str:
    """``value`` cut to at most ``max_bytes`` of UTF-8, never splitting a
    character."""
    encoded = value.encode("utf-8")
    if len(encoded) <= max_bytes:
        return value
    return encoded[:max_bytes].decode("utf-8", errors="ignore")


def _share(part: int | None, whole: int) -> int | None:
    """A reported share of a token total, or ``None`` when it was not
    reported or exceeds the total."""
    return part if part is not None and 0 <= part <= whole else None


def _emit_stop_reason_error(
    session: Session,
    provider: Provider,
    response: Any,
    model: str | None,
    latency_ms: int,
    stop_reason: str | None,
    prov_meta: dict[str, Any] | None = None,
) -> None:
    """File an llm_error for a 200 response whose stop reason means the
    call did not succeed. ``stop_reason`` is what a stream guard saw in
    the events; otherwise the provider reads it from the response. The
    response's request id keys the per-provider retry counter, so two
    refusals in one session are two attempts, not one chain. Never raises
    and emits nothing for every success reason."""
    try:
        reason = stop_reason
        if reason is None:
            reason = provider.response_stop_reason(response)
        classification = classify_stop_reason(
            reason,
            provider=_provider_name(provider),
            request_id=_response_request_id(response, prov_meta),
        )
        if classification is None:
            return
        _enqueue_error_event(session, provider, classification.to_payload(), model, latency_ms)
    except Exception as emit_exc:
        _log.warning("Failed to emit llm_error for stop reason (%s)", type(emit_exc).__name__)
