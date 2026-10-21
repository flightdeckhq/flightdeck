"""litellm proxy: intercepts ``litellm.completion()`` / ``acompletion()``,
streaming included, and ``litellm.embedding()`` / ``aembedding()``.

Why this module exists. litellm routes calls to many underlying providers
via module-level entry points. Its Anthropic route uses raw
``httpx.Client.post()`` instead of constructing ``anthropic.Anthropic``,
so the sensor's SDK-class descriptors (see
``interceptor/anthropic.py``) never get a chance to see the call.
This module closes the gap by patching the litellm functions
directly.

Patching shape diverges from the Anthropic/OpenAI interceptors
intentionally: litellm's public surface is module-level functions,
not a class with cached-property resources. Instead of installing
descriptors, :func:`patch_litellm_functions` swaps the module
attributes in place and stashes the originals on hidden sentinel
attributes for later :func:`unpatch_litellm_functions` restoration.
The pre-call / post-call plumbing still flows through
``interceptor/base.call`` / ``call_async`` / ``call_stream`` /
``call_stream_async`` so every interceptor emits the same event schema.

Class-level patching is the recommended integration path (call
:func:`flightdeck_sensor.patch` and every ``litellm.completion`` call
anywhere in the process is intercepted). :class:`SensorLitellm`
exists for programmatic per-callsite wrapping -- a narrow use case
where a user wants to observe one specific call without mutating the
litellm module globals. Both paths share the helpers in this module,
so they cannot drift.

**A call served through the OpenAI SDK is reported once.** litellm's
OpenAI route constructs ``openai.OpenAI`` and calls
``chat.completions.create`` on it, which the sensor's OpenAI descriptor
also intercepts. Every underlying litellm call this module makes runs
under ``base.outer_intercept()`` (see :func:`_as_outer_call`), and the
SDK interceptors hand a call made under that mark to the SDK untouched,
so the litellm wrapper is the single reporter: one ``pre_call``, one
policy check and one ``post_call`` (or ``llm_error``) per litellm call.

**Streaming.** ``stream=True`` returns the sensor's stream guard
(:class:`base.GuardedStream` from ``completion``,
:class:`base.GuardedAsyncStream` from ``acompletion``) around litellm's
``CustomStreamWrapper``. The guard iterates like the wrapper (``for
chunk in ...`` / ``async for chunk in ...``) and proxies its attributes.
The sensor asks litellm for ``stream_options={"include_usage": True}``,
which makes litellm append one chunk carrying the provider's ``usage``
after the ``finish_reason`` chunk; the guard meters that chunk and hides
it from a caller who did not ask for usage, so their loop sees exactly
the chunks it would see without the sensor. litellm's wrapper is not a
context manager and has no ``close()``, so the guard is used as a plain
iterator; the ``post_call`` is emitted when the stream is read to its
end, or when the guard is collected after a loop left early.

**Not patched.** ``litellm.text_completion`` / ``atext_completion``
build a chat request and call ``completion`` through the name bound in
``litellm.main``, which the package-attribute swap does not reach;
patching ``litellm.main.completion`` as well would make every
``acompletion`` (which calls ``completion`` the same way) enter the
sensor twice per call. Calls through ``text_completion`` are therefore
unobserved. ``litellm.responses`` / ``aresponses`` go through litellm's
own httpx handler (so no SDK interceptor sees them either) and return
the Responses API shape (``usage.input_tokens`` / ``output_tokens``,
``input=`` instead of ``messages=``), which needs its own provider
adapter before it can be metered; they are unobserved until then.

**Coverage caveat.** The patch covers direct callers of the patched
entry points -- the vast majority of litellm integrations. Frameworks
that route through lower-level litellm entry points (e.g.
``litellm.llms.custom_httpx.http_handler`` directly, or via an internal
``llm_request()`` helper) still bypass this interceptor. An httpx-level
interceptor would be the broader alternative; it is out of scope here
and will be filed separately if framework reports surface it.
"""

from __future__ import annotations

import copy
import logging
from typing import TYPE_CHECKING, Any

