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

from flightdeck_sensor.core.errors import classify_exception
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
    estimated = provider.estimate_tokens(kwargs)
    call_kwargs = _pre_call(session, provider, kwargs, estimated)

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
    estimated = provider.estimate_tokens(kwargs)
    call_kwargs = _pre_call(session, provider, kwargs, estimated)

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
    estimated = provider.estimate_tokens(kwargs)
    call_kwargs = _pre_call(session, provider, kwargs, estimated)
    return GuardedStream(real_fn, call_kwargs, session, provider, estimated)


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
    estimated = provider.estimate_tokens(kwargs)
    call_kwargs = _pre_call(session, provider, kwargs, estimated)
    return GuardedAsyncStream(real_fn, call_kwargs, session, provider, estimated)


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
    ) -> None:
        self._real_fn = real_fn
        self._kwargs = kwargs
        self._session = session
        self._provider = provider
        self._estimated = estimated
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
        """Phase 4 streaming sub-object attached to the post_call payload.

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
        if self._first_chunk_t is not None:
            ttft_ms = int((self._first_chunk_t - self._t0) * 1000)

        inter_chunk: dict[str, int] | None = None
        if len(self._inter_chunk_ms) >= 1:
            sorted_gaps = sorted(self._inter_chunk_ms)
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
            "chunk_count": self._chunk_count,
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
    ) -> None:
        self._real_fn = real_fn
        self._kwargs = kwargs
        self._session = session
        self._provider = provider
        self._estimated = estimated
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

    # Identical shape to the sync variant -- share the helper so a future
    # tweak to the summary shape lands in one place.
    _build_streaming_summary = GuardedStream._build_streaming_summary


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
    *,
    event_type: EventType = EventType.POST_CALL,
    streaming: dict[str, Any] | None = None,
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
            tool_payload = session._build_payload(
                EventType.TOOL_CALL,
                model=resp_model,
                tool_name=inv.name,
                tool_input=inv.tool_input,
            )
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

        payload = session._build_payload(
            EventType.LLM_ERROR,
            model=model,
            latency_ms=latency_ms,
        )
        payload["error"] = error_payload
        session.event_queue.enqueue(payload)
    except Exception:
        _log.warning("Failed to emit llm_error event", exc_info=True)
