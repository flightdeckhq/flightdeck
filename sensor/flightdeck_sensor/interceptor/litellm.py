"""litellm proxy: intercepts ``litellm.completion()`` / ``acompletion()``,
``litellm.text_completion()`` / ``atext_completion()``,
``litellm.responses()`` / ``aresponses()`` (streaming included) and
``litellm.embedding()`` / ``aembedding()``.

Why this module exists. litellm routes calls to many underlying providers
via module-level entry points. Its Anthropic route uses raw
``httpx.Client.post()`` instead of constructing ``anthropic.Anthropic``,
and its native Responses API route uses its own httpx handler too, so the
sensor's SDK interceptors never get a chance to see those calls. This
module closes the gap by patching the litellm functions directly.

Patching shape diverges from the Anthropic/OpenAI interceptors
intentionally: litellm's public surface is module-level functions,
not SDK classes. Instead of patching classes,
:func:`patch_litellm_functions` swaps the module
attributes in place and stashes the originals on hidden sentinel
attributes for later :func:`unpatch_litellm_functions` restoration.
The pre-call / post-call plumbing still flows through
``interceptor/base.call`` / ``call_async`` / ``call_stream`` /
``call_stream_async`` so every interceptor emits the same event schema.
A wrapper takes the entry point's arguments as litellm does, positional
ones included.

Patching ``litellm`` in place is the recommended integration path (call
:func:`flightdeck_sensor.patch` and every litellm call anywhere in the
process is intercepted). :class:`SensorLitellm` exists for programmatic
per-callsite wrapping -- a narrow use case where a user wants to observe
one specific call without mutating the litellm module globals. Both
paths share the helpers in this module, so they cannot drift.

**Every litellm call is reported once.** Every underlying litellm call
this module makes runs under ``base.outer_intercept()`` (see
:func:`_as_outer_call`). The SDK interceptors hand a call made under
the mark through untouched (litellm's OpenAI chat route constructs
``openai.OpenAI`` and calls ``chat.completions.create`` on it), and so
do this module's own wrappers when litellm's responses/completion
bridge re-issues the call through them (:data:`_BRIDGE_MODULES`):
``responses`` on a provider without a native Responses API (Anthropic)
bridges through ``litellm.completion`` / ``acompletion``, and
``completion`` on a Responses-only model through ``litellm.responses``.
``text_completion`` calls ``completion`` through the name bound in
``litellm.main``, which is not patched. So the wrapper of the entry
point the caller used is the single reporter: one ``pre_call``, one
policy check and one ``post_call`` (or ``llm_error``) per litellm call,
carrying the shape that entry point returns (a ``TextCompletionResponse``
for ``text_completion``, the Responses API shape for ``responses`` on
every route). Any other litellm call made while one is in flight is a
call of its own and is reported.

**Streaming.** ``stream=True`` returns the sensor's stream guard
(:class:`base.GuardedStream` from the sync entry points,
:class:`base.GuardedAsyncStream` from the async ones) around litellm's
own stream (``CustomStreamWrapper``, ``TextCompletionStreamWrapper``, a
Responses streaming iterator). The guard iterates like the wrapper
(``for chunk in ...`` / ``async for chunk in ...``) and proxies its
attributes. For ``completion`` and ``text_completion`` the sensor asks
litellm for ``stream_options={"include_usage": True}``, which makes
litellm append one chunk carrying the provider's ``usage`` after the
``finish_reason`` chunk; the guard meters that chunk and hides it from a
caller who did not ask for usage, so their loop sees exactly the chunks
it would see without the sensor. A Responses stream carries its usage on
its terminal event and needs no option. litellm's stream wrappers are
not context managers and have no ``close()``, so the guard is used as a
plain iterator; the ``post_call`` is emitted when the stream is read to
its end, or when the guard is collected after a loop left early.

**Scope of the mark.** It covers the whole litellm call, so an SDK
call made from inside it -- by a litellm callback, guardrail or custom
provider, or by a task created inside the call, which inherits the
mark -- is neither policed nor metered. A litellm call made from inside
it is (only the bridge's re-issue of the same call passes through).

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
import functools
import inspect
import logging
import sys
from typing import TYPE_CHECKING, Any

from flightdeck_sensor.core.types import EventType
from flightdeck_sensor.interceptor import base
from flightdeck_sensor.providers.litellm import (
    LitellmProvider,
    LitellmResponsesProvider,
    LitellmTextCompletionProvider,
)

if TYPE_CHECKING:
    from collections.abc import Callable, Coroutine
    from types import FrameType

    from flightdeck_sensor.core.session import Session

_log = logging.getLogger("flightdeck_sensor.interceptor.litellm")


# ----------------------------------------------------------------------
# Captured module reference + availability
# ----------------------------------------------------------------------

try:
    import litellm as _litellm_module

    _OrigCompletion: Any = _litellm_module.completion
    _OrigAcompletion: Any = _litellm_module.acompletion
    # ``getattr`` with a fallback keeps the import resilient against a
    # litellm that lacks one of the other entry points.
    _OrigEmbedding: Any = getattr(_litellm_module, "embedding", None)
    _OrigAembedding: Any = getattr(_litellm_module, "aembedding", None)
    _OrigTextCompletion: Any = getattr(_litellm_module, "text_completion", None)
    _OrigAtextCompletion: Any = getattr(_litellm_module, "atext_completion", None)
    _OrigResponses: Any = getattr(_litellm_module, "responses", None)
    _OrigAresponses: Any = getattr(_litellm_module, "aresponses", None)
    _LITELLM_AVAILABLE = True
except ImportError:
    _litellm_module = None  # type: ignore[assignment]
    _OrigCompletion = None
    _OrigAcompletion = None
    _OrigEmbedding = None
    _OrigAembedding = None
    _OrigTextCompletion = None
    _OrigAtextCompletion = None
    _OrigResponses = None
    _OrigAresponses = None
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
# The in-place patch and the per-callsite SensorLitellm wrapper both
# route through these helpers: same outer-call mark, same stream
# handling, same event shape.


def _as_outer_call(fn: Callable[..., Any]) -> Callable[..., Any]:
    """``fn`` run under :func:`base.outer_intercept`, so an interceptor
    litellm reaches while serving the call (its OpenAI route calls
    ``openai.OpenAI().chat.completions.create``; its Responses bridge
    calls ``litellm.completion``) passes the call through instead of
    reporting it a second time."""

    def _call(**kwargs: Any) -> Any:
        with base.outer_intercept():
            return fn(**kwargs)

    return _call


def _as_outer_async_call(
    fn: Callable[..., Coroutine[Any, Any, Any]],
) -> Callable[..., Coroutine[Any, Any, Any]]:
    """Async form of :func:`_as_outer_call`. The mark is set inside the
    coroutine, so it lives in the task that awaits litellm -- where
    litellm's SDK call runs, or its executor hop for sync-only providers
    and for ``atext_completion`` / ``aresponses``, which copies the
    context."""

    async def _call(**kwargs: Any) -> Any:
        with base.outer_intercept():
            return await fn(**kwargs)

    return _call


def _positional_names(fn: Callable[..., Any]) -> tuple[str, ...]:
    """The names of ``fn``'s parameters that can be passed positionally,
    in order; empty when its signature cannot be read. Read once per
    entry point, when it is patched."""
    try:
        return tuple(
            p.name
            for p in inspect.signature(fn).parameters.values()
            if p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD)
        )
    except (TypeError, ValueError):
        return ()


def _named_arguments(
    names: tuple[str, ...], args: tuple[Any, ...], kwargs: dict[str, Any]
) -> dict[str, Any] | None:
    """``args`` bound to ``names`` (the entry point's positional parameter
    names) and merged into ``kwargs``, so a caller's
    ``litellm.completion("gpt-4o", messages)`` reaches the sensor with
    named arguments, the only form the intercept reads. ``None`` when the
    arguments cannot be bound (too many positional arguments, or one also
    passed by name); the caller then hands them to litellm untouched,
    which raises exactly what litellm raises without the sensor."""
    if not args:
        return kwargs
    if len(args) > len(names) or any(name in kwargs for name in names[: len(args)]):
        return None
    return {**dict(zip(names, args, strict=False)), **kwargs}


# litellm modules that re-issue the caller's own call through another of
# its patched entry points, in another API shape: ``responses`` on a
# provider without a native Responses API bridges through
# ``litellm.completion`` / ``acompletion``, and ``completion`` on a
# Responses-only model bridges through ``litellm.responses`` /
# ``aresponses``. A call such a module makes while the outer litellm call
# is in flight is that same call, which the outer wrapper reports, so it
# passes through. Every other nested litellm call (from a callback,
# guardrail or custom provider, or one litellm makes itself: an agentic
# follow-up, a semantic-cache embedding, an LLM judge) is a call of its
# own and is reported. A litellm release that moves a bridge shows as a
# double count of that bridge, which the bridge tests catch, never as a
# missed call.
_BRIDGE_MODULES = frozenset(
    {
        "litellm.responses.litellm_completion_transformation.handler",
        "litellm.completion_extras.litellm_responses_transformation.handler",
    }
)


def _is_bridge_hop(caller: FrameType | None) -> bool:
    """Whether a patched entry point was called by litellm's bridge while
    an outer litellm call is in flight (see :data:`_BRIDGE_MODULES`).
    ``caller`` is the frame that called it; for an async entry point,
    the frame that awaited it."""
    if caller is None or not base.outer_intercept_active():
        return False
    return caller.f_globals.get("__name__") in _BRIDGE_MODULES


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
    delta and no finish reason, so the test is on the delta's fields.
    A route that attached usage to an early role-only chunk (no content
    yet) would match too and lose that chunk; none of the live-verified
    routes does (Anthropic sync, OpenAI async), and the usage chunk is
    the trailing one on every route litellm's wrapper serves."""
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


