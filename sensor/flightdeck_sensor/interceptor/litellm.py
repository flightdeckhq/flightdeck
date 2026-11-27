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
do this module's own wrappers when litellm re-issues the caller's own
call through them (:data:`_REISSUE_MODULES`): ``responses`` on a
provider without a native Responses API (Anthropic) bridges through
``litellm.completion`` / ``acompletion``, ``completion`` on a
Responses-only model through ``litellm.responses``, and a call with
``fallbacks`` runs each attempt through ``litellm.acompletion`` (the
global ``litellm.model_fallbacks`` reaches the same loop, but in litellm
1.83.0 and 1.104.2 a call with it set never returns, with or without the
sensor: every attempt re-reads it and opens a new loop). ``text_completion`` calls
``completion`` through the name bound in ``litellm.main``, which is not
patched. So the wrapper of the entry point the caller used is the single
reporter: one ``pre_call``, one policy check and one ``post_call`` (or
``llm_error``) per litellm call, carrying the shape that entry point
returns (a ``TextCompletionResponse`` for ``text_completion``, the
Responses API shape for ``responses`` on every route) and, for a call a
fallback answered, the model that answered. An attempt that failed
before a fallback answered is not reported on its own, nor are the
tokens of a non-streamed attempt the provider billed before it failed (a
client timeout the provider finished anyway, a ``post_call_rules``
rejection): the loop swallows the exception and moves on. A stream that
fails mid-way is not hidden, since the loop has returned its stream
object. Under a DEGRADE policy the pre-call check drops the call's
``fallbacks`` and ``context_window_fallback_dict``
(``model_alternative_params``, the same on every litellm adapter:
``text_completion``, and a ``responses`` call litellm bridges through
``completion``, hand the caller's arguments on to ``completion``), so
no attempt runs a model the policy did not choose. Any other litellm
call made while one is in flight is a call of its own and is reported.

**Known double counts.** These are reported more than once rather than
risk hiding a billed call:

* litellm's MCP gateway (a chat call whose tools name the gateway)
  re-issues the call through ``litellm.acompletion`` from the same
  function that makes the follow-up calls after its tools run, so the
  re-issue cannot be told from a billed follow-up and is reported as
  well.
* A sync call with ``fallbacks`` made while an event loop is running in
  its thread (a notebook, a sync call inside async code): litellm runs
  the attempts in a worker thread it starts without copying the context,
  so the mark does not reach them and every attempt is reported as a
  call of its own beside the outer call (a failed primary and one
  fallback: three pre_calls, two post_calls and one llm_error).
* The re-issue check reads the module of the frame that called the
  patched entry point. An instrumentation library that replaces
  ``litellm.completion`` (or another entry point) after
  ``flightdeck_sensor.patch()`` puts its own frame there, so every
  re-issued call through it is reported twice.

**Streaming.** ``stream=True`` meters litellm's own stream
(``CustomStreamWrapper``, ``TextCompletionStreamWrapper``, a Responses
streaming iterator) with the sensor's stream guard
(:class:`base.GuardedStream` from the sync entry points,
:class:`base.GuardedAsyncStream` from the async ones), and the caller
gets that stream as an instance of litellm's own class sharing its
attributes, read through the guard (:func:`_handed_over`):
``CustomStreamWrapper`` iterates both ways (``for chunk in ...`` and
``async for chunk in ...``, whichever call made it) and is no context
manager, and so is what the caller gets; either way of reading it is
metered once. A litellm ``Router``, which checks for
``CustomStreamWrapper``, wraps it for its mid-stream fallbacks and sends a
lazily-sent stream's request with ``fetch_sync_stream`` /
``fetch_stream``, does so as without the sensor; each deployment attempt
is a call of its own.

The caller reads exactly the chunks litellm shows without the sensor:
the sensor never changes the ``stream_options`` litellm decides on and
never hides or rewrites a chunk. It asks for usage only where the
request is final, on the body actually sent (``extra_body`` merged over
the arguments key by key, as the OpenAI SDK and litellm's handlers merge
it), an explicit ``include_usage: false`` included. A request litellm
sends through the OpenAI SDK is asked at the SDK (the OpenAI
interceptor's litellm request hook), which takes out what its ask causes
before litellm reads the stream and leaves the counts on the call's
mark: the call's only counts. A provider whose OpenAI-shaped request
litellm sends with its own handler is asked in the request body only
(:func:`_asked_in_the_body`); every other provider is asked nothing. Off
the SDK the counts are the usage litellm shows when the provider was
asked or reports usage itself, else those litellm keeps on its stream
(``LitellmProvider.usage_from_finished_stream``), else the pre-call
estimate; never a count litellm worked out itself. A Responses stream
carries its usage on its terminal event.

A stream whose request leaves at its first read (Gemini's routes, and
``text_completion`` on a legacy completions model;
:func:`_sends_on_first_read`) is policed at the call, so a BLOCK refuses
it there, but its ``pre_call`` and ``post_call`` are reported when the
request leaves, and one never read reports nothing; one made with no
session active finds its session at that first read
(:class:`_SessionAtFirstRead`). A stream's reads, and its
``fetch_sync_stream`` / ``fetch_stream``, run under the call's mark, so
the request a first read or a fetch sends is the call's. litellm's stream
wrappers are not context managers and have no ``close()``, so the guard
is used as a plain iterator; the ``post_call`` is emitted when the stream
is read to its end, or when the guard is collected after a loop left
early.

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
import dis
import functools
import inspect
import logging
import sys
from collections.abc import Mapping
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
    from types import CodeType, FrameType

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


def _as_outer_call(
    fn: Callable[..., Any], mark: base.OuterCall | None = None
) -> Callable[..., Any]:
    """``fn`` run under :func:`base.outer_intercept` (with ``mark``, the
    litellm call's own, when given), so an interceptor litellm reaches
    while serving the call (its OpenAI route calls
    ``openai.OpenAI().chat.completions.create``; its Responses bridge calls
    ``litellm.completion``) passes the call through instead of reporting it
    a second time."""

    def _call(**kwargs: Any) -> Any:
        with base.outer_intercept(mark):
            return fn(**kwargs)

    return _call


def _as_outer_async_call(
    fn: Callable[..., Coroutine[Any, Any, Any]], mark: base.OuterCall | None = None
) -> Callable[..., Coroutine[Any, Any, Any]]:
    """Async form of :func:`_as_outer_call`. The mark is set inside the
    coroutine, so it lives in the task that awaits litellm -- where
    litellm's SDK call runs, or its executor hop for sync-only providers
    and for ``atext_completion`` / ``aresponses``, which copies the
    context."""

    async def _call(**kwargs: Any) -> Any:
        with base.outer_intercept(mark):
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


# litellm modules that re-issue the caller's own call through one of its
# patched entry points: the responses/completion bridges (``responses`` on
# a provider without a native Responses API bridges through
# ``litellm.completion`` / ``acompletion``, ``completion`` on a
# Responses-only model through ``litellm.responses`` / ``aresponses``)
# and the fallback loop (a call with ``fallbacks`` runs every attempt --
# the caller's model first -- through ``litellm.acompletion``; the global
# ``litellm.model_fallbacks`` reaches it too, but such a call never
# returns in litellm 1.83.0 and 1.104.2). A call such a module
# makes while the outer litellm call is in flight is that same call,
# which the outer wrapper reports, so it passes through: once, with the
# response that came back (a fallback's carries the model that answered),
# and with no event for an attempt that failed before a fallback
# answered. Every other nested litellm call (from a callback, guardrail
# or custom provider, or one litellm makes itself: an agentic or MCP
# follow-up, a semantic-cache embedding, an LLM judge) is a call of its
# own and is reported. A litellm release that moves one of these shows as
# a double count, which the re-issue tests catch, never as a missed call.
_REISSUE_MODULES = frozenset(
    {
        "litellm.responses.litellm_completion_transformation.handler",
        "litellm.completion_extras.litellm_responses_transformation.handler",
        "litellm.litellm_core_utils.fallback_utils",
    }
)


def _reissued_by_litellm(caller: FrameType | None) -> bool:
    """Whether a patched entry point was called from one of litellm's
    re-issue modules (:data:`_REISSUE_MODULES`). ``caller`` is the frame
    that called it; for an async entry point, the frame that awaited it.
    Only consulted while an outer litellm call is in flight."""
    return caller is not None and caller.f_globals.get("__name__") in _REISSUE_MODULES


# The litellm providers whose request is in OpenAI's shape but which
# litellm sends with its own HTTP handler rather than the OpenAI SDK
# (measured on litellm 1.83.0 and 1.104.2; together_ai and edenai are
# such providers on 1.104, and together_ai goes through the SDK on 1.83).
# Their usage is asked for in the request body only (see
# :func:`_asked_in_the_body`). A provider litellm sends through the OpenAI
# SDK is asked at the SDK, on the request litellm built (the OpenAI
# interceptor's litellm request hook); every other provider reports its
# usage in its own events and is asked nothing.
_OPENAI_SHAPED_OWN_HANDLER = frozenset(
    {
        "azure_ai",
        "chatgpt",
        "cometapi",
        "deepseek",
        "edenai",
        "fireworks_ai",
        "github_copilot",
        "groq",
        "hosted_vllm",
        "together_ai",
        "xai",
    }
)


def _asks_for_usage(options: Any) -> bool:
    return isinstance(options, Mapping) and bool(options.get("include_usage"))


def _sent_stream_options(kwargs: dict[str, Any]) -> Any:
    """The ``stream_options`` of the body litellm's own handler sends:
    ``extra_body`` is merged over litellm's body key by key, so its
    ``stream_options``, when it has one, replaces the caller's argument
    whole."""
    extra = kwargs.get("extra_body")
    if isinstance(extra, Mapping) and "stream_options" in extra:
        return extra["stream_options"]
    return kwargs.get("stream_options")


def _asked_in_the_body(kwargs: dict[str, Any], mark: base.OuterCall) -> dict[str, Any]:
    """The call as sent for a provider :data:`_OPENAI_SHAPED_OWN_HANDLER`
    names whose body (``extra_body`` merged over the caller's arguments,
    as litellm merges it) does not ask for usage, an explicit
    ``include_usage: false`` included: ``include_usage: true`` set in the
    ``stream_options`` of its ``extra_body``, the other keys of the
    ``stream_options`` the body would carry kept. litellm puts it in the
    provider's request body and nowhere else, and litellm's own
    ``stream_options``, which decide what its stream shows the caller, are
    left as the caller passed them: litellm shows the usage chunk only to
    a caller whose ``stream_options`` asks for usage. So the body is not
    changed for a caller whose ``stream_options`` asks while its
    ``extra_body`` refuses: litellm would show that caller the usage
    chunk the ask causes. That provider is then asked nothing and sends
    no usage, which the mark records (``usage_unasked``), so the call is
    metered from the estimate. Any other call is sent as it is."""
    if _asks_for_usage(_sent_stream_options(kwargs)):
        return kwargs
    try:
        _model, provider_name, _key, _base = _litellm_module.get_llm_provider(
            model=kwargs.get("model", ""),
            custom_llm_provider=kwargs.get("custom_llm_provider"),
            api_base=kwargs.get("api_base"),
        )
    except Exception:
        return kwargs
    if provider_name not in _OPENAI_SHAPED_OWN_HANDLER:
        return kwargs
    extra = kwargs.get("extra_body")
    if _asks_for_usage(kwargs.get("stream_options")) or not (
        extra is None or isinstance(extra, Mapping)
    ):
        mark.usage_unasked = True
        return kwargs
    sent = _sent_stream_options(kwargs)
    body = dict(extra or {})
    body["stream_options"] = {**(sent if isinstance(sent, Mapping) else {}), "include_usage": True}
    return {**kwargs, "extra_body": body}


# The litellm module whose generators send a legacy completions request
# when first read (``text_completion`` on a completions model).
_SENDS_WHEN_READ_MODULE = "litellm.llms.openai.completion.handler"
# litellm's own async wrapper around a text_completion stream.
_ASYNC_TEXT_WRAPPER = ("litellm.main", "_async_streaming")


def _module_of(frame: FrameType | None) -> str | None:
    name = frame.f_globals.get("__name__") if frame is not None else None
    return name if isinstance(name, str) else None


def _async_gen_unstarted(gen: Any) -> bool:
    """Whether async generator ``gen`` has not started. Python 3.12+ says
    so (``inspect.getasyncgenstate``). Python 3.11 has no such state: an
    unstarted generator there is one not running whose frame still stands
    at its ``RETURN_GENERATOR`` instruction, where a generator's frame
    waits until it is first resumed (the instructions before it set up the
    generator's cells, so it is not always the first)."""
    if sys.version_info >= (3, 12):
        return bool(inspect.getasyncgenstate(gen) == inspect.AGEN_CREATED)
    frame = gen.ag_frame
    if frame is None or gen.ag_running:
        return False
    return bool(frame.f_lasti <= _generator_start(gen.ag_code))


def _generator_start(code: CodeType) -> int:
    """The offset of a generator code's ``RETURN_GENERATOR`` instruction
    (Python 3.11), or -1 when it has none, which reads as started (the
    stream is then reported as a request made at the call)."""
    for instruction in dis.get_instructions(code):
        if instruction.opname == "RETURN_GENERATOR":
            return instruction.offset
    return -1


def _sends_on_first_read(stream: Any) -> bool:
    """Whether litellm's stream has yet to send its request, which leaves
    at its first read: a ``CustomStreamWrapper`` that makes its call when
    first read (Gemini's routes), or a ``text_completion`` stream over
    litellm's legacy completions generator, not yet started. False for
    anything else, including a shape this does not know, which is then
    reported as a request made at the call."""
    name = type(stream).__name__
    if name == "CustomStreamWrapper":
        return (
            getattr(stream, "completion_stream", None) is None
            and getattr(stream, "make_call", None) is not None
        )
    if name == "TextCompletionStreamWrapper":
        return _source_unsent(getattr(stream, "completion_stream", None))
    return False


def _source_unsent(source: Any) -> bool:
    """See :func:`_sends_on_first_read`: what a text stream reads from."""
    if type(source).__name__ == "CustomStreamWrapper":
        return _sends_on_first_read(source)
    if inspect.isgenerator(source):
        return (
            inspect.getgeneratorstate(source) == inspect.GEN_CREATED
            and _module_of(source.gi_frame) == _SENDS_WHEN_READ_MODULE
        )
    if inspect.isasyncgen(source) and _async_gen_unstarted(source):
        module = _module_of(source.ag_frame)
        if module == _SENDS_WHEN_READ_MODULE:
            return True
        if (module, source.ag_code.co_name) == _ASYNC_TEXT_WRAPPER:
            frame = source.ag_frame
            return frame is not None and _source_unsent(frame.f_locals.get("response"))
    return False


# The methods of litellm's CustomStreamWrapper that send the request of a
# stream that has not sent it yet (one that sends at its first read): a
# litellm Router calls them on the stream it gets, before reading it, so
# that a provider error surfaces inside its retry and fallback handling.
_SENDING_METHODS = ("fetch_sync_stream", "fetch_stream")


def _handed_over(reader: base.StreamReader) -> Any:
    """litellm's stream as the caller gets it: an instance of litellm's own
    stream class sharing the stream's attributes, whose reads and request
    go through ``reader`` (:func:`base.sdk_stream_twin`). A caller that
    inspects what litellm returned sees litellm's stream: a litellm Router
    checks for ``CustomStreamWrapper`` before it wraps the stream for its
    mid-stream fallbacks and reads its ``_hidden_params``, and calls
    ``fetch_sync_stream`` / ``fetch_stream`` on a stream that sends at its
    first read. A stream class that cannot be twinned is handed over seen
    through its protocol (:func:`base.protocol_view`)."""
    twin = base.sdk_stream_twin(reader, sending=_SENDING_METHODS)
    return base.protocol_view(reader) if twin is None else twin


def _intercept_completion(
    orig: Any,
    kwargs: dict[str, Any],
    session: Session,
    provider: LitellmProvider,
) -> Any:
    """``litellm.completion`` through the sensor: a stream guard for
    ``stream=True``, the plain call intercept otherwise."""
    return _intercept_sync(orig, kwargs, session, provider, ask=True)


async def _intercept_acompletion(
    orig: Any,
    kwargs: dict[str, Any],
    session: Session,
    provider: LitellmProvider,
) -> Any:
    """``litellm.acompletion`` through the sensor; ``stream=True``
    resolves to litellm's stream read through the async stream guard,
    matching ``await litellm.acompletion(..., stream=True)`` on the
    unpatched module."""
    return await _intercept_async(orig, kwargs, session, provider, ask=True)


def _intercept_text_completion(
    orig: Any,
    kwargs: dict[str, Any],
    session: Session,
    provider: LitellmProvider,
) -> Any:
    """``litellm.text_completion`` through the sensor (see
    :func:`_intercept_completion`)."""
    return _intercept_sync(orig, kwargs, session, provider, ask=True)


async def _intercept_atext_completion(
    orig: Any,
    kwargs: dict[str, Any],
    session: Session,
    provider: LitellmProvider,
) -> Any:
    """``litellm.atext_completion`` through the sensor."""
    return await _intercept_async(orig, kwargs, session, provider, ask=True)


def _intercept_responses(
    orig: Any,
    kwargs: dict[str, Any],
    session: Session,
    provider: LitellmProvider,
) -> Any:
    """``litellm.responses`` through the sensor. A Responses stream
    carries its usage on its terminal event, so nothing is asked for."""
    return _intercept_sync(orig, kwargs, session, provider, ask=False)


async def _intercept_aresponses(
    orig: Any,
    kwargs: dict[str, Any],
    session: Session,
    provider: LitellmProvider,
) -> Any:
    """``litellm.aresponses`` through the sensor."""
    return await _intercept_async(orig, kwargs, session, provider, ask=False)


def _stream_call(
    kwargs: dict[str, Any], provider: LitellmProvider, *, ask: bool
) -> tuple[base.OuterCall, dict[str, Any]]:
    """The litellm call's own mark, which the provider reads the usage
    from that the OpenAI interceptor hands over, and the kwargs the call
    is made with."""
    mark = base.OuterCall()
    provider.outer_call = mark
    return mark, (_asked_in_the_body(kwargs, mark) if ask else kwargs)


def _intercept_sync(
    orig: Any,
    kwargs: dict[str, Any],
    session: Session,
    provider: LitellmProvider,
    *,
    ask: bool,
) -> Any:
    """A sync entry point through the sensor: a stream guard for
    ``stream=True``, the plain call intercept otherwise."""
    if kwargs.get("stream"):
        mark, call_kwargs = _stream_call(kwargs, provider, ask=ask)
        # Opened at the call: litellm raises its argument errors there and
        # sends most requests there, so provider errors surface at the
        # call, as without the sensor; a stream that sends at its first
        # read reports the call then (sent_on_first_read). Its reads run
        # under the call's mark, so the request a first read sends is the
        # call's. The caller gets litellm's stream read through the guard
        # (see _handed_over), or litellm's whole response when it answered
        # with one (see base._GuardCore.whole_response).
        guard = base.call_stream(
            _as_outer_call(orig, mark),
            call_kwargs,
            session,
            provider,
            read_within=functools.partial(base.outer_intercept, mark),
            sent_on_first_read=_sends_on_first_read,
        ).open()
        whole = guard.whole_response()
        return _handed_over(guard) if whole is None else whole
    return base.call(_as_outer_call(orig), kwargs, session, provider)


async def _intercept_async(
    orig: Any,
    kwargs: dict[str, Any],
    session: Session,
    provider: LitellmProvider,
    *,
    ask: bool,
) -> Any:
    """Async form of :func:`_intercept_sync`."""
    if kwargs.get("stream"):
        mark, call_kwargs = _stream_call(kwargs, provider, ask=ask)
        guard = base.call_stream_async(
            _as_outer_async_call(orig, mark),
            call_kwargs,
            session,
            provider,
            read_within=functools.partial(base.outer_intercept, mark),
            sent_on_first_read=_sends_on_first_read,
        )
        await guard.open()
        whole = guard.whole_response()
        return _handed_over(guard) if whole is None else whole
    return await base.call_async(_as_outer_async_call(orig), kwargs, session, provider)


class _SessionAtFirstRead:
    """The reader of a litellm stream made while no session was active
    whose request leaves at its first read (see :func:`_sends_on_first_read`):
    that read, or a call that sends the request before any read (a
    Router's ``fetch_sync_stream`` / ``fetch_stream``), is the call, so it
    finds its session then. A session reports it (one ``pre_call`` and its
    ``post_call``) and a blocking one refuses it with nothing sent; with
    none it is litellm's own. The caller gets litellm's stream read
    through it (see :func:`_handed_over`)."""

    def __init__(
        self,
        stream: Any,
        kwargs: dict[str, Any],
        provider_cls: type[LitellmProvider],
        made_async: bool,
    ) -> None:
        self._stream = stream
        self._kwargs = kwargs
        self._provider_cls = provider_cls
        self._made_async = made_async
        # Found at the first read: the guard of the session found then, or
        # None with no session (the stream is then litellm's own).
        self._found = False
        self._guard: base.GuardedStream | base.GuardedAsyncStream | None = None

    def __copy__(self) -> Any:
        """A reader of the stream's copy, which finds its session at its own
        first read; once the stream was read, the guard's copy."""
        if self._guard is not None:
            return copy.copy(self._guard)
        return type(self)(
            copy.copy(self._stream), self._kwargs, self._provider_cls, self._made_async
        )

    def _guard_args(self) -> tuple[Session, LitellmProvider, base.OuterCall] | None:
        session = _current_session()
        if session is None:
            return None
        provider = self._provider_cls(capture_prompts=session.config.capture_prompts)
        mark = base.OuterCall()
        provider.outer_call = mark
        return session, provider, mark

    def _sync_guard(self) -> base.GuardedStream | base.GuardedAsyncStream | None:
        if not self._found:
            args = self._guard_args()
            if args is not None:
                session, provider, mark = args
                self._guard = base.call_stream(
                    base._returning(self._stream),
                    self._kwargs,
                    session,
                    provider,
                    read_within=functools.partial(base.outer_intercept, mark),
                ).open()
            self._found = True
        return self._guard

    async def _async_guard(self) -> base.GuardedStream | base.GuardedAsyncStream | None:
        if not self._found:
            if not self._made_async:
                return self._sync_guard()
            args = self._guard_args()
            if args is not None:
                session, provider, mark = args
                guard = base.call_stream_async(
                    base._returning(self._stream),
                    self._kwargs,
                    session,
                    provider,
                    read_within=functools.partial(base.outer_intercept, mark),
                )
                await guard.open()
                self._guard = guard
            self._found = True
        return self._guard

    def next_chunk(self) -> Any:
        guard = self._sync_guard()
        return next(self._stream) if guard is None else guard.next_chunk()

    async def anext_chunk(self) -> Any:
        guard = await self._async_guard()
        if guard is None:
            return await self._stream.__anext__()
        return await guard.anext_chunk()

    def run_sending(self, send: Callable[[], Any]) -> Any:
        guard = self._sync_guard()
        return send() if guard is None else guard.run_sending(send)

    async def arun_sending(self, send: Callable[[], Any]) -> Any:
        guard = await self._async_guard()
        if guard is None:
            return await send()
        return await guard.arun_sending(send)


def _found_at_first_read(
    result: Any,
    names: tuple[str, ...],
    args: tuple[Any, ...],
    kwargs: dict[str, Any],
    provider_cls: type[LitellmProvider],
    *,
    made_async: bool,
) -> Any:
    """What a call made while no session was active returns: litellm's
    own result, or, for a stream whose request leaves at its first read,
    that stream read through :class:`_SessionAtFirstRead`."""
    if not kwargs.get("stream") and "stream" not in names[: len(args)]:
        return result
    try:
        lazy = _sends_on_first_read(result)
    except Exception:
        lazy = False
    named = _named_arguments(names, args, kwargs) if lazy else None
    if named is None or not named.get("stream"):
        return result
    return _handed_over(_SessionAtFirstRead(result, named, provider_cls, made_async))


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
        returns litellm's stream read through a :class:`base.GuardedStream`
        (see :func:`_handed_over`)."""
        return _intercept_completion(_OrigCompletion, kwargs, self._session, self._provider)

    async def acompletion(self, **kwargs: Any) -> Any:
        """Intercept ``litellm.acompletion(**kwargs)``; ``stream=True``
        resolves to litellm's stream read through a
        :class:`base.GuardedAsyncStream` (see :func:`_handed_over`)."""
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
#   _flightdeck_patched            -- boolean marker that the module was
#                                     patched (unpatch reads it); each
#                                     wrapper carries _WRAPPER_MARK, which
#                                     is what patching checks
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

# Marks the sensor's wrapper of a litellm entry point. Patching checks each
# entry point for it rather than trusting the module's _flightdeck_patched
# flag alone: a reload of litellm re-runs its module code in the existing
# namespace, which rebinds every entry point to litellm's own function and
# leaves the flag set, and patch() patches a reloaded SDK again.
_WRAPPER_MARK = "_flightdeck_wrapper"


def _patched_sync(
    orig: Any,
    names: tuple[str, ...],
    intercept: Callable[..., Any],
    provider_cls: type[LitellmProvider],
) -> Callable[..., Any]:
    """The module attribute that replaces a sync entry point. The call
    passes through to litellm untouched with no active session, or when
    litellm re-issues the outer call through it (see
    :func:`_reissued_by_litellm`; the calling frame is read only while an
    outer litellm call is in flight). ``names`` are the entry point's
    positional parameter names."""

    @functools.wraps(orig)
    def _patched(*args: Any, **kwargs: Any) -> Any:
        session = _current_session()
        if session is None:
            return _found_at_first_read(
                orig(*args, **kwargs), names, args, kwargs, provider_cls, made_async=False
            )
        if base.outer_intercept_active() and _reissued_by_litellm(sys._getframe(1)):
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
        if session is None:
            return _found_at_first_read(
                await orig(*args, **kwargs), names, args, kwargs, provider_cls, made_async=True
            )
        if base.outer_intercept_active() and _reissued_by_litellm(sys._getframe(1)):
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

    # Capture every original before replacing any, so an entry point's
    # signature source is always litellm's own function (a wrapper already
    # in place hands inspect.signature litellm's through __wrapped__).
    originals = {
        attr: getattr(_litellm_module, attr, None) for attr, *_rest in _PATCHED_ENTRY_POINTS
    }
    patched: list[str] = []
    for attr, signature_attr, intercept, provider_cls, is_async in _PATCHED_ENTRY_POINTS:
        orig = originals[attr]
        if orig is None or getattr(orig, _WRAPPER_MARK, False) is True:
            continue  # absent from this litellm, or already the sensor's wrapper
        names = _positional_names(originals.get(signature_attr) or orig)
        build = _patched_async if is_async else _patched_sync
        # Stash the original on the module so unpatch can restore it even
        # if the module was reloaded between patch and unpatch.
        setattr(_litellm_module, f"_flightdeck_orig_{attr}", orig)
        wrapper = build(orig, names, intercept, provider_cls)
        setattr(wrapper, _WRAPPER_MARK, True)
        setattr(_litellm_module, attr, wrapper)
        patched.append(f"litellm.{attr}")
    _litellm_module._flightdeck_patched = True

    if not patched:
        if not quiet:
            _log.debug("litellm already patched, skipping")
        return
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
