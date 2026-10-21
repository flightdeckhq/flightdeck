"""Anthropic interceptor: resource-level patch of the ``Messages`` classes.

Two intercept paths exist for Anthropic clients:

1. **Resource-level patching (recommended)** -- :func:`patch_anthropic_classes`
   replaces ``create``, ``stream`` and ``parse`` on the four resource
   classes every Anthropic client hands out --
   ``anthropic.resources.messages.messages.Messages`` / ``AsyncMessages``
   and their beta twins under ``anthropic.resources.beta.messages`` --
   with methods that route the call through the shared guard core in
   :mod:`flightdeck_sensor.interceptor.base`. The patch lives on the
   resource, not the client, so it covers every client class the SDK
   ships: ``Anthropic`` / ``AsyncAnthropic`` build the resource through a
   class-level ``cached_property``, while ``AnthropicBedrock``,
   ``AnthropicVertex``, ``AnthropicBedrockMantle`` and their async forms
   assign ``self.messages = Messages(self)`` as a plain instance
   attribute in ``__init__``, and ``AnthropicFoundry`` returns a
   ``Messages`` subclass -- none of which a descriptor installed on the
   ``Anthropic`` class would ever see. Frameworks that build their own
   clients (``langchain-anthropic``, ``llama-index-llms-anthropic``,
   CrewAI) are covered the same way.

   The SDK's ``with_raw_response`` and ``with_streaming_response`` views
   wrap the resource's own ``create`` / ``parse`` at construction time
   (``MessagesWithRawResponse.__init__`` does
   ``self.create = to_raw_response_wrapper(messages.create)``), so once
   the resource method is patched a view first touched afterwards is
   intercepted too; a view first touched before ``patch()`` keeps the
   unpatched method it bound and is not metered. The
   raw view returns a response whose body is already read and whose
   ``parse()`` is synchronous on both client kinds, so it is metered
   like a plain call. The streaming view hands the caller an unread
   response, so the sensor returns a proxy that defers metering to the
   caller's ``parse()`` (``await parse()`` on the async client) and
   never reads the body itself.

2. **Per-instance wrapping** -- :class:`SensorAnthropic` wraps a
   single client instance via the public ``flightdeck_sensor.wrap()``
   API. Any SDK client (``anthropic._base_client.BaseClient``
   subclass) is accepted. Useful for code that wants to opt into
   observability for one specific client without enabling global
   patching.

When both are active (``patch()`` followed by ``wrap()``), ``wrap()``
in ``flightdeck_sensor/__init__.py`` short-circuits and returns the
client unchanged because the resource classes are already patched.
``wrap()`` followed by ``patch()`` is safe too: :class:`SensorMessages`
calls the resource's original methods, so a wrapped client is metered
exactly once -- except when the resource class overrides a patched
method and calls ``super()``, where the proxy resolves the override,
the override re-enters the patched base method, and one request is
reported twice.

Platform attribution: every ``post_call`` carries the platform the
client talks to under ``provider_metadata.platform`` (``anthropic``,
``bedrock``, ``vertex``, ``foundry``, ``aws``, ``bedrock-mantle``, or
the bare host of a gateway the caller pointed the SDK at), read from
``client.base_url.host`` and nothing else.

Interception hierarchy for resource-level patching::

    Messages._flightdeck_patched         ← {"create": orig, "stream": orig, "parse": orig}
    Messages.create / stream / parse     ← _intercepting_method
      └── on call with an active session:
            SensorMessages(resource, session, provider).<name>(**kwargs)
            (provider carries capture_prompts + the client's platform)

Interception hierarchy for per-instance wrapping::

    SensorAnthropic (wraps any anthropic BaseClient)
      ├── @property messages  →  SensorMessages
      │   ├── create()        →  call() / call_async(); with stream=True the
      │   │                       stream guard (call_stream / call_stream_async);
      │   │                       on the streaming view a deferred proxy
      │   ├── stream()        →  call_stream() or call_stream_async()
      │   ├── parse()         →  call() / call_async()
      │   ├── with_raw_response / with_streaming_response
      │   │                   →  the SDK's own view classes built over this proxy
      │   └── __getattr__     →  pass-through
      ├── @property beta      →  SensorBeta            (wrap() parity with patch())
      │   └── @property messages → SensorMessages
      ├── with_options()      →  new SensorAnthropic
      ├── with_raw_response   →  _SensorClientView (messages / beta.messages
      ├── with_streaming_response → go through the proxies above)
      └── __getattr__         →  pass-through
"""

from __future__ import annotations

import collections
import contextlib
import functools
import inspect
import logging
import time
import types
import weakref
from typing import TYPE_CHECKING, Any

