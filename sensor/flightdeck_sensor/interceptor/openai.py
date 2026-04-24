"""OpenAI client proxy: intercepts chat.completions.create(),
responses.create() and embeddings.create().

Two intercept paths exist for OpenAI clients (mirroring the Anthropic
interceptor):

1. **Class-level patching (recommended)** -- :func:`patch_openai_classes`
   mutates ``openai.OpenAI`` and ``openai.AsyncOpenAI`` in place,
   replacing three ``cached_property`` descriptors on each class:

   * ``chat`` → :class:`_OpenAIChatDescriptor` → :class:`SensorChat`
   * ``responses`` → :class:`_OpenAIResponsesDescriptor` →
     :class:`SensorResponses`
   * ``embeddings`` → :class:`_OpenAIEmbeddingsDescriptor` →
     :class:`SensorEmbeddings`

   Each resource uses its own idempotency sentinel
   (``_flightdeck_patched`` for chat, ``_flightdeck_patched_responses``
   for responses, ``_flightdeck_patched_embeddings`` for embeddings)
   so multiple resources on the same class can coexist. The chat
   sentinel keeps the historical attribute name for backward
   compatibility with :func:`flightdeck_sensor.wrap` which checks it
   to decide whether a client is already patched.
2. **Per-instance wrapping** via :class:`SensorOpenAI` and the public
   ``flightdeck_sensor.wrap()`` API.

Interception hierarchy for class-level patching::

    openai.OpenAI._flightdeck_patched              ← chat sentinel
    openai.OpenAI._flightdeck_patched_responses    ← responses sentinel
    openai.OpenAI._flightdeck_patched_embeddings   ← embeddings sentinel
    openai.OpenAI.chat                             ← _OpenAIChatDescriptor
    openai.OpenAI.responses                        ← _OpenAIResponsesDescriptor
    openai.OpenAI.embeddings                       ← _OpenAIEmbeddingsDescriptor
      └── on first __get__ of each:
            real = orig_descriptor.func(instance)  # raw resource
            wrapped = Sensor{Chat,Responses,Embeddings}(real, ...)
            instance.__dict__[name] = wrapped
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

        Phase 4: async streaming is now supported via
        :func:`base.call_stream_async`. Sync and async streaming go through
        guarded wrappers that measure TTFT, chunk count, and abort
        reasons.
        """
        if kwargs.get("stream"):
            call_kwargs = _inject_stream_options(kwargs)
            if self._is_async:
                return base.call_stream_async(
                    self._real.create,
                    call_kwargs,
                    self._session,
                    self._provider,
                )
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


class SensorResponses:
    """Proxy for ``client.responses`` -- intercepts ``create()``.

    OpenAI's Responses API (March 2025 and recommended for all new
    projects) lives at ``OpenAI.responses``, a direct sibling of
    ``OpenAI.chat``. The intercept surface is a single ``create()``
    method -- streaming is intentionally not special-cased here; a
    ``stream=True`` call currently flows through ``base.call`` and the
    returned stream object is passed through unchanged. Reconciled
    token counts for streaming Responses calls are tracked as a
    future enhancement, symmetric to the async-stream limitation in
    ``SensorCompletions.create``.

    Token usage extraction is handled by :class:`OpenAIProvider` which
    falls back to ``usage.input_tokens`` / ``usage.output_tokens``
    (the Responses API shape) when the chat shape is absent.
    """

    def __init__(
        self,
        real_responses: Any,
        session: Session,
        provider: OpenAIProvider,
        *,
        is_async: bool = False,
    ) -> None:
        self._real = real_responses
        self._session = session
        self._provider = provider
        self._is_async = is_async

    def create(self, **kwargs: Any) -> Any:
        """Intercept responses.create() -- sync or async dispatch."""
        real_fn = self._real.create
        if self._is_async:
            return base.call_async(
                real_fn, kwargs, self._session, self._provider
            )
        return base.call(real_fn, kwargs, self._session, self._provider)

    def __getattr__(self, name: str) -> Any:
        # Pass through: parse, stream, retrieve, delete, cancel,
        # connect, compact, input_items, input_tokens, with_raw_response,
        # with_streaming_response.
        return getattr(self._real, name)


