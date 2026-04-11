"""OpenAI client proxy: intercepts chat.completions.create().

Two intercept paths exist for OpenAI clients (mirroring the Anthropic
interceptor):

1. **Class-level patching (recommended)** -- :func:`patch_openai_classes`
   mutates ``openai.OpenAI`` and ``openai.AsyncOpenAI`` in place,
   replacing the ``chat`` ``cached_property`` descriptor with
   :class:`_OpenAIChatDescriptor`. Every instance created anywhere
   has its first ``.chat`` access produce a :class:`SensorChat`
   wrapper, cached in ``instance.__dict__`` for subsequent accesses.
2. **Per-instance wrapping** via :class:`SensorOpenAI` and the public
   ``flightdeck_sensor.wrap()`` API.

Interception hierarchy for class-level patching::

    openai.OpenAI._flightdeck_patched   ← idempotency sentinel
    openai.OpenAI.chat                  ← _OpenAIChatDescriptor
      └── on first __get__:
            real = orig_descriptor.func(instance)  # raw Chat
            wrapped = SensorChat(real, session, provider, is_async)
            instance.__dict__['chat'] = wrapped
            return wrapped

Interception hierarchy for per-instance wrapping::

    SensorOpenAI (wraps openai.OpenAI or AsyncOpenAI)
      ├── @property chat      →  SensorChat
      │   ├── @property completions  →  SensorCompletions
      │   │   ├── create()           →  call(), call_async(), or call_stream()
      │   │   └── __getattr__        →  pass-through
      │   └── __getattr__    →  pass-through
      ├── with_options()     →  new SensorOpenAI
      ├── with_raw_response  →  new SensorOpenAI
      ├── with_streaming_response → new SensorOpenAI
      └── __getattr__        →  pass-through

When ``stream=True``, injects ``stream_options={"include_usage": True}``
into kwargs so OpenAI returns token usage in the final streaming chunk.
"""

from __future__ import annotations

import copy
import logging
from typing import TYPE_CHECKING, Any

from flightdeck_sensor.interceptor import base
from flightdeck_sensor.providers.openai import OpenAIProvider

if TYPE_CHECKING:
    from flightdeck_sensor.core.session import Session

_log = logging.getLogger("flightdeck_sensor.interceptor.openai")


# ----------------------------------------------------------------------
# Captured class references
# ----------------------------------------------------------------------
#
# Captured at module import time, BEFORE patch() can run, so isinstance()
# checks below survive any later mutation. See the matching block in
# interceptor/anthropic.py for the rationale and the Phase 4.5 audit
# Finding 2 backstory.

try:
    import openai as _openai_module
    _OrigOpenAI: type | None = _openai_module.OpenAI
    _OrigAsyncOpenAI: type | None = _openai_module.AsyncOpenAI
    _OPENAI_AVAILABLE = True
except ImportError:
    _openai_module = None  # type: ignore[assignment]
    _OrigOpenAI = None
    _OrigAsyncOpenAI = None
    _OPENAI_AVAILABLE = False


def _is_async_client(client: Any) -> bool:
    """Detect async OpenAI client using the captured class reference."""
    if _OrigAsyncOpenAI is None:
        return False
    return isinstance(client, _OrigAsyncOpenAI)


class SensorCompletions:
    """Proxy for ``chat.completions`` -- intercepts ``create()``."""

    def __init__(
        self,
        real_completions: Any,
        session: Session,
        provider: OpenAIProvider,
        *,
        is_async: bool = False,
    ) -> None:
        self._real = real_completions
        self._session = session
        self._provider = provider
        self._is_async = is_async

    def create(self, **kwargs: Any) -> Any:
        """Intercept chat.completions.create().

        When ``stream=True``, injects ``stream_options`` so OpenAI includes
        token usage in the final streaming chunk.

        Async streaming (``await async_client.chat.completions.create(stream=True)``)
        is not yet supported and raises ``NotImplementedError``. The
        previous implementation silently dispatched async streaming to
        the sync ``base.call_stream`` path; raising surfaces the
        limitation immediately rather than producing broken behavior at
        runtime. TODO: implement ``base.call_stream_async`` and a
        matching async stream wrapper.
        """
        if kwargs.get("stream"):
            if self._is_async:
                raise NotImplementedError(
                    "Async streaming via AsyncOpenAI.chat.completions.create"
                    "(stream=True) is not yet supported by flightdeck-sensor. "
                    "Use a non-streaming async call or sync streaming "
                    "instead. Tracked for a future sensor release."
                )
            call_kwargs = _inject_stream_options(kwargs)
            return base.call_stream(
                self._real.create,
                call_kwargs,
                self._session,
                self._provider,
            )

        real_fn = self._real.create
        if self._is_async:
            return base.call_async(real_fn, kwargs, self._session, self._provider)
        return base.call(real_fn, kwargs, self._session, self._provider)

    @property
    def with_raw_response(self) -> _SensorCompletionsRawResponseWrapper:
        """Return an intercept wrapper for ``chat.completions.with_raw_response``.

        ``langchain-openai`` (1.x) uses
        ``self.client.with_raw_response.create(**payload)`` to drive
        every chat call -- where ``self.client`` is the chat.completions
        resource (which the sensor's class-level patch wraps as a
        SensorCompletions). Without this property, ``__getattr__`` would
        fall through to ``self._real.with_raw_response``, which is the
        cached_property on the underlying real ``Completions`` and
        returns ``CompletionsWithRawResponse(real_completions)``. That
        wrapper captures ``real_completions.create`` (the unwrapped
        bound method) at construction time via
        ``_legacy_response.to_raw_response_wrapper``, so subsequent
        ``.create()`` calls bypass the sensor pipeline entirely.

        The override here returns a small wrapper class whose
        ``.create()`` runs the sensor pre/post intercept around the
        captured raw-response create closure. The closure still injects
        the ``X-Stainless-Raw-Response`` header so the framework gets
        the same return shape it expects (``LegacyAPIResponse``).
        """
        return _SensorCompletionsRawResponseWrapper(
            self._real.with_raw_response,
            self._session,
            self._provider,
            is_async=self._is_async,
        )

    def __getattr__(self, name: str) -> Any:
        return getattr(self._real, name)


