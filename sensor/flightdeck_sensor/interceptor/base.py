"""Provider-agnostic intercept functions for LLM calls.

Four module-level entry points:

* :func:`call` -- synchronous intercept
* :func:`call_async` -- asynchronous intercept
* :func:`call_stream` -- streaming intercept (returns :class:`GuardedStream`)
* :func:`call_stream_async` -- async streaming intercept (returns
  :class:`GuardedAsyncStream`)

The two stream guards meter token usage from the events that pass through
them and emit the ``post_call`` once the stream settles.
"""

from __future__ import annotations

import collections
import collections.abc
import contextlib
import contextvars
import copy
import functools
import importlib.util
import inspect
import io
import json
import logging
import sys
import time
import types
import weakref
from typing import TYPE_CHECKING, Any, NamedTuple, cast

from flightdeck_sensor.core.errors import (
    REQUEST_ID_MAX_LEN,
    TIMEOUT_EXCEPTION_NAMES,
    AbortReason,
    ErrorType,
    StreamOutcome,
    classify_exception,
    classify_stop_reason,
)
from flightdeck_sensor.core.exceptions import (
    BudgetExceededError,
    DirectiveError,
    MCPPolicyBlocked,
)
from flightdeck_sensor.core.types import (
    CallDetails,
    EventType,
    PolicyDecision,
    PolicyDecisionSummary,
    TokenUsage,
)
from flightdeck_sensor.providers._access import DROPPED_STREAM, read_once


def _safe_pct(used: int, limit: int | None) -> int:
    """Helper for the ``policy_decision.reason`` string. Avoids
    division-by-zero when limit is unset (PolicyCache returns ALLOW
    in that case so we shouldn't reach the WARN/BLOCK path with a
    None limit, but defensive-zero keeps the reason readable in
    edge cases like a directive_update racing the threshold check)."""
    if not limit or limit <= 0:
        return 0
    return (used * 100) // limit


if TYPE_CHECKING:
    from collections.abc import AsyncIterator, Callable, Iterator, Mapping
    from types import TracebackType

    from flightdeck_sensor.core.session import Session
    from flightdeck_sensor.providers.protocol import Provider, StreamAccumulator

_log = logging.getLogger("flightdeck_sensor.interceptor.base")

# Keys of the stream fields a failed stream's llm_error carries under
# payload.error, next to the classification fields.
_KEY_ABORT_REASON = "abort_reason"
_KEY_PARTIAL_CHUNKS = "partial_chunks"
_KEY_PARTIAL_TOKENS_INPUT = "partial_tokens_input"
_KEY_PARTIAL_TOKENS_OUTPUT = "partial_tokens_output"


# ------------------------------------------------------------------
# Outer-call mark: an outer interceptor and the SDK interceptors it
# reaches report one call once
# ------------------------------------------------------------------
#
# litellm serves its OpenAI route by calling the OpenAI SDK, whose
# ``chat.completions`` the sensor also intercepts. Without coordination
# that one call is reported twice: by the litellm wrapper, and again by
# the SDK interceptor the wrapper ends up calling. So the outer
# interceptor runs the underlying call inside ``outer_intercept()``, and
# an SDK interceptor that finds ``outer_intercept_active()`` true hands
# the call to the SDK untouched -- no pre_call, no policy check, no
# stream guard, no post_call -- because the outer interceptor already
# does all of that for the same call.
#
# The mark lives in a ContextVar and is a small per-call flag object:
# another thread, or a task created before the call, never sees it, so
# an SDK call they make at the same time is still reported; a task
# created inside the call inherits a copy of the context (asyncio copies
# it into new tasks) and reads the mark active while the call is in
# flight and inactive once it has ended, because the flag is cleared
# when the call ends rather than only reset in the creating context.
# (litellm's executor hop for sync-only providers copies the context,
# so the mark follows that too.) Reading the mark costs one ContextVar
# lookup and one attribute read per intercepted call.
#
# Scope, stated as a limitation: the mark covers the whole outer call,
# so an SDK call made from inside it while it is in flight -- by a
# litellm callback, guardrail or custom provider, or by a task created
# inside the call -- is neither policed nor metered. Narrowing the mark
# to the one SDK call the outer interceptor serves (a per-call client
# identity) was judged not worth the complexity for now. Pinned by
# test_sdk_call_from_a_litellm_pre_call_hook_runs_under_the_mark_and_emits_nothing
# in tests/unit/test_interceptor_litellm.py.
#
# litellm's own patched entry points read the mark too, more narrowly:
# a litellm call made while another is in flight passes through only
# when litellm re-issues the caller's own call -- its responses <->
# completion bridge, or its fallback loop -- which the outer wrapper
# already reports. Any other nested litellm call -- from a callback,
# guardrail or custom provider, or one litellm makes itself (an agentic
# follow-up, a semantic-cache embedding) -- is a call of its own and is
# policed and metered (see ``_REISSUE_MODULES`` in litellm.py).
#
# Opting in:
# * Outer side: wrap the function handed to call / call_async /
#   call_stream / call_stream_async so it runs under
#   ``with outer_intercept():`` (see ``_as_outer_call`` in litellm.py).
#   The mark covers the call only; a stream's chunks are read later,
#   outside the block, which is fine because the SDK request itself is
#   sent inside the call.
# * Inner side: at the point where the SDK wrapper would otherwise enter
#   the sensor, ``if outer_intercept_active(): return <the raw path>``.
#   openai.py does this where ``client.chat.completions`` is resolved
#   (SensorChat.completions) and in SensorEmbeddings.create; anthropic.py
#   in the patched resource methods (_intercepting_method) and, for a
#   wrap()-built client, in SensorMessages.create / stream / parse.


class _OuterCall:
    """The mark of one outer call: ``active`` is cleared when the call
    ends, so every context that copied a reference (a task created inside
    the call) reads the call as over, not only the context that set it."""

    __slots__ = ("active",)

    def __init__(self) -> None:
        self.active = True


_OUTER_INTERCEPT: contextvars.ContextVar[_OuterCall | None] = contextvars.ContextVar(
    "flightdeck_outer_intercept", default=None
)


@contextlib.contextmanager
def outer_intercept() -> Iterator[None]:
    """Mark the provider call made inside the block as already metered by
    the interceptor running it, so an SDK interceptor the call reaches
    passes it through. Nesting is safe: the outer mark stays active until
    the outermost block exits."""
    mark = _OuterCall()
    token = _OUTER_INTERCEPT.set(mark)
    try:
        yield
    finally:
        mark.active = False
        _OUTER_INTERCEPT.reset(token)


def outer_intercept_active() -> bool:
    """Whether an outer interceptor is making the current call (see
    :func:`outer_intercept`); an SDK interceptor that sees ``True`` hands
    the call to the SDK untouched."""
    mark = _OUTER_INTERCEPT.get()
    return mark is not None and mark.active


# ------------------------------------------------------------------
# The session a proxy reports to
# ------------------------------------------------------------------

# The package whose ``_session`` is the active session. Read from
# ``sys.modules`` at each lookup rather than imported: an interceptor
# module is imported through the package, so it is always there, and the
# lookup is cheaper than an ``import`` statement on the call path.
_SENSOR_MODULE = "flightdeck_sensor"


class FollowSession:
    """How a sensor proxy that outlives a session finds the session to
    report a call to: the one active at the call, so a client kept across
    ``teardown()`` and a new ``init()`` reports to the new session, and
    with none active, or once the class named by ``patched_on`` no longer
    carries the patch's sentinel attribute, the call goes to the SDK
    untouched. The proxies the OpenAI class patch hands out and the ones
    ``wrap()`` returns carry one, shared down their tree of resource
    proxies.

    The provider carries the session's capture setting, so it is built by
    ``make_provider(client, session)`` once per session. A call costs two
    method calls, a read of the sentinel attribute on the patched class,
    a ``sys.modules`` lookup, an attribute read and an identity check:
    about 0.2 microseconds on a developer machine, against 0.05 for a
    proxy with a fixed session."""

    __slots__ = ("_client", "_make_provider", "_patched_on", "_bound")

    def __init__(
        self,
        client: Any,
        make_provider: Callable[[Any, Session], Any],
        patched_on: tuple[type, str] | None = None,
    ) -> None:
        self._client = client
        self._make_provider = make_provider
        # (class, sentinel attribute) of the patch that handed the proxy
        # out; None for a proxy no patch handed out (wrap()).
        self._patched_on = patched_on
        # (session, provider) for the session the last call reported to;
        # replaced whole, so a reader never sees one without the other.
        self._bound: tuple[Session, Any] | None = None

    def resolve(self) -> tuple[Session, Any] | None:
        """``(session, provider)`` for a call made now, or ``None`` when
        the call must go to the SDK untouched."""
        patched_on = self._patched_on
        # The class attribute read goes through the type's attribute
        # cache; the patch sets and deletes the sentinel on that class.
        if patched_on is not None and getattr(patched_on[0], patched_on[1], None) is None:
            return None
        sensor = sys.modules.get(_SENSOR_MODULE)
        session: Session | None = None if sensor is None else sensor._session
        if session is None:
            return None
        bound = self._bound
        if bound is None or bound[0] is not session:
            bound = (session, self._make_provider(self._client, session))
            self._bound = bound
        return bound


class SessionProxy:
    """What every sensor proxy over an SDK object holds: the object it
    stands in for, and the session and provider its calls report to.
    Those are the ones it was built with, unless it carries ``follow``,
    as the proxies the OpenAI class patch hands out and the ones
    ``wrap()`` returns do: then each call reports to the session active
    at that call, and with none (or the class unpatched) goes to the SDK
    untouched (see :class:`FollowSession`). A following proxy still holds
    the session and provider it was built with, which it hands to the
    proxies it builds and never reports to."""

    def __init__(
        self,
        real: Any,
        session: Session,
        provider: Any,
        *,
        is_async: bool = False,
        follow: FollowSession | None = None,
    ) -> None:
        self._real = real
        self._session = session
        self._provider = provider
        self._is_async = is_async
        self._follow = follow

    def _target(self) -> tuple[Session, Any] | None:
        """The session and provider a call made now reports to, or
        ``None`` when it goes to the SDK untouched."""
        if self._follow is None:
            return self._session, self._provider
        return self._follow.resolve()

    def _call(
        self,
        send: Callable[[dict[str, Any], tuple[Session, Any] | None], Any],
        kwargs: dict[str, Any],
        sdk_call: Callable[..., Any],
    ) -> Any:
        """``send(kwargs, target)`` for the target of this call;
        ``sdk_call`` is the SDK method the call stands in for. On a
        following async proxy the target is resolved when the call is
        awaited, which is when an async SDK request goes out: a stream
        manager awaits it on entry, not when it is built, so its request
        reports to the session active on entry, and goes out untouched
        with none. The SDK checks the arguments when the call is made, as
        it does unsensored (see :func:`check_arguments`)."""
        if self._is_async and self._follow is not None:
            check_arguments(sdk_call, kwargs)

            async def _awaited() -> Any:
                return await send(kwargs, self._target())

            return _awaited()
        return send(kwargs, self._target())


# ------------------------------------------------------------------
# Parity with the SDK method a sensor callable stands in for
# ------------------------------------------------------------------
#
# A sensored client behaves like an unsensored one, so a sensor callable
# that stands in for an async SDK method looks like it to introspection
# (frameworks tell sync from async with inspect.iscoroutinefunction) and
# rejects bad arguments at the same moment: when the call is made, or for
# an SDK method that checks them only once awaited (the raw views'
# ``async def wrapped(*args, **kwargs)``), when it is awaited.


# How many ``__wrapped__`` links _unwrapped() follows: an SDK method is
# wrapped once or twice (``required_args``, a raw view's wrapper).
_MAX_WRAPPED_DEPTH = 8


def _function_of(method: Callable[..., Any]) -> Any:
    """The function behind a bound method, or the callable itself."""
    return getattr(method, "__func__", method)


def _unwrapped(method: Callable[..., Any]) -> Any:
    """The innermost function behind ``method``, along ``__wrapped__``
    (``inspect.unwrap`` without its bookkeeping: this runs on every async
    call)."""
    function = _function_of(method)
    for _ in range(_MAX_WRAPPED_DEPTH):
        inner = getattr(function, "__wrapped__", None)
        if inner is None:
            break
        function = _function_of(inner)
    return function


# The attribute ``inspect.markcoroutinefunction`` (Python 3.12+) sets on a
# plain function it marks as a coroutine function; what
# ``typing_extensions.deprecated`` does to an ``async def`` there.
_COROUTINE_MARKER_ATTRIBUTE = "_is_coroutine_marker"


def _is_coroutine_function(method: Callable[..., Any]) -> bool:
    """``inspect.iscoroutinefunction(method)``, read straight from the code
    flags for a plain function or a method of one, the SDKs' case. A plain
    function marked as a coroutine function, and any other callable, go to
    ``inspect``."""
    function = _function_of(method)
    if type(function) is types.FunctionType:
        if function.__code__.co_flags & inspect.CO_COROUTINE:
            return True
        if getattr(function, _COROUTINE_MARKER_ATTRIBUTE, None) is None:
            return False
    return inspect.iscoroutinefunction(method)


def check_arguments(sdk_call: Callable[..., Any], kwargs: dict[str, Any]) -> None:
    """Have the SDK check the arguments of an async call now, as it does
    when the call is made unsensored: its method validates them (a
    missing or unknown one raises ``TypeError``) and returns its
    coroutine without running it, and that coroutine is closed unawaited,
    which sends nothing and warns of nothing. Only for a method whose
    underlying function is a coroutine function, which returns an
    unstarted coroutine; anything else is left to the call itself."""
    if not _is_coroutine_function(_unwrapped(sdk_call)):
        return
    pending = sdk_call(**kwargs)
    if inspect.iscoroutine(pending):
        pending.close()


# The signatures check_signature() binds against, one per SDK function
# (never per bound method: a cache keyed on one would hold its resource,
# and so its client, alive, and never hit for the next client's).
_SIGNATURE_CACHE_SIZE = 64


@functools.lru_cache(maxsize=_SIGNATURE_CACHE_SIZE)
def _signature(function: Callable[..., Any]) -> inspect.Signature:
    return inspect.signature(function)


def check_signature(function: Callable[..., Any], *args: Any, **kwargs: Any) -> None:
    """Raise the ``TypeError`` calling ``function`` with these arguments
    would raise on binding them, without calling it: for an SDK method
    that hands back an object at once (``messages.stream()``'s manager),
    which the sensor calls only after its estimate and policy check, so a
    bad call raises before the sensor reads or reports anything. A bound
    method is checked as its function with its ``self`` bound first."""
    if inspect.ismethod(function):
        _signature(function.__func__).bind(function.__self__, *args, **kwargs)
        return
    _signature(function).bind(*args, **kwargs)


