"""Metering for the SDKs' raw and streaming response views.

Both provider SDKs (anthropic, openai) generate the same two views over
every resource:

* ``with_raw_response`` returns the HTTP response wrapped in the SDK's
  ``LegacyAPIResponse`` (or, on anthropic 2.x async clients, an
  ``AsyncAPIResponse``) with the body read, unless the call streams;
  ``parse()`` turns it into the usual object.
* ``with_streaming_response`` returns the response with the body unread,
  inside a context manager that closes it on exit.

A view marks its requests with the ``X-Stainless-Raw-Response`` header
(:func:`raw_response_mode` reads it). A call whose body is unread when the
caller receives it -- the streaming view, and a raw-view call with
``stream=True``, whose body is the event stream -- is metered here: the
pre-call check runs and the request is sent at once, as on the unguarded
SDK, and the post_call is owed until the caller parses the response or
closes it. The caller gets a proxy (:class:`DeferredResponse` /
:class:`DeferredAsyncResponse`) that meters at its ``parse()`` and never
reads the body itself; when the parsed value is an SDK event stream the
shared stream guard takes it over (:meth:`DeferredCall.guard_stream`) and
meters the events as the caller iterates them.
"""

from __future__ import annotations

import collections
import contextlib
import inspect
import logging
import time
import weakref
from typing import TYPE_CHECKING, Any

from flightdeck_sensor.core.exceptions import BudgetExceededError, DirectiveError
from flightdeck_sensor.core.types import EventType
from flightdeck_sensor.interceptor import base
from flightdeck_sensor.providers._access import UNREADABLE, ParsedRawResponse, response_message

if TYPE_CHECKING:
    from collections.abc import Callable

    from flightdeck_sensor.core.session import Session
    from flightdeck_sensor.providers.protocol import Provider

_log = logging.getLogger("flightdeck_sensor.interceptor.raw_views")

# The header the SDKs' with_raw_response / with_streaming_response views
# add to every request they make: "true" (or "raw" on the anthropic 2.x
# SDK) asks for the raw response with the body read, "stream" for the raw
# response with the body unread. Spelled out here rather than imported
# from the SDKs' private ``_constants`` so an SDK that moves the constant
# degrades to "not a raw call" instead of disabling an interceptor; the
# layout canary tests pin the spelling to each SDK's own.
RAW_RESPONSE_HEADER = "X-Stainless-Raw-Response"
RAW_MODE_STREAM = "stream"
RAW_MODES_READ = frozenset({"true", "raw"})


def raw_response_mode(kwargs: dict[str, Any]) -> str | None:
    """The view's header value (``"true"`` / ``"raw"`` / ``"stream"``)
    when the call comes through a raw or streaming view, else ``None``."""
    headers = kwargs.get("extra_headers")
    if not isinstance(headers, dict):
        return None
    for name, value in headers.items():
        if isinstance(name, str) and name.lower() == RAW_RESPONSE_HEADER.lower():
            return value if isinstance(value, str) else None
    return None


def body_unread(kwargs: dict[str, Any]) -> bool:
    """Whether a view call hands the caller a response whose body is still
    unread: every streaming-view call, and a raw-view call that streams."""
    mode = raw_response_mode(kwargs)
    return mode == RAW_MODE_STREAM or (mode in RAW_MODES_READ and bool(kwargs.get("stream")))


def _is_async_stream(stream: Any) -> bool:
    """An SDK ``AsyncStream`` iterates only asynchronously."""
    return hasattr(stream, "__aiter__") and not hasattr(stream, "__iter__")