from flightdeck_sensor.core.exceptions import BudgetExceededError, DirectiveError
from flightdeck_sensor.interceptor import base
from flightdeck_sensor.providers.anthropic import AnthropicProvider

if TYPE_CHECKING:
    from collections.abc import Callable

    from flightdeck_sensor.core.session import Session

_log = logging.getLogger("flightdeck_sensor.interceptor.anthropic")


# ----------------------------------------------------------------------
# Captured class references
# ----------------------------------------------------------------------
#
# These are captured at module import time, BEFORE patch() can run, so
# isinstance() checks below survive any later mutation of the
# ``anthropic`` module attributes. The resource classes are the patch
# targets; the client classes serve the ``wrap()`` detection and the
# sync / async split.
#
# Wrapped in try/except so this module can still be imported when
# ``anthropic`` is not installed (e.g. ``flightdeck-sensor[openai]``
# only installs).

# The lowest SDK release carrying the resource layout imported below
# (the Messages resource modules, their parse method, the Bedrock and
# Vertex beta resources and the raw-response header); the matrix is run
# against 0.94. An installed SDK below it is reported once, at import,
# rather than silently left unmetered.
_MIN_SDK_VERSION = "0.86"

try:
    import anthropic as _anthropic_module
except ImportError:
    _anthropic_module = None  # type: ignore[assignment]

try:
    if _anthropic_module is None:
        raise ImportError("anthropic is not installed")
    from anthropic._base_client import AsyncAPIClient as _OrigAsyncAPIClientImported
    from anthropic._base_client import BaseClient as _OrigBaseClientImported
    from anthropic.resources.beta.messages.messages import (
        AsyncMessages as _OrigAsyncBetaMessagesImported,
    )
    from anthropic.resources.beta.messages.messages import (
        Messages as _OrigBetaMessagesImported,
    )
    from anthropic.resources.messages.messages import (
        AsyncMessages as _OrigAsyncMessagesImported,
    )
    from anthropic.resources.messages.messages import (
        Messages as _OrigMessagesImported,
    )

    _OrigAnthropic: type | None = _anthropic_module.Anthropic
    _OrigAsyncAnthropic: type | None = _anthropic_module.AsyncAnthropic
    # Every SDK client -- first-party, Bedrock, Vertex, Foundry, AWS,
    # Mantle -- derives from BaseClient; the async ones from
    # AsyncAPIClient. These two references drive wrap() detection and
    # the sync / async split for wrapped clients.
    _OrigBaseClient: type | None = _OrigBaseClientImported
    _OrigAsyncAPIClient: type | None = _OrigAsyncAPIClientImported
    _OrigMessages: type | None = _OrigMessagesImported
    _OrigAsyncMessages: type | None = _OrigAsyncMessagesImported
    _OrigBetaMessages: type | None = _OrigBetaMessagesImported
    _OrigAsyncBetaMessages: type | None = _OrigAsyncBetaMessagesImported
    _ANTHROPIC_AVAILABLE = True
except ImportError as _layout_error:
    _OrigAnthropic = None
    _OrigAsyncAnthropic = None
    _OrigBaseClient = None
    _OrigAsyncAPIClient = None
    _OrigMessages = None
    _OrigAsyncMessages = None
    _OrigBetaMessages = None
    _OrigAsyncBetaMessages = None
    _ANTHROPIC_AVAILABLE = False
    if _anthropic_module is not None:
        _log.warning(
            "anthropic %s lacks the Messages resource layout the sensor patches "
            "(needs anthropic>=%s): Anthropic calls are not metered (%s)",
            getattr(_anthropic_module, "__version__", "?"),
            _MIN_SDK_VERSION,
            _layout_error,
        )

# The Bedrock and Vertex clients hand out their own beta ``messages``
# resource: a fresh class that copies the first-party beta methods it
# supports as plain class attributes (``create = FirstPartyMessagesAPI
# .create``; Vertex also ``stream``), so patching the first-party class
# never reaches them and they are patched in their own right. Captured
# separately so an SDK that drops these private modules still leaves the
# first-party patch intact; the layout canary test pins their presence.
_PLATFORM_BETA_TARGETS: tuple[tuple[type, bool], ...] = ()
if _ANTHROPIC_AVAILABLE:
    try:
        from anthropic.lib.bedrock import _beta_messages as _bedrock_beta_messages
        from anthropic.lib.vertex import _beta_messages as _vertex_beta_messages

        _PLATFORM_BETA_TARGETS = (
            (_bedrock_beta_messages.Messages, False),
            (_bedrock_beta_messages.AsyncMessages, True),
            (_vertex_beta_messages.Messages, False),
            (_vertex_beta_messages.AsyncMessages, True),
        )
    except (ImportError, AttributeError) as _beta_layout_error:
        _log.warning(
            "anthropic %s has no Bedrock / Vertex beta resources where the sensor "
            "expects them (needs anthropic>=%s): beta.messages calls on those "
            "clients are not metered (%s)",
            getattr(_anthropic_module, "__version__", "?"),
            _MIN_SDK_VERSION,
            _beta_layout_error,
        )