from flightdeck_sensor.core.types import EventType
from flightdeck_sensor.interceptor import base
from flightdeck_sensor.providers.litellm import LitellmProvider

if TYPE_CHECKING:
    from collections.abc import Callable, Coroutine

    from flightdeck_sensor.core.session import Session

_log = logging.getLogger("flightdeck_sensor.interceptor.litellm")


# ----------------------------------------------------------------------
# Captured module reference + availability
# ----------------------------------------------------------------------

try:
    import litellm as _litellm_module

    _OrigCompletion: Any = _litellm_module.completion
    _OrigAcompletion: Any = _litellm_module.acompletion
    # embedding / aembedding are the two entry points for
    # embedding-model calls. We capture them for the same reasons we
    # capture completion -- tokens charged are real, and embeddings
    # dominate RAG workflows. ``getattr`` with a fallback keeps the
    # import resilient against an older litellm that predates aembedding.
    _OrigEmbedding: Any = getattr(_litellm_module, "embedding", None)
    _OrigAembedding: Any = getattr(_litellm_module, "aembedding", None)
    _LITELLM_AVAILABLE = True
except ImportError:
    _litellm_module = None  # type: ignore[assignment]
    _OrigCompletion = None
    _OrigAcompletion = None
    _OrigEmbedding = None
    _OrigAembedding = None
    _LITELLM_AVAILABLE = False


def _current_session() -> Session | None:
    """Lazy lookup of the active flightdeck_sensor session.

    Matches the helper in ``interceptor/anthropic.py`` /
    ``interceptor/openai.py`` -- imported at call time to avoid a
    circular import between the sensor's ``__init__`` and the
    interceptor modules.
    """
    import flightdeck_sensor

    return flightdeck_sensor._session


# ----------------------------------------------------------------------
# Shared intercept paths
# ----------------------------------------------------------------------
#
# The class-level patch and the per-callsite SensorLitellm wrapper both
# route through these helpers: same re-entrancy mark, same stream
# handling, same event shape.


def _as_outer_call(fn: Callable[..., Any]) -> Callable[..., Any]:
    """``fn`` run under :func:`base.outer_intercept`, so an SDK
    interceptor litellm reaches while serving the call (its OpenAI route
    calls ``openai.OpenAI().chat.completions.create``) passes the call
    through instead of reporting it a second time."""

    def _call(**kwargs: Any) -> Any:
        with base.outer_intercept():
            return fn(**kwargs)

    return _call


def _as_outer_async_call(
    fn: Callable[..., Coroutine[Any, Any, Any]],
) -> Callable[..., Coroutine[Any, Any, Any]]:
    """Async form of :func:`_as_outer_call`. The mark is set inside the
    coroutine, so it lives in the task that awaits litellm -- where
    litellm's SDK call runs, or its executor hop for sync-only
    providers, which copies the context."""

    async def _call(**kwargs: Any) -> Any:
        with base.outer_intercept():
            return await fn(**kwargs)

    return _call


def _inject_stream_options(kwargs: dict[str, Any]) -> tuple[dict[str, Any], bool]:
    """Ask litellm for ``stream_options={"include_usage": True}`` on a
    copy of ``kwargs`` and say whether the caller had asked for usage
    themselves (then the usage chunk is theirs; otherwise the guard
    absorbs it). litellm forwards the option to providers that support
    it and computes the usage itself for the rest, so the trailing chunk
    is there on every route. Kept local rather than imported from the
    OpenAI interceptor: the option has the same meaning on both, but the
    two modules must stay independently importable and editable."""
    result = copy.copy(kwargs)
    existing = result.get("stream_options")
    caller_asked = isinstance(existing, dict) and bool(existing.get("include_usage"))
    if isinstance(existing, dict):
        result["stream_options"] = {**existing, "include_usage": True}
    else:
        result["stream_options"] = {"include_usage": True}
    return result, caller_asked