class DeferredCall:
    """One call made through a view whose body is unread: the pre-call
    check has run and the request has been sent, the post_call is owed
    until the caller parses the body or closes the response.

    A call whose response is abandoned without either is still reported:
    the response's finalizer queues the settle on the session (never
    settling inline, since a finalizer can run inside any of the
    sensor's critical sections) and the next intercepted call, or the
    session's end, runs it; a call whose response is still referenced
    when the session ends is settled then. Both are the stream guards'
    mechanisms, so the call registers itself with the session the way a
    guard does (``_session``, ``_entered``, ``_finalized``,
    ``_settle_now``)."""

    _entered = True

    def __init__(
        self,
        session: Session,
        provider: Provider,
        call_kwargs: dict[str, Any],
        estimated: int,
        estimated_via: str,
        t0: float,
        *,
        is_stream: Callable[[Any], bool],
        hide_chunk: Callable[[Any], bool] | None = None,
        event_type: EventType = EventType.POST_CALL,
    ) -> None:
        self._session = session
        self._provider = provider
        self._call_kwargs = call_kwargs
        self._estimated = estimated
        self._estimated_via = estimated_via
        self._t0 = t0
        self._is_stream = is_stream
        self._hide_chunk = hide_chunk
        self._event_type = event_type
        self._settled = False
        self._headers: Any = None
        # The SDK response, held weakly: whether its body was consumed is
        # read at settle time (see settle()), unless the response proxy's
        # finalizer already recorded it (see abandon()).
        self._response_ref: Callable[[], Any] = lambda: None
        self._consumed_at_abandon: bool | None = None
        # The stream guard a parsed event stream went to: every later
        # parse() hands it back, and the view's close() settles it.
        self._guard: Any = None

    @property
    def _finalized(self) -> bool:
        return self._settled

    @property
    def guard(self) -> Any:
        return self._guard

    @property
    def streams(self) -> bool:
        """Whether the request asked for an event stream."""
        return bool(self._call_kwargs.get("stream"))

    def finish_guard(self) -> None:
        """Settle the stream guard as the view closes: a caller who left
        the stream early is reported now, not when the guard is
        collected. A guard already settled (the stream was read to its
        end) only closes its SDK stream. An async guard reached from a
        synchronous close settles without closing, since closing needs
        an await; the view has closed the HTTP response already."""
        guard = self._guard
        if guard is None:
            return
        if isinstance(guard, base.GuardedStream):
            guard.__exit__(None, None, None)
        else:
            guard._settle_now()

    async def finish_guard_async(self) -> None:
        """Async counterpart of :meth:`finish_guard`."""
        guard = self._guard
        if guard is None:
            return
        if isinstance(guard, base.GuardedAsyncStream):
            await guard.__aexit__(None, None, None)
        else:
            guard.__exit__(None, None, None)

    def is_stream(self, parsed: Any) -> bool:
        """Whether a parsed value is the SDK's event stream."""
        try:
            return bool(self._is_stream(parsed))
        except Exception:
            return False

    def register(self, response: Any) -> None:
        """Keep the response headers for a settle without a body, and a
        weak reference to the response so a later settle can tell whether
        its body was read some other way; join the session's open guards
        so the session's end settles the call."""
        self._headers = response.headers
        try:
            self._response_ref = weakref.ref(response)
        except TypeError:  # a response type without weak references
            self._response_ref = lambda: response
        guards = getattr(self._session, "open_stream_guards", None)
        lock = getattr(self._session, "open_stream_guards_lock", None)
        if isinstance(guards, weakref.WeakSet) and lock is not None:
            with lock:
                guards.add(self)

    def _body_consumed(self) -> bool:
        """Whether the caller consumed the body: as the response proxy's
        finalizer recorded it, else read through the weak reference. The
        recorded value comes first because the collector clears weak
        references to cyclic garbage before any finalizer runs, so a
        response dropped inside a reference cycle (an exception's
        traceback, an asyncio frame) can no longer be read here."""
        if self._consumed_at_abandon is not None:
            return self._consumed_at_abandon
        response = self._response_ref()
        return response is not None and _body_already_read(response)

    def _settle_now(self) -> None:
        self.settle(None, self._headers)

    def abandon(self, consumed: bool | None = None) -> None:
        """Queue the settle for the next intercept or the session's end;
        called from the response proxy's finalizer, so nothing is
        settled here. ``consumed`` is whether the body was consumed, read
        by the finalizer from its own (strong) reference to the response;
        it is recorded on the call, so the queued settle and a settle at
        the session's end racing it on another thread both see it, and
        neither holds a reference to the response."""
        if self._settled:
            return
        if consumed is None:
            consumed = self._body_consumed()
        self._consumed_at_abandon = consumed
        queue = getattr(self._session, "queued_stream_settles", None)
        if isinstance(queue, collections.deque):
            queue.append(lambda: self.settle(None, self._headers, body_consumed=consumed))

    def settle(self, parsed: Any, headers: Any, *, body_consumed: bool | None = None) -> None:
        """Emit the post_call once, with whatever the caller parsed.

        A streamed request (``stream=True``) that settles here was never
        read through the stream guard. When its body was never consumed
        either (the response was closed, dropped or still open at the
        session's end before ``parse()``), it is reported as an aborted
        stream with no chunks, on the pre-call estimate. When the caller
        consumed the body some other way (``iter_lines()``, ``read()``,
        the raw ``http_response``), the transport cannot tell a full read
        from a partial one, so no ``streaming`` block is claimed and the
        estimate stands. When the caller does not pass ``body_consumed``,
        it is what the response proxy's finalizer recorded, else read
        from the response (see :meth:`_body_consumed`)."""
        if self._settled:
            return
        self._settled = True
        if body_consumed is None:
            body_consumed = self._body_consumed()
        streaming: dict[str, Any] | None = None
        if self._call_kwargs.get("stream"):
            parsed = None if self.is_stream(parsed) else parsed
            if not body_consumed:
                streaming = base._build_streaming_summary(self._t0, None, 0, [], False)
        latency_ms = int((time.monotonic() - self._t0) * 1000)
        try:
            base._post_call(
                self._session,
                self._provider,
                ParsedRawResponse(parsed, headers),
                self._estimated,
                latency_ms,
                self._call_kwargs,
                event_type=self._event_type,
                streaming=streaming,
                estimated_via=self._estimated_via,
            )
        except Exception as emit_exc:
            _log.warning("Failed to post deferred post_call (%s)", type(emit_exc).__name__)

    def guard_stream(self, stream: Any) -> Any:
        """Hand a parsed SDK event stream (``create(stream=True)`` through
        a view) to the stream guard, which meters it as the caller
        iterates and emits the post_call when it settles. The guard's
        latency runs from ``parse()``, where it opens, not from the
        request; the pre-call check already ran at the request. The guard
        is entered here, so a stream the caller closes or drops without
        reading is reported as an aborted stream with no chunks. The
        stream's own kind picks the guard: an async client's raw view
        parses synchronously but yields an ``AsyncStream``. A later
        ``parse()`` gets the same guard: the SDK caches the parsed stream,
        and handing that back unguarded would let its chunks (and, on an
        OpenAI chat stream, the injected usage chunk) bypass the guard."""
        if self._guard is not None:
            return self._guard
        if self._settled:
            return stream
        self._settled = True
        guard: Any
        if _is_async_stream(stream):
            # Entered at once, like the sync guard below: a guard entered
            # only at the first ``async for`` would never settle for a
            # caller who closes the view, or drops the stream, unread.
            guard = base.GuardedAsyncStream(
                lambda **_kw: stream,
                self._call_kwargs,
                self._session,
                self._provider,
                self._estimated,
                self._estimated_via,
                hide_chunk=self._hide_chunk,
            ).adopt(stream)
        else:
            guard = base.GuardedStream(
                lambda **_kw: stream,
                self._call_kwargs,
                self._session,
                self._provider,
                self._estimated,
                self._estimated_via,
                hide_chunk=self._hide_chunk,
            ).open()
        self._guard = guard
        return guard