# The header the SDK's with_raw_response / with_streaming_response views
# add to every request they make: "true" asks for the raw response with
# the body read, "stream" for the raw response with the body unread.
# Spelled out here rather than imported from anthropic._constants so an
# SDK that moves the constant degrades to "not a raw call" instead of
# disabling the whole interceptor; the layout canary test pins the two
# spellings to each other.
_RAW_RESPONSE_HEADER = "X-Stainless-Raw-Response"
_RAW_MODE_READ = "true"
_RAW_MODE_STREAM = "stream"

# Sentinel attribute on a patched resource class, holding the original
# methods so unpatch can restore them and SensorMessages can bypass the
# patched ones.
_PATCHED_SENTINEL = "_flightdeck_patched"

# The resource methods that send an inference request. count_tokens,
# batches and tool_runner are not patched: count_tokens is the sensor's
# own estimator and makes no inference call, batches is asynchronous
# offline work with its own billing, and tool_runner drives the loop
# through create / stream, which are already intercepted.
_PATCHED_METHODS = ("create", "stream", "parse")

# Platform reported when the client is Anthropic's own API; also the
# fallback when a client exposes no usable base_url at all (a test
# double), since the SDK is Anthropic's.
PLATFORM_ANTHROPIC = "anthropic"

# Hosts the SDK's own client classes default to, mapped to the platform
# name reported on the event: (host prefix, host suffix, platform). The
# first matching row wins. A host that matches no row -- a gateway or a
# proxy the caller pointed the SDK at -- is reported verbatim, so the
# deployment topology stays visible instead of being mislabelled as
# Anthropic's own API.
_PLATFORM_HOSTS: tuple[tuple[str, str, str], ...] = (
    # Every suffix starts with a separator so a look-alike such as
    # evilanthropic.com or anthropic.com.evil.example stays bare, and
    # Vertex matches only the Vertex AI API hosts (aiplatform.<...>
    # .googleapis.com and the regional <region>-aiplatform.googleapis.com),
    # not every Google API host.
    ("", ".anthropic.com", PLATFORM_ANTHROPIC),
    ("bedrock-runtime.", ".amazonaws.com", "bedrock"),
    ("bedrock-mantle.", ".api.aws", "bedrock-mantle"),
    ("aws-external-anthropic.", ".api.aws", "aws"),
    ("aiplatform.", ".googleapis.com", "vertex"),
    ("", "-aiplatform.googleapis.com", "vertex"),
    ("", ".services.ai.azure.com", "foundry"),
)


# A platform value is one of the names above or a hostname. Hostnames are
# bounded by the DNS limit on a fully qualified name, and only letters,
# digits, dots and hyphens are accepted once lowercased; anything longer
# or containing other characters is reported as PLATFORM_INVALID_HOST,
# so a malformed or hostile base_url cannot put arbitrary bytes into
# every post_call of a session.
_MAX_PLATFORM_HOST_LENGTH = 253
_PLATFORM_HOST_CHARS = frozenset("abcdefghijklmnopqrstuvwxyz0123456789.-")
PLATFORM_INVALID_HOST = "invalid-host"


def platform_for_host(host: str) -> str:
    """The platform name for an API host: a known platform (see
    ``_PLATFORM_HOSTS``), else the host itself when it is a well-formed
    hostname, else :data:`PLATFORM_INVALID_HOST`."""
    lowered = host.lower()
    if (
        not lowered
        or len(lowered) > _MAX_PLATFORM_HOST_LENGTH
        or not set(lowered) <= _PLATFORM_HOST_CHARS
    ):
        return PLATFORM_INVALID_HOST
    for prefix, suffix, platform in _PLATFORM_HOSTS:
        if lowered.startswith(prefix) and lowered.endswith(suffix):
            return platform
    return lowered


def platform_of(client: Any) -> str:
    """The platform a client talks to: the platform of
    ``client.base_url.host`` (see :func:`platform_for_host`), else
    :data:`PLATFORM_ANTHROPIC` when the client exposes no usable host.
    The host is the only source, so a first-party client pointed at a
    gateway reports the gateway rather than a label its class carries."""
    try:
        host = getattr(getattr(client, "base_url", None), "host", None)
        if isinstance(host, str) and host:
            return platform_for_host(host)
    except Exception:
        _log.debug("platform attribution failed", exc_info=True)
    return PLATFORM_ANTHROPIC


