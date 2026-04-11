"""Anthropic client proxy: intercepts messages.create() and messages.stream().

Two intercept paths exist for Anthropic clients:

1. **Class-level patching (recommended)** -- :func:`patch_anthropic_classes`
   mutates ``anthropic.Anthropic`` and ``anthropic.AsyncAnthropic`` in
   place, replacing the ``messages`` ``cached_property`` descriptor
   with :class:`_AnthropicMessagesDescriptor`. Every instance created
   anywhere -- including instances constructed inside frameworks like
   ``langchain-anthropic`` and ``llama-index-llms-anthropic`` -- has
   its first ``.messages`` access produce a :class:`GuardedMessages`
   wrapper. The wrapped resource is cached in ``instance.__dict__``
   so subsequent accesses bypass the descriptor entirely (matching
   ``functools.cached_property`` semantics).
2. **Per-instance wrapping** -- :class:`GuardedAnthropic` wraps a
   single client instance via the public ``flightdeck_sensor.wrap()``
   API. Useful for code that wants to opt into observability for one
   specific client without enabling global patching.

When both are active (``patch()`` followed by ``wrap()``), ``wrap()``
in ``flightdeck_sensor/__init__.py`` short-circuits and returns the
client unchanged because the class-level patch has already installed
the descriptor on the client's class.

Interception hierarchy for class-level patching::

    anthropic.Anthropic._flightdeck_patched   ← idempotency sentinel
    anthropic.Anthropic.messages              ← _AnthropicMessagesDescriptor
      └── on first __get__:
            real = orig_descriptor.func(instance)  # raw Messages
            wrapped = GuardedMessages(real, session, provider, is_async)
            instance.__dict__['messages'] = wrapped
            return wrapped

Interception hierarchy for per-instance wrapping::

    GuardedAnthropic (wraps anthropic.Anthropic or AsyncAnthropic)
      ├── @property messages  →  GuardedMessages
      │   ├── create()        →  call() or call_async()
      │   ├── stream()        →  call_stream() or NotImplementedError (async)
      │   └── __getattr__     →  pass-through
      ├── with_options()      →  new GuardedAnthropic
      ├── with_raw_response   →  new GuardedAnthropic
      ├── with_streaming_response → new GuardedAnthropic
      └── __getattr__         →  pass-through
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from flightdeck_sensor.interceptor import base
from flightdeck_sensor.providers.anthropic import AnthropicProvider

if TYPE_CHECKING:
    from flightdeck_sensor.core.session import Session

_log = logging.getLogger("flightdeck_sensor.interceptor.anthropic")


# ----------------------------------------------------------------------
# Captured class references
# ----------------------------------------------------------------------
#
# These are captured at module import time, BEFORE patch() can run, so
# isinstance() checks below survive any later mutation of the
# ``anthropic`` module attributes. Using these captured references is
# the fix for the Phase 4.5 audit Finding 2 crash where _is_async_client
# called ``isinstance(client, AsyncAnthropic)`` against an
# ``AsyncAnthropic`` reference that the patch path had replaced with a
# function thunk -- ``isinstance(x, function)`` raises ``TypeError``.
#
# Wrapped in try/except so this module can still be imported when
# ``anthropic`` is not installed (e.g. ``flightdeck-sensor[openai]``
# only installs).

try:
    import anthropic as _anthropic_module
    _OrigAnthropic: type | None = _anthropic_module.Anthropic
    _OrigAsyncAnthropic: type | None = _anthropic_module.AsyncAnthropic
    _ANTHROPIC_AVAILABLE = True
except ImportError:
    _anthropic_module = None  # type: ignore[assignment]
    _OrigAnthropic = None
    _OrigAsyncAnthropic = None
    _ANTHROPIC_AVAILABLE = False


def _is_async_client(client: Any) -> bool:
    """Detect async Anthropic client using the captured class reference.

    Uses ``_OrigAsyncAnthropic`` (captured at module import time) so the
    isinstance check survives ``patch()`` mutating the module attribute.
    """
    if _OrigAsyncAnthropic is None:
        return False
    return isinstance(client, _OrigAsyncAnthropic)


class GuardedMessages:
    """Proxy for the ``messages`` resource on an Anthropic client.

    Intercepts ``create()`` and ``stream()`` -- everything else passes through.
    """

    def __init__(
        self,
        real_messages: Any,
        session: Session,
        provider: AnthropicProvider,
        *,
        is_async: bool = False,
    ) -> None:
        self._real = real_messages
        self._session = session
        self._provider = provider
        self._is_async = is_async

    def create(self, **kwargs: Any) -> Any:
        """Intercept messages.create() -- sync or async depending on client type."""
        real_fn = self._real.create
        if self._is_async:
            return base.call_async(real_fn, kwargs, self._session, self._provider)
        return base.call(real_fn, kwargs, self._session, self._provider)

    def stream(self, **kwargs: Any) -> base.GuardedStream:
        """Intercept messages.stream() -- returns a GuardedStream context manager.

        Sync only. Async streaming via ``async with client.messages.stream(...)``
        is not yet supported and raises ``NotImplementedError``. The previous
        implementation silently dispatched the async stream to the sync
        ``base.call_stream`` which then misbehaved at runtime; raising
        early surfaces the limitation immediately. TODO: implement
        ``base.call_stream_async`` and a matching ``GuardedAsyncStream``
        context manager.
        """
        if self._is_async:
            raise NotImplementedError(
                "Async streaming via AsyncAnthropic.messages.stream() is not "
                "yet supported by flightdeck-sensor. Use a non-streaming "
                "async call (await client.messages.create(...)) or sync "
                "streaming (with sync_client.messages.stream(...) as stream:) "
                "instead. Tracked for a future sensor release."
            )
        return base.call_stream(self._real.stream, kwargs, self._session, self._provider)

    def __getattr__(self, name: str) -> Any:
        # Pass through: batch, count_tokens, etc.
        return getattr(self._real, name)


class GuardedAnthropic:
    """Proxy for ``anthropic.Anthropic`` or ``anthropic.AsyncAnthropic``.

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
        self._provider = provider or AnthropicProvider(
            capture_prompts=session.config.capture_prompts,
        )

    @property
    def messages(self) -> GuardedMessages:
        """Return a :class:`GuardedMessages` proxy that intercepts create/stream."""
        return GuardedMessages(
            self._client.messages,
            self._session,
            self._provider,
            is_async=self._is_async,
        )

    def with_options(self, **kwargs: Any) -> GuardedAnthropic:
        """Return a new GuardedAnthropic wrapping a client with updated options."""
        new_client = self._client.with_options(**kwargs)
        return GuardedAnthropic(new_client, self._session, self._provider)

    @property
    def with_raw_response(self) -> GuardedAnthropic:
        """Return a new GuardedAnthropic wrapping the raw response client."""
        return GuardedAnthropic(
            self._client.with_raw_response,
            self._session,
            self._provider,
        )

    @property
    def with_streaming_response(self) -> GuardedAnthropic:
        """Return a new GuardedAnthropic wrapping the streaming response client."""
        return GuardedAnthropic(
            self._client.with_streaming_response,
            self._session,
            self._provider,
        )

    def __getattr__(self, name: str) -> Any:
        # Pass through: api_key, base_url, _client, etc.
        return getattr(self._client, name)