def _body_already_read(response: Any) -> bool:
    """Whether the raw HTTP body has been consumed, so parsing it now
    reads nothing further from the network."""
    try:
        return bool(response.http_response.is_stream_consumed)
    except Exception:
        return False


def _asked_for_type(args: tuple[Any, ...], kwargs: dict[str, Any]) -> bool:
    """Whether a ``parse()`` call named the type to parse into
    (``parse(to=...)``), so what it returned is the caller's own type
    rather than the SDK's message."""
    to = args[0] if args else kwargs.get("to")
    return to is not None


def _typed_parse_read_body(response: Any, call: DeferredCall) -> bool:
    """Whether a parse into the caller's own type left a body the sensor
    may parse into the SDK's message now: read already, and not an event
    stream. The SDK caches each parse per type, so that parse leaves the
    caller's later ``parse()`` as it would be. A body the typed parse left
    unread (``to=httpx.Response``) counts as read some other way: the call
    stays owed, and settles at the view's close, the response's collection
    or the session's end, as for any such read."""
    return not call.streams and _body_already_read(response)


class DeferredResponse:
    """Stands in for the SDK's response on a view whose body is unread
    (``APIResponse`` on the sync streaming view, ``LegacyAPIResponse`` on
    a streaming raw-view call). The sensor meters at the caller's
    ``parse()`` and never reads the body itself. ``close()`` (which the
    SDK's response context manager calls on exit) settles a response the
    caller read some other way -- parsing it then only when the body has
    already been consumed, so nothing is read from the network -- and
    reports the estimate for a body never read. When the parsed value is
    an SDK event stream (``create(stream=True)`` through a view) the
    stream guard takes over and meters the events as they are iterated;
    ``close()`` then settles that guard, so a stream left early inside
    the view's ``with`` block is reported as the block exits, and a later
    ``parse()`` returns the same guard. Every other attribute is proxied
    to the SDK response."""

    def __init__(self, response: Any, call: DeferredCall) -> None:
        self._response = response
        self._call = call
        call.register(response)

    def parse(self, *args: Any, **kwargs: Any) -> Any:
        parsed = self._response.parse(*args, **kwargs)
        if self._call.is_stream(parsed):
            return self._call.guard_stream(parsed)
        if not _asked_for_type(args, kwargs):
            self._call.settle(parsed, self._response.headers)
        elif _typed_parse_read_body(self._response, self._call):
            self._call.settle(response_message(self._response), self._response.headers)
        return parsed

    def close(self) -> None:
        if self._call.guard is None:
            parsed = None
            consumed = _body_already_read(self._response)
            if consumed:
                parsed = response_message(self._response)
            self._call.settle(parsed, self._response.headers, body_consumed=consumed)
        self._response.close()
        self._call.finish_guard()

    def __del__(self) -> None:
        # Abandoned without parse() or close(): queue the settle (see
        # DeferredCall.abandon); the SDK response goes with this proxy.
        # Whether its body was consumed is read here, through this
        # proxy's own reference: in a collected cycle the call's weak
        # reference is already cleared. Everything is suppressed: a
        # finalizer can run at interpreter shutdown or inside another
        # thread's collection.
        with contextlib.suppress(BaseException):
            self._call.abandon(_body_already_read(self._response))

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            raise AttributeError(name)
        return getattr(self._response, name)