# The attributes of a function inspect reads to tell what kind of
# callable an object is and what its signature is; a CoroutineFunctionLike
# answers them for the SDK function it stands in for.
_FUNCTION_ATTRIBUTES = frozenset(
    {
        "__code__",
        "__name__",
        "__qualname__",
        "__defaults__",
        "__kwdefaults__",
        "__annotations__",
        _COROUTINE_MARKER_ATTRIBUTE,
    }
)


class CoroutineFunctionLike:
    """A synchronous callable that introspection takes for the SDK
    coroutine function it stands in for.

    A sensor callable standing in for an ``async def`` SDK method
    (``AsyncMessages.parse``, ``AsyncEmbeddings.create``) must reject bad
    arguments when it is called, as Python does for the SDK's, so it is a
    plain callable returning a coroutine; yet ``inspect.iscoroutinefunction``
    must answer for it as for the SDK's. ``inspect`` decides from a
    function's code object and accepts any object carrying one with a
    function's other attributes, so this one carries the SDK function's
    (``like``): its code, name, qualified name, defaults and annotations,
    and its docstring and module, so ``help()`` shows the SDK's own;
    ``__wrapped__`` is ``like``, for the signature. ``inspect.isfunction``
    is still false for it. Marking a plain function with
    ``inspect.markcoroutinefunction`` would serve too, but that is not on
    Python 3.11. As a class attribute it binds like a method."""

    __slots__ = ("_call", "_like", "__dict__")

    def __init__(self, call: Callable[..., Any], like: Callable[..., Any]) -> None:
        self._call = call
        self._like = like
        # Class attributes, so read from the instance dict rather than
        # through __getattr__.
        function = _function_of(like)
        self.__doc__ = getattr(function, "__doc__", None)
        module = getattr(function, "__module__", None)
        if isinstance(module, str):
            self.__module__ = module

    def __call__(self, *args: Any, **kwargs: Any) -> Any:
        return self._call(*args, **kwargs)

    def __get__(self, instance: Any, owner: type | None = None) -> Any:
        return self if instance is None else types.MethodType(self, instance)

    @property
    def __wrapped__(self) -> Callable[..., Any]:
        return self._like

    def __getattr__(self, name: str) -> Any:
        if name in _FUNCTION_ATTRIBUTES:
            return getattr(_function_of(self._like), name)
        raise AttributeError(name)


def _function_like(call: Callable[..., Any], like: Callable[..., Any]) -> Callable[..., Any]:
    """``call`` as a plain function carrying ``like``'s name, qualified
    name, docstring and module, with ``__wrapped__`` set to ``like`` for
    the signature."""

    def method(*args: Any, **kwargs: Any) -> Any:
        return call(*args, **kwargs)

    function = _function_of(like)
    # Copied when present: a stand-in for the SDK's method (a test double)
    # may lack some, and a missing one must never cost the call its
    # interception.
    for name in ("__name__", "__qualname__", "__doc__", "__module__"):
        value = getattr(function, name, None)
        if isinstance(value, str) or (name == "__doc__" and value is None):
            setattr(method, name, value)
    method.__wrapped__ = like  # type: ignore[attr-defined]
    return method


def like_sdk(sdk_function: Callable[..., Any], call: Callable[..., Any]) -> Any:
    """``call`` standing in for ``sdk_function``: a :class:`CoroutineFunctionLike`
    when that is a coroutine function, else ``call`` itself, which carries
    ``sdk_function``'s name, docs and signature (``functools.wraps``)."""
    if inspect.iscoroutinefunction(sdk_function):
        return CoroutineFunctionLike(call, sdk_function)
    return functools.wraps(sdk_function)(call)


class SDKMethod:
    """A :class:`SessionProxy` method that stands in for the method of the
    same name on the SDK object the proxy wraps (``_real``). The bound
    method is handed out shaped like the SDK's: a
    :class:`CoroutineFunctionLike` of it when that is a coroutine function
    (an async resource's ``async def``), else a plain function carrying
    its name and docs with the SDK's method as ``__wrapped__``, so the two
    introspect alike, signature included. One proxy class serves sync and
    async resources, whose methods differ in kind, so this is decided per
    proxy."""

    def __init__(self, function: Callable[..., Any]) -> None:
        self._function = function
        self._name = function.__name__
        self.__doc__ = function.__doc__

    def __set_name__(self, owner: type, name: str) -> None:
        self._name = name

    def __get__(self, instance: Any, owner: type | None = None) -> Any:
        if instance is None:
            return self._function
        bound = types.MethodType(self._function, instance)
        # An AttributeError raised here would send the lookup to the
        # proxy's __getattr__, the SDK's unsensored method: shaping is
        # best effort, the bound method the fallback.
        try:
            sdk_method = getattr(instance._real, self._name, None)
            if sdk_method is None:
                return bound
            if instance._is_async and _is_coroutine_function(sdk_method):
                return CoroutineFunctionLike(bound, sdk_method)
            return _function_like(bound, sdk_method)
        except Exception:
            _log.debug("SDK method %s not shaped", self._name, exc_info=True)
            return bound


def drain_deferred_settles(session: Session) -> None:
    """Run the settles that guards' finalizers queued on ``session``
    (see _GuardCore._defer_settle); called at every intercept on that
    session and when it ends. deque.append and popleft are atomic under
    the GIL, so neither the finalizer nor the drain takes a lock."""
    queue = getattr(session, "queued_stream_settles", None)
    if not isinstance(queue, collections.deque):
        return
    while True:
        try:
            settle = queue.popleft()
        except IndexError:  # empty, or another thread drained it first
            return
        try:
            settle()
        except Exception:
            _log.debug("Deferred stream settle failed", exc_info=True)


def settle_open_guards(session: Session, lock_wait: float | None = None) -> None:
    """Settle every open stream guard of ``session``; the session calls
    this as it ends, before its event queue closes, because a guard
    collected after that could no longer report. Registration and this
    snapshot share the session's lock, because a weak set cannot be
    iterated while another thread adds to it.

    ``lock_wait`` (a signal's shutdown) bounds the wait for that lock:
    code a signal interrupted may hold it, and on Python 3.13 may never
    release it, so while it stays held the guards are left unsettled."""
    guards_set = getattr(session, "open_stream_guards", None)
    lock = getattr(session, "open_stream_guards_lock", None)
    if not isinstance(guards_set, weakref.WeakSet) or lock is None:
        return
    if lock_wait is None:
        with lock:
            guards = list(guards_set)
    else:
        if not lock.acquire(timeout=lock_wait):
            return
        try:
            guards = list(guards_set)
        finally:
            lock.release()
    for guard in guards:
        try:
            if guard._session is session and guard._entered and not guard._finalized:
                guard._settle_now()
        except Exception:
            _log.debug("Settling an open stream at session end failed", exc_info=True)


# ------------------------------------------------------------------
# One-shot iterables in a call's arguments
# ------------------------------------------------------------------
#
# The SDKs accept an iterator (a generator) wherever they type an argument
# ``Iterable``: ``messages``, ``system`` blocks, ``tools``, a message's
# ``content``. The sensor reads the arguments before the SDK does (the
# estimate: Anthropic's count_tokens, litellm's token_counter, the
# tiktoken count; then content capture), and an iterator can be read only
# once. So the sensor reads each one into a list for itself, and the SDK
# is handed a _Replay of the same items in its place: an iterator the SDK
# reads, rejects, copies or re-reads exactly as it would the caller's (an
# SDK that does not accept an iterator for an argument still raises;
# litellm, which copies its arguments, still fails to copy a generator).
# The _Replay records how the SDK read it, so the stored content holds
# what the SDK's last read yielded: what it sent, when it reads an
# argument twice. Only the arguments the sensor reads are looked at; an
# iterator anywhere else is the SDK's alone and reaches it untouched.
#
# The same walk reads the other objects a caller may hand over in those
# arguments as what the SDK sends for them. A pydantic model (the SDK's
# reply passed back, as a tool-use loop does: an OpenAI
# ChatCompletionMessage, Responses output items, Anthropic content blocks;
# or the caller's own model) is read as the JSON the SDK writes for it
# (see _request_dump), for the estimate and the stored content, while the
# SDK gets the caller's own object. Nothing is stored as its string form:
# an object the sensor cannot write as what was sent leaves the event
# without its content (transport.body_limit).

# Argument types that are never an iterator and hold none: most of a
# request's values, so the common path is one type lookup each.
_PLAIN_TYPES = frozenset({str, int, float, bool, type(None), bytes})

# The module of Python's own iterator types (generators, ``list_iterator``,
# ``map``, ``zip``...).
_BUILTINS_MODULE = "builtins"

# The arguments the sensor reads before the SDK does: the estimate's
# (Anthropic's count_tokens takes messages, system and tools; the OpenAI
# and litellm counts messages, a Responses input and instructions, a text
# completion's prompt; the Gemini count a request's contents) and content
# capture's (the same, and tools). These alone are walked for iterators:
# one in extra_query, metadata, stop or a client option is never read by
# the sensor, so it goes to the SDK as it is and can never keep the policy
# check from running. google-genai's ``config`` is not among them: its
# public methods build the config object (a ``GenerateContentConfig``,
# its lists read) before the request method the sensor patches is
# called.
_READ_ARGUMENT_NAMES = frozenset(
    {"messages", "system", "tools", "input", "instructions", "prompt", "contents"}
)

# The SDKs whose request models read a one-shot iterable argument through a
# pydantic union of a list and a model: google-genai's ``contents`` is
# ``list[Content | Part | ...] | Content | ...``, which reads a generator
# or a builtin iterator (``iter(list)``, ``map``) as the list and any other
# object as a ``Content`` built from its attributes, an empty one for the
# sensor's own iterator. Such an SDK is handed a generator over the
# sensor's iterator in place of a caller's generator or builtin iterator,
# and the sensor's iterator itself in place of any other, so it reads each
# as it reads the caller's (see _as_sent).
_GENERATOR_RECEIVERS = frozenset({"google"})

# Collections the SDKs accept for an ``Iterable`` argument and list before
# they send it, but that JSON cannot write: content capture stores them as
# the lists the SDK sends (see as_received). Read again, they yield the
# same items, so the SDK still gets the caller's own object.
_LISTED_COLLECTIONS = (
    collections.abc.KeysView,
    collections.abc.ValuesView,
    collections.abc.ItemsView,
    set,
    frozenset,
    collections.deque,
    range,
)

# The class names of the SDKs' sentinels for a value left out
# (``NOT_GIVEN``, ``omit``): the SDK drops such a value from the request,
# so the stored content does too.
_OMITTED_VALUE_TYPES = frozenset({"NotGiven", "Omit"})


def _model_class() -> Any:
    """pydantic's ``BaseModel`` when pydantic is loaded (every SDK the
    sensor patches loads it), else None."""
    return getattr(sys.modules.get("pydantic"), "BaseModel", None)


@functools.cache
def _anthropic_dumps_by_alias() -> bool:
    """Whether the installed anthropic SDK writes a model into a request
    by field alias: its 2.x request preparation (``_utils._prepare``) does,
    the transform of earlier releases does not."""
    try:
        return importlib.util.find_spec("anthropic._utils._prepare") is not None
    except Exception:
        return False


# The SDK whose request models are written without their unset (None)
# fields under their own field names, by its ``convert_to_dict`` (bytes as
# URL-safe base64, as pydantic's JSON mode writes them under the models'
# ``ser_json_bytes="base64"``).
_GOOGLE_RECEIVER = "google"


def _request_dump(receiver: str) -> Callable[[Any], Any]:
    """How the SDK ``receiver`` (a provider's name) writes a pydantic model
    it finds in a request: the model's JSON dump of the fields that were
    set, without those its class marks ``__api_exclude__``, by alias for
    anthropic 2.x. That is the OpenAI and Anthropic SDKs' own rule for a
    request body (their transform, anthropic 2.x's ``openapi_model_dump``);
    litellm, whose input the sensor stores, forwards it to the OpenAI SDK.
    google-genai writes the fields that are not None, by field name (see
    :data:`_GOOGLE_RECEIVER`). pydantic's serializer warnings stay off: the
    SDK dumps the model again when it sends it."""
    if receiver == _GOOGLE_RECEIVER:

        def dump_google(model: Any) -> Any:
            return model.model_dump(mode="json", exclude_none=True, warnings=False)

        return dump_google
    by_alias = receiver == "anthropic" and _anthropic_dumps_by_alias()

    def dump(model: Any) -> Any:
        return model.model_dump(
            mode="json",
            exclude_unset=True,
            by_alias=by_alias,
            exclude=getattr(model, "__api_exclude__", None),
            warnings=False,
        )

    return dump


# How deep the sensor looks into a call's arguments for an iterator. A
# request nests a few levels (messages, a message, its content blocks, a
# tool result's content, a tool's JSON schema), so 64 leaves room for any
# real one, keeps the walk well inside the interpreter's recursion limit
# when the caller's own stack is deep, and stops it on arguments that
# hold themselves. Anything deeper is passed on unread.
_MAX_ARGUMENT_DEPTH = 64


def _is_one_shot(value: Any) -> bool:
    """Whether ``value`` is an iterator the sensor reads into a list. A
    file is one too, but whoever it is given to reads it as a file, so it
    is left as it is."""
    return isinstance(value, collections.abc.Iterator) and not isinstance(value, io.IOBase)


def _to_read(value: Any, depth: int = 0) -> bool:
    """Whether anything the SDK sends in another form is anywhere in
    ``value``, inside the lists, tuples and dicts it is made of, down to
    :data:`_MAX_ARGUMENT_DEPTH`: an iterator, a collection JSON cannot
    write (see :data:`_LISTED_COLLECTIONS`), a mapping that is not a dict,
    a pydantic model or a left-out value (see
    :data:`_OMITTED_VALUE_TYPES`). A walk that copies nothing, the whole
    cost of an ordinary call's arguments."""
    kind = type(value)
    if kind is dict:
        items: Any = value.values()
    elif kind is list or kind is tuple:
        items = value
    else:
        if kind in _PLAIN_TYPES:
            return False
        model = _model_class()
        return (
            _is_one_shot(value)
            or isinstance(value, (*_LISTED_COLLECTIONS, collections.abc.Mapping))
            or (model is not None and isinstance(value, model))
            or kind.__name__ in _OMITTED_VALUE_TYPES
        )
    if depth >= _MAX_ARGUMENT_DEPTH:
        return False
    for item in items:
        if type(item) in _PLAIN_TYPES:
            continue
        if _to_read(item, depth + 1):
            return True
    return False


def _pickling_error(iterator: Any) -> str | None:
    """The message of the ``TypeError`` copying or pickling ``iterator``
    raises (a generator's ``cannot pickle 'generator' object``), or
    ``None`` when it can be copied."""
    try:
        iterator.__reduce_ex__(4)
    except TypeError as exc:
        return str(exc)
    except Exception:
        return None
    return None