# Delta fields that make a streamed chunk visible content for the caller.
# A chunk whose choices carry none of these and no finish reason, but
# carries ``usage``, is litellm's trailing usage chunk.
_DELTA_CONTENT_FIELDS = ("content", "tool_calls", "function_call", "reasoning_content")


def _is_usage_only_chunk(chunk: Any) -> bool:
    """litellm's trailing usage chunk. Unlike OpenAI, litellm does not
    send it with empty ``choices``: it carries one choice with an empty
    delta and no finish reason, so the test is on the delta's fields."""
    if getattr(chunk, "usage", None) is None:
        return False
    for choice in getattr(chunk, "choices", None) or []:
        if getattr(choice, "finish_reason", None):
            return False
        delta = getattr(choice, "delta", None)
        if delta is not None and any(
            getattr(delta, field, None) for field in _DELTA_CONTENT_FIELDS
        ):
            return False
    return True


def _intercept_completion(
    orig: Any,
    kwargs: dict[str, Any],
    session: Session,
    provider: LitellmProvider,
) -> Any:
    """``litellm.completion`` through the sensor: a stream guard for
    ``stream=True``, the plain call intercept otherwise."""
    if kwargs.get("stream"):
        call_kwargs, caller_asked = _inject_stream_options(kwargs)
        hide_chunk = None if caller_asked else _is_usage_only_chunk
        # Opened eagerly: litellm sends the request inside completion(),
        # so provider errors surface at the call, as without the sensor.
        return base.call_stream(
            _as_outer_call(orig),
            call_kwargs,
            session,
            provider,
            hide_chunk=hide_chunk,
        ).open()
    return base.call(_as_outer_call(orig), kwargs, session, provider)


async def _intercept_acompletion(
    orig: Any,
    kwargs: dict[str, Any],
    session: Session,
    provider: LitellmProvider,
) -> Any:
    """``litellm.acompletion`` through the sensor; ``stream=True``
    resolves to the async stream guard, matching ``await
    litellm.acompletion(..., stream=True)`` on the unpatched module."""
    if kwargs.get("stream"):
        call_kwargs, caller_asked = _inject_stream_options(kwargs)
        hide_chunk = None if caller_asked else _is_usage_only_chunk
        guard = base.call_stream_async(
            _as_outer_async_call(orig),
            call_kwargs,
            session,
            provider,
            hide_chunk=hide_chunk,
        )
        return await guard.open()
    return await base.call_async(_as_outer_async_call(orig), kwargs, session, provider)


def _intercept_embedding(
    orig: Any,
    kwargs: dict[str, Any],
    session: Session,
    provider: LitellmProvider,
) -> Any:
    """``litellm.embedding`` through the sensor as an ``embeddings`` event.
    Run under the outer mark too, so the SDK route stays single-counted
    should the OpenAI interceptor ever cover the raw-response embeddings
    path litellm uses."""
    return base.call(
        _as_outer_call(orig),
        kwargs,
        session,
        provider,
        event_type=EventType.EMBEDDINGS,
    )


async def _intercept_aembedding(
    orig: Any,
    kwargs: dict[str, Any],
    session: Session,
    provider: LitellmProvider,
) -> Any:
    """``litellm.aembedding`` through the sensor (see :func:`_intercept_embedding`)."""
    return await base.call_async(
        _as_outer_async_call(orig),
        kwargs,
        session,
        provider,
        event_type=EventType.EMBEDDINGS,
    )


# ----------------------------------------------------------------------
# Per-callsite wrapper (SensorLitellm)
# ----------------------------------------------------------------------