class SensorEmbeddings:
    """Proxy for ``client.embeddings`` -- intercepts ``create()``.

    Embeddings are common in RAG-heavy agent pipelines and counting
    their tokens is important for full agent-workflow accounting.
    The wrapper shape is identical to :class:`SensorResponses` -- only
    ``create()`` is intercepted, everything else passes through.

    Embeddings responses carry ``usage.prompt_tokens`` and
    ``usage.total_tokens`` only (no ``completion_tokens``); the
    existing chat path in :meth:`OpenAIProvider.extract_usage`
    already returns ``(prompt_tokens, 0)`` in that case, which is
    semantically correct -- embeddings produce vectors, not output
    text.
    """

    def __init__(
        self,
        real_embeddings: Any,
        session: Session,
        provider: OpenAIProvider,
        *,
        is_async: bool = False,
    ) -> None:
        self._real = real_embeddings
        self._session = session
        self._provider = provider
        self._is_async = is_async

    def create(self, **kwargs: Any) -> Any:
        """Intercept embeddings.create() -- sync or async dispatch.

        Phase 4: emits ``event_type="embeddings"`` (not the generic
        ``post_call``) so the dashboard can render embedding calls
        distinctly. Token accounting stays identical -- embeddings carry
        input tokens only, ``output_tokens=0`` as returned by
        :meth:`OpenAIProvider.extract_usage`.
        """
        real_fn = self._real.create
        from flightdeck_sensor.core.types import EventType
        if self._is_async:
            return base.call_async(
                real_fn, kwargs, self._session, self._provider,
                event_type=EventType.EMBEDDINGS,
            )
        return base.call(
            real_fn, kwargs, self._session, self._provider,
            event_type=EventType.EMBEDDINGS,
        )

    def __getattr__(self, name: str) -> Any:
        # Pass through: with_raw_response, with_streaming_response.
        return getattr(self._real, name)