class _ReadIterator(list):  # type: ignore[type-arg]
    """The items of an iterator the sensor read from a call's arguments;
    the SDK gets a :class:`_Replay` of them in its place (see
    :func:`_as_sent`)."""

    # The exception the iterator raised after these items, if any.
    error: Exception | None = None
    # The name of the iterator's type, and the TypeError message copying
    # it raises (see _pickling_error).
    kind: str = "generator"
    pickling_error: str | None = None
    # Whether the iterator's type is a builtin one (a generator,
    # ``iter(list)``, ``map``) rather than a class of the caller's (see
    # _GENERATOR_RECEIVERS).
    builtin: bool = True
    # The _Replay last handed to the SDK in its place.
    replay: _Replay | None = None


class _Replay:
    """The iterator the SDK gets in place of one the sensor read: its
    items, then the exception it raised, if it raised one. Each pass the
    SDK makes over it (from an ``iter()``) is recorded as the range of
    items it yielded, for :func:`as_received`. Copying it copies the items
    not yet yielded, and fails with the caller's iterator's own
    ``TypeError`` when that one cannot be copied. Its type bears the name
    of the caller's iterator's type (see :func:`_replay_type`), so an SDK
    that names it in an error names it as it would the caller's."""

    __slots__ = ("_error", "_items", "_pickling_error", "_position", "passes")

    def __init__(self, items: list[Any], error: Exception | None, pickling_error: str | None):
        self._items = items
        self._error = error
        self._pickling_error = pickling_error
        self._position = 0
        self.passes: list[list[int]] = []

    def __iter__(self) -> _Replay:
        self.passes.append([self._position, self._position])
        return self

    def __next__(self) -> Any:
        if not self.passes:
            self.passes.append([self._position, self._position])
        if self._position < len(self._items):
            item = self._items[self._position]
            self._position += 1
            self.passes[-1][1] = self._position
            return item
        error = self._error
        if error is not None:
            self._error = None
            raise error
        raise StopIteration

    def __reduce_ex__(self, protocol: Any) -> Any:
        if self._pickling_error is not None:
            raise TypeError(self._pickling_error)
        remaining = self._items[self._position :]
        return (_replay_copy, (type(self).__name__, remaining, self._error))

    def __repr__(self) -> str:
        return f"<{type(self).__name__} object at {id(self):#x}>"


@functools.cache
def _replay_type(kind: str) -> type[_Replay]:
    """The :class:`_Replay` type named ``kind``."""
    return type(kind, (_Replay,), {"__slots__": ()})


def _replay_copy(kind: str, items: list[Any], error: Exception | None) -> _Replay:
    """A copy of a :class:`_Replay`, made by ``copy`` or ``pickle``."""
    return _replay_type(kind)(items, error, None)


class _Dumped(dict):  # type: ignore[type-arg]
    """A pydantic model from a call's arguments, read as the JSON the SDK
    writes for it (see :func:`_request_dump`); ``original`` is the
    caller's object, which the SDK gets (see :func:`_as_sent`)."""

    original: Any = None


def _materialised(
    value: Any,
    failure: list[Exception],
    depth: int = 0,
    dump: Callable[[Any], Any] | None = None,
) -> Any:
    """``value`` with every iterator in it read into a :class:`_ReadIterator`
    of its items and every pydantic model read as ``dump`` writes it (a
    :class:`_Dumped`; one ``dump`` fails on is left as it is), inside the
    lists, tuples and dicts it is made of, down to
    :data:`_MAX_ARGUMENT_DEPTH`. The very same object when it holds
    neither; otherwise a copy along the path to each one only, so the
    caller's own containers are never changed. An iterator that raises
    keeps the items read before it did and the exception, which is also
    put in ``failure``; nothing after it is read."""
    kind = type(value)
    if kind in _PLAIN_TYPES or failure:
        return value
    if kind is list or kind is tuple:
        if depth >= _MAX_ARGUMENT_DEPTH:
            return value
        items: list[Any] | None = None
        for index, item in enumerate(value):
            read = _materialised(item, failure, depth + 1, dump)
            if read is not item:
                if items is None:
                    items = list(value)
                items[index] = read
        if items is None:
            return value
        return items if kind is list else tuple(items)
    if kind is dict:
        if depth >= _MAX_ARGUMENT_DEPTH:
            return value
        entries: dict[Any, Any] | None = None
        for key, item in value.items():
            read = _materialised(item, failure, depth + 1, dump)
            if read is not item:
                if entries is None:
                    entries = dict(value)
                entries[key] = read
        return value if entries is None else entries
    model = _model_class()
    if dump is not None and model is not None and isinstance(value, model):
        try:
            dumped = _Dumped(dump(value))
        except Exception:
            return value
        dumped.original = value
        return dumped
    if _is_one_shot(value):
        read_items = _ReadIterator()
        read_items.kind = type(value).__name__
        read_items.builtin = type(value).__module__ == _BUILTINS_MODULE
        try:
            for item in value:
                read_items.append(_materialised(item, failure, depth + 1, dump))
                if failure:
                    break
        except Exception as exc:
            read_items.error = exc
            failure.append(exc)
        read_items.pickling_error = _pickling_error(value)
        return read_items
    return value


def _rebuilt(value: Any, convert: Callable[[Any, int], Any], depth: int) -> Any:
    """``value`` with ``convert`` applied to each item of the lists,
    tuples and dicts it is made of: the very same object when no item
    changed, else a copy along the path to each change only."""
    kind = type(value)
    if kind is list or kind is tuple:
        items: list[Any] | None = None
        for index, item in enumerate(value):
            if type(item) in _PLAIN_TYPES:
                continue
            new = convert(item, depth + 1)
            if new is not item:
                if items is None:
                    items = list(value)
                items[index] = new
        if items is None:
            return value
        return items if kind is list else tuple(items)
    if kind is dict or kind is _ReadArguments:
        entries: dict[Any, Any] | None = None
        for key, item in value.items():
            if type(item) in _PLAIN_TYPES:
                continue
            new = convert(item, depth + 1)
            if new is not item:
                if entries is None:
                    entries = dict(value)
                entries[key] = new
        return value if entries is None else entries
    return value


def _over(replay: _Replay) -> Iterator[Any]:
    """A generator over ``replay``, which still records the SDK's pass and
    raises the caller's iterator's exception after its items."""
    yield from replay


def _as_sent(value: Any, depth: int = 0, generators: bool = False) -> Any:
    """What the SDK is given for a value :func:`_materialised` produced:
    a fresh :class:`_Replay` in place of each :class:`_ReadIterator`
    (linked to it as its ``replay``), its items sent the same way, inside
    new containers along the path to it; the sensor's own lists are left
    as they are for content capture. With ``generators`` (an SDK of
    :data:`_GENERATOR_RECEIVERS`), a generator over that replay in place
    of a caller's generator or builtin iterator. The caller's own object
    in place of each :class:`_Dumped`."""
    if isinstance(value, _Dumped):
        return value.original
    if isinstance(value, _ReadIterator):
        replay = _replay_type(value.kind)(
            [_as_sent(item, depth + 1, generators) for item in value],
            value.error,
            value.pickling_error,
        )
        value.replay = replay
        return _over(replay) if generators and value.builtin else replay
    if depth >= _MAX_ARGUMENT_DEPTH:
        return value
    if generators:
        return _rebuilt(value, functools.partial(_as_sent, generators=True), depth)
    return _rebuilt(value, _as_sent, depth)


def as_received(value: Any, depth: int = 0) -> Any:
    """A call's arguments as the SDK read them, for content capture: in
    place of each iterator the sensor read, what the SDK's last pass over
    its :class:`_Replay` yielded. That is what the SDK sent when it reads
    the argument twice (the OpenAI SDK's chat ``parse()`` checks ``tools``
    before it builds the request, which then holds what is left). An
    iterator the SDK never read (it passed the replay on, or copied it)
    is the items the caller's iterator held, as a list argument is. A
    collection JSON cannot write (see :data:`_LISTED_COLLECTIONS`) is the
    list of its items in their own order, and a mapping that is not a dict
    a dict, which is what the SDK sends. A pydantic model is the JSON it
    was read as (a :class:`_Dumped`), and a left-out value is dropped from
    the dict holding it, as the SDK drops it. The very same object, and
    nothing copied, for arguments that hold none of these."""
    if isinstance(value, _Dumped):
        return dict(value)
    if isinstance(value, _ReadIterator):
        replay = value.replay
        items: list[Any] = value
        if replay is not None and replay.passes:
            start, end = replay.passes[-1]
            items = value[start:end]
        return [as_received(item, depth + 1) for item in items]
    if depth >= _MAX_ARGUMENT_DEPTH:
        return value
    if isinstance(value, _LISTED_COLLECTIONS):
        return [as_received(item, depth + 1) for item in value]
    kind = type(value)
    if (kind is dict or kind is _ReadArguments) and any(
        type(item).__name__ in _OMITTED_VALUE_TYPES for item in value.values()
    ):
        value = {
            key: item
            for key, item in value.items()
            if type(item).__name__ not in _OMITTED_VALUE_TYPES
        }
    elif kind is not dict and isinstance(value, collections.abc.Mapping):
        value = dict(value)
    return _rebuilt(value, as_received, depth)


def _snapshot(value: Any, depth: int = 0, dump: Callable[[Any], Any] | None = None) -> Any:
    """``value`` with every list, tuple and dict of the caller's in it
    copied, down to :data:`_MAX_ARGUMENT_DEPTH`. The sensor's own
    containers (:class:`_ReadIterator`, :class:`_Dumped`) are kept as they
    are, so content capture still resolves them (see :func:`as_received`).
    With ``dump``, each pydantic model (the caller's own, or one the sensor
    read, a :class:`_Dumped`) is read as ``dump`` writes it now, as the
    caller may have changed it in place since; one ``dump`` fails on is
    kept as it is. Nothing is read otherwise: an iterator stays unread,
    for the SDK."""
    kind = type(value)
    if kind in _PLAIN_TYPES or depth >= _MAX_ARGUMENT_DEPTH:
        return value
    if kind is list or kind is tuple:
        return [_snapshot(item, depth + 1, dump) for item in value]
    if kind is dict:
        return {key: _snapshot(item, depth + 1, dump) for key, item in value.items()}
    if dump is not None:
        original = value.original if kind is _Dumped else value
        model = _model_class()
        if model is not None and isinstance(original, model):
            try:
                dumped = _Dumped(dump(original))
            except Exception:
                return value
            dumped.original = original
            return dumped
    return value


def _sending(session: Session, call_kwargs: dict[str, Any]) -> dict[str, Any]:
    """``call_kwargs`` as the call is handed to the SDK, which builds the
    request from them now: with capture on, a :class:`_ReadArguments`
    carrying a copy of the arguments content capture stores (see
    :func:`_captured`), taken at this moment. The caller often changes
    those lists next (a tool-use loop appends the reply to the very list
    it sent, a stream's caller may do so before it reads the stream), and
    the event is written later, on the drain thread. The SDK gets the same
    objects either way; with capture off nothing is copied. Arguments
    copied already are kept: a raw view's stream is guarded only when the
    caller parses it, long after its request went out."""
    if not session.config.capture_prompts or getattr(call_kwargs, "captured", None) is not None:
        return call_kwargs
    sending = _ReadArguments(call_kwargs)
    sending.captured = {
        name: _snapshot(value)
        for name, value in call_kwargs.items()
        if name in _READ_ARGUMENT_NAMES
    }
    return sending


def _entry_copy(
    session: Session,
    call_kwargs: dict[str, Any],
    receiver: str,
    given: Mapping[str, tuple[Any, Any]],
) -> dict[str, Any] | None:
    """A second copy of the arguments content capture stores, taken as a
    stream manager the SDK made when the call was made is entered (see
    :func:`_keep_the_copy_sent`), of the arguments as the SDK holds them
    now: the caller's own object for one the SDK was handed as the caller
    gave it (see :attr:`Arguments.given`), else the sensor's, with each
    pydantic model read again as the SDK ``receiver`` (a provider's name)
    writes it. None with capture off, when nothing was copied at the call
    either, and when the copy fails: the stream is opening, and the copy
    taken at the call stands."""
    if getattr(call_kwargs, "captured", None) is None or not session.config.capture_prompts:
        return None
    dump = _request_dump(receiver)
    copied: dict[str, Any] = {}
    try:
        for name, value in call_kwargs.items():
            if name not in _READ_ARGUMENT_NAMES:
                continue
            handed = given.get(name)
            copied[name] = _snapshot(
                handed[1] if handed is not None and value is handed[0] else value, dump=dump
            )
    except Exception:
        _log.debug("Could not copy a stream's arguments on entry")
        return None
    return copied


def _unwritable(value: Any) -> Any:
    """What a value JSON cannot write compares as (never stored)."""
    return {"<unwritable>": type(value).__name__}


def _sent_body(stream: Any) -> dict[str, Any] | None:
    """The JSON body of the request a stream answered, as the SDK sent it
    (``stream.response.request``), or None when it cannot be read."""
    try:
        body = json.loads(stream.response.request.content)
    except Exception:
        return None
    return body if isinstance(body, dict) else None


def _holds_as_sent(
    call_kwargs: dict[str, Any], captured: dict[str, Any], names: list[str], sent: dict[str, Any]
) -> bool:
    """Whether the copy ``captured`` of a call's arguments, resolved as
    content capture resolves it, holds for each of ``names`` what the
    request ``sent`` carried."""
    merged = _ReadArguments(call_kwargs)
    merged.update(captured)
    received = as_received(merged)
    for name in names:
        if name not in sent:
            return False
        as_json = json.loads(json.dumps(received.get(name), default=_unwritable))
        if as_json != sent[name]:
            return False
    return True


def _keep_the_copy_sent(
    call_kwargs: dict[str, Any], at_entry: dict[str, Any] | None, stream: Any
) -> None:
    """For a stream manager the SDK made when the call was made, once it
    has sent its request: keep, as what content capture stores, the copy
    of the arguments taken at the moment the SDK built that request. A
    release builds it when ``stream()`` is called (anthropic 0.86) or when
    the manager is entered (anthropic 2.x), and no release number is
    read: the two copies differ only when the caller changed its
    arguments in between, and then the request the stream answered says
    which one was sent. The copy taken at the call stands when it holds
    what was sent for every argument that changed; otherwise the entry
    copy does, also when that request cannot be read. Nothing here may
    reach the caller, whose request has gone out: a failure keeps the
    entry copy."""
    at_call = getattr(call_kwargs, "captured", None)
    if at_entry is None or at_call is None or not isinstance(call_kwargs, _ReadArguments):
        return
    try:
        changed = [name for name, value in at_entry.items() if at_call.get(name) != value]
        if not changed:
            return
        sent = _sent_body(stream)
        if sent is not None and _holds_as_sent(call_kwargs, at_call, changed, sent):
            return
    except Exception:
        _log.debug("Could not tell which copy of a stream's arguments was sent")
    call_kwargs.captured = at_entry