def _is_async_client(client: Any) -> bool:
    """Detect an async Anthropic client using the captured class reference.

    Uses ``_OrigAsyncAPIClient`` (captured at module import time) so the
    isinstance check survives ``patch()`` mutating module attributes,
    and so every async client class (``AsyncAnthropicBedrock``,
    ``AsyncAnthropicVertex``, ...) is recognised, not only
    ``AsyncAnthropic``.
    """
    if _OrigAsyncAPIClient is None:
        return False
    return isinstance(client, _OrigAsyncAPIClient)


def _raw_response_mode(kwargs: dict[str, Any]) -> str | None:
    """``"true"`` / ``"stream"`` when the call comes through the SDK's
    raw or streaming view, else ``None``."""
    headers = kwargs.get("extra_headers")
    if not isinstance(headers, dict):
        return None
    for name, value in headers.items():
        if isinstance(name, str) and name.lower() == _RAW_RESPONSE_HEADER.lower():
            return value if isinstance(value, str) else None
    return None


def _provider_for(client: Any, session: Session) -> AnthropicProvider:
    return AnthropicProvider(
        capture_prompts=session.config.capture_prompts,
        platform=platform_of(client),
    )


# ----------------------------------------------------------------------
# Deferred metering for the streaming view
# ----------------------------------------------------------------------


class _ParsedRawResponse:
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


class _DeferredCall:
    """One call made through the streaming view: the pre-call check has
    run and the request has been sent, the post_call is owed until the
    caller parses the body or closes the response.

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
        provider: AnthropicProvider,
        call_kwargs: dict[str, Any],
        estimated: int,
        estimated_via: str,
        t0: float,
    ) -> None:
        self._session = session
        self._provider = provider
        self._call_kwargs = call_kwargs
        self._estimated = estimated
        self._estimated_via = estimated_via
        self._t0 = t0
        self._settled = False
        self._headers: Any = None

    @property
    def _finalized(self) -> bool:
        return self._settled

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
                _ParsedRawResponse(parsed, headers),
                self._estimated,
                latency_ms,
                self._call_kwargs,
                estimated_via=self._estimated_via,
            )
        except Exception as emit_exc:
            _log.warning("Failed to post deferred post_call (%s)", type(emit_exc).__name__)

    def guard_stream(self, stream: Any) -> Any:
        """Hand a parsed SDK event stream (``create(stream=True)`` through
        a raw view) to the stream guard, which meters it as the caller
        iterates and emits the post_call when it settles. The guard's
        latency runs from ``parse()``, where it opens, not from the
        request; the pre-call check already ran at the request. The
        stream's own kind picks the guard: an async client's raw view
        parses synchronously but yields an ``AsyncStream``."""
        if self._settled:
            return stream
        self._settled = True
        if _anthropic_module is not None and isinstance(stream, _anthropic_module.AsyncStream):
            return base.GuardedAsyncStream(
                lambda **_kw: stream,
                self._call_kwargs,
                self._session,
                self._provider,
                self._estimated,
                self._estimated_via,
            )
        return base.GuardedStream(
            lambda **_kw: stream,
            self._call_kwargs,
            self._session,
            self._provider,
            self._estimated,
            self._estimated_via,
        ).open()


def _is_sdk_stream(obj: Any) -> bool:
    if _anthropic_module is None:
        return False
    return isinstance(obj, (_anthropic_module.Stream, _anthropic_module.AsyncStream))


def _body_already_read(response: Any) -> bool:
    """Whether the raw HTTP body has been consumed, so parsing it now
    reads nothing further from the network."""
    try:
        return bool(response.http_response.is_stream_consumed)
    except Exception:
        return False


class _DeferredResponse:
    """Stands in for the SDK's ``APIResponse`` on the sync
    ``with_streaming_response`` view. The body is unread when the caller
    receives it, so the sensor meters at the caller's ``parse()`` and
    never reads the body itself. ``close()`` (which the SDK's response
    context manager calls on exit) settles a response the caller read
    some other way -- parsing it then only when the body has already
    been consumed, so nothing is read from the network -- and reports
    the estimate for a body never read. When the parsed value is an SDK
    event stream (``create(stream=True)`` through the view) the stream
    guard takes over and meters the events as they are iterated. Every
    other attribute is proxied to the SDK response."""

    def __init__(self, response: Any, call: _DeferredCall) -> None:
        self._response = response
        self._call = call
        call.register(response.headers)

    def parse(self, *args: Any, **kwargs: Any) -> Any:
        parsed = self._response.parse(*args, **kwargs)
        if _is_sdk_stream(parsed):
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
        # _DeferredCall.abandon); the SDK response goes with this proxy.
        # Everything is suppressed: a finalizer can run at interpreter
        # shutdown or inside another thread's collection.
        with contextlib.suppress(BaseException):
            self._call.abandon()

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            raise AttributeError(name)
        return getattr(self._response, name)


def _deferred_proxy(response: Any, call: _DeferredCall) -> Any:
    """The proxy matching the response's own ``parse()``: a coroutine on
    the async client's streaming view (``AsyncAPIResponse``), a
    plain method on every raw view (``LegacyAPIResponse``), the
    async client's included."""
    if inspect.iscoroutinefunction(getattr(response, "parse", None)):
        return _DeferredAsyncResponse(response, call)
    return _DeferredResponse(response, call)