class DeferredAsyncResponse:
    """Async counterpart of :class:`DeferredResponse`: the SDK's
    ``AsyncAPIResponse.parse()`` is a coroutine, so metering happens
    when the caller's ``await response.parse()`` resolves."""

    def __init__(self, response: Any, call: DeferredCall) -> None:
        self._response = response
        self._call = call
        call.register(response)

    async def parse(self, *args: Any, **kwargs: Any) -> Any:
        parsed = await self._response.parse(*args, **kwargs)
        if self._call.is_stream(parsed):
            return self._call.guard_stream(parsed)
        if not _asked_for_type(args, kwargs):
            self._call.settle(parsed, self._response.headers)
        elif _typed_parse_read_body(self._response, self._call):
            self._call.settle(await self._message(), self._response.headers)
        return parsed

    async def _message(self) -> Any:
        """The SDK's message from a body already read, or
        :data:`UNREADABLE` when it does not parse."""
        try:
            return await self._response.parse()
        except Exception:
            return UNREADABLE

    async def close(self) -> None:
        if self._call.guard is None:
            parsed: Any = None
            consumed = _body_already_read(self._response)
            if consumed:
                parsed = await self._message()
            self._call.settle(parsed, self._response.headers, body_consumed=consumed)
        await self._response.close()
        await self._call.finish_guard_async()

    def __del__(self) -> None:
        # See DeferredResponse.__del__.
        with contextlib.suppress(BaseException):
            self._call.abandon(_body_already_read(self._response))

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            raise AttributeError(name)
        return getattr(self._response, name)