def _captured(call_kwargs: dict[str, Any]) -> dict[str, Any]:
    """The arguments content capture stores for a call: those
    :func:`_sending` copied when the call was handed to the SDK, the rest
    as they are, resolved by :func:`as_received`."""
    captured = getattr(call_kwargs, "captured", None)
    if captured is not None:
        merged = _ReadArguments(call_kwargs)
        merged.update(captured)
        call_kwargs = merged
    if isinstance(call_kwargs, _ReadArguments):
        received: dict[str, Any] = as_received(call_kwargs)
        return received
    return call_kwargs


class _ReadArguments(dict):  # type: ignore[type-arg]
    """A call's arguments with the iterators among them read (see
    :func:`materialise_iterators`). Content capture resolves only
    arguments of this type (see :func:`as_received`), so an ordinary
    call's capture walks nothing more; the copy the policy check makes on
    a degrade keeps the type. ``captured`` is set by :func:`_sending`."""

    captured: dict[str, Any] | None = None


# No argument handed to the SDK as the caller gave it (see Arguments.given).
_NONE_GIVEN: Mapping[str, tuple[Any, Any]] = types.MappingProxyType({})


class Arguments(NamedTuple):
    """A call's arguments as the sensor reads them, and the SDK call to
    make with them (see :func:`materialise_iterators`)."""

    kwargs: dict[str, Any]
    send: Callable[..., Any]
    # False when reading an iterator among them raised (see
    # materialise_iterators); a stream intercept then calls the SDK at once.
    readable: bool
    # The arguments the sensor reads in another form while the SDK gets
    # them as the caller gave them: name -> (the sensor's value, the
    # caller's object). A stream manager made at the call reads those
    # again on entry (see _entry_copy).
    given: Mapping[str, tuple[Any, Any]] = _NONE_GIVEN


def materialise_iterators(
    kwargs: dict[str, Any], real_fn: Callable[..., Any], receiver: str = ""
) -> Arguments:
    """A call's arguments for the sensor to read and the SDK call to make
    with them. Only the arguments the sensor reads are looked at (see
    :data:`_READ_ARGUMENT_NAMES`). With nothing to read in another form
    among them (see :func:`_to_read`), the arguments are ``kwargs`` and
    ``real_fn`` themselves. Otherwise they are a copy in which each
    iterator is a list of its items and each pydantic model the JSON the
    SDK ``receiver`` (a provider's name) writes for it, and the SDK call
    hands the SDK an argument holding no iterator as the caller's own
    object, and one holding an iterator with a :class:`_Replay` of its
    items in its place, inside copies of the containers on the path to
    it, and the caller's own models (see the comment above).

    An iterator that raises while it is read stops the reading, and the
    arguments are not readable: the caller still runs the estimate (on
    the items read) and the policy check before the SDK is touched, and
    the SDK gets a replay of the items read before the failure that then
    raises the same exception. So the SDK raises it where it reads that
    argument, as without the sensor, and the call is reported as any call
    the SDK rejects (an ``llm_error`` after its ``pre_call``); an SDK that
    never reads it sends the call, which is metered as any other."""
    try:
        names = [
            name
            for name, value in kwargs.items()
            if name in _READ_ARGUMENT_NAMES
            and type(value) not in _PLAIN_TYPES
            and _to_read(value, 1)
        ]
        if not names:
            return Arguments(kwargs, real_fn, True)
        failure: list[Exception] = []
        read: dict[str, Any] = _ReadArguments(kwargs)
        dump = _request_dump(receiver)
        for name in names:
            read[name] = _materialised(kwargs[name], failure, 1, dump)
        # An argument with no iterator in it (a pydantic model, a collection
        # JSON cannot write) is read in another form for the sensor alone:
        # the SDK gets the caller's own object, containers included, so a
        # change the caller makes to it before the SDK builds its request
        # (a stream manager entered later) reaches the SDK, as without the
        # sensor. The policy check never replaces these values.
        given = {
            name: (read[name], kwargs[name])
            for name in names
            if not _holds_read_iterator(read[name])
        }
    except RecursionError:
        # The caller's own stack is too deep for the walk: the SDK gets
        # the arguments as they are. The log line needs stack too.
        with contextlib.suppress(RecursionError):
            _log.debug(
                "A call's arguments could not be walked for iterators; passed on as they are"
            )
        return Arguments(kwargs, real_fn, True)

    generators = receiver in _GENERATOR_RECEIVERS

    def send(**call_kwargs: Any) -> Any:
        handed_over: dict[str, Any] = {}
        for name, value in call_kwargs.items():
            handed = given.get(name)
            if handed is not None and value is handed[0]:
                handed_over[name] = handed[1]
            elif type(value) in _PLAIN_TYPES:
                handed_over[name] = value
            else:
                handed_over[name] = _as_sent(value, 1, generators)
        return real_fn(**handed_over)

    return Arguments(read, send, not failure, given)


def _holds_read_iterator(value: Any, depth: int = 1) -> bool:
    """Whether a value :func:`_materialised` produced holds an iterator the
    sensor read (a :class:`_ReadIterator`), inside the lists, tuples and
    dicts it is made of."""
    if isinstance(value, _ReadIterator):
        return True
    kind = type(value)
    if depth >= _MAX_ARGUMENT_DEPTH:
        return False
    if kind is list or kind is tuple:
        items: Any = value
    elif kind is dict:
        items = value.values()
    else:
        return False
    return any(
        _holds_read_iterator(item, depth + 1) for item in items if type(item) not in _PLAIN_TYPES
    )


def _returning(result: Any) -> Callable[..., Any]:
    """An SDK call already made, for a stream guard to open: it returns
    ``result`` whatever it is given."""

    def made(**_kwargs: Any) -> Any:
        return result

    return made


def _sent_at_once(
    session: Session, provider: Provider, real_fn: Any, call_kwargs: dict[str, Any]
) -> Callable[..., Any]:
    """A stream call made now, as the caller made it, for the guard to
    enter what it returns: a stream manager's (``messages.stream()``),
    and a call whose arguments are unreadable. A release whose
    ``stream()`` reads its arguments when called builds its request here
    and raises a failing iterator's exception here (reported as a failed
    call); one that reads them on entry does both when the guard enters
    what this returns."""
    t0 = time.monotonic()
    try:
        result = real_fn(**call_kwargs)
    except (BudgetExceededError, DirectiveError):
        raise
    except BaseException as exc:
        _emit_error(session, provider, exc, int((time.monotonic() - t0) * 1000), call_kwargs)
        raise
    return _returning(result)


# ------------------------------------------------------------------
# Sync intercept
# ------------------------------------------------------------------


def call(
    real_fn: Any,
    kwargs: dict[str, Any],
    session: Session,
    provider: Provider,
    *,
    event_type: EventType = EventType.POST_CALL,
) -> Any:
    """Synchronous call intercept.

    1. Estimate tokens, check policy (BLOCK/DEGRADE/WARN).
    2. Execute the real provider call.
    3. Extract actual usage, reconcile, post event (``event_type`` — default
       POST_CALL; callers pass EMBEDDINGS for embedding-model calls).
    4. On provider exception, emit a structured LLM_ERROR event via the
       error taxonomy and re-raise.

    An iterator among the arguments is read into a list for the sensor,
    and the SDK gets an iterator of the sensor's over the same items; one
    that raises midway raises from the SDK where it reads it (see
    :func:`materialise_iterators`).
    """
    arguments = materialise_iterators(kwargs, real_fn, provider.name)
    kwargs, real_fn = arguments.kwargs, arguments.send
    estimated, estimated_via = provider.estimate_tokens(kwargs)
    call_kwargs = _sending(session, _pre_call(session, provider, kwargs, estimated, estimated_via))

    t0 = time.monotonic()
    try:
        response = real_fn(**call_kwargs)
    except (BudgetExceededError, DirectiveError):
        # Sensor-emitted control-flow exceptions are not LLM API errors.
        # They never escape from the real_fn call anyway, but the explicit
        # re-raise keeps the except ordering stable against future edits.
        raise
    except BaseException as exc:
        latency_ms = int((time.monotonic() - t0) * 1000)
        _emit_error(session, provider, exc, latency_ms, call_kwargs)
        raise
    latency_ms = int((time.monotonic() - t0) * 1000)

    _post_call(
        session,
        provider,
        response,
        estimated,
        latency_ms,
        call_kwargs,
        event_type=event_type,
        estimated_via=estimated_via,
    )
    return response


# ------------------------------------------------------------------
# Async intercept
# ------------------------------------------------------------------


async def call_async(
    real_fn: Any,
    kwargs: dict[str, Any],
    session: Session,
    provider: Provider,
    *,
    event_type: EventType = EventType.POST_CALL,
) -> Any:
    """Asynchronous call intercept -- same logic as :func:`call`, awaited."""
    arguments = materialise_iterators(kwargs, real_fn, provider.name)
    kwargs, real_fn = arguments.kwargs, arguments.send
    estimated, estimated_via = provider.estimate_tokens(kwargs)
    call_kwargs = _pre_call(session, provider, kwargs, estimated, estimated_via)

    call_kwargs = _sending(session, call_kwargs)
    t0 = time.monotonic()
    try:
        response = await real_fn(**call_kwargs)
    except (BudgetExceededError, DirectiveError):
        raise
    except BaseException as exc:
        latency_ms = int((time.monotonic() - t0) * 1000)
        _emit_error(session, provider, exc, latency_ms, call_kwargs)
        raise
    latency_ms = int((time.monotonic() - t0) * 1000)

    _post_call(
        session,
        provider,
        response,
        estimated,
        latency_ms,
        call_kwargs,
        event_type=event_type,
        estimated_via=estimated_via,
    )
    return response


# ------------------------------------------------------------------
# Streaming intercept
# ------------------------------------------------------------------


def call_stream(
    real_fn: Any,
    kwargs: dict[str, Any],
    session: Session,
    provider: Provider,
    *,
    hide_chunk: Callable[[Any], bool] | None = None,
    call_now: bool = False,
) -> GuardedStream:
    """Streaming call intercept.

    Pre-call policy check runs *before* the guard is returned. Token
    reconciliation runs once the stream is exhausted, closed, or its
    ``with`` block exits (including early exit).

    An iterator among the arguments is read into a list first (see
    :func:`materialise_iterators`). ``call_now`` (a stream manager, such
    as Anthropic's ``messages.stream()``) has the SDK called at once,
    after the policy check, as the caller calls it, and the guard enters
    the manager it returns; so is a call with an iterator that raised
    midway (see :func:`_sent_at_once`).
    """
    arguments = materialise_iterators(kwargs, real_fn, provider.name)
    kwargs, real_fn = arguments.kwargs, arguments.send
    estimated, estimated_via = provider.estimate_tokens(kwargs)
    call_kwargs = _pre_call(session, provider, kwargs, estimated, estimated_via)
    if call_now or not arguments.readable:
        call_kwargs = _sending(session, call_kwargs)
        real_fn = _sent_at_once(session, provider, real_fn, call_kwargs)
    return GuardedStream(
        real_fn,
        call_kwargs,
        session,
        provider,
        estimated,
        estimated_via,
        hide_chunk=hide_chunk,
        made_at_call=call_now,
        given=arguments.given,
    )


def call_stream_async(
    real_fn: Any,
    kwargs: dict[str, Any],
    session: Session,
    provider: Provider,
    *,
    hide_chunk: Callable[[Any], bool] | None = None,
    call_now: bool = False,
) -> GuardedAsyncStream:
    """Async streaming call intercept.

    Semantically identical to :func:`call_stream` with awaitable
    context-manager + async-iterator protocols. Pre-call policy check
    still runs synchronously before the context is returned so BLOCK is
    honoured before the first network byte. An iterator among the
    arguments, and ``call_now``, are handled as in :func:`call_stream`.
    """
    arguments = materialise_iterators(kwargs, real_fn, provider.name)
    kwargs, real_fn = arguments.kwargs, arguments.send
    estimated, estimated_via = provider.estimate_tokens(kwargs)
    call_kwargs = _pre_call(session, provider, kwargs, estimated, estimated_via)
    if call_now or not arguments.readable:
        call_kwargs = _sending(session, call_kwargs)
        real_fn = _sent_at_once(session, provider, real_fn, call_kwargs)
    return GuardedAsyncStream(
        real_fn,
        call_kwargs,
        session,
        provider,
        estimated,
        estimated_via,
        hide_chunk=hide_chunk,
        made_at_call=call_now,
        given=arguments.given,
    )


def _merge_usage(current: TokenUsage | None, new: TokenUsage) -> TokenUsage:
    """Fold a usage snapshot read from a chunk into the running total.

    The counters are cumulative, so the larger value wins field by field:
    a later ``message_delta`` output count supersedes the first one, while
    a delta that carries a smaller or no input count leaves the input read
    from ``message_start`` untouched.
    """
    if current is None:
        return new
    return TokenUsage(
        input_tokens=max(new.input_tokens, current.input_tokens),
        output_tokens=max(new.output_tokens, current.output_tokens),
        cache_read_tokens=max(new.cache_read_tokens, current.cache_read_tokens),
        cache_creation_tokens=max(new.cache_creation_tokens, current.cache_creation_tokens),
        reasoning_tokens=_max_reported(new.reasoning_tokens, current.reasoning_tokens),
        cache_creation_1h_tokens=_max_reported(
            new.cache_creation_1h_tokens, current.cache_creation_1h_tokens
        ),
    )


def _max_reported(a: int | None, b: int | None) -> int | None:
    """The larger of two optional cumulative counters; ``None`` only when
    neither was reported."""
    if a is None:
        return b
    if b is None:
        return a
    return max(a, b)


# Billing modes the sensor stamps (ARCHITECTURE.md, Cost estimation): a
# call to a model server on this machine is local, every other call is
# paid per token unless init(billing_mode=) / FLIGHTDECK_BILLING_MODE
# says otherwise.
BILLING_METERED = "metered"
BILLING_LOCAL = "local"


def _call_billing_mode(session: Session, provider: Provider) -> str:
    """The billing mode of one call through ``provider``: the configured
    mode, else local for a model server on this machine, else metered.
    Stamped on a call's post_call and on a failed stream's llm_error, whose
    partial tokens the provider bills the same way."""
    return session.config.billing_mode or (BILLING_LOCAL if provider.local else BILLING_METERED)


# The ingestion API's cap on the free-form strings of the token and cost
# fields (model ids, tier, speed, residency, stop reason), in UTF-8 bytes;
# a longer value would get the whole event rejected, so it is cut to fit
# instead.
_MAX_DETAIL_BYTES = 256