class _DeferredAsyncResponse:
    """Async counterpart of :class:`_DeferredResponse`: the SDK's
    ``AsyncAPIResponse.parse()`` is a coroutine, so metering happens
    when the caller's ``await response.parse()`` resolves."""

    def __init__(self, response: Any, call: _DeferredCall) -> None:
        self._response = response
        self._call = call
        call.register(response.headers)

    async def parse(self, *args: Any, **kwargs: Any) -> Any:
        parsed = await self._response.parse(*args, **kwargs)
        if _is_sdk_stream(parsed):
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
        # See _DeferredResponse.__del__.
        with contextlib.suppress(BaseException):
            self._call.abandon()

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            raise AttributeError(name)
        return getattr(self._response, name)


# ----------------------------------------------------------------------
# Resource proxies
# ----------------------------------------------------------------------


class SensorMessages:
    """Proxy for the ``messages`` resource on an Anthropic client.

    Intercepts ``create()``, ``stream()`` and ``parse()`` -- everything
    else passes through. Always calls the resource's *original* methods,
    so it meters exactly once whether or not the resource class is
    patched.
    """

    def __init__(
        self,
        real_messages: Any,
        session: Session,
        provider: AnthropicProvider,
        *,
        is_async: bool = False,
        originals: dict[str, Callable[..., Any]] | None = None,
    ) -> None:
        self._real = real_messages
        self._session = session
        self._provider = provider
        self._is_async = is_async
        # The original methods of the patched class whose wrapper built
        # this proxy, so the call reaches the SDK's own method directly
        # even when the resource's class overrides it (an override that
        # calls super() re-enters the wrapper; resolving through the
        # instance again would recurse).
        self._originals = originals

    def _method(self, name: str) -> Any:
        """The resource's own ``name`` method, bypassing the resource-level
        patch. The wrapper that built this proxy hands over the originals
        of its class; a proxy built by ``wrap()`` finds the class that
        defines the method along the MRO (Foundry hands out subclasses of
        the patched classes) and binds its stored original when that
        class is patched, else reads the method as usual."""
        if self._originals is not None and name in self._originals:
            return types.MethodType(self._originals[name], self._real)
        for klass in type(self._real).__mro__:
            if name not in klass.__dict__:
                continue
            originals = klass.__dict__.get(_PATCHED_SENTINEL)
            if isinstance(originals, dict) and name in originals:
                return types.MethodType(originals[name], self._real)
            break
        return getattr(self._real, name)

    def _deferred(self, real_fn: Any, kwargs: dict[str, Any]) -> Any:
        """Send the request now, meter when the caller parses the response
        (see :class:`_DeferredResponse`). Pre-call policy runs before
        the request, as on every other path; a failing request emits
        ``llm_error`` and re-raises."""
        estimated, estimated_via = self._provider.estimate_tokens(kwargs)
        call_kwargs = base._pre_call(
            self._session, self._provider, kwargs, estimated, estimated_via
        )
        t0 = time.monotonic()
        if self._is_async:

            async def _async_deferred() -> Any:
                try:
                    response = await real_fn(**call_kwargs)
                except (BudgetExceededError, DirectiveError):
                    raise
                except BaseException as exc:
                    latency_ms = int((time.monotonic() - t0) * 1000)
                    base._emit_error(self._session, self._provider, exc, latency_ms, call_kwargs)
                    raise
                call = _DeferredCall(
                    self._session, self._provider, call_kwargs, estimated, estimated_via, t0
                )
                return _deferred_proxy(response, call)

            return _async_deferred()
        try:
            response = real_fn(**call_kwargs)
        except (BudgetExceededError, DirectiveError):
            raise
        except BaseException as exc:
            latency_ms = int((time.monotonic() - t0) * 1000)
            base._emit_error(self._session, self._provider, exc, latency_ms, call_kwargs)
            raise
        call = _DeferredCall(
            self._session, self._provider, call_kwargs, estimated, estimated_via, t0
        )
        return _deferred_proxy(response, call)

    def create(self, **kwargs: Any) -> Any:
        """Intercept messages.create() -- sync or async depending on client type.

        ``stream=True`` returns the SDK's raw event stream, so it takes
        the same guard as ``messages.stream()``: usage is metered from the
        ``message_start`` / ``message_delta`` events as they pass through,
        and the guard iterates like the SDK ``Stream`` with or without a
        ``with`` block. The async form returns a coroutine resolving to
        the guard, matching ``await client.messages.create(..., stream=True)``.

        A call through ``with_streaming_response`` (and one through
        ``with_raw_response`` with ``stream=True``, whose body is a stream
        the caller obtains from ``parse()``) is metered when the caller
        parses the response; a call through ``with_raw_response`` has its
        body read already and is metered like a plain call.
        """
        real_fn = self._method("create")
        raw_mode = _raw_response_mode(kwargs)
        if raw_mode == _RAW_MODE_STREAM or (raw_mode == _RAW_MODE_READ and kwargs.get("stream")):
            return self._deferred(real_fn, kwargs)
        if kwargs.get("stream"):
            # Opened eagerly: the unguarded SDK sends the request inside
            # create(), so provider errors must surface here, not at the
            # first iteration.
            if self._is_async:

                async def _async_stream_create() -> base.GuardedAsyncStream:
                    guard = base.call_stream_async(real_fn, kwargs, self._session, self._provider)
                    return await guard.open()

                return _async_stream_create()
            return base.call_stream(real_fn, kwargs, self._session, self._provider).open()
        if self._is_async:
            return base.call_async(real_fn, kwargs, self._session, self._provider)
        return base.call(real_fn, kwargs, self._session, self._provider)

    def stream(self, **kwargs: Any) -> Any:
        """Intercept messages.stream() -- returns a guarded context manager.

        Async streaming is supported. Sync ``messages.stream``
        returns a :class:`base.GuardedStream`; async
        ``AsyncAnthropic.messages.stream`` returns a
        :class:`base.GuardedAsyncStream` with awaitable
        ``__aenter__``/``__aexit__`` and ``__aiter__``/``__anext__``. The
        caller decides which surface based on their client type.
        """
        real_fn = self._method("stream")
        if self._is_async:
            return base.call_stream_async(real_fn, kwargs, self._session, self._provider)
        return base.call_stream(real_fn, kwargs, self._session, self._provider)

    def parse(self, **kwargs: Any) -> Any:
        """Intercept messages.parse() (structured output): a plain call
        whose response is a parsed ``Message`` subclass, so usage, content
        and tool calls come out as for ``create()``. Through the
        streaming view it is deferred like ``create()``."""
        real_fn = self._method("parse")
        if _raw_response_mode(kwargs) == _RAW_MODE_STREAM:
            return self._deferred(real_fn, kwargs)
        if self._is_async:
            return base.call_async(real_fn, kwargs, self._session, self._provider)
        return base.call(real_fn, kwargs, self._session, self._provider)

    @property
    def with_raw_response(self) -> Any:
        """The SDK's raw view built over this proxy, so a wrapped
        client's ``messages.with_raw_response.create`` is metered."""
        return type(self._real.with_raw_response)(self)

    @property
    def with_streaming_response(self) -> Any:
        """The SDK's streaming view built over this proxy; its
        ``create`` is metered when the caller parses the response."""
        return type(self._real.with_streaming_response)(self)

    def __getattr__(self, name: str) -> Any:
        # Pass through: batches, count_tokens, etc.
        return getattr(self._real, name)