class _SensorCompletionsRawResponseWrapper:
    """Sensor proxy for ``CompletionsWithRawResponse`` (langchain-openai path).

    Wraps the SDK's ``CompletionsWithRawResponse`` instance and runs the
    sensor's pre/post intercept around its ``create`` closure. The
    closure is the result of
    ``_legacy_response.to_raw_response_wrapper(real_completions.create)``
    -- treating it as the ``real_fn`` passed into ``base.call`` /
    ``base.call_async`` produces the same intercept behavior the
    direct ``SensorCompletions.create`` path provides, while preserving
    the SDK's raw-response return shape that langchain expects.

    Pass-through ``__getattr__`` delegates ``.parse``, ``.retrieve``,
    ``.update``, ``.list``, ``.delete`` etc to the underlying SDK
    wrapper unchanged. Only ``.create`` is intercepted because that
    is the only method that triggers an LLM call worth metering.
    """

    def __init__(
        self,
        real_wrapper: Any,
        session: Session,
        provider: OpenAIProvider,
        *,
        is_async: bool = False,
    ) -> None:
        self._real = real_wrapper
        self._session = session
        self._provider = provider
        self._is_async = is_async

    def create(self, **kwargs: Any) -> Any:
        """Intercept the raw-response create closure with the sensor pipeline."""
        real_fn = self._real.create
        if self._is_async:
            return base.call_async(
                real_fn, kwargs, self._session, self._provider
            )
        return base.call(real_fn, kwargs, self._session, self._provider)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._real, name)


class SensorChat:
    """Proxy for ``client.chat`` -- intercepts ``.completions``."""

    def __init__(
        self,
        real_chat: Any,
        session: Session,
        provider: OpenAIProvider,
        *,
        is_async: bool = False,
    ) -> None:
        self._real = real_chat
        self._session = session
        self._provider = provider
        self._is_async = is_async

    @property
    def completions(self) -> SensorCompletions:
        """Return a :class:`SensorCompletions` proxy."""
        return SensorCompletions(
            self._real.completions,
            self._session,
            self._provider,
            is_async=self._is_async,
        )

    def __getattr__(self, name: str) -> Any:
        return getattr(self._real, name)


class SensorOpenAI:
    """Proxy for ``openai.OpenAI`` or ``openai.AsyncOpenAI``.

    ``.chat`` is a ``@property`` -- this is how interception works.
    ``__getattr__`` delegates everything else to the wrapped client.
    """

    def __init__(
        self,
        client: Any,
        session: Session,
        provider: OpenAIProvider | None = None,
    ) -> None:
        self._client = client
        self._session = session
        self._is_async = _is_async_client(client)
        self._provider = provider or OpenAIProvider(
            capture_prompts=session.config.capture_prompts,
        )

    @property
    def chat(self) -> SensorChat:
        """Return a :class:`SensorChat` proxy that intercepts completions."""
        return SensorChat(
            self._client.chat,
            self._session,
            self._provider,
            is_async=self._is_async,
        )

    def with_options(self, **kwargs: Any) -> SensorOpenAI:
        """Return a new SensorOpenAI wrapping a client with updated options."""
        new_client = self._client.with_options(**kwargs)
        return SensorOpenAI(new_client, self._session, self._provider)

    @property
    def with_raw_response(self) -> SensorOpenAI:
        """Return a new SensorOpenAI wrapping the raw response client."""
        return SensorOpenAI(
            self._client.with_raw_response,
            self._session,
            self._provider,
        )

    @property
    def with_streaming_response(self) -> SensorOpenAI:
        """Return a new SensorOpenAI wrapping the streaming response client."""
        return SensorOpenAI(
            self._client.with_streaming_response,
            self._session,
            self._provider,
        )

    def __getattr__(self, name: str) -> Any:
        return getattr(self._client, name)