def _has_usage(usage: Any) -> bool:
    """Whether a litellm ``Usage`` counts any tokens."""
    total = 0
    for name in ("prompt_tokens", "completion_tokens"):
        value = getattr(usage, name, None)
        if isinstance(value, int) and not isinstance(value, bool):
            total += value
    return total > 0


def _is_text_usage_only_chunk(chunk: Any) -> bool:
    """litellm's trailing usage chunk on a ``text_completion`` stream: a
    ``TextCompletionResponse`` whose usage counts tokens (every chunk
    carries a ``Usage``, zeros on all but this one) and whose choice
    carries no text and no finish reason."""
    if not _has_usage(getattr(chunk, "usage", None)):
        return False
    for choice in getattr(chunk, "choices", None) or []:
        if getattr(choice, "finish_reason", None) or getattr(choice, "text", None):
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
    return _intercept_sync(orig, kwargs, session, provider, _is_usage_only_chunk)


async def _intercept_acompletion(
    orig: Any,
    kwargs: dict[str, Any],
    session: Session,
    provider: LitellmProvider,
) -> Any:
    """``litellm.acompletion`` through the sensor; ``stream=True``
    resolves to the async stream guard, matching ``await
    litellm.acompletion(..., stream=True)`` on the unpatched module."""
    return await _intercept_async(orig, kwargs, session, provider, _is_usage_only_chunk)