class SensorBeta:
    """Proxy for ``client.beta`` on any Anthropic client.

    Mirrors :class:`SensorMessages` for the beta path so ``wrap()``
    has full parity with ``patch()`` for ``beta.messages.create()``,
    ``.stream()`` and ``.parse()`` calls. Without this wrapper, code that
    did ``client = wrap(anthropic.Anthropic())`` and then
    ``client.beta.messages.create(...)`` bypassed the sensor entirely.

    Pass-through for any other ``beta.*`` attribute the SDK exposes;
    only ``beta.messages`` is intercepted because that is the only
    LLM-inference entry point on the beta surface.
    """

    def __init__(
        self,
        real_beta: Any,
        session: Session,
        provider: AnthropicProvider,
        *,
        is_async: bool = False,
    ) -> None:
        self._real = real_beta
        self._session = session
        self._provider = provider
        self._is_async = is_async

    @property
    def messages(self) -> SensorMessages:
        """Return a :class:`SensorMessages` proxy for ``beta.messages``."""
        return SensorMessages(
            self._real.messages,
            self._session,
            self._provider,
            is_async=self._is_async,
        )

    def __getattr__(self, name: str) -> Any:
        # Pass through: prompt_caching, models, etc.
        return getattr(self._real, name)


class _SensorClientView:
    """``client.with_raw_response`` / ``client.with_streaming_response`` on
    a wrapped client: ``messages`` and ``beta.messages`` resolve to the
    corresponding view of the sensor proxies, so the raw and streaming
    paths are metered; everything else proxies to the SDK's own view."""

    def __init__(self, sensor_client: SensorAnthropic, view: str) -> None:
        self._sensor_client = sensor_client
        self._view = view

    @property
    def messages(self) -> Any:
        return getattr(self._sensor_client.messages, self._view)

    @property
    def beta(self) -> _SensorClientView:
        return _SensorBetaView(self._sensor_client, self._view)

    def __getattr__(self, name: str) -> Any:
        return getattr(getattr(self._sensor_client._client, self._view), name)


