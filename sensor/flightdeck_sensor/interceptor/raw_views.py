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


class ParsedRawResponse:
    """What the guard core sees once a deferred response has been parsed:
    the parsed message for usage, model, content and tool calls, plus the
    HTTP headers of the raw response for ``provider_metadata``. ``parsed``
    is ``None`` when the caller never parsed the body, in which case
    usage falls back to the pre-call estimate and no response content is
    stored."""

    def __init__(self, parsed: Any, headers: Any) -> None:
        self._parsed = parsed
        self.headers = headers

    def parse(self) -> Any:
        return self._parsed

    def model_dump(self, **kwargs: Any) -> dict[str, Any]:
        dump = getattr(self._parsed, "model_dump", None)
        if callable(dump):
            result = dump(**kwargs)
            return result if isinstance(result, dict) else {}
        return {}

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            raise AttributeError(name)
        return getattr(self._parsed, name)


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

    @property
    def _finalized(self) -> bool:
        return self._settled

    def is_stream(self, parsed: Any) -> bool:
        """Whether a parsed value is the SDK's event stream."""
        try:
            return bool(self._is_stream(parsed))
        except Exception:
            return False

    def register(self, headers: Any) -> None:
        """Keep the response headers for a settle without a body and join
        the session's open guards so the session's end settles the call."""
        self._headers = headers
        guards = getattr(self._session, "open_stream_guards", None)
        lock = getattr(self._session, "open_stream_guards_lock", None)
        if isinstance(guards, weakref.WeakSet) and lock is not None:
            with lock:
                guards.add(self)

    def _settle_now(self) -> None:
        self.settle(None, self._headers)

    def abandon(self) -> None:
        """Queue the settle for the next intercept or the session's end;
        called from the response proxy's finalizer, so nothing is
        settled here."""
        if self._settled:
            return
        queue = getattr(self._session, "queued_stream_settles", None)
        if isinstance(queue, collections.deque):
            queue.append(lambda: self.settle(None, self._headers))

    def settle(self, parsed: Any, headers: Any) -> None:
        """Emit the post_call once, with whatever the caller parsed."""
        if self._settled:
            return
        self._settled = True
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
                estimated_via=self._estimated_via,
            )
        except Exception as emit_exc:
            _log.warning("Failed to post deferred post_call (%s)", type(emit_exc).__name__)

    def guard_stream(self, stream: Any) -> Any:
        """Hand a parsed SDK event stream (``create(stream=True)`` through
        a view) to the stream guard, which meters it as the caller
        iterates and emits the post_call when it settles. The guard's
        latency runs from ``parse()``, where it opens, not from the
        request; the pre-call check already ran at the request. The
        stream's own kind picks the guard: an async client's raw view
        parses synchronously but yields an ``AsyncStream``."""
        if self._settled:
            return stream
        self._settled = True
        if _is_async_stream(stream):
            return base.GuardedAsyncStream(
                lambda **_kw: stream,
                self._call_kwargs,
                self._session,
                self._provider,
                self._estimated,
                self._estimated_via,
                hide_chunk=self._hide_chunk,
            )
        return base.GuardedStream(
            lambda **_kw: stream,
            self._call_kwargs,
            self._session,
            self._provider,
            self._estimated,
            self._estimated_via,
            hide_chunk=self._hide_chunk,
        ).open()


def _body_already_read(response: Any) -> bool:
    """Whether the raw HTTP body has been consumed, so parsing it now
    reads nothing further from the network."""
    try:
        return bool(response.http_response.is_stream_consumed)
    except Exception:
        return False


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
    stream guard takes over and meters the events as they are iterated.
    Every other attribute is proxied to the SDK response."""

    def __init__(self, response: Any, call: DeferredCall) -> None:
        self._response = response
        self._call = call
        call.register(response.headers)

    def parse(self, *args: Any, **kwargs: Any) -> Any:
        parsed = self._response.parse(*args, **kwargs)
        if self._call.is_stream(parsed):
            return self._call.guard_stream(parsed)
        self._call.settle(parsed, self._response.headers)
        return parsed

    def close(self) -> None:
        parsed = None
        if _body_already_read(self._response):
            with contextlib.suppress(Exception):
                parsed = self._response.parse()
        self._call.settle(parsed, self._response.headers)
        self._response.close()

    def __del__(self) -> None:
        # Abandoned without parse() or close(): queue the settle (see
        # DeferredCall.abandon); the SDK response goes with this proxy.
        # Everything is suppressed: a finalizer can run at interpreter
        # shutdown or inside another thread's collection.
        with contextlib.suppress(BaseException):
            self._call.abandon()

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
        call.register(response.headers)

    async def parse(self, *args: Any, **kwargs: Any) -> Any:
        parsed = await self._response.parse(*args, **kwargs)
        if self._call.is_stream(parsed):
            return self._call.guard_stream(parsed)
        self._call.settle(parsed, self._response.headers)
        return parsed

    async def close(self) -> None:
        parsed = None
        if _body_already_read(self._response):
            with contextlib.suppress(Exception):
                parsed = await self._response.parse()
        self._call.settle(parsed, self._response.headers)
        await self._response.close()

    def __del__(self) -> None:
        # See DeferredResponse.__del__.
        with contextlib.suppress(BaseException):
            self._call.abandon()

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
    embeddings call)."""
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
    try:
        response = real_fn(**call_kwargs)
    except (BudgetExceededError, DirectiveError):
        raise
    except BaseException as exc:
        latency_ms = int((time.monotonic() - t0) * 1000)
        base._emit_error(session, provider, exc, latency_ms, call_kwargs)
        raise
    return deferred_proxy(response, _call_for())