def _intercept_text_completion(
    orig: Any,
    kwargs: dict[str, Any],
    session: Session,
    provider: LitellmProvider,
) -> Any:
    """``litellm.text_completion`` through the sensor (see
    :func:`_intercept_completion`); the usage chunk of a stream is a
    ``TextCompletionResponse``."""
    return _intercept_sync(orig, kwargs, session, provider, _is_text_usage_only_chunk)


async def _intercept_atext_completion(
    orig: Any,
    kwargs: dict[str, Any],
    session: Session,
    provider: LitellmProvider,
) -> Any:
    """``litellm.atext_completion`` through the sensor."""
    return await _intercept_async(orig, kwargs, session, provider, _is_text_usage_only_chunk)


def _intercept_responses(
    orig: Any,
    kwargs: dict[str, Any],
    session: Session,
    provider: LitellmProvider,
) -> Any:
    """``litellm.responses`` through the sensor. A Responses stream
    carries its usage on its terminal event, so nothing is added to the
    request and nothing is hidden from the caller."""
    return _intercept_sync(orig, kwargs, session, provider, None)


async def _intercept_aresponses(
    orig: Any,
    kwargs: dict[str, Any],
    session: Session,
    provider: LitellmProvider,
) -> Any:
    """``litellm.aresponses`` through the sensor."""
    return await _intercept_async(orig, kwargs, session, provider, None)


