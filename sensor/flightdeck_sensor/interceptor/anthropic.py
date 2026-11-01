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
exactly once. When the resource class overrides a patched method and
calls ``super()``, the proxy resolves the override and runs it under
the outer-call mark, so the patched base method it re-enters passes
through instead of reporting the request a second time. An override
that defers its ``super()`` call into an object it returns (a context
manager's ``__enter__``) runs outside the mark and is still reported
twice.

Platform attribution: every ``post_call`` carries the platform the
client talks to under ``provider_metadata.platform`` (``anthropic``,
``bedrock``, ``vertex``, ``google-cloud``, ``foundry``, ``aws``,
``bedrock-mantle``, or
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

import functools
import inspect
import logging
import types
from typing import TYPE_CHECKING, Any

from flightdeck_sensor.interceptor import base, raw_views
from flightdeck_sensor.interceptor.platform import (
    PLATFORM_ANTHROPIC,
    PLATFORM_VERTEX,
    endpoint_of,
)
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


def platform_of(client: Any) -> str:
    """The platform a client talks to (see
    :func:`flightdeck_sensor.interceptor.platform.endpoint_of`), else
    :data:`PLATFORM_ANTHROPIC` when the client exposes no usable host."""
    return endpoint_of(client, PLATFORM_ANTHROPIC).platform


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


def _provider_for(client: Any, session: Session) -> AnthropicProvider:
    endpoint = endpoint_of(client, PLATFORM_ANTHROPIC)
    return AnthropicProvider(
        capture_prompts=session.config.capture_prompts,
        platform=endpoint.platform,
        local=endpoint.local,
        inference_scope=_vertex_scope(client, endpoint.platform),
    )


def _vertex_scope(client: Any, platform: str) -> str | None:
    """``global`` or ``regional`` for a Vertex AI client, from the region
    it was configured with (``AnthropicVertex(region=...)``, defaulting
    to ``CLOUD_ML_REGION``); ``None`` for every other platform."""
    if platform != PLATFORM_VERTEX:
        return None
    region = getattr(client, "region", None)
    if not isinstance(region, str) or not region:
        return None
    return "global" if region == "global" else "regional"


# ----------------------------------------------------------------------
# Raw and streaming views (see interceptor/raw_views.py)
# ----------------------------------------------------------------------


def _is_sdk_stream(obj: Any) -> bool:
    if _anthropic_module is None:
        return False
    return isinstance(obj, (_anthropic_module.Stream, _anthropic_module.AsyncStream))


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
        class is patched, else reads the method as usual. That last case
        can be a subclass override that calls ``super()`` into a patched
        base method, so it runs under the outer-call mark: this proxy
        already meters the call and the patched base passes through."""
        if self._originals is not None and name in self._originals:
            return types.MethodType(self._originals[name], self._real)
        for klass in type(self._real).__mro__:
            if name not in klass.__dict__:
                continue
            originals = klass.__dict__.get(_PATCHED_SENTINEL)
            if isinstance(originals, dict) and name in originals:
                return types.MethodType(originals[name], self._real)
            break
        return _under_outer_mark(getattr(self._real, name))

    def _deferred(self, real_fn: Any, kwargs: dict[str, Any]) -> Any:
        """Send the request now, meter when the caller parses the response
        (see :class:`raw_views.DeferredResponse`). Pre-call policy runs
        before the request, as on every other path; a failing request
        emits ``llm_error`` and re-raises."""
        return raw_views.send_deferred(
            real_fn,
            kwargs,
            self._session,
            self._provider,
            is_async=self._is_async,
            is_stream=_is_sdk_stream,
        )

    def _async_raw_read(self, real_fn: Any, kwargs: dict[str, Any]) -> Any:
        """A call through an async client's raw view, metered like a plain
        call. From the 2.x SDKs the view returns an ``AsyncAPIResponse``
        whose ``parse()`` is a coroutine; its body is already read, so the
        sensor awaits that parse (no network, and the SDK caches the
        result for the caller's own ``parse()``), meters the parsed
        message and hands the caller the response itself. A body that
        fails to parse is metered with the estimate and the caller's own
        ``parse()`` raises, exactly as without the sensor. A response
        with a synchronous ``parse()`` (the 0.x ``LegacyAPIResponse``) is
        metered as returned."""
        kept: dict[str, Any] = {}

        async def _read(**call_kwargs: Any) -> Any:
            response = await real_fn(**call_kwargs)
            parse = getattr(response, "parse", None)
            if not inspect.iscoroutinefunction(parse):
                return response
            kept["response"] = response
            headers = getattr(response, "headers", None)
            try:
                parsed = await parse()
            except Exception:
                # The caller's own parse() raises this, as it would without
                # the sensor; the call itself succeeded and is metered with
                # the estimate, as on the 0.x raw view.
                return raw_views.ParsedRawResponse(None, headers)
            return raw_views.ParsedRawResponse(parsed, headers)

        async def _call() -> Any:
            result = await base.call_async(_read, kwargs, self._session, self._provider)
            return kept.get("response", result)

        return _call()

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
        # An outer interceptor (litellm) making this call already meters
        # it: hand the call to the SDK untouched (see base.outer_intercept).
        if base.outer_intercept_active():
            return real_fn(**kwargs)
        if raw_views.body_unread(kwargs):
            return self._deferred(real_fn, kwargs)
        if raw_views.raw_response_mode(kwargs) in raw_views.RAW_MODES_READ and self._is_async:
            return self._async_raw_read(real_fn, kwargs)
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
        # An outer interceptor (litellm) making this call already meters
        # it: hand the call to the SDK untouched (see base.outer_intercept).
        if base.outer_intercept_active():
            return real_fn(**kwargs)
        if self._is_async:
            return base.call_stream_async(real_fn, kwargs, self._session, self._provider)
        return base.call_stream(real_fn, kwargs, self._session, self._provider)

    def parse(self, **kwargs: Any) -> Any:
        """Intercept messages.parse() (structured output): a plain call
        whose response is a parsed ``Message`` subclass, so usage, content
        and tool calls come out as for ``create()``. Through the
        streaming view it is deferred like ``create()``."""
        real_fn = self._method("parse")
        # An outer interceptor (litellm) making this call already meters
        # it: hand the call to the SDK untouched (see base.outer_intercept).
        if base.outer_intercept_active():
            return real_fn(**kwargs)
        raw_mode = raw_views.raw_response_mode(kwargs)
        if raw_mode == raw_views.RAW_MODE_STREAM:
            return self._deferred(real_fn, kwargs)
        if raw_mode in raw_views.RAW_MODES_READ and self._is_async:
            return self._async_raw_read(real_fn, kwargs)
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


def _under_outer_mark(fn: Any) -> Any:
    """``fn`` run under the outer-call mark (see ``base.outer_intercept``),
    including the await of a coroutine it returns, so a patched resource
    method it reaches hands the call to the SDK untouched. An override
    that returns something else (a context manager or generator) and
    calls ``super()`` only later, when that object is used, runs outside
    the mark, and that request is reported twice."""

    @functools.wraps(fn)
    def run(*args: Any, **kwargs: Any) -> Any:
        with base.outer_intercept():
            result = fn(*args, **kwargs)
        if inspect.iscoroutine(result):
            pending = result

            async def _awaited() -> Any:
                with base.outer_intercept():
                    return await pending

            return _awaited()
        return result

    return run


def _intercepting_method(
    name: str, originals: dict[str, Callable[..., Any]], *, is_async: bool
) -> Any:
    """The replacement for a resource method: with an active session the
    call goes through a :class:`SensorMessages` built over the resource,
    unless an outer interceptor is already metering it, and that proxy
    calls the class's original (handed over in ``originals``, so a
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
        # No session, an outer interceptor (litellm) already metering this
        # call (see base.outer_intercept), or the class was unpatched: the
        # original runs untouched.
        if (
            session is None
            or base.outer_intercept_active()
            or not _installed(type(self), name, method)
        ):
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