class _SensorBetaView(_SensorClientView):
    """``client.with_raw_response.beta`` on a wrapped client."""

    @property
    def messages(self) -> Any:
        return getattr(self._sensor_client.beta.messages, self._view)

    def __getattr__(self, name: str) -> Any:
        return getattr(getattr(self._sensor_client._client, self._view).beta, name)


class SensorAnthropic:
    """Proxy for any Anthropic SDK client (``anthropic.Anthropic``,
    ``AsyncAnthropic``, ``AnthropicBedrock``, ``AnthropicVertex``, ...).

    ``.messages`` is a ``@property`` -- this is how interception works.
    ``__getattr__`` delegates everything else (api_key, base_url, etc.)
    to the wrapped client untracked.
    """

    def __init__(
        self,
        client: Any,
        session: Session,
        provider: AnthropicProvider | None = None,
    ) -> None:
        self._client = client
        self._session = session
        self._is_async = _is_async_client(client)
        self._provider = provider or _provider_for(client, session)

    @property
    def messages(self) -> SensorMessages:
        """Return a :class:`SensorMessages` proxy that intercepts create/stream/parse."""
        return SensorMessages(
            self._client.messages,
            self._session,
            self._provider,
            is_async=self._is_async,
        )

    @property
    def beta(self) -> SensorBeta:
        """Return a :class:`SensorBeta` proxy so ``client.beta.messages``
        is intercepted on the ``wrap()`` code path too."""
        return SensorBeta(
            self._client.beta,
            self._session,
            self._provider,
            is_async=self._is_async,
        )

    def with_options(self, **kwargs: Any) -> SensorAnthropic:
        """Return a new SensorAnthropic wrapping a client with updated options."""
        new_client = self._client.with_options(**kwargs)
        return SensorAnthropic(new_client, self._session, self._provider)

    @property
    def with_raw_response(self) -> _SensorClientView:
        """The raw view: ``.messages.create`` returns the SDK's
        raw response and is metered like a plain call."""
        return _SensorClientView(self, "with_raw_response")

    @property
    def with_streaming_response(self) -> _SensorClientView:
        """The streaming view: ``.messages.create`` is metered
        when the caller parses the response."""
        return _SensorClientView(self, "with_streaming_response")

    def __getattr__(self, name: str) -> Any:
        # Pass through: api_key, base_url, _client, etc.
        return getattr(self._client, name)


# ----------------------------------------------------------------------
# Resource-level patching
# ----------------------------------------------------------------------


def _current_session() -> Session | None:
    """Lazy lookup of the active flightdeck_sensor session.

    Imported lazily to avoid the circular import that would arise from
    a top-level ``from flightdeck_sensor import _session`` -- this
    interceptor module is itself imported by ``flightdeck_sensor/
    __init__.py``.
    """
    import flightdeck_sensor

    return flightdeck_sensor._session


def _installed(cls: type, name: str, wrapper: Any) -> bool:
    """Whether ``wrapper`` is still installed as ``name`` on the resource's
    class or one of its bases. A view built while patched keeps a bound
    reference to the wrapper, which must step aside once ``unpatch`` has
    restored the original; a subclass that overrides the method and
    reaches the wrapper through ``super()`` still finds it on the base."""
    return any(klass.__dict__.get(name) is wrapper for klass in cls.__mro__)