# Stream hooks that fold the response's own content (the SDK
# accumulators build exception messages from raw tool-call arguments), so
# a failure is logged by class name only, never with its message or
# traceback, whatever the capture setting.
_CONTENT_HOOKS = frozenset({"stream_accumulator"})

# The cut applied to a tool_call's ``server_name``, in characters: the
# same bound the Claude Code plugin applies to ``tool_name`` and
# ``server_name``, so an MCP server label has one limit wherever it is
# reported from.
_MAX_SERVER_NAME_CHARS = 256

# Set on an exception once an intercept has reported it, so a stream's
# with-exit does not report the same failure of a nested call again.
_REPORTED_ATTR = "_flightdeck_reported"


def _mark_reported(exc: BaseException) -> None:
    with contextlib.suppress(Exception):
        setattr(exc, _REPORTED_ATTR, True)


def _is_provider_failure(exc_val: BaseException | None) -> bool:
    """Whether an exception leaving a ``with`` block is the stream failing.

    SDK errors raised while reading through the guard are reported in
    ``__next__`` / ``__anext__``; an exception reaching ``__exit__`` came
    from the caller's own body or from a helper method that read the
    stream itself. It is a provider failure only when no intercept has
    reported it already and either the error classifier knows its class
    or it comes from a transport or SDK module (or is a ConnectionError),
    whoever raised it. Cancellations and interrupts are not ``Exception``
    subclasses, the sensor's own policy exceptions come from another
    intercepted call inside the block, and the caller's own bugs are the
    caller leaving.
    """
    if exc_val is None or not isinstance(exc_val, Exception):
        return False
    if getattr(exc_val, _REPORTED_ATTR, False):
        return False
    if isinstance(exc_val, (BudgetExceededError, DirectiveError, MCPPolicyBlocked)):
        return False
    if classify_exception(exc_val, provider_hint=None).error_type is not ErrorType.OTHER:
        return True
    # The SDKs wrap only the request: a response body that dies raises the
    # transport's own classes (httpx.ReadTimeout, RemoteProtocolError, a
    # reset) through helper methods such as get_final_message().
    module = type(exc_val).__module__.partition(".")[0]
    return module in _TRANSPORT_MODULES or isinstance(exc_val, ConnectionError)


# Modules whose exceptions mean the stream or its transport failed.
# httpx2 / httpcore2 are the transport of the anthropic 2.x and openai
# 3.x SDKs; h2 raises for HTTP/2 connections on either transport.
_TRANSPORT_MODULES = frozenset(
    {"httpx", "httpcore", "httpx2", "httpcore2", "anyio", "h11", "h2", "anthropic", "openai"}
)


def _abort_reason_for(exc: BaseException, saw_chunk: bool) -> str:
    """``abort_reason`` of a failed stream: where it failed, or ``timeout``
    whatever the position when the exception is a timeout."""
    if type(exc).__name__ in TIMEOUT_EXCEPTION_NAMES:
        return AbortReason.TIMEOUT.value
    if saw_chunk:
        return AbortReason.ERROR_MID_STREAM.value
    return AbortReason.ERROR_BEFORE_STREAM.value


def _text_of(guard: Any, event: Any) -> str | None:
    """The provider's text for one event; a failing hook degrades the
    text stream to empty rather than breaking the caller's loop."""
    try:
        text = guard._provider.text_from_stream_chunk(event)
    except Exception:
        guard._hook_failed("text_from_stream_chunk")
        return None
    return text if isinstance(text, str) else None


def _text_deltas(guard: Any) -> Iterator[str]:
    """Text deltas read through the guard; the provider knows the event
    shape, the guard only meters."""
    for event in guard:
        text = _text_of(guard, event)
        if text is not None:
            yield text


async def _async_text_deltas(guard: Any) -> AsyncIterator[str]:
    async for event in guard:
        text = _text_of(guard, event)
        if text is not None:
            yield text


class _GuardCore:
    """State and provider-facing helpers shared by :class:`GuardedStream`
    and :class:`GuardedAsyncStream`. Everything here is synchronous; the
    subclasses add the sync or async lifecycle and iteration protocol."""

    # Inter-chunk gaps are kept for the p50 / p95 / max stats. 1000
    # entries is plenty for those percentiles on any realistic stream
    # and bounds memory on a very long one (the first 1000 gaps are kept).
    _MAX_GAPS_TRACKED = 1000

    def __init__(
        self,
        real_fn: Any,
        kwargs: dict[str, Any],
        session: Session,
        provider: Provider,
        estimated: int,
        estimated_via: str = "none",
        hide_chunk: Callable[[Any], bool] | None = None,
        made_at_call: bool = False,
        given: Mapping[str, tuple[Any, Any]] = _NONE_GIVEN,
    ) -> None:
        self._real_fn = real_fn
        self._kwargs = kwargs
        # A stream manager the SDK made when the call was made: the request
        # is built then or on entry, depending on the release (see
        # _keep_the_copy_sent), from the arguments the SDK holds, ``given``
        # among them (see Arguments.given).
        self._made_at_call = made_at_call
        self._given = given
        self._session = session
        self._provider = provider
        self._estimated = estimated
        self._estimated_via = estimated_via
        # Chunks the guard absorbs instead of handing to the caller (the
        # usage chunk the sensor asked OpenAI for); None hides nothing.
        self._hide_chunk = hide_chunk
        self._stream: Any = None
        self._ctx: Any = None
        self._t0: float = 0.0
        self._opened_t: float | None = None
        self._first_chunk_t: float | None = None
        self._last_chunk_t: float | None = None
        self._chunk_count: int = 0
        self._inter_chunk_ms: list[float] = []
        self._stream_iter: Any = None
        self._usage: TokenUsage | None = None
        self._entered = False
        self._exhausted = False
        self._finalized = False
        self._saw_terminal_chunk = False
        # The stop reason a streamed event announced (a raw
        # stream has no final message to read it from at settle time).
        self._stop_reason: str | None = None
        # Call details the streamed events reported (served model, tier,
        # server-tool counters), folded event by event.
        self._details: CallDetails | None = None
        self._hooks_failed: set[str] = set()
        self._open_error: BaseException | None = None
        # Assembles a raw event stream into the message a non-streamed
        # call returns (see Provider.stream_accumulator); None for a
        # helper stream, which assembles its own.
        self._accumulator: StreamAccumulator | None = None
        drain_deferred_settles(session)

    def _hook_failed(self, hook: str) -> None:
        """A provider stream hook raised. The guard carries on without it
        (metering falls back to what the other hooks and the estimate
        give) and says so once per hook and stream rather than per chunk."""
        if hook not in self._hooks_failed:
            self._hooks_failed.add(hook)
            if hook in _CONTENT_HOOKS:
                # Class name only: the exception text can echo content.
                _log.debug(
                    "Provider %s hook raised (%s); stream metering degraded",
                    hook,
                    type(sys.exc_info()[1]).__name__,
                )
                return
            _log.debug("Provider %s hook raised; stream metering degraded", hook, exc_info=True)

    def use_accumulator(self, accumulator: StreamAccumulator | None) -> None:
        """Replace the accumulator the provider gave the guard; an OpenAI
        ``.stream()`` helper hands over its own assembly this way."""
        self._accumulator = accumulator

    def _attach_accumulator(self) -> None:
        """Ask the provider for an accumulator once the SDK stream is
        open; without one the guard meters as before and stores no
        assembled response."""
        try:
            self._accumulator = self._provider.stream_accumulator(self._stream, self._kwargs)
        except Exception:
            self._hook_failed("stream_accumulator")
            self._accumulator = None

    def _accumulate(self, chunk: Any) -> None:
        """Fold one chunk into the assembled message. A failure drops the
        accumulator for the rest of the stream: a message missing a chunk
        would be stored as if it were the response."""
        if self._accumulator is None:
            return
        try:
            self._accumulator.add(chunk)
        except Exception:
            self._hook_failed("stream_accumulator")
            self._accumulator = None

    def _assembled(self) -> Any | None:
        if self._accumulator is None:
            return None
        try:
            return self._accumulator.message()
        except Exception:
            self._hook_failed("stream_accumulator")
            return None

    def _register_open(self) -> None:
        guards = getattr(self._session, "open_stream_guards", None)
        lock = getattr(self._session, "open_stream_guards_lock", None)
        if isinstance(guards, weakref.WeakSet) and lock is not None:
            with lock:
                guards.add(self)

    def _require_stream(self) -> Any:
        """The SDK stream once the call succeeded; a guard whose call
        raised stays unusable and says why instead of failing on None."""
        if self._stream is None:
            raise RuntimeError("the stream never opened") from self._open_error
        return self._stream

    def _settle_now(self) -> None:
        """Settle synchronously with what the guard holds; the sync guard
        finalizes, the async guard settles on the snapshot usage."""
        raise NotImplementedError

    def _plain_final_message(self) -> Any | None:
        """The provider's final message when it is a plain object; an
        awaitable (an async helper's coroutine) is closed and dropped,
        because the callers of this helper have no event loop."""
        try:
            message = self._provider.final_message(self._stream)
        except Exception:
            self._hook_failed("final_message")
            return None
        if inspect.isawaitable(message):
            with contextlib.suppress(Exception):
                message.close()  # type: ignore[attr-defined]
            return None
        return message

    def _hidden(self, chunk: Any) -> bool:
        if self._hide_chunk is None:
            return False
        try:
            return bool(self._hide_chunk(chunk))
        except Exception:
            self._hook_failed("hide_chunk")
            return False

    def _defer_settle(self) -> None:
        """Queue the settle for the next intercept or the session's end.

        A finalizer never settles inline: the cyclic collector can run it
        on any thread at any allocation, including inside a critical
        section of the session, its policy cache or its event queue, and
        none of those locks is re-entrant. The settle path takes all
        three, so running it from ``__del__`` could deadlock the sensor;
        a deque append takes no lock.

        Everything the settle needs is read here with plain attribute
        reads (the merged usage, whether the response completed, a
        complete helper's snapshot), then the SDK stream and the call are
        dropped, so the collection frees the stream, and with it its HTTP
        connection, at once; a stream kept until the drain would keep the
        provider generating. Closing it here is not an option either, as
        the SDK's close takes the connection pool's lock.
        """
        self._merge_settled_usage()
        completed = self._is_complete()
        message = self._plain_final_message() if completed else None
        self._saw_terminal_chunk = completed  # the stream can no longer be asked
        self._stream = None
        self._ctx = None
        self._stream_iter = None
        self._real_fn = None
        queue = getattr(self._session, "queued_stream_settles", None)
        if isinstance(queue, collections.deque):
            queue.append(lambda: self._settle(message, completed))

    def _emit_pre_stream_error(self, exc: BaseException) -> None:
        # The context-manager protocol does not call __exit__ when
        # __enter__ raises, and a plain iterator has no __exit__ at all,
        # so pre-stream failures (rate limit, auth) are reported here
        # before the exception reaches the caller.
        self._finalized = True
        latency_ms = int((time.monotonic() - self._t0) * 1000)
        try:
            _emit_error(
                self._session,
                self._provider,
                exc,
                latency_ms,
                self._kwargs,
                is_stream_error=False,
                partial={
                    _KEY_ABORT_REASON: AbortReason.ERROR_BEFORE_STREAM.value,
                    _KEY_PARTIAL_CHUNKS: 0,
                },
            )
        except Exception as emit_exc:
            # No exc_info: the provider exception is the active context and
            # may echo prompt text; the failure class is enough.
            _log.warning(
                "Failed to emit llm_error for pre-stream exception (%s)", type(emit_exc).__name__
            )

    def _record_chunk(self, chunk: Any, *, visible: bool = True) -> None:
        """Meter one chunk. A hidden chunk (one the guard absorbs instead of
        handing to the caller) contributes usage and completion but no
        count or timing, so the stats describe what the caller saw."""
        if visible:
            now = time.monotonic()
            if self._first_chunk_t is None:
                self._first_chunk_t = now
            else:
                gap_ms = (now - (self._last_chunk_t or now)) * 1000
                if len(self._inter_chunk_ms) < self._MAX_GAPS_TRACKED:
                    self._inter_chunk_ms.append(gap_ms)
            self._last_chunk_t = now
            self._chunk_count += 1
        self._accumulate(chunk)
        try:
            found = self._provider.usage_from_stream_chunk(chunk)
        except Exception:
            self._hook_failed("usage_from_stream_chunk")
            found = None
        if found is not None:
            self._usage = _merge_usage(self._usage, found)
        try:
            if self._provider.chunk_completes_stream(chunk):
                self._saw_terminal_chunk = True
        except Exception:
            self._hook_failed("chunk_completes_stream")
        try:
            reason = self._provider.stop_reason_from_stream_chunk(chunk)
        except Exception:
            self._hook_failed("stop_reason_from_stream_chunk")
            reason = None
        if isinstance(reason, str):
            self._stop_reason = reason
        try:
            details = self._provider.call_details_from_stream_chunk(chunk)
        except Exception:
            self._hook_failed("call_details_from_stream_chunk")
            details = None
        # Chat chunks repeat the same model and tier on every chunk; fold
        # only a chunk that reports something new.
        if details is not None and details != self._details:
            self._details = details if self._details is None else self._details.merged(details)

    def _merge_settled_usage(self) -> None:
        """Fold in the usage the SDK stream object holds at settle time
        (a helper's accumulated snapshot); safe on every path because the
        provider never reads further from the stream here."""
        try:
            settled = self._provider.usage_from_finished_stream(self._stream)
        except Exception:
            self._hook_failed("usage_from_finished_stream")
            settled = None
        if settled is not None:
            self._usage = _merge_usage(self._usage, settled)

    def _is_complete(self) -> bool:
        """Whether the response was read in full: the SDK iterator ended, a
        terminal event passed through the guard (a consumer that stops at
        it has read the whole response), or a helper stream reports its
        message complete."""
        if self._exhausted or self._saw_terminal_chunk:
            return True
        try:
            return bool(self._provider.stream_completed(self._stream))
        except Exception:
            self._hook_failed("stream_completed")
            return False

    def _emit_stream_error(self, exc_val: BaseException) -> None:
        if self._finalized:
            return
        self._finalized = True
        latency_ms = int((time.monotonic() - self._t0) * 1000)
        try:
            # A helper consumed through get_final_message() bypasses the
            # guard's iterator, so whether data had arrived is judged by
            # the chunks the guard saw or the usage the stream object had
            # accumulated by the time it failed.
            self._merge_settled_usage()
            saw_data = self._first_chunk_t is not None or (
                self._usage is not None and self._usage.total > 0
            )
            _emit_error(
                self._session,
                self._provider,
                exc_val,
                latency_ms,
                self._kwargs,
                is_stream_error=saw_data,
                partial=self._partial_block(exc_val, saw_data),
                # The partial tokens are billed as the call would have
                # been; the server prices them by this mode.
                billing_mode=_call_billing_mode(self._session, self._provider),
            )
        except Exception as emit_exc:
            # No exc_info: the provider exception is the active context and
            # may echo prompt text; the failure class is enough.
            _log.warning(
                "Failed to emit llm_error for stream exception (%s)", type(emit_exc).__name__
            )

    def _partial_block(self, exc_val: BaseException, saw_data: bool) -> dict[str, Any]:
        """The llm_error partial block for a failed stream: abort reason,
        chunks read, and the tokens the provider had already delivered
        (which it bills, so they also count against the session)."""
        abort_reason = _abort_reason_for(exc_val, saw_data)
        partial: dict[str, Any] = {
            _KEY_ABORT_REASON: abort_reason,
            _KEY_PARTIAL_CHUNKS: self._chunk_count,
        }
        if self._usage is not None and self._usage.total > 0:
            partial[_KEY_PARTIAL_TOKENS_INPUT] = self._usage.input_tokens
            partial[_KEY_PARTIAL_TOKENS_OUTPUT] = self._usage.output_tokens
            with contextlib.suppress(Exception):
                self._session.record_usage(self._usage)
        return partial

    def _settle(self, message: Any | None, completed: bool) -> None:
        """Emit the post_call once. ``message`` is the helper's assembled
        final message when one is available; it then stands in for the
        stream as the response so content capture and tool-call
        extraction see the full response. A raw stream's accumulator
        supplies that message instead: the complete one when the stream
        completed, else the partial one, which only content capture
        stores (a half-streamed tool call is not a call the model made,
        and the usage, model and stop reason come from the events)."""
        if self._finalized or not self._entered:
            return
        self._finalized = True
        content_response: Any = None
        if message is None:
            assembled = self._assembled()
            if completed:
                message = assembled
            else:
                content_response = assembled
        # A settle may run long after the caller stopped reading (close(),
        # collection, session end, a stop at the terminal event), so only a
        # stream the guard read to its end, or a helper the caller read to
        # completion itself, is timed to the settle; otherwise latency runs
        # to the last chunk delivered, or to the moment the response opened
        # when no chunk was.
        end_t = time.monotonic()
        if not self._exhausted and not (completed and self._last_chunk_t is None):
            end_t = self._last_chunk_t or self._opened_t or end_t
        latency_ms = int((end_t - self._t0) * 1000)
        try:
            self._merge_settled_usage()
            _post_call(
                self._session,
                self._provider,
                message
                if message is not None
                else (self._stream if self._stream is not None else DROPPED_STREAM),
                self._estimated,
                latency_ms,
                self._kwargs,
                streaming=_build_streaming_summary(
                    self._t0,
                    self._first_chunk_t,
                    self._chunk_count,
                    self._inter_chunk_ms,
                    completed,
                ),
                estimated_via=self._estimated_via,
                usage_override=self._usage,
                stop_reason=self._stop_reason,
                details_override=self._details,
                content_response=content_response,
            )
        except Exception as emit_exc:
            # No exc_info: the provider exception is the active context and
            # may echo prompt text; the failure class is enough.
            _log.warning("Failed to post stream reconciliation event (%s)", type(emit_exc).__name__)