class SensorLitellm:
    """Per-callsite wrapper for litellm's completion surface.

    Rarely used directly. The recommended integration path is
    :func:`flightdeck_sensor.patch` which installs
    :func:`patch_litellm_functions` and intercepts every
    ``litellm.completion`` call process-wide. ``SensorLitellm`` exists
    for programmatic wrapping when a caller wants to observe a single
    call without mutating the litellm module globals -- e.g. tests,
    or an embedded script that intentionally keeps the rest of the
    process using raw litellm.

    Holds captured references to the unpatched litellm functions and
    a bound :class:`Session` / :class:`LitellmProvider`. Delegates
    through the module's shared intercept helpers so every intercept
    path (class-level patch, per-callsite wrap) emits the same event
    schema, streaming included.
    """

    def __init__(
        self,
        session: Session,
        provider: LitellmProvider | None = None,
    ) -> None:
        if not _LITELLM_AVAILABLE:
            raise ImportError(
                "litellm is not installed. Install with `pip install flightdeck-sensor[litellm]`."
            )
        self._session = session
        self._provider = provider or LitellmProvider(
            capture_prompts=session.config.capture_prompts,
        )

    def completion(self, **kwargs: Any) -> Any:
        """Intercept ``litellm.completion(**kwargs)``; ``stream=True``
        returns a :class:`base.GuardedStream` over litellm's stream."""
        return _intercept_completion(_OrigCompletion, kwargs, self._session, self._provider)

    async def acompletion(self, **kwargs: Any) -> Any:
        """Intercept ``litellm.acompletion(**kwargs)``; ``stream=True``
        resolves to a :class:`base.GuardedAsyncStream`."""
        return await _intercept_acompletion(
            _OrigAcompletion,
            kwargs,
            self._session,
            self._provider,
        )

    def embedding(self, **kwargs: Any) -> Any:
        """Intercept ``litellm.embedding(**kwargs)``.

        Embedding-model calls carry input tokens only; the ``event_type``
        promotion lets the dashboard and analytics distinguish them from
        chat completions.
        """
        if _OrigEmbedding is None:
            raise RuntimeError(
                "litellm.embedding is not available on the installed version; "
                "upgrade litellm or use a different embedding client."
            )
        return _intercept_embedding(_OrigEmbedding, kwargs, self._session, self._provider)

    async def aembedding(self, **kwargs: Any) -> Any:
        """Intercept ``litellm.aembedding(**kwargs)``."""
        if _OrigAembedding is None:
            raise RuntimeError(
                "litellm.aembedding is not available on the installed version; "
                "upgrade litellm or use a different embedding client."
            )
        return await _intercept_aembedding(
            _OrigAembedding,
            kwargs,
            self._session,
            self._provider,
        )


# ----------------------------------------------------------------------
# Class-level (module-level for litellm) patch / unpatch
# ----------------------------------------------------------------------
#
# Sentinel attributes:
#   _flightdeck_patched            -- boolean marker, idempotency gate
#   _flightdeck_orig_completion    -- captured sync function
#   _flightdeck_orig_acompletion   -- captured async function
#   _flightdeck_orig_embedding     -- captured sync embedding function
#   _flightdeck_orig_aembedding    -- captured async embedding function


def _provider_for(session: Session) -> LitellmProvider:
    return LitellmProvider(capture_prompts=session.config.capture_prompts)