def _intercept_sync(
    orig: Any,
    kwargs: dict[str, Any],
    session: Session,
    provider: LitellmProvider,
    usage_chunk: Callable[[Any], bool] | None,
) -> Any:
    """A sync entry point through the sensor: a stream guard for
    ``stream=True`` (with the usage option added when ``usage_chunk``
    names the chunk it produces), the plain call intercept otherwise."""
    if kwargs.get("stream"):
        call_kwargs, hide_chunk = _stream_request(kwargs, usage_chunk)
        # Opened eagerly: litellm sends the request inside the call, so
        # provider errors surface at the call, as without the sensor.
        return base.call_stream(
            _as_outer_call(orig),
            call_kwargs,
            session,
            provider,
            hide_chunk=hide_chunk,
        ).open()
    return base.call(_as_outer_call(orig), kwargs, session, provider)


async def _intercept_async(
    orig: Any,
    kwargs: dict[str, Any],
    session: Session,
    provider: LitellmProvider,
    usage_chunk: Callable[[Any], bool] | None,
) -> Any:
    """Async form of :func:`_intercept_sync`."""
    if kwargs.get("stream"):
        call_kwargs, hide_chunk = _stream_request(kwargs, usage_chunk)
        guard = base.call_stream_async(
            _as_outer_async_call(orig),
            call_kwargs,
            session,
            provider,
            hide_chunk=hide_chunk,
        )
        return await guard.open()
    return await base.call_async(_as_outer_async_call(orig), kwargs, session, provider)


def _stream_request(
    kwargs: dict[str, Any], usage_chunk: Callable[[Any], bool] | None
) -> tuple[dict[str, Any], Callable[[Any], bool] | None]:
    """The kwargs a streamed call is sent with and the guard's
    ``hide_chunk``: with ``usage_chunk``, the usage option is added and
    the chunk it produces hidden unless the caller asked for it."""
    if usage_chunk is None:
        return kwargs, None
    call_kwargs, caller_asked = _inject_stream_options(kwargs)
    return call_kwargs, (None if caller_asked else usage_chunk)


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


def _require(fn: Any, name: str) -> Any:
    """The captured litellm entry point, or a clear error when the
    installed litellm has none."""
    if fn is None:
        raise RuntimeError(
            f"litellm.{name} is not available on the installed version; upgrade litellm."
        )
    return fn