def _inject_stream_options(kwargs: dict[str, Any]) -> dict[str, Any]:
    """Inject ``stream_options={"include_usage": True}`` into a copy of kwargs.

    OpenAI does not return token usage in streaming responses by default.
    This option causes the final chunk to include a ``usage`` field.
    """
    result = copy.copy(kwargs)
    existing = result.get("stream_options")
    if isinstance(existing, dict):
        existing = {**existing, "include_usage": True}
        result["stream_options"] = existing
    else:
        result["stream_options"] = {"include_usage": True}
    return result


# ----------------------------------------------------------------------
# Class-level patching: descriptor and patch/unpatch functions
# ----------------------------------------------------------------------


def _current_session() -> Session | None:
    """Lazy lookup of the active flightdeck_sensor session.

    See the matching helper in ``interceptor/anthropic.py`` for the
    circular-import rationale.
    """
    import flightdeck_sensor

    return flightdeck_sensor._session


class _OpenAIChatDescriptor:
    """Replacement for the ``chat`` cached_property on OpenAI clients.

    Symmetric to :class:`_AnthropicMessagesDescriptor` in
    ``interceptor/anthropic.py``. On first access on a given instance,
    obtains the raw ``Chat`` (or ``AsyncChat``) resource by invoking
    the original ``cached_property``'s underlying function, wraps it
    in a :class:`SensorChat` proxy bound to the active session, and
    stores the wrapped version in ``instance.__dict__[name]`` so
    subsequent accesses bypass the descriptor.

    If no flightdeck session is currently active the descriptor returns
    the raw resource without wrapping AND without populating the cache.
    """

    def __init__(
        self,
        original: Any,
        is_async: bool,
    ) -> None:
        self._original = original  # the original functools.cached_property
        self._is_async = is_async
        self._attr_name: str | None = None

    def __set_name__(self, owner: type, name: str) -> None:
        self._attr_name = name

    def __get__(self, instance: Any, owner: type | None = None) -> Any:
        if instance is None:
            return self

        raw = self._original.func(instance)

        session = _current_session()
        if session is None:
            return raw

        provider = OpenAIProvider(
            capture_prompts=session.config.capture_prompts,
        )
        wrapped = SensorChat(
            raw,
            session,
            provider,
            is_async=self._is_async,
        )

        if self._attr_name is not None:
            instance.__dict__[self._attr_name] = wrapped

        return wrapped


def patch_openai_classes(quiet: bool = False) -> None:
    """Class-level patch for ``openai.OpenAI`` and ``AsyncOpenAI``.

    Idempotent: a second call is a no-op. Mirrors the Anthropic
    counterpart in ``interceptor/anthropic.py``.

    For each class:

    1. Check ``hasattr(cls, '_flightdeck_patched')`` -- if present, skip.
    2. Capture the original ``chat`` ``cached_property`` from
       ``cls.__dict__``.
    3. Store the captured original on ``cls._flightdeck_patched``.
    4. Replace ``cls.chat`` with a fresh
       :class:`_OpenAIChatDescriptor`.

    If ``openai`` is not installed this is a silent no-op.
    """
    if not _OPENAI_AVAILABLE:
        if not quiet:
            _log.debug("openai not installed; skipping patch")
        return

    _patch_one_class(_OrigOpenAI, is_async=False, quiet=quiet)
    _patch_one_class(_OrigAsyncOpenAI, is_async=True, quiet=quiet)


def _patch_one_class(cls: Any, *, is_async: bool, quiet: bool) -> None:
    """Patch a single OpenAI / AsyncOpenAI class. Internal helper."""
    if hasattr(cls, "_flightdeck_patched"):
        return  # already patched, idempotent no-op

    orig_descriptor = cls.__dict__.get("chat")
    if orig_descriptor is None:
        if not quiet:
            _log.warning(
                "patch: %s has no 'chat' descriptor; skipping",
                cls.__name__,
            )
        return

    cls._flightdeck_patched = orig_descriptor
    new_descriptor = _OpenAIChatDescriptor(
        orig_descriptor,
        is_async=is_async,
    )
    new_descriptor._attr_name = "chat"
    cls.chat = new_descriptor

    if not quiet:
        _log.info("Patched %s.chat descriptor", cls.__name__)


def unpatch_openai_classes() -> None:
    """Reverse :func:`patch_openai_classes`. Idempotent.

    Restores the original ``chat`` ``cached_property`` on each class
    and removes the ``_flightdeck_patched`` sentinel.

    Same pre-existing-instance limitation as
    :func:`unpatch_anthropic_classes`: instances that have already
    accessed ``.chat`` once retain the wrapped version in their
    ``__dict__`` until garbage collected.
    """
    if not _OPENAI_AVAILABLE:
        return
    _unpatch_one_class(_OrigOpenAI)
    _unpatch_one_class(_OrigAsyncOpenAI)


def _unpatch_one_class(cls: Any) -> None:
    """Unpatch a single OpenAI / AsyncOpenAI class. Internal helper."""
    orig_descriptor = getattr(cls, "_flightdeck_patched", None)
    if orig_descriptor is None:
        return  # not patched, idempotent no-op
    cls.chat = orig_descriptor
    delattr(cls, "_flightdeck_patched")
