"""litellm proxy: intercepts ``litellm.completion()`` and ``litellm.acompletion()``.

KI21 context. litellm routes calls to many underlying providers via
two module-level entry points. Its Anthropic route uses raw
``httpx.Client.post()`` instead of constructing ``anthropic.Anthropic``,
so the sensor's SDK-class descriptors (see
``interceptor/anthropic.py``) never get a chance to see the call.
This module closes the gap by patching the two litellm functions
directly.

Patching shape diverges from the Anthropic/OpenAI interceptors
intentionally: litellm's public surface is two module-level functions,
not a class with cached-property resources. Instead of installing
descriptors, :func:`patch_litellm_functions` swaps the module
attributes in place and stashes the originals on hidden sentinel
attributes for later :func:`unpatch_litellm_functions` restoration.
The pre-call / post-call plumbing still flows through
``interceptor/base.call`` / ``call_async`` so every interceptor emits
the same event schema.

Class-level patching is the recommended integration path (call
:func:`flightdeck_sensor.patch` and every ``litellm.completion`` call
anywhere in the process is intercepted). :class:`SensorLitellm`
exists for programmatic per-callsite wrapping -- a narrow use case
where a user wants to observe one specific call without mutating the
litellm module globals.

**Coverage caveat.** The patch covers direct callers of
``litellm.completion`` / ``litellm.acompletion`` -- the vast majority
of litellm integrations. Frameworks that route through lower-level
litellm entry points (e.g. ``litellm.llms.custom_httpx.http_handler``
directly, or via an internal ``llm_request()`` helper) still bypass
this interceptor. KI21's original diagnosis listed an httpx-level
interceptor as the broader alternative; that is out of scope for the
KI21 fix here and will be filed separately if framework reports
surface it.

**Streaming is not supported in v1.** ``stream=True`` calls raise
``NotImplementedError``. See KI26 for the streaming follow-up.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from flightdeck_sensor.interceptor import base
from flightdeck_sensor.providers.litellm import LitellmProvider

if TYPE_CHECKING:
    from flightdeck_sensor.core.session import Session

_log = logging.getLogger("flightdeck_sensor.interceptor.litellm")


# Error message shared between the class-level patch and the per-instance
# SensorLitellm wrapper so the user-facing language matches regardless
# of how the call was routed into the sensor.
_STREAMING_NOT_SUPPORTED_MSG = (
    "flightdeck-sensor does not yet support litellm streaming calls. "
    "For now, use stream=False. See KI26 for streaming support."
)


# ----------------------------------------------------------------------
# Captured module reference + availability
# ----------------------------------------------------------------------

try:
    import litellm as _litellm_module
    _OrigCompletion: Any = _litellm_module.completion
    _OrigAcompletion: Any = _litellm_module.acompletion
    # Phase 4: embedding / aembedding are the two entry points for
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
    through ``base.call`` / ``call_async`` so every intercept path
    (class-level patch, per-callsite wrap) emits the same event
    schema.
    """

    def __init__(
        self,
        session: Session,
        provider: LitellmProvider | None = None,
    ) -> None:
        if not _LITELLM_AVAILABLE:
            raise ImportError(
                "litellm is not installed. "
                "Install with `pip install flightdeck-sensor[litellm]`."
            )
        self._session = session
        self._provider = provider or LitellmProvider(
            capture_prompts=session.config.capture_prompts,
        )

    def completion(self, **kwargs: Any) -> Any:
        """Intercept ``litellm.completion(**kwargs)``.

        Raises ``NotImplementedError`` on ``stream=True`` -- streaming
        support is tracked as KI26.
        """
        if kwargs.get("stream"):
            raise NotImplementedError(_STREAMING_NOT_SUPPORTED_MSG)
        return base.call(_OrigCompletion, kwargs, self._session, self._provider)

    async def acompletion(self, **kwargs: Any) -> Any:
        """Intercept ``litellm.acompletion(**kwargs)``.

        Raises ``NotImplementedError`` on ``stream=True`` -- streaming
        support is tracked as KI26.
        """
        if kwargs.get("stream"):
            raise NotImplementedError(_STREAMING_NOT_SUPPORTED_MSG)
        return await base.call_async(
            _OrigAcompletion, kwargs, self._session, self._provider,
        )

    # Phase 4: embeddings parallel to completion. Same delegation pattern;
    # event_type is EMBEDDINGS so the dashboard can render them distinctly.
    def embedding(self, **kwargs: Any) -> Any:
        """Intercept ``litellm.embedding(**kwargs)``.

        Embedding-model calls carry input tokens only; the ``event_type``
        promotion lets the dashboard and analytics distinguish them from
        chat completions.
        """
        from flightdeck_sensor.core.types import EventType
        if _OrigEmbedding is None:
            raise RuntimeError(
                "litellm.embedding is not available on the installed version; "
                "upgrade litellm or use a different embedding client."
            )
        return base.call(
            _OrigEmbedding, kwargs, self._session, self._provider,
            event_type=EventType.EMBEDDINGS,
        )

    async def aembedding(self, **kwargs: Any) -> Any:
        """Intercept ``litellm.aembedding(**kwargs)``."""
        from flightdeck_sensor.core.types import EventType
        if _OrigAembedding is None:
            raise RuntimeError(
                "litellm.aembedding is not available on the installed version; "
                "upgrade litellm or use a different embedding client."
            )
        return await base.call_async(
            _OrigAembedding, kwargs, self._session, self._provider,
            event_type=EventType.EMBEDDINGS,
        )