# ----------------------------------------------------------------------
# Class-level patching: descriptor and patch/unpatch functions
# ----------------------------------------------------------------------


def _current_session() -> Session | None:
    """Lazy lookup of the active flightdeck_sensor session.

    Imported lazily to avoid the circular import that would arise from
    a top-level ``from flightdeck_sensor import _session`` -- this
    interceptor module is itself imported by ``flightdeck_sensor/
    __init__.py`` at line 30.
    """
    import flightdeck_sensor

    return flightdeck_sensor._session


class _AnthropicMessagesDescriptor:
    """Replacement for the ``messages`` cached_property on Anthropic clients.

    On first access on a given instance, calls the original
    ``cached_property``'s underlying function to obtain the raw
    ``Messages`` (or ``AsyncMessages``) resource, wraps it in a
    :class:`GuardedMessages` proxy bound to the active sensor session,
    and stores the wrapped version in ``instance.__dict__[name]``.
    Subsequent accesses bypass the descriptor entirely because Python's
    attribute lookup checks ``instance.__dict__`` before non-data
    descriptors on the class -- this matches the cache semantics of
    the original ``functools.cached_property`` we are replacing.

    If no flightdeck session is currently active (``_session is None``)
    the descriptor returns the raw resource without wrapping AND without
    populating the cache. This means the next access (potentially after
    ``init()`` has been called) will go through the descriptor again
    and wrap correctly.
    """

    def __init__(
        self,
        original: Any,
        is_async: bool,
    ) -> None:
        self._original = original  # the original functools.cached_property
        self._is_async = is_async
        # Will be set by __set_name__ when assigned to the class.
        self._attr_name: str | None = None

    def __set_name__(self, owner: type, name: str) -> None:
        self._attr_name = name

    def __get__(self, instance: Any, owner: type | None = None) -> Any:
        if instance is None:
            return self

        # Get the raw Messages / AsyncMessages by invoking the original
        # cached_property's underlying function directly. This bypasses
        # the cached_property's instance-cache write so we control where
        # the cache lands.
        raw = self._original.func(instance)

        session = _current_session()
        if session is None:
            # No active session -- return raw without wrapping AND without
            # caching, so a later access (after init()) will be wrapped.
            return raw

        provider = AnthropicProvider(
            capture_prompts=session.config.capture_prompts,
        )
        wrapped = GuardedMessages(
            raw,
            session,
            provider,
            is_async=self._is_async,
        )

        # Populate the instance cache so subsequent accesses skip the
        # descriptor and return the wrapped version directly. This
        # matches the cached_property protocol -- non-data descriptors
        # are bypassed when instance.__dict__ has the attribute.
        if self._attr_name is not None:
            instance.__dict__[self._attr_name] = wrapped

        return wrapped