def deferred_proxy(response: Any, call: DeferredCall) -> Any:
    """The proxy matching the response's own ``parse()``: a coroutine on
    the async client's streaming view (``AsyncAPIResponse``), a plain
    method on every raw view (``LegacyAPIResponse``), the async client's
    included."""
    if inspect.iscoroutinefunction(getattr(response, "parse", None)):
        return DeferredAsyncResponse(response, call)
    return DeferredResponse(response, call)


def send_deferred(
    real_fn: Any,
    kwargs: dict[str, Any],
    session: Session,
    provider: Provider,
    *,
    is_async: bool,
    is_stream: Callable[[Any], bool],
    hide_chunk: Callable[[Any], bool] | None = None,
    event_type: EventType = EventType.POST_CALL,
) -> Any:
    """Send a view request whose body is unread now, and meter when the
    caller parses the response (see :class:`DeferredResponse`). Pre-call
    policy runs before the request, as on every other path; a failing
    request emits ``llm_error`` and re-raises. ``kwargs`` are sent as
    given (an interceptor adds its own request options first, such as
    OpenAI's ``stream_options``); ``hide_chunk`` passes to the stream
    guard a parsed event stream gets. On an async client the result is
    a coroutine resolving to the proxy, as the SDK's own call is.
    ``event_type`` is the event the settle emits (``embeddings`` for an
    embeddings call). An iterator among the arguments is read as in
    :func:`base.materialise_iterators`."""
    arguments = base.materialise_iterators(kwargs, real_fn, provider.name)
    kwargs, real_fn = arguments.kwargs, arguments.send
    estimated, estimated_via = provider.estimate_tokens(kwargs)
    call_kwargs = base._pre_call(session, provider, kwargs, estimated, estimated_via)
    t0 = time.monotonic()

    def _call_for() -> DeferredCall:
        return DeferredCall(
            session,
            provider,
            call_kwargs,
            estimated,
            estimated_via,
            t0,
            is_stream=is_stream,
            hide_chunk=hide_chunk,
            event_type=event_type,
        )

    if is_async:

        async def _async_deferred() -> Any:
            nonlocal call_kwargs
            call_kwargs = base._sending(session, call_kwargs)
            try:
                response = await real_fn(**call_kwargs)
            except (BudgetExceededError, DirectiveError):
                raise
            except BaseException as exc:
                latency_ms = int((time.monotonic() - t0) * 1000)
                base._emit_error(session, provider, exc, latency_ms, call_kwargs)
                raise
            return deferred_proxy(response, _call_for())

        return _async_deferred()
    call_kwargs = base._sending(session, call_kwargs)
    try:
        response = real_fn(**call_kwargs)
    except (BudgetExceededError, DirectiveError):
        raise
    except BaseException as exc:
        latency_ms = int((time.monotonic() - t0) * 1000)
        base._emit_error(session, provider, exc, latency_ms, call_kwargs)
        raise
    return deferred_proxy(response, _call_for())