# ----------------------------------------------------------------------
# Class-level (module-level for litellm) patch / unpatch
# ----------------------------------------------------------------------
#
# Sentinel attributes:
#   _flightdeck_patched            -- boolean marker, idempotency gate
#   _flightdeck_orig_completion    -- captured sync function
#   _flightdeck_orig_acompletion   -- captured async function


def patch_litellm_functions(quiet: bool = False) -> None:
    """Swap ``litellm.completion`` / ``litellm.acompletion`` with
    wrappers that route through :func:`interceptor.base.call` /
    ``call_async``.

    Idempotent: a second call is a no-op. If litellm is not installed
    this is a silent no-op.

    The wrappers fetch the active session lazily on each call. If no
    session is active, the original litellm function runs unwrapped --
    matching the Anthropic/OpenAI interceptors which also early-return
    the raw resource in that state.

    ``stream=True`` raises ``NotImplementedError`` with a clear message
    pointing at KI26.
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
    # Phase 4: also capture and patch the embedding surface when
    # available. getattr + None fallback keeps this backwards-compatible
    # with any litellm version that might lack one of the entry points.
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
        if kwargs.get("stream"):
            raise NotImplementedError(_STREAMING_NOT_SUPPORTED_MSG)
        provider = LitellmProvider(
            capture_prompts=session.config.capture_prompts,
        )
        return base.call(orig_completion, kwargs, session, provider)

    async def _patched_acompletion(**kwargs: Any) -> Any:
        session = _current_session()
        if session is None:
            return await orig_acompletion(**kwargs)
        if kwargs.get("stream"):
            raise NotImplementedError(_STREAMING_NOT_SUPPORTED_MSG)
        provider = LitellmProvider(
            capture_prompts=session.config.capture_prompts,
        )
        return await base.call_async(orig_acompletion, kwargs, session, provider)

    def _patched_embedding(**kwargs: Any) -> Any:
        session = _current_session()
        if session is None or orig_embedding is None:
            return orig_embedding(**kwargs) if orig_embedding else None
        from flightdeck_sensor.core.types import EventType
        provider = LitellmProvider(
            capture_prompts=session.config.capture_prompts,
        )
        return base.call(
            orig_embedding, kwargs, session, provider,
            event_type=EventType.EMBEDDINGS,
        )

    async def _patched_aembedding(**kwargs: Any) -> Any:
        session = _current_session()
        if session is None or orig_aembedding is None:
            return await orig_aembedding(**kwargs) if orig_aembedding else None
        from flightdeck_sensor.core.types import EventType
        provider = LitellmProvider(
            capture_prompts=session.config.capture_prompts,
        )
        return await base.call_async(
            orig_aembedding, kwargs, session, provider,
            event_type=EventType.EMBEDDINGS,
        )

    _litellm_module.completion = _patched_completion
    _litellm_module.acompletion = _patched_acompletion
    if orig_embedding is not None:
        _litellm_module.embedding = _patched_embedding
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
    """Restore the original ``litellm.completion`` and
    ``litellm.acompletion`` module attributes. Idempotent. Silent
    no-op when litellm is not installed or was never patched.
    """
    if not _LITELLM_AVAILABLE:
        return

    if not getattr(_litellm_module, "_flightdeck_patched", False):
        if not quiet:
            _log.debug("litellm not patched, skipping unpatch")
        return

    orig_completion = getattr(
        _litellm_module, "_flightdeck_orig_completion", None,
    )
    orig_acompletion = getattr(
        _litellm_module, "_flightdeck_orig_acompletion", None,
    )
    orig_embedding = getattr(
        _litellm_module, "_flightdeck_orig_embedding", None,
    )
    orig_aembedding = getattr(
        _litellm_module, "_flightdeck_orig_aembedding", None,
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