def patch_litellm_functions(quiet: bool = False) -> None:
    """Swap ``litellm.completion`` / ``acompletion`` / ``embedding`` /
    ``aembedding`` with wrappers that route through the sensor.

    Idempotent: a second call is a no-op. If litellm is not installed
    this is a silent no-op.

    The wrappers fetch the active session lazily on each call. If no
    session is active, the original litellm function runs unwrapped --
    matching the Anthropic/OpenAI interceptors which also early-return
    the raw resource in that state.
    """
    if not _LITELLM_AVAILABLE:
        if not quiet:
            _log.debug("litellm not installed, skipping patch")
        return

    if getattr(_litellm_module, "_flightdeck_patched", False):
        if not quiet:
            _log.debug("litellm already patched, skipping")
        return

    orig_completion = _litellm_module.completion
    orig_acompletion = _litellm_module.acompletion
    # Also capture and patch the embedding surface when available.
    # getattr + None fallback keeps this backwards-compatible with any
    # litellm version that might lack one of the entry points.
    orig_embedding = getattr(_litellm_module, "embedding", None)
    orig_aembedding = getattr(_litellm_module, "aembedding", None)

    # Stash originals on the module so unpatch can restore them even
    # if the module was reloaded between patch and unpatch.
    _litellm_module._flightdeck_orig_completion = orig_completion
    _litellm_module._flightdeck_orig_acompletion = orig_acompletion
    _litellm_module._flightdeck_orig_embedding = orig_embedding
    _litellm_module._flightdeck_orig_aembedding = orig_aembedding

    def _patched_completion(**kwargs: Any) -> Any:
        session = _current_session()
        if session is None:
            return orig_completion(**kwargs)
        return _intercept_completion(orig_completion, kwargs, session, _provider_for(session))

    async def _patched_acompletion(**kwargs: Any) -> Any:
        session = _current_session()
        if session is None:
            return await orig_acompletion(**kwargs)
        return await _intercept_acompletion(
            orig_acompletion, kwargs, session, _provider_for(session)
        )

    def _patched_embedding(**kwargs: Any) -> Any:
        session = _current_session()
        if session is None or orig_embedding is None:
            return orig_embedding(**kwargs) if orig_embedding else None
        return _intercept_embedding(orig_embedding, kwargs, session, _provider_for(session))

    async def _patched_aembedding(**kwargs: Any) -> Any:
        session = _current_session()
        if session is None or orig_aembedding is None:
            return await orig_aembedding(**kwargs) if orig_aembedding else None
        return await _intercept_aembedding(orig_aembedding, kwargs, session, _provider_for(session))

    _litellm_module.completion = _patched_completion
    _litellm_module.acompletion = _patched_acompletion
    # ``litellm.embedding`` is declared as an ``@overload`` function in
    # litellm's type stubs; mypy rejects the plain-function assignment
    # here even though the runtime replacement is fully compatible.
    # Silence the specific mismatch rather than widen the patched
    # function's signature to Any, which would hide real type bugs in
    # the wrapper itself.
    if orig_embedding is not None:
        _litellm_module.embedding = _patched_embedding  # type: ignore[assignment]
    if orig_aembedding is not None:
        _litellm_module.aembedding = _patched_aembedding
    _litellm_module._flightdeck_patched = True

    if not quiet:
        parts = ["litellm.completion", "litellm.acompletion"]
        if orig_embedding is not None:
            parts.append("litellm.embedding")
        if orig_aembedding is not None:
            parts.append("litellm.aembedding")
        _log.info("%s patched", " and ".join(parts))


def unpatch_litellm_functions(quiet: bool = False) -> None:
    """Restore the original ``litellm.completion`` / ``acompletion`` /
    ``embedding`` / ``aembedding`` module attributes. Idempotent. Silent
    no-op when litellm is not installed or was never patched.
    """
    if not _LITELLM_AVAILABLE:
        return

    if not getattr(_litellm_module, "_flightdeck_patched", False):
        if not quiet:
            _log.debug("litellm not patched, skipping unpatch")
        return

    orig_completion = getattr(
        _litellm_module,
        "_flightdeck_orig_completion",
        None,
    )
    orig_acompletion = getattr(
        _litellm_module,
        "_flightdeck_orig_acompletion",
        None,
    )
    orig_embedding = getattr(
        _litellm_module,
        "_flightdeck_orig_embedding",
        None,
    )
    orig_aembedding = getattr(
        _litellm_module,
        "_flightdeck_orig_aembedding",
        None,
    )
    if orig_completion is not None:
        _litellm_module.completion = orig_completion
    if orig_acompletion is not None:
        _litellm_module.acompletion = orig_acompletion
    if orig_embedding is not None:
        _litellm_module.embedding = orig_embedding
    if orig_aembedding is not None:
        _litellm_module.aembedding = orig_aembedding

    for attr in (
        "_flightdeck_orig_completion",
        "_flightdeck_orig_acompletion",
        "_flightdeck_orig_embedding",
        "_flightdeck_orig_aembedding",
        "_flightdeck_patched",
    ):
        if hasattr(_litellm_module, attr):
            delattr(_litellm_module, attr)

    if not quiet:
        _log.info("litellm.completion/acompletion/embedding/aembedding unpatched")