class GuardedStream(_GuardCore):
    """Guard around a streaming LLM response.

    Works as a context manager (``with guard as s: for chunk in s``) and
    as a plain iterator (``for chunk in guard``) because the SDKs
    document both patterns. As chunks pass through, the provider reads
    any token usage they carry (``usage_from_stream_chunk``) and the
    guard keeps the merged result, so ``post_call`` reports the counts
    the provider sent inside the stream rather than the pre-call
    estimate. The event is emitted exactly once, at the first of: the
    stream being read to its end, ``close()``, leaving the ``with``
    block, or the guard being garbage-collected; a failure emits
    ``llm_error`` instead. Every other attribute (``get_final_message``,
    ``response``, ``request_id``) is proxied to the SDK stream, and
    ``text_stream`` is re-implemented on top of the guard so it is
    metered too.
    """

    def _enter_stream(self) -> None:
        """Make the underlying call once. ``self._stream`` is the SDK
        object the caller iterates; ``self._ctx`` is whatever the call
        returned (a context manager for ``messages.stream()``, the
        stream itself for ``create(stream=True)``)."""
        if self._entered:
            return
        self._entered = True
        self._t0 = time.monotonic()
        try:
            self._kwargs = _sending(self._session, self._kwargs)
            at_entry = (
                _entry_copy(
                    self._session, self._kwargs, _provider_name(self._provider), self._given
                )
                if self._made_at_call
                else None
            )
            self._ctx = self._real_fn(**self._kwargs)
            if hasattr(self._ctx, "__enter__"):
                self._stream = self._ctx.__enter__()
            else:
                self._stream = self._ctx
            _keep_the_copy_sent(self._kwargs, at_entry, self._stream)
            self._register_open()
            self._attach_accumulator()
            self._opened_t = time.monotonic()
        except BaseException as exc:
            self._open_error = exc
            self._emit_pre_stream_error(exc)
            raise

    def open(self) -> GuardedStream:
        """Send the request now instead of on first use. ``create(stream=True)``
        calls this so provider errors surface at the call, as they do on
        the unguarded SDK; ``messages.stream()`` stays lazy like the SDK's
        own context manager."""
        self._enter_stream()
        return self

    def __enter__(self) -> GuardedStream:
        self._enter_stream()
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: TracebackType | None,
    ) -> None:
        if exc_val is not None and not self._is_complete() and _is_provider_failure(exc_val):
            self._close_underlying(exc_type, exc_val, exc_tb)
            self._emit_stream_error(exc_val)
            return
        # No exception, a response already read in full, a cancellation /
        # interrupt, the sensor's own policy exception or the caller's own
        # exception: the caller left the stream, which is a post_call
        # (completed when the response was read in full, else aborted),
        # not a provider failure.
        self._finalize()
        self._close_underlying(exc_type, exc_val, exc_tb)

    def close(self) -> None:
        """Settle the accounting and close the SDK stream. Lets callers
        that iterate without a ``with`` block stop early and still get
        their ``post_call`` promptly."""
        self._finalize()
        self._close_underlying(None, None, None)

    def _close_underlying(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: TracebackType | None,
    ) -> None:
        try:
            if self._ctx is not None and hasattr(self._ctx, "__exit__"):
                self._ctx.__exit__(exc_type, exc_val, exc_tb)
            elif self._stream is not None and hasattr(self._stream, "close"):
                self._stream.close()
        except Exception as exc:
            # No exc_info: a provider error may be the active context and
            # echo prompt text.
            _log.debug("Exception closing underlying stream (%s)", type(exc).__name__)

    def _finalize(self) -> None:
        if self._finalized or not self._entered:
            return
        completed = self._is_complete()
        # A complete helper stream hands over its assembled message; an
        # awaitable cannot be used on this sync path, the snapshot usage
        # still applies.
        self._settle(self._plain_final_message() if completed else None, completed)

    def __del__(self) -> None:
        # A plain loop abandoned with ``break`` reaches neither close()
        # nor __exit__; queue the settle when the guard is collected so
        # the call is still reported. Everything is suppressed: __del__
        # can run at interpreter shutdown or inside another thread's
        # collection.
        try:
            if self._entered and not self._finalized:
                self._defer_settle()
        except BaseException:
            pass

    def _settle_now(self) -> None:
        self._finalize()

    # -- iteration -----------------------------------------------------

    def __iter__(self) -> Iterator[Any]:
        self._enter_stream()
        if self._stream_iter is None:
            self._stream_iter = iter(self._require_stream())
        return self

    def __next__(self) -> Any:
        self._enter_stream()
        if self._stream_iter is None:
            self._stream_iter = iter(self._require_stream())
        while True:
            try:
                chunk = next(self._stream_iter)
            except StopIteration:
                self._exhausted = True
                self._finalize()
                raise
            except Exception as exc:
                # A provider error raised while reading (an error event, a
                # connection reset) is reported here so a caller iterating
                # without a with block, whose __exit__ never runs, still
                # gets the llm_error; the with form is idempotent through
                # _finalized.
                self._emit_stream_error(exc)
                raise
            if self._hidden(chunk):
                self._record_chunk(chunk, visible=False)
                continue
            self._record_chunk(chunk)
            return chunk

    @property
    def text_stream(self) -> Iterator[str]:
        """Text deltas of a helper stream, iterated through the guard so
        chunk stats and usage are recorded; the SDK's own ``text_stream``
        would bypass the guard. Absent, as on the SDK object, when the
        stream has no ``text_stream`` of its own."""
        # The SDK helpers set ``text_stream`` on the instance in __init__
        # (the class carries only the annotation), so probe the object.
        self._enter_stream()
        if not hasattr(self._stream, "text_stream"):
            raise AttributeError("text_stream")
        return _text_deltas(self)

    def __getattr__(self, name: str) -> Any:
        # Reached only for names the guard itself does not define. Keep
        # private / dunder lookups local so hasattr() probes and copy /
        # pickle machinery never trigger the underlying call.
        if name.startswith("_"):
            raise AttributeError(name)
        self._enter_stream()
        if self._stream is None:
            raise AttributeError(name)
        return getattr(self._stream, name)


def _build_streaming_summary(
    t0: float,
    first_chunk_t: float | None,
    chunk_count: int,
    inter_chunk_ms: list[float],
    completed: bool,
) -> dict[str, Any]:
    """Streaming sub-object attached to the post_call payload.

    * ``ttft_ms`` -- ``None`` if no chunks ever arrived, else the
      millisecond delta from request dispatch to first chunk.
    * ``chunk_count`` -- chunks the caller iterated through the guard.
      Zero is legal (the caller entered the context and never iterated).
    * ``inter_chunk_ms`` -- ``{"p50", "p95", "max"}`` over the captured
      gaps; ``None`` when fewer than two chunks arrived.
    * ``final_outcome`` -- ``"completed"`` when the stream was read to
      its end (the SDK iterator ended, a terminal event passed through
      the guard, or a helper stream reports its message complete), else
      ``"aborted"``.
    * ``abort_reason`` -- ``"client_aborted"`` on an aborted stream, else
      ``None``. Provider failures never reach this helper: they emit
      ``llm_error`` with their own abort reason.
    """
    ttft_ms: int | None = None
    if first_chunk_t is not None:
        ttft_ms = int((first_chunk_t - t0) * 1000)

    inter_chunk: dict[str, int] | None = None
    if len(inter_chunk_ms) >= 1:
        sorted_gaps = sorted(inter_chunk_ms)
        inter_chunk = {
            "p50": int(_percentile(sorted_gaps, 50)),
            "p95": int(_percentile(sorted_gaps, 95)),
            "max": int(sorted_gaps[-1]),
        }

    return {
        "ttft_ms": ttft_ms,
        "chunk_count": chunk_count,
        "inter_chunk_ms": inter_chunk,
        "final_outcome": (StreamOutcome.COMPLETED if completed else StreamOutcome.ABORTED).value,
        "abort_reason": None if completed else AbortReason.CLIENT_ABORTED.value,
    }


class GuardedAsyncStream(_GuardCore):
    """Async counterpart of :class:`GuardedStream`.

    Supports ``async with client.messages.stream(...) as s: async for
    chunk in s`` as well as ``async for chunk in await
    client.chat.completions.create(..., stream=True)`` with no ``async
    with``. Metering, emission and attribute proxying follow the sync
    guard; the underlying call may return a coroutine that resolves to
    the stream, which is awaited once, and a complete helper's final
    message is awaited at settle time so content capture sees the full
    response. Attributes of the SDK stream are reachable only once the
    guard has been entered (``async with`` or the first ``async for``),
    since entering requires an ``await``.
    """

    async def _enter_stream(self) -> None:
        if self._entered:
            return
        self._entered = True
        self._t0 = time.monotonic()
        try:
            self._kwargs = _sending(self._session, self._kwargs)
            at_entry = (
                _entry_copy(
                    self._session, self._kwargs, _provider_name(self._provider), self._given
                )
                if self._made_at_call
                else None
            )
            self._ctx = self._real_fn(**self._kwargs)
            # AsyncOpenAI.chat.completions.create(stream=True) returns a
            # coroutine resolving to the async stream; AsyncAnthropic's
            # messages.stream() returns the async context manager
            # directly. Await once, then enter if it is a context manager.
            if inspect.iscoroutine(self._ctx):
                self._ctx = await self._ctx
            if hasattr(self._ctx, "__aenter__"):
                self._stream = await self._ctx.__aenter__()
            else:
                self._stream = self._ctx
            _keep_the_copy_sent(self._kwargs, at_entry, self._stream)
            self._register_open()
            self._attach_accumulator()
            self._opened_t = time.monotonic()
        except BaseException as exc:
            self._open_error = exc
            self._emit_pre_stream_error(exc)
            raise

    async def open(self) -> GuardedAsyncStream:
        """Send the request now (see :meth:`GuardedStream.open`)."""
        await self._enter_stream()
        return self

    def adopt(self, stream: Any) -> GuardedAsyncStream:
        """Enter the guard over an SDK stream that is already open (a view
        response's parsed event stream), which needs no ``await``: the
        request was sent before the guard existed. An entered guard is
        settled by its exit, ``close()``, collection or the session's
        end, so a stream the caller never iterates is still reported,
        as an aborted stream with no chunks. The stream is the guard's
        own (no context manager around it), so closing the guard closes
        the stream."""
        if self._entered:
            return self
        self._entered = True
        self._t0 = time.monotonic()
        self._stream = stream
        self._register_open()
        self._attach_accumulator()
        self._opened_t = time.monotonic()
        return self

    async def __aenter__(self) -> GuardedAsyncStream:
        await self._enter_stream()
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: TracebackType | None,
    ) -> None:
        if exc_val is not None and not self._is_complete() and _is_provider_failure(exc_val):
            await self._close_underlying(exc_type, exc_val, exc_tb)
            self._emit_stream_error(exc_val)
            return
        # No exception, a response already read in full, a cancellation,
        # the sensor's own policy exception or the caller's own exception:
        # the caller left the stream (see GuardedStream.__exit__).
        await self._finalize()
        await self._close_underlying(exc_type, exc_val, exc_tb)

    async def close(self) -> None:
        """Settle the accounting and close the SDK stream (mirrors the
        SDKs' ``await stream.close()``)."""
        await self._finalize()
        await self._close_underlying(None, None, None)

    async def _close_underlying(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: TracebackType | None,
    ) -> None:
        try:
            if self._ctx is not None and hasattr(self._ctx, "__aexit__"):
                await self._ctx.__aexit__(exc_type, exc_val, exc_tb)
            elif self._stream is not None and hasattr(self._stream, "close"):
                result = self._stream.close()
                if inspect.isawaitable(result):
                    await result
        except Exception as exc:
            _log.debug("Exception closing underlying async stream (%s)", type(exc).__name__)

    async def _finalize(self) -> None:
        if self._finalized or not self._entered:
            return
        completed = self._is_complete()
        message: Any = None
        if completed:
            try:
                message = self._provider.final_message(self._stream)
                if inspect.isawaitable(message):
                    message = await message
            except Exception:
                self._hook_failed("final_message")
                message = None
        self._settle(message, completed)

    def _settle_now(self) -> None:
        # No event loop here: the provider's final message is taken only
        # when it is a plain object (the Anthropic snapshot).
        completed = self._is_complete()
        self._settle(self._plain_final_message() if completed else None, completed)

    def __del__(self) -> None:
        # See GuardedStream.__del__.
        try:
            if self._entered and not self._finalized:
                self._defer_settle()
        except BaseException:
            pass

    def __aiter__(self) -> GuardedAsyncStream:
        return self

    async def __anext__(self) -> Any:
        await self._enter_stream()
        if self._stream_iter is None:
            self._stream_iter = self._require_stream().__aiter__()
        while True:
            try:
                chunk = await self._stream_iter.__anext__()
            except StopAsyncIteration:
                self._exhausted = True
                await self._finalize()
                raise
            except Exception as exc:
                self._emit_stream_error(exc)
                raise
            if self._hidden(chunk):
                self._record_chunk(chunk, visible=False)
                continue
            self._record_chunk(chunk)
            return chunk

    @property
    def text_stream(self) -> AsyncIterator[str]:
        """Async text deltas of a helper stream, iterated through the guard
        (see :attr:`GuardedStream.text_stream`); reachable once the stream
        is open, like every other proxied attribute."""
        if self._stream is None or not hasattr(self._stream, "text_stream"):
            raise AttributeError("text_stream")
        return _async_text_deltas(self)

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_") or self._stream is None:
            raise AttributeError(name)
        return getattr(self._stream, name)