class SensorOpenAI:
    """Proxy for ``openai.OpenAI`` or ``openai.AsyncOpenAI``.

    ``.chat``, ``.responses`` and ``.embeddings`` are ``@property``
    hooks -- this is how per-instance interception works.
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

    @property
    def responses(self) -> SensorResponses:
        """Return a :class:`SensorResponses` proxy that intercepts create()."""
        return SensorResponses(
            self._client.responses,
            self._session,
            self._provider,
            is_async=self._is_async,
        )

    @property
    def embeddings(self) -> SensorEmbeddings:
        """Return a :class:`SensorEmbeddings` proxy that intercepts create()."""
        return SensorEmbeddings(
            self._client.embeddings,
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


class _OpenAIResponsesDescriptor:
    """Replacement for the ``responses`` cached_property on OpenAI clients.

    Structurally identical to :class:`_OpenAIChatDescriptor`; wraps the
    raw ``Responses`` / ``AsyncResponses`` resource in a
    :class:`SensorResponses` proxy bound to the active session.
    """

    def __init__(
        self,
        original: Any,
        is_async: bool,
    ) -> None:
        self._original = original
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
        wrapped = SensorResponses(
            raw,
            session,
            provider,
            is_async=self._is_async,
        )

        if self._attr_name is not None:
            instance.__dict__[self._attr_name] = wrapped

        return wrapped


class _OpenAIEmbeddingsDescriptor:
    """Replacement for the ``embeddings`` cached_property on OpenAI clients.

    Structurally identical to :class:`_OpenAIChatDescriptor`; wraps the
    raw ``Embeddings`` / ``AsyncEmbeddings`` resource in a
    :class:`SensorEmbeddings` proxy.
    """

    def __init__(
        self,
        original: Any,
        is_async: bool,
    ) -> None:
        self._original = original
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
        wrapped = SensorEmbeddings(
            raw,
            session,
            provider,
            is_async=self._is_async,
        )

        if self._attr_name is not None:
            instance.__dict__[self._attr_name] = wrapped

        return wrapped


# ----------------------------------------------------------------------
# Resource patch table
# ----------------------------------------------------------------------
#
# Each entry describes one resource on the OpenAI / AsyncOpenAI classes
# that the class-level patch installs a descriptor for. The same table
# drives both :func:`patch_openai_classes` and
# :func:`unpatch_openai_classes` so the set of patched resources is
# defined in exactly one place.
#
# ``sentinel_attr`` is the attribute used for idempotency. The chat
# entry keeps the historical name ``_flightdeck_patched`` because
# ``flightdeck_sensor.wrap()`` (and existing unit tests) check for it
# to decide whether a client is already covered by the class-level
# patch. The two new entries use per-resource sentinels so multiple
# resources can coexist on the same class.

_OPENAI_PATCH_RESOURCES: tuple[tuple[str, str, type], ...] = (
    ("chat", "_flightdeck_patched", _OpenAIChatDescriptor),
    ("responses", "_flightdeck_patched_responses", _OpenAIResponsesDescriptor),
    ("embeddings", "_flightdeck_patched_embeddings", _OpenAIEmbeddingsDescriptor),
)


def patch_openai_classes(quiet: bool = False) -> None:
    """Class-level patch for ``openai.OpenAI`` and ``AsyncOpenAI``.

    Idempotent: a second call is a no-op. Mirrors the Anthropic
    counterpart in ``interceptor/anthropic.py``.

    For each (class, resource) pair:

    1. Check ``hasattr(cls, sentinel_attr)`` -- if present, skip.
    2. Capture the original ``cached_property`` from ``cls.__dict__``.
    3. Store the captured original on the per-resource sentinel so
       :func:`unpatch_openai_classes` can restore it.
    4. Replace ``cls.<resource>`` with a fresh descriptor instance.

    The three resources patched are ``chat``, ``responses`` and
    ``embeddings``. See :data:`_OPENAI_PATCH_RESOURCES`.

    If ``openai`` is not installed this is a silent no-op.
    """
    if not _OPENAI_AVAILABLE:
        if not quiet:
            _log.debug("openai not installed; skipping patch")
        return

    for attr_name, sentinel_attr, descriptor_cls in _OPENAI_PATCH_RESOURCES:
        _patch_one_resource(
            _OrigOpenAI,
            attr_name=attr_name,
            sentinel_attr=sentinel_attr,
            descriptor_cls=descriptor_cls,
            is_async=False,
            quiet=quiet,
        )
        _patch_one_resource(
            _OrigAsyncOpenAI,
            attr_name=attr_name,
            sentinel_attr=sentinel_attr,
            descriptor_cls=descriptor_cls,
            is_async=True,
            quiet=quiet,
        )


def _patch_one_resource(
    cls: Any,
    *,
    attr_name: str,
    sentinel_attr: str,
    descriptor_cls: type,
    is_async: bool,
    quiet: bool,
) -> None:
    """Patch one resource attribute on one OpenAI / AsyncOpenAI class.

    Parameterized form of the previous ``_patch_one_class`` so that
    ``chat``, ``responses`` and ``embeddings`` all share the same
    helper instead of three copy-pasted variants. Each resource has
    its own idempotency sentinel attribute so multiple patched
    resources coexist on the same class.
    """
    if hasattr(cls, sentinel_attr):
        return  # already patched, idempotent no-op

    orig_descriptor = cls.__dict__.get(attr_name)
    if orig_descriptor is None:
        if not quiet:
            _log.warning(
                "patch: %s has no %r descriptor; skipping",
                cls.__name__,
                attr_name,
            )
        return

    setattr(cls, sentinel_attr, orig_descriptor)
    new_descriptor = descriptor_cls(
        orig_descriptor,
        is_async=is_async,
    )
    new_descriptor._attr_name = attr_name
    setattr(cls, attr_name, new_descriptor)

    if not quiet:
        _log.info("Patched %s.%s descriptor", cls.__name__, attr_name)


def unpatch_openai_classes() -> None:
    """Reverse :func:`patch_openai_classes`. Idempotent.

    Restores the original ``cached_property`` for each patched
    resource and removes the per-resource sentinel attributes.

    Same pre-existing-instance limitation as
    :func:`unpatch_anthropic_classes`: instances that have already
    accessed a patched resource once retain the wrapped version in
    their ``__dict__`` until garbage collected.
    """
    if not _OPENAI_AVAILABLE:
        return
    for attr_name, sentinel_attr, _descriptor_cls in _OPENAI_PATCH_RESOURCES:
        _unpatch_one_resource(
            _OrigOpenAI,
            attr_name=attr_name,
            sentinel_attr=sentinel_attr,
        )
        _unpatch_one_resource(
            _OrigAsyncOpenAI,
            attr_name=attr_name,
            sentinel_attr=sentinel_attr,
        )


def _unpatch_one_resource(
    cls: Any,
    *,
    attr_name: str,
    sentinel_attr: str,
) -> None:
    """Unpatch one resource on one OpenAI / AsyncOpenAI class."""
    orig_descriptor = getattr(cls, sentinel_attr, None)
    if orig_descriptor is None:
        return  # not patched, idempotent no-op
    setattr(cls, attr_name, orig_descriptor)
    delattr(cls, sentinel_attr)