def patch_anthropic_classes(quiet: bool = False) -> None:
    """Class-level patch for ``anthropic.Anthropic`` and ``AsyncAnthropic``.

    Idempotent: a second call is a no-op. Safe to invoke from
    ``flightdeck_sensor.patch()``.

    For each of the two classes:

    1. Check ``hasattr(cls, '_flightdeck_patched')`` -- if present, skip.
    2. Capture the original ``messages`` ``cached_property`` from
       ``cls.__dict__``.
    3. Store the captured original on ``cls._flightdeck_patched`` so
       :func:`unpatch_anthropic_classes` can restore it.
    4. Replace ``cls.messages`` with a fresh
       :class:`_AnthropicMessagesDescriptor` instance bound to the
       async-ness of that class.

    No ``__init__`` patching is needed -- the descriptor handles
    everything on first access. Anthropic clients construct cleanly
    via the unmodified ``__init__``; only the ``messages`` resource
    access is intercepted.

    If ``anthropic`` is not installed this is a silent no-op (matching
    the previous ``_patch_anthropic`` behavior).
    """
    if not _ANTHROPIC_AVAILABLE:
        if not quiet:
            _log.debug("anthropic not installed; skipping patch")
        return

    _patch_one_class(_OrigAnthropic, is_async=False, quiet=quiet)
    _patch_one_class(_OrigAsyncAnthropic, is_async=True, quiet=quiet)


def _patch_one_class(cls: Any, *, is_async: bool, quiet: bool) -> None:
    """Patch a single Anthropic / AsyncAnthropic class. Internal helper."""
    if hasattr(cls, "_flightdeck_patched"):
        return  # already patched, idempotent no-op

    orig_descriptor = cls.__dict__.get("messages")
    if orig_descriptor is None:
        if not quiet:
            _log.warning(
                "patch: %s has no 'messages' descriptor; skipping",
                cls.__name__,
            )
        return

    cls._flightdeck_patched = orig_descriptor
    new_descriptor = _AnthropicMessagesDescriptor(
        orig_descriptor,
        is_async=is_async,
    )
    new_descriptor._attr_name = "messages"
    cls.messages = new_descriptor

    if not quiet:
        _log.info("Patched %s.messages descriptor", cls.__name__)


def unpatch_anthropic_classes() -> None:
    """Reverse :func:`patch_anthropic_classes`. Idempotent.

    Restores the original ``messages`` ``cached_property`` on each
    class and removes the ``_flightdeck_patched`` sentinel.

    **Limitation**: instances created BEFORE ``unpatch`` was called
    that have already accessed ``.messages`` once will have a wrapped
    :class:`GuardedMessages` cached in their ``__dict__``. Those
    instances will continue to use the wrapped resource until the
    instance is garbage collected. Clearing the cache on arbitrary
    live instances is not feasible without a heavy gc traversal and
    is not attempted here.
    """
    if not _ANTHROPIC_AVAILABLE:
        return
    _unpatch_one_class(_OrigAnthropic)
    _unpatch_one_class(_OrigAsyncAnthropic)


def _unpatch_one_class(cls: Any) -> None:
    """Unpatch a single Anthropic / AsyncAnthropic class. Internal helper."""
    orig_descriptor = getattr(cls, "_flightdeck_patched", None)
    if orig_descriptor is None:
        return  # not patched, idempotent no-op
    cls.messages = orig_descriptor
    delattr(cls, "_flightdeck_patched")