def _percentile(sorted_values: list[float], pct: float) -> float:
    """Cheap percentile over a pre-sorted list. Returns 0 if empty.

    No scipy / numpy dependency -- the sensor stays dependency-free for
    every install type.
    """
    if not sorted_values:
        return 0.0
    k = (len(sorted_values) - 1) * (pct / 100.0)
    lo = int(k)
    hi = min(lo + 1, len(sorted_values) - 1)
    if lo == hi:
        return sorted_values[lo]
    frac = k - lo
    return sorted_values[lo] + (sorted_values[hi] - sorted_values[lo]) * frac


# ------------------------------------------------------------------
# Shared pre/post logic
# ------------------------------------------------------------------


def _pre_call(
    session: Session,
    provider: Provider,
    kwargs: dict[str, Any],
    estimated: int,
    estimated_via: str = "none",
) -> dict[str, Any]:
    """Run policy check and return (possibly modified) kwargs.

    Each enforcement decision emits a structured policy event so
    operators can see warn / degrade / block on the session timeline.
    See ARCHITECTURE.md "Event Types" → policy_warn / policy_degrade /
    policy_block.

    * BLOCK: emit :attr:`EventType.POLICY_BLOCK`, flush the event queue
      so the event lands before the process exit, then raise
      :class:`BudgetExceededError`. Source is always ``"server"``
      (local thresholds fire WARN only).
    * DEGRADE: returns a *copy* of kwargs with swapped model, and without
      the request parameters the provider names as other models the call
      could run instead (``model_alternative_params``; a litellm call's
      ``fallbacks``), so the degrade target is the only model it can run.
      POLICY_DEGRADE is NOT emitted here — it fires once on
      ``_apply_directive(DEGRADE)`` arrival. Per-call swaps are visible
      via post_call.model only.
    * WARN: emit :attr:`EventType.POLICY_WARN` (source ``"local"`` for
      ``init(limit=...)`` thresholds, ``"server"`` for server policy),
      log warning, return original kwargs.
    * ALLOW: returns original kwargs unchanged.
    """
    drain_deferred_settles(session)
    with session._lock:
        shutdown = session._shutdown_requested
        reason = session._shutdown_reason
    if shutdown:
        raise DirectiveError("shutdown", reason)

    result = session.policy.check(session.tokens_used, estimated)
    decision = result.decision

    # Build the pre_call decision summary so it can ride on the
    # pre_call event. Omitted on the allow case (the vast majority).
    pre_call_decision: PolicyDecisionSummary | None = None
    if decision == PolicyDecision.BLOCK:
        block_pct = session.policy.block_at_pct
        pre_call_decision = PolicyDecisionSummary(
            policy_id=result.policy_id or "",
            scope=result.matched_policy_scope or "",
            decision="block",
            reason=(
                f"Pre-call check: {session.tokens_used + estimated}/"
                f"{session.policy.token_limit} would cross block "
                f"threshold ({block_pct}%, server policy)"
            ),
        )
    elif decision == PolicyDecision.WARN:
        warn_source = result.source or "server"
        local_warn = warn_source == "local"
        if local_warn:
            warn_threshold_pct = int(session.policy.local_warn_at * 100)
            warn_token_limit = session.policy.local_limit
        else:
            warn_threshold_pct = session.policy.warn_at_pct or 0
            warn_token_limit = session.policy.token_limit
        pre_call_decision = PolicyDecisionSummary(
            policy_id=result.policy_id or ("local" if local_warn else ""),
            scope=result.matched_policy_scope or ("local_failsafe" if local_warn else ""),
            decision="warn",
            reason=(
                f"Pre-call check: {session.tokens_used + estimated}/"
                f"{warn_token_limit} would cross warn threshold "
                f"({warn_threshold_pct}%, {warn_source} policy)"
            ),
        )
    elif decision == PolicyDecision.DEGRADE:
        pre_call_decision = PolicyDecisionSummary(
            policy_id=result.policy_id or "",
            scope=result.matched_policy_scope or "",
            decision="degrade",
            reason=(
                f"Pre-call check: degrade-to-{session.policy.degrade_to} "
                f"applied (per active directive)"
            ),
        )

    # Emit a pre_call event carrying the agent's intent + estimator
    # attribution + decision summary. Always emitted (including before
    # BLOCK) so the agent's intent is recorded even when the call is
    # rejected — matches the plugin's pre_call posture.
    pre_call_extras: dict[str, Any] = {
        "tokens_input": estimated,
        "estimated_via": estimated_via,
    }
    try:
        pre_model = provider.get_model(kwargs)
    except Exception:
        pre_model = ""
    if pre_model:
        pre_call_extras["model"] = pre_model
    if pre_call_decision is not None:
        pre_call_extras["policy_decision_pre"] = pre_call_decision.as_payload_dict()
    pre_call_payload = session._build_payload(EventType.PRE_CALL, **pre_call_extras)
    session.event_queue.enqueue(pre_call_payload)

    if decision == PolicyDecision.BLOCK:
        # POLICY_BLOCK: source hardcoded ``"server"`` — local
        # PolicyCache fires WARN only, never BLOCK. ``intended_model``
        # captures the model the blocked call was going to use so the
        # operator can answer "which call hit the limit?".
        intended_model = provider.get_model(kwargs)
        # Shared policy_decision block. Reason
        # follows the locked pattern: <what happened> + <by what
        # mechanism> + <relevant context>.
        block_pct = session.policy.block_at_pct
        block_decision = PolicyDecisionSummary(
            policy_id=result.policy_id or "",
            scope=result.matched_policy_scope or "",
            decision="block",
            reason=(
                f"Token usage {session.tokens_used}/{session.policy.token_limit} "
                f"({_safe_pct(session.tokens_used, session.policy.token_limit)}%) "
                f"crossed block threshold ({block_pct}%, server policy)"
            ),
        )
        block_payload = session._build_payload(
            EventType.POLICY_BLOCK,
            source="server",
            threshold_pct=block_pct,
            tokens_used=session.tokens_used,
            token_limit=session.policy.token_limit,
            intended_model=intended_model,
            policy_decision=block_decision.as_payload_dict(),
        )
        session.event_queue.enqueue(block_payload)
        # Synchronous flush: the BudgetExceededError below tears the
        # call down immediately and the caller may exit the process
        # without giving the drain thread a chance to ship the event.
        # Failure to flush is logged but does not change the raise.
        try:
            session.event_queue.flush()
        except Exception as exc:
            _log.warning(
                "[flightdeck] policy_block: failed to flush event queue: %s",
                exc,
            )
        raise BudgetExceededError(
            session_id=session.config.session_id,
            tokens_used=session.tokens_used,
            token_limit=session.policy.token_limit or 0,
        )

    if decision == PolicyDecision.DEGRADE and session.policy.degrade_to:
        # POLICY_DEGRADE is NOT emitted here. The decision event fired
        # once on _apply_directive(DEGRADE) arrival; per-call swaps are
        # visible via post_call.model. See decision lock above.
        call_kwargs = copy.copy(kwargs)
        call_kwargs["model"] = session.policy.degrade_to
        # The degrade target is the only model the policy allows: a
        # parameter that names other models the provider may run in its
        # place (a litellm call's ``fallbacks``, tried when an attempt
        # fails) is dropped, so a failure of the degraded attempt is the
        # call's failure instead of a way around the policy.
        for name in getattr(provider, "model_alternative_params", ()):
            call_kwargs.pop(name, None)
        _log.info(
            "Policy DEGRADE: swapping model to %s (session %s)",
            session.policy.degrade_to,
            session.config.session_id,
        )
        return call_kwargs

    if decision == PolicyDecision.WARN:
        # source comes from the PolicyResult — ``"local"`` for an
        # init(limit=...) threshold, ``"server"`` for a server policy
        # threshold. Local and server can both fire once each per
        # session (PolicyCache tracks separately).
        warn_source = result.source or "server"
        # Both branches must produce an int. ``warn_at_pct`` is Optional
        # on PolicyResult; the ``or 0`` guard mirrors the pre_call_decision
        # branch (line ~722) and prevents ``None`` from leaking into the
        # event payload's ``threshold_pct`` field or the operator-visible
        # f-string reason ("crossed warn threshold (None%, server policy)"
        # would be silently misleading). With both branches typed int the
        # mypy --strict no-redef error against the prior binding clears
        # without an annotation.
        if warn_source == "local":
            warn_threshold_pct = int(session.policy.local_warn_at * 100)
            warn_token_limit = session.policy.local_limit
        else:
            warn_threshold_pct = session.policy.warn_at_pct or 0
            warn_token_limit = session.policy.token_limit
        # Shared policy_decision block.
        local_warn = warn_source == "local"
        warn_decision = PolicyDecisionSummary(
            policy_id=result.policy_id or ("local" if local_warn else ""),
            scope=result.matched_policy_scope or ("local_failsafe" if local_warn else ""),
            decision="warn",
            reason=(
                f"Token usage {session.tokens_used}/{warn_token_limit} "
                f"({_safe_pct(session.tokens_used, warn_token_limit)}%) "
                f"crossed warn threshold ({warn_threshold_pct}%, {warn_source} policy)"
            ),
        )
        warn_payload = session._build_payload(
            EventType.POLICY_WARN,
            source=warn_source,
            threshold_pct=warn_threshold_pct,
            tokens_used=session.tokens_used,
            token_limit=warn_token_limit,
            policy_decision=warn_decision.as_payload_dict(),
        )
        session.event_queue.enqueue(warn_payload)
        _log.warning(
            "Token budget warning: %d tokens used of %s limit (session %s)",
            session.tokens_used,
            warn_token_limit,
            session.config.session_id,
        )

    return kwargs