class SensorLitellm:
    """Per-callsite wrapper for litellm's completion surface.

    Rarely used directly. The recommended integration path is
    :func:`flightdeck_sensor.patch` which installs
    :func:`patch_litellm_functions` and intercepts every litellm call
    process-wide. ``SensorLitellm`` exists for programmatic wrapping when
    a caller wants to observe a single call without mutating the litellm
    module globals -- e.g. tests, or an embedded script that
    intentionally keeps the rest of the process using raw litellm.

    Holds captured references to the unpatched litellm functions and a
    bound :class:`Session`. Delegates through the module's shared
    intercept helpers so every intercept path (in-place patch,
    per-callsite wrap) emits the same event schema, streaming included.
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

    def _shaped(self, provider_cls: type[LitellmProvider]) -> LitellmProvider:
        """The adapter for an entry point whose request and response
        shapes differ from ``completion``'s, with this wrapper's capture
        setting."""
        return provider_cls(capture_prompts=self._session.config.capture_prompts)

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

    def text_completion(self, **kwargs: Any) -> Any:
        """Intercept ``litellm.text_completion(**kwargs)``."""
        return _intercept_text_completion(
            _require(_OrigTextCompletion, "text_completion"),
            kwargs,
            self._session,
            self._shaped(LitellmTextCompletionProvider),
        )

    async def atext_completion(self, **kwargs: Any) -> Any:
        """Intercept ``litellm.atext_completion(**kwargs)``."""
        return await _intercept_atext_completion(
            _require(_OrigAtextCompletion, "atext_completion"),
            kwargs,
            self._session,
            self._shaped(LitellmTextCompletionProvider),
        )

    def responses(self, **kwargs: Any) -> Any:
        """Intercept ``litellm.responses(**kwargs)``."""
        return _intercept_responses(
            _require(_OrigResponses, "responses"),
            kwargs,
            self._session,
            self._shaped(LitellmResponsesProvider),
        )

    async def aresponses(self, **kwargs: Any) -> Any:
        """Intercept ``litellm.aresponses(**kwargs)``."""
        return await _intercept_aresponses(
            _require(_OrigAresponses, "aresponses"),
            kwargs,
            self._session,
            self._shaped(LitellmResponsesProvider),
        )

    # Embeddings parallel to completion. Same delegation pattern;
    # event_type is EMBEDDINGS so the dashboard can render them distinctly.
    def embedding(self, **kwargs: Any) -> Any:
        """Intercept ``litellm.embedding(**kwargs)``.

        Embedding-model calls carry input tokens only; the ``event_type``
        promotion lets the dashboard and analytics distinguish them from
        chat completions.
        """
        return _intercept_embedding(
            _require(_OrigEmbedding, "embedding"), kwargs, self._session, self._provider
        )

    async def aembedding(self, **kwargs: Any) -> Any:
        """Intercept ``litellm.aembedding(**kwargs)``."""
        return await _intercept_aembedding(
            _require(_OrigAembedding, "aembedding"),
            kwargs,
            self._session,
            self._provider,
        )


# ----------------------------------------------------------------------
# In-place (module-level) patch / unpatch
# ----------------------------------------------------------------------
#
# Each patched entry point: (module attribute, the entry point whose
# signature names its positional arguments, intercept helper, adapter,
# async). The async ``atext_completion`` and ``aembedding`` take
# ``*args, **kwargs`` and forward them to their sync counterparts, whose
# signatures name them. Sentinel attributes on the module:
#   _flightdeck_patched            -- boolean marker, idempotency gate
#   _flightdeck_orig_<attribute>   -- the captured original of each entry
#                                     point patched

_PATCHED_ENTRY_POINTS: tuple[
    tuple[str, str, Callable[..., Any], type[LitellmProvider], bool], ...
] = (
    ("completion", "completion", _intercept_completion, LitellmProvider, False),
    ("acompletion", "acompletion", _intercept_acompletion, LitellmProvider, True),
    (
        "text_completion",
        "text_completion",
        _intercept_text_completion,
        LitellmTextCompletionProvider,
        False,
    ),
    (
        "atext_completion",
        "text_completion",
        _intercept_atext_completion,
        LitellmTextCompletionProvider,
        True,
    ),
    ("responses", "responses", _intercept_responses, LitellmResponsesProvider, False),
    ("aresponses", "aresponses", _intercept_aresponses, LitellmResponsesProvider, True),
    ("embedding", "embedding", _intercept_embedding, LitellmProvider, False),
    ("aembedding", "embedding", _intercept_aembedding, LitellmProvider, True),
)


def _patched_sync(
    orig: Any,
    names: tuple[str, ...],
    intercept: Callable[..., Any],
    provider_cls: type[LitellmProvider],
) -> Callable[..., Any]:
    """The module attribute that replaces a sync entry point. The call
    passes through to litellm untouched with no active session, or when
    litellm's bridge re-issues the outer call through it (see
    :func:`_is_bridge_hop`). ``names`` are the entry point's positional
    parameter names."""

    @functools.wraps(orig)
    def _patched(*args: Any, **kwargs: Any) -> Any:
        session = _current_session()
        if session is None or _is_bridge_hop(sys._getframe(1)):
            return orig(*args, **kwargs)
        named = _named_arguments(names, args, kwargs)
        if named is None:
            return orig(*args, **kwargs)
        provider = provider_cls(capture_prompts=session.config.capture_prompts)
        return intercept(orig, named, session, provider)

    return _patched


def _patched_async(
    orig: Any,
    names: tuple[str, ...],
    intercept: Callable[..., Any],
    provider_cls: type[LitellmProvider],
) -> Callable[..., Any]:
    """Async form of :func:`_patched_sync`; the mark and the caller are
    read when the call is awaited, in the task and frame that await it."""

    @functools.wraps(orig)
    async def _patched(*args: Any, **kwargs: Any) -> Any:
        session = _current_session()
        if session is None or _is_bridge_hop(sys._getframe(1)):
            return await orig(*args, **kwargs)
        named = _named_arguments(names, args, kwargs)
        if named is None:
            return await orig(*args, **kwargs)
        provider = provider_cls(capture_prompts=session.config.capture_prompts)
        return await intercept(orig, named, session, provider)

    return _patched


def patch_litellm_functions(quiet: bool = False) -> None:
    """Swap litellm's ``completion`` / ``acompletion`` /
    ``text_completion`` / ``atext_completion`` / ``responses`` /
    ``aresponses`` / ``embedding`` / ``aembedding`` with wrappers that
    route through the sensor. An entry point the installed litellm lacks
    is skipped.

    Idempotent: a second call is a no-op. If litellm is not installed
    this is a silent no-op.

    The wrappers fetch the active session lazily on each call. If no
    session is active, the original litellm function runs unwrapped --
    matching the SDK interceptors, which also leave the call to the SDK
    in that state.
    """
    if not _LITELLM_AVAILABLE:
        if not quiet:
            _log.debug("litellm not installed, skipping patch")
        return

    if getattr(_litellm_module, "_flightdeck_patched", False):
        if not quiet:
            _log.debug("litellm already patched, skipping")
        return

    # Capture every original before replacing any, so an entry point's
    # signature source is always litellm's own function.
    originals = {
        attr: getattr(_litellm_module, attr, None) for attr, *_rest in _PATCHED_ENTRY_POINTS
    }
    patched: list[str] = []
    for attr, signature_attr, intercept, provider_cls, is_async in _PATCHED_ENTRY_POINTS:
        orig = originals[attr]
        if orig is None:
            continue
        names = _positional_names(originals.get(signature_attr) or orig)
        build = _patched_async if is_async else _patched_sync
        # Stash the original on the module so unpatch can restore it even
        # if the module was reloaded between patch and unpatch.
        setattr(_litellm_module, f"_flightdeck_orig_{attr}", orig)
        setattr(_litellm_module, attr, build(orig, names, intercept, provider_cls))
        patched.append(f"litellm.{attr}")
    _litellm_module._flightdeck_patched = True

    if not quiet:
        _log.info("%s patched", ", ".join(patched))


def unpatch_litellm_functions(quiet: bool = False) -> None:
    """Restore the original litellm entry points patched by
    :func:`patch_litellm_functions`. Idempotent. Silent no-op when
    litellm is not installed or was never patched.
    """
    if not _LITELLM_AVAILABLE:
        return

    if not getattr(_litellm_module, "_flightdeck_patched", False):
        if not quiet:
            _log.debug("litellm not patched, skipping unpatch")
        return

    for attr, *_rest in _PATCHED_ENTRY_POINTS:
        sentinel = f"_flightdeck_orig_{attr}"
        orig = getattr(_litellm_module, sentinel, None)
        if orig is not None:
            setattr(_litellm_module, attr, orig)
        if hasattr(_litellm_module, sentinel):
            delattr(_litellm_module, sentinel)
    delattr(_litellm_module, "_flightdeck_patched")

    if not quiet:
        _log.info("litellm entry points unpatched")