def _intercepting_method(
    name: str, originals: dict[str, Callable[..., Any]], *, is_async: bool
) -> Any:
    """The replacement for a resource method: with an active session the
    call goes through a :class:`SensorMessages` built over the resource,
    which calls the class's original (handed over in ``originals``, so a
    subclass override that reaches here through ``super()`` is not
    re-entered); with no session, or once the class has been unpatched,
    it is the original, untouched, so a client built before ``init()``
    is metered as soon as a session exists, nothing is cached in an
    unmetered state, and a view that captured the wrapper stops metering
    with ``unpatch``."""
    original = originals[name]

    @functools.wraps(original)
    def method(self: Any, **kwargs: Any) -> Any:
        session = _current_session()
        if session is None or not _installed(type(self), name, method):
            return original(self, **kwargs)
        client = getattr(self, "_client", None)
        proxy = SensorMessages(
            self,
            session,
            _provider_for(client, session),
            is_async=is_async,
            originals=originals,
        )
        return getattr(proxy, name)(**kwargs)

    return method


def _resource_targets() -> tuple[tuple[Any, bool], ...]:
    """The resource classes the patch installs on: the four first-party
    ones plus the Bedrock / Vertex beta resources (see
    ``_PLATFORM_BETA_TARGETS``)."""
    return (
        (_OrigMessages, False),
        (_OrigAsyncMessages, True),
        (_OrigBetaMessages, False),
        (_OrigAsyncBetaMessages, True),
        *_PLATFORM_BETA_TARGETS,
    )


def is_patched() -> bool:
    """Whether the resource-level patch is installed."""
    return _OrigMessages is not None and _PATCHED_SENTINEL in _OrigMessages.__dict__


def patch_anthropic_classes(quiet: bool = False) -> None:
    """Resource-level patch of ``Messages`` / ``AsyncMessages`` and the
    beta ``Messages`` / ``AsyncMessages`` classes.

    Idempotent: a second call is a no-op. Safe to invoke from
    ``flightdeck_sensor.patch()``.

    For each of the four classes:

    1. Check ``_flightdeck_patched`` in ``cls.__dict__`` -- if present, skip.
    2. Capture the original ``create``, ``stream`` and ``parse``
       functions from ``cls.__dict__``.
    3. Store them on ``cls._flightdeck_patched`` so
       :func:`unpatch_anthropic_classes` can restore them and
       :class:`SensorMessages` can call them directly.
    4. Replace each with an intercepting method bound to the async-ness
       of that class.

    No client class is touched: every client hands out instances of
    these four classes (or subclasses of them), however it builds them.
    Clients and resources that already exist are covered from the next
    call on, since the methods live on the class. The one exception is
    a raw or streaming view (``messages.with_raw_response`` /
    ``with_streaming_response``) first touched before ``patch()``: the
    SDK binds the resource method when it builds the view, so such a
    view keeps the unpatched method and is not metered.

    If ``anthropic`` is not installed this is a silent no-op.
    """
    if not _ANTHROPIC_AVAILABLE:
        if not quiet:
            _log.debug("anthropic not installed; skipping patch")
        return
    for cls, is_async in _resource_targets():
        _patch_one_resource(cls, is_async=is_async, quiet=quiet)


def _patch_one_resource(cls: Any, *, is_async: bool, quiet: bool) -> None:
    """Patch one resource class. Internal helper."""
    if _PATCHED_SENTINEL in cls.__dict__:
        return  # already patched, idempotent no-op

    originals: dict[str, Callable[..., Any]] = {}
    for name in _PATCHED_METHODS:
        original = cls.__dict__.get(name)
        if not callable(original):
            # Expected on the platform beta resources, which carry only
            # the methods their platform supports.
            _log.debug("patch: %s has no '%s' method; skipping it", cls.__name__, name)
            continue
        originals[name] = original

    setattr(cls, _PATCHED_SENTINEL, originals)
    for name in originals:
        setattr(cls, name, _intercepting_method(name, originals, is_async=is_async))

    if not quiet:
        _log.info("Patched %s.%s", cls.__name__, " / ".join(originals))


def unpatch_anthropic_classes() -> None:
    """Reverse :func:`patch_anthropic_classes`. Idempotent.

    Restores the original methods on each resource class and removes
    the ``_flightdeck_patched`` sentinel. Because the patch lives on
    the class, every existing resource reverts at once, and a view
    built while patched (``client.messages.with_raw_response``), which
    keeps a bound reference to the intercepting method, passes its
    calls straight through from then on: that method steps aside
    whenever the class no longer resolves to it.
    """
    if not _ANTHROPIC_AVAILABLE:
        return
    for cls, _is_async in _resource_targets():
        _unpatch_one_resource(cls)


def _unpatch_one_resource(cls: Any) -> None:
    """Unpatch a single resource class. Internal helper."""
    originals = cls.__dict__.get(_PATCHED_SENTINEL)
    if not isinstance(originals, dict):
        return  # not patched, idempotent no-op
    for name, original in originals.items():
        setattr(cls, name, original)
    delattr(cls, _PATCHED_SENTINEL)