def _post_call(
    session: Session,
    provider: Provider,
    response: Any,
    estimated: int,
    latency_ms: int,
    call_kwargs: dict[str, Any] | None = None,
    *,
    event_type: EventType = EventType.POST_CALL,
    streaming: dict[str, Any] | None = None,
    estimated_via: str = "none",
    usage_override: TokenUsage | None = None,
    stop_reason: str | None = None,
    details_override: CallDetails | None = None,
    content_response: Any = None,
) -> None:
    """Extract actual usage, reconcile with estimate, post event.

    ``event_type`` defaults to :attr:`EventType.POST_CALL`; callers pass
    :attr:`EventType.EMBEDDINGS` for embedding-model calls so the dashboard
    can render them distinctly.

    ``streaming`` carries the streaming sub-object (``ttft_ms``,
    chunk stats, ``final_outcome``) when the response came from
    :class:`GuardedStream`. Omitted entirely for non-streaming calls so the
    wire shape stays identical for non-streaming calls.

    ``stop_reason`` is the stop reason a stream guard read from
    the streamed events; when ``None`` the provider is asked to read it
    from the response. A reason that means the call did not succeed files
    an llm_error beside the post_call.

    ``details_override`` carries the call details a stream guard folded
    from the streamed events; the response's own details (a helper
    stream's final message) are laid over them.

    ``content_response`` is what content capture stores in place of
    ``response`` (a raw stream's partially assembled message when the
    caller left early); every other read still uses ``response``.

    A raw-response wrapper (``with_raw_response``) is read once, here, as
    the message its ``parse()`` returns, and every read below takes that
    message: the stored content, the served model, usage, stop reason,
    tool calls, and the wrapper's headers for ``provider_metadata``.
    """
    response = read_once(response)
    # ``usage_override`` carries the counts a stream guard read from the
    # provider's in-stream usage events; stream objects themselves expose
    # no usage, so without it every streamed call would fall back to the
    # estimate.
    if usage_override is not None and usage_override.total > 0:
        actual = usage_override
    else:
        actual = provider.extract_usage(response)

    # Use actual if available, otherwise fall back to estimate
    if actual.total > 0:
        usage = actual
    else:
        usage = TokenUsage(input_tokens=estimated, output_tokens=0)
        _log.debug(
            "No usage in response, using estimate of %d tokens",
            estimated,
        )

    # The model the response names (the served one, which can differ from
    # the requested alias), else the model the request asked for: a
    # stream object, a raw response whose parse failed and a streaming
    # view never parsed name none.
    resp_model = provider.get_model(call_kwargs or {})
    with contextlib.suppress(Exception):
        resp_model = getattr(response, "model", "") or resp_model

    # Extract content when capture_prompts is enabled
    content_dict: dict[str, Any] | None = None
    has_content = False
    if session.config.capture_prompts and call_kwargs is not None:
        pc = provider.extract_content(
            _captured(call_kwargs),
            content_response if content_response is not None else response,
            event_type=event_type,
        )
        if pc is not None:
            pc.session_id = session.config.session_id
            has_content = True
            content_dict = {
                "system": pc.system,
                "messages": pc.messages,
                "tools": pc.tools,
                "response": pc.response,
                "provider": pc.provider,
                "model": pc.model,
                "session_id": pc.session_id,
                "event_id": pc.event_id,
                "captured_at": pc.captured_at,
                # ``input`` is populated only on embeddings events;
                # chat events leave it None and the field drops via
                # the dashboard's optional read.
                "input": pc.input,
                # ``embedding_output`` carries the raw vectors from
                # embeddings.create() responses when capture_prompts
                # is on. None on chat events. Worker projects to
                # event_content.embedding_output.
                "embedding_output": pc.embedding_output,
            }

    # Atomically increment the session token counter and capture the
    # post-increment total in one critical section. The captured value
    # is then passed explicitly into _build_payload as
    # tokens_used_session so concurrent threads' contributions cannot
    # leak into this thread's reported running total. Without this
    # capture order, _build_payload would read self._tokens_used after
    # other threads' record_usage calls had already advanced it,
    # producing duplicate or skipped values on the dashboard token
    # curve.
    session_total = session.record_usage(usage)
    session.record_model(resp_model)

    # Embeddings carry input tokens only -- the provider response shape
    # populates ``usage.prompt_tokens`` with ``completion_tokens`` absent or
    # zero, so the existing extractor already returns ``output_tokens=0``.
    # No special-casing here beyond honouring ``event_type``.
    payload = session._build_payload(
        event_type,
        model=resp_model,
        tokens_input=usage.input_tokens,
        tokens_output=usage.output_tokens,
        tokens_total=usage.total,
        tokens_cache_read=usage.cache_read_tokens,
        tokens_cache_creation=usage.cache_creation_tokens,
        tokens_used_session=session_total,
        latency_ms=latency_ms,
    )
    if has_content:
        payload["has_content"] = True
        payload["content"] = content_dict
    if streaming is not None:
        payload["streaming"] = streaming
    _add_token_cost_fields(
        payload,
        session,
        provider,
        response,
        call_kwargs,
        usage,
        details_override,
        stop_reason,
    )

    # provider_metadata: rate-limit headers, request id, processing
    # time. Always-included when the provider exposes any of them so
    # the dashboard's rate-limit-pressure chip renders without a
    # separate header export.
    try:
        prov_meta = provider.extract_response_metadata(response)
    except Exception:
        prov_meta = None
    if prov_meta:
        payload["provider_metadata"] = prov_meta

    # estimated_via attribution lets a large post-call delta be
    # attributed to estimator quality (heuristic fallback).
    if estimated_via:
        payload["estimated_via"] = estimated_via

    # policy_decision_post: fires when this call's cumulative usage
    # crossed a threshold the pre-call check didn't catch. Inline
    # declaration on post_call / embeddings so the dashboard's row
    # renderer doesn't have to join sibling policy_warn /
    # policy_block events. Omitted when no crossing.
    try:
        post_result = session.policy.check(session_total, 0)
        if post_result.decision in (PolicyDecision.WARN, PolicyDecision.BLOCK):
            decision_str = "warn" if post_result.decision == PolicyDecision.WARN else "block"
            post_source = post_result.source or "server"
            local = post_source == "local"
            post_decision = PolicyDecisionSummary(
                policy_id=post_result.policy_id or ("local" if local else ""),
                scope=post_result.matched_policy_scope or ("local_failsafe" if local else ""),
                decision=decision_str,
                reason=(
                    f"Post-call cumulative usage crossed {decision_str} "
                    f"threshold ({post_source} policy) on this call's tokens"
                ),
            )
            payload["policy_decision_post"] = post_decision.as_payload_dict()
    except Exception:
        _log.debug("policy_decision_post evaluation failed", exc_info=True)

    # output_dimensions on embeddings: small + observable summary so
    # the dashboard renders the shape chip without fetching
    # event_content.
    if event_type == EventType.EMBEDDINGS:
        try:
            dims = provider.extract_output_dimensions(response)
        except Exception:
            dims = None
        if dims:
            payload["output_dimensions"] = dims

    if event_type == EventType.POST_CALL:
        session.set_current_call_event_id(payload["id"])
    session.event_queue.enqueue(payload)

    # A provider can answer 200 with a stop reason that still means the
    # call did not succeed (Anthropic's refusal or context-window
    # overrun). File an llm_error beside the post_call so error views and
    # the session's terminal-error flag see it; the post_call stays
    # because the call was billed and its usage must count.
    if event_type == EventType.POST_CALL:
        _emit_stop_reason_error(
            session, provider, response, resp_model, latency_ms, stop_reason, prov_meta
        )

    # Emit one tool_call event per tool invocation in the response.
    # Supplementary to post_call (not a replacement) so dashboards can
    # filter/aggregate tool usage independently of the underlying LLM
    # call. Failures are swallowed -- tool extraction is best-effort
    # and must not destabilise the hot path.
    try:
        invocations = provider.extract_tool_invocations(response)
    except Exception:
        _log.debug("extract_tool_invocations raised; skipping tool events", exc_info=True)
        invocations = []
    for inv in invocations:
        try:
            # LLM-side tool_call routes tool_input via event_content's
            # dedicated tool_input column when capture is on, which keeps
            # events.payload lean and matches the MCP tool_call capture
            # posture (single content store with dedicated columns).
            tool_payload = session._build_payload(
                EventType.TOOL_CALL,
                model=resp_model,
                tool_name=inv.name,
            )
            # A provider-hosted MCP call names the server it went to;
            # carried under the field every MCP event uses for it.
            # Metadata, like the tool name, so it ships with capture off.
            if inv.server_name:
                tool_payload["server_name"] = inv.server_name[:_MAX_SERVER_NAME_CHARS]
            if session.config.capture_prompts and inv.tool_input is not None:
                # Build the event_content envelope. The model's
                # response holds only the call, not the tool's result,
                # so the envelope carries tool_input and leaves
                # tool_output null, and nothing fills it in later:
                # the result reaches the model as part of the next
                # request's messages, which that call's own content
                # records when capture is on.
                from flightdeck_sensor.core.tool_capture import (
                    build_tool_capture_content,
                )

                capture_content = build_tool_capture_content(
                    tool_input=inv.tool_input,
                    tool_output=None,
                    server_name=resp_model or "",
                    session_id=session.config.session_id,
                )
                if capture_content is not None:
                    # Override the provider field — this is an LLM
                    # tool call, not an MCP one. Worker doesn't
                    # branch on provider; the field is informational
                    # for operators querying event_content directly.
                    capture_content["provider"] = "llm"
                    tool_payload["has_content"] = True
                    tool_payload["content"] = capture_content
            session.event_queue.enqueue(tool_payload)
            # A framework wrap that runs the tool itself checks this, so
            # the call is not reported a second time.
            session.note_reported_tool_call(inv.tool_id)
        except Exception:
            _log.debug("failed to enqueue tool_call event", exc_info=True)


# ------------------------------------------------------------------
# Error-event emission. Classifies the live exception against
# the 14-entry taxonomy (see ``core/errors.py``), constructs an
# LLM_ERROR event with the structured ``error`` sub-object, and enqueues
# it for transport. Never raises -- classification itself is best-effort,
# and a failure to emit the error event must not perturb the re-raise
# that the caller is about to do.
# ------------------------------------------------------------------


def _emit_error(
    session: Session,
    provider: Provider,
    exc: BaseException,
    latency_ms: int,
    call_kwargs: dict[str, Any] | None,
    *,
    is_stream_error: bool = False,
    partial: dict[str, Any] | None = None,
    billing_mode: str | None = None,
) -> None:
    _mark_reported(exc)
    try:
        provider_hint = getattr(provider, "name", None)
        classification = classify_exception(
            exc,
            provider_hint=provider_hint,
            is_stream_error=is_stream_error,
            # Provider-controlled exception text is gated on
            # capture_prompts: content_filter exceptions echo the
            # offending prompt fragment in their str(); when capture
            # is off, _redacted_message returns the class name only so
            # the fragment stays out of events.payload.
            capture_prompts=session.config.capture_prompts,
        )

        model: str | None = None
        if call_kwargs is not None:
            try:
                model = provider.get_model(call_kwargs)
            except Exception:
                model = call_kwargs.get("model") if isinstance(call_kwargs, dict) else None

        error_payload = classification.to_payload()
        if partial is not None:
            error_payload.update(partial)
        _enqueue_error_event(
            session, provider, error_payload, model, latency_ms, billing_mode=billing_mode
        )
    except Exception as emit_exc:
        # No exc_info: the provider exception is the active context and
        # may echo prompt text; the failure class is enough.
        _log.warning("Failed to emit llm_error event (%s)", type(emit_exc).__name__)


def _enqueue_error_event(
    session: Session,
    provider: Provider,
    error_payload: dict[str, Any],
    model: str | None,
    latency_ms: int,
    *,
    billing_mode: str | None = None,
) -> None:
    """Build and enqueue the LLM_ERROR event around a finished ``error``
    sub-object, whether it came from an exception or a stop reason.
    ``billing_mode`` is stamped top-level when given (a failed stream's
    llm_error, whose partial tokens the provider bills)."""
    # Per-(provider, request_id) retry counter — bounded LRU on
    # Session — answers "did the retry chain finally give up".
    # terminal is best-effort: an error is terminal when the
    # classifier marks it non-retryable. The alternative
    # (lookback to confirm caller actually retried) needs cross-
    # event correlation that adds latency to the hot path; the
    # classifier-driven heuristic is correct for the vast
    # majority of real retry chains.
    # error_payload.get(...) returns Any | None; the `or
    # getattr(provider, "name", "")` fallback already produces a
    # str at runtime. cast(str, ...) tells mypy the result is str
    # without manufacturing a third "" fallback that would conflate
    # missing-key, present-but-None, and present-but-empty cases.
    provider_name = cast("str", error_payload.get("provider") or getattr(provider, "name", ""))
    # Trust-boundary check: error_payload is sensor-internal but
    # composed from provider-supplied error attributes (request_id
    # is whatever the SDK exposed). isinstance enforces the
    # str | None contract record_retry_attempt expects, instead of
    # papering over a malformed value type with cast(). A non-str
    # request_id falls through to None — record_retry_attempt then
    # treats the call as a fresh attempt rather than crashing on a
    # type mismatch.
    request_id_raw = error_payload.get("request_id")
    request_id = request_id_raw if isinstance(request_id_raw, str) else None
    retry_attempt = session.record_retry_attempt(provider_name, request_id)
    terminal = not bool(error_payload.get("is_retryable", False))

    payload = session._build_payload(
        EventType.LLM_ERROR,
        model=model,
        latency_ms=latency_ms,
    )
    payload["error"] = error_payload
    payload["retry_attempt"] = retry_attempt
    payload["terminal"] = terminal
    if billing_mode is not None:
        payload["billing_mode"] = billing_mode
    session.event_queue.enqueue(payload)


def _provider_name(provider: Provider) -> str:
    """The adapter's wire name; ``unknown`` for an adapter that carries
    none (a stop reason has no exception module to infer it from)."""
    name = getattr(provider, "name", None)
    return name if isinstance(name, str) and name else "unknown"


def _response_request_id(response: Any, prov_meta: dict[str, Any] | None) -> str | None:
    """The provider's request id of a 200 response, capped at
    ``REQUEST_ID_MAX_LEN`` characters: the SDK stamps it on the parsed
    object as ``_request_id``; a raw-response wrapper exposes it through
    the headers the provider metadata already read."""
    with contextlib.suppress(Exception):
        stamped = getattr(response, "_request_id", None)
        if isinstance(stamped, str) and stamped:
            return stamped[:REQUEST_ID_MAX_LEN]
    if prov_meta:
        from_headers = prov_meta.get("request_id")
        if isinstance(from_headers, str) and from_headers:
            return from_headers[:REQUEST_ID_MAX_LEN]
    return None


def _add_token_cost_fields(
    payload: dict[str, Any],
    session: Session,
    provider: Provider,
    response: Any,
    call_kwargs: dict[str, Any] | None,
    usage: TokenUsage,
    details_override: CallDetails | None,
    stop_reason: str | None,
) -> None:
    """Add the token, model and cost fields of the event contract
    (ARCHITECTURE.md, POST /v1/events) to an LLM call's payload. A field
    is sent only when known, so the wire stays as before for whatever a
    provider does not report. Never raises."""
    try:
        details = details_override
        try:
            own = provider.call_details(response)
        except Exception:
            own = None
        if own is not None:
            details = own if details is None else details.merged(own)

        fields: dict[str, Any] = {
            "model_requested": provider.get_model(call_kwargs or {}) or None,
            "provider": provider.vendor,
            "billing_mode": _call_billing_mode(session, provider),
            "inference_scope": provider.inference_scope,
            # Each share must fit inside its total, or ingestion rejects
            # the whole event; a share that does not is left out.
            "tokens_reasoning": _share(usage.reasoning_tokens, usage.output_tokens),
            "tokens_cache_creation_1h": _share(
                usage.cache_creation_1h_tokens, usage.cache_creation_tokens
            ),
        }
        reason = stop_reason
        if reason is None:
            with contextlib.suppress(Exception):
                reason = provider.response_stop_reason(response)
        if isinstance(reason, str) and reason:
            fields["stop_reason"] = reason
        if details is not None:
            fields.update(
                model_served=details.model_served,
                service_tier=details.service_tier,
                speed=details.speed,
                inference_geo=details.inference_geo,
                server_tool_use=details.server_tool_use,
                cost_reported=details.cost_reported,
                cost_source=details.cost_source,
            )
        for key, value in fields.items():
            if value is None:
                continue
            if isinstance(value, str):
                value = _clip_utf8(value, _MAX_DETAIL_BYTES)
            payload[key] = value
    except Exception:
        _log.debug("token and cost fields failed", exc_info=True)


def _clip_utf8(value: str, max_bytes: int) -> str:
    """``value`` cut to at most ``max_bytes`` of UTF-8, never splitting a
    character."""
    encoded = value.encode("utf-8")
    if len(encoded) <= max_bytes:
        return value
    return encoded[:max_bytes].decode("utf-8", errors="ignore")


def _share(part: int | None, whole: int) -> int | None:
    """A reported share of a token total, or ``None`` when it was not
    reported or exceeds the total."""
    return part if part is not None and 0 <= part <= whole else None


def _emit_stop_reason_error(
    session: Session,
    provider: Provider,
    response: Any,
    model: str | None,
    latency_ms: int,
    stop_reason: str | None,
    prov_meta: dict[str, Any] | None = None,
) -> None:
    """File an llm_error for a 200 response whose stop reason means the
    call did not succeed. ``stop_reason`` is what a stream guard saw in
    the events; otherwise the provider reads it from the response. The
    response's request id keys the per-provider retry counter, so two
    refusals in one session are two attempts, not one chain. Never raises
    and emits nothing for every success reason."""
    try:
        reason = stop_reason
        if reason is None:
            reason = provider.response_stop_reason(response)
        classification = classify_stop_reason(
            reason,
            provider=_provider_name(provider),
            request_id=_response_request_id(response, prov_meta),
        )
        if classification is None:
            return
        _enqueue_error_event(session, provider, classification.to_payload(), model, latency_ms)
    except Exception as emit_exc:
        _log.warning("Failed to emit llm_error for stop reason (%s)", type(emit_exc).__name__)
