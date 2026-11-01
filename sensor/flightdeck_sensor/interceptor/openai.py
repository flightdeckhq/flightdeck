"""OpenAI client proxy: intercepts chat.completions.create() / parse() /
stream() (on ``client.chat`` and on ``client.beta.chat``),
responses.create() / parse() / stream(), embeddings.create(), and the
``with_raw_response`` and ``with_streaming_response`` views of those
resources.

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
      │   │   ├── create()           →  call(), call_async(), or call_stream();
      │   │   │                             through a view whose body is unread,
      │   │   │                             raw_views.send_deferred()
      │   │   ├── parse()            →  call() or call_async()
      │   │   ├── stream()           →  the SDK's own helper, its request sent
      │   │   │                         through create() above
      │   │   ├── with_raw_response  →  _SensorRawResponseWrapper
      │   │   │   ├── create() / parse()  →  call() or call_async();
      │   │   │   │                          stream=True deferred to parse()
      │   │   │   └── __getattr__    →  pass-through
      │   │   ├── with_streaming_response → the SDK's view over this proxy
      │   │   └── __getattr__        →  pass-through
      │   └── __getattr__    →  pass-through
      ├── @property responses →  SensorResponses (same shape: create(),
      │                          parse(), stream(), with_raw_response,
      │                          with_streaming_response)
      ├── with_options()     →  new SensorOpenAI
      ├── with_raw_response  →  the SDK's client view over this proxy
      ├── with_streaming_response → the SDK's client view over this proxy
      └── __getattr__        →  pass-through

When ``stream=True``, injects ``stream_options={"include_usage": True}``
into kwargs so OpenAI returns token usage in the final streaming chunk.

The SDK's raw and streaming views (``with_raw_response`` /
``with_streaming_response``, on a resource or on the client) mark their
requests with the ``X-Stainless-Raw-Response`` header. A view call whose
body is unread when the caller gets the response -- every streaming-view
call, and a raw-view call with ``stream=True`` -- is metered when the
caller parses it (see :mod:`flightdeck_sensor.interceptor.raw_views`); a
parsed event stream goes to the stream guard.
"""

from __future__ import annotations

import contextlib
import copy
import inspect
import json
import logging
import time
import types
from typing import TYPE_CHECKING, Any

from flightdeck_sensor.core.errors import classify_stop_reason
from flightdeck_sensor.core.types import EventType
from flightdeck_sensor.interceptor import base, raw_views
from flightdeck_sensor.interceptor.platform import PLATFORM_OPENAI, endpoint_of
from flightdeck_sensor.providers.openai import OpenAIProvider, helper_stream_accumulator

if TYPE_CHECKING:
    from flightdeck_sensor.core.session import Session

_log = logging.getLogger("flightdeck_sensor.interceptor.openai")


# ----------------------------------------------------------------------
# Captured class references
# ----------------------------------------------------------------------
#
# Captured at module import time, BEFORE patch() can run, so isinstance()
# checks below survive any later mutation. See the matching block in
# interceptor/anthropic.py for the rationale.

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

# ``client.beta`` is the SDK's ``Beta`` / ``AsyncBeta`` resource. Its own
# ``chat`` cached_property hands out a separate ``Chat`` resource, which
# the client's ``chat`` descriptor never sees, so it is patched on its
# own. From openai 1.92 it is the same ``Chat`` class as ``client.chat``;
# from 1.40 to 1.91 it is a beta ``Chat`` whose ``completions`` carry only
# ``parse`` and ``stream``. An SDK without the module, or whose ``Beta``
# has no ``chat``, is left alone.
try:
    from openai.resources.beta import AsyncBeta as _OrigAsyncBeta
    from openai.resources.beta import Beta as _OrigBeta
except ImportError:
    _OrigBeta = None  # type: ignore[assignment,misc]
    _OrigAsyncBeta = None  # type: ignore[assignment,misc]


def _provider_for(client: Any, session: Session) -> OpenAIProvider:
    """An OpenAI provider for a client, attributed to the endpoint the
    client talks to (``openai``, ``azure``, or the host of an
    OpenAI-compatible server; see
    :func:`flightdeck_sensor.interceptor.platform.endpoint_of`)."""
    endpoint = endpoint_of(client, PLATFORM_OPENAI)
    return OpenAIProvider(
        capture_prompts=session.config.capture_prompts,
        platform=endpoint.platform,
        local=endpoint.local,
    )


def _is_async_client(client: Any) -> bool:
    """Detect async OpenAI client using the captured class reference."""
    if _OrigAsyncOpenAI is None:
        return False
    return isinstance(client, _OrigAsyncOpenAI)


def _billed_completion_of(exc: BaseException) -> Any | None:
    """The completion a parse failure carries, when the provider answered.

    ``chat.completions.parse()`` raises ``LengthFinishReasonError`` after
    the provider answered with HTTP 200 and billed the call: the output
    hit the caller's ``max_tokens`` before the structured output was
    complete. The exception carries that completion, usage included.
    ``ContentFilterFinishReasonError`` and a schema failure carry none.
    Never raises.
    """
    with contextlib.suppress(Exception):
        return getattr(exc, "completion", None)
    return None


class _CarriedCompletion:
    """A completion a parse failure carries, metered with the HTTP
    response it came from: ``headers`` are the response's own (request
    id, rate limits), never a field the provider's body might hold under
    that name; every other attribute is the completion's."""

    def __init__(self, completion: Any, headers: Any) -> None:
        self._completion = completion
        self.headers = headers

    def model_dump(self, **kwargs: Any) -> Any:
        return self._completion.model_dump(**kwargs)

    def __getattr__(self, name: str) -> Any:
        # Single-underscore names are forwarded on purpose: the SDK stamps
        # the request id on the completion as ``_request_id``.
        if name.startswith("__"):
            raise AttributeError(name)
        return getattr(self._completion, name)


def _answered_body(raw: Any) -> Any | None:
    """The provider's answer behind a raw response whose parse failed, as
    a plain object the intercept can meter: the JSON body's fields
    (``usage``, ``model``, ``choices`` / ``output``) plus the response
    ``headers``. ``None`` when the body is not a JSON object. A body key
    named ``headers`` would collide with that attribute and is dropped.
    Never raises."""
    try:
        body = json.loads(raw.text)
        if not isinstance(body, dict):
            return None
        fields = {key: value for key, value in body.items() if key != "headers"}
        return types.SimpleNamespace(**fields, headers=getattr(raw, "headers", None))
    except Exception:
        return None


def _stop_reason_already_reported(provider: OpenAIProvider, answer: Any) -> bool:
    """Whether the post_call built from ``answer`` filed its own llm_error
    for a stop reason that means the call failed. Never raises."""
    try:
        reason = provider.response_stop_reason(answer)
        return classify_stop_reason(reason, provider=provider.name) is not None
    except Exception:
        return False


class _ParseOutcome:
    """What a wrapped ``parse()`` call kept aside for the intercept's
    caller: the exception a billed-but-failed parse raised (reported as
    the ``llm_error`` once the ``post_call`` is out) and the raw
    response, which the raw-response path's caller still receives.
    ``unreadable`` is the parse exception of a raw response whose answer
    could not be read at all; it raises through the intercept (which
    reports the ``llm_error`` alone) and the raw-response caller still
    gets ``raw``."""

    def __init__(self) -> None:
        self.exc: BaseException | None = None
        self.raw: Any | None = None
        self.unreadable: BaseException | None = None


def _call_parse(
    real_fn: Any,
    kwargs: dict[str, Any],
    session: Session,
    provider: OpenAIProvider,
    *,
    is_async: bool,
    return_raw: bool,
) -> Any:
    """Run a raw-response ``parse`` closure through the non-streaming
    intercept, parsing the response eagerly.

    ``parse()`` never streams: the SDK posts with ``stream=False`` and
    parses the completion into the caller's ``response_format`` /
    ``text_format`` type. ``real_fn`` is the SDK's raw-response closure
    for it, so the response reaches the sensor before the SDK parses it;
    the parse runs here, and the SDK caches a successful one.

    A call the provider answered (HTTP 200) and billed, but that still
    failed for the caller, is reported as both: the ``post_call`` built
    from the provider's answer (usage, model, its tool calls) and then
    the ``llm_error`` (``http_status`` 200, terminal). To get the
    ``post_call`` first, the wrapped ``real_fn`` hands that answer to the
    intercept as the response and keeps the exception aside; the error
    is emitted once the intercept has returned. The answer is the
    completion the exception carries (``LengthFinishReasonError``) or
    else the HTTP body (``ContentFilterFinishReasonError``, a schema
    failure). When neither can be read (a 200 whose body is not a JSON
    object) the exception raises through the intercept, which reports
    the ``llm_error`` alone: a failed parse never lands as a
    success-looking ``post_call``. The raw-response caller still gets
    the raw response in that case, as from the SDK.

    With ``return_raw`` the caller gets the raw response, as from the
    SDK's ``with_raw_response.parse()``, and its own ``.parse()`` raises
    as it would without the sensor; otherwise the caller gets the parsed
    object, or the SDK's exception, as from the plain ``parse()``.
    """
    outcome = _ParseOutcome()

    def _answered(response: Any) -> Any:
        """What the intercept meters for a raw response: its parsed
        form, or when parsing fails, the provider's answer."""
        try:
            parsed = response.parse()
        except Exception as exc:
            answer = _billed_completion_of(exc)
            if answer is not None:
                answer = _CarriedCompletion(answer, getattr(response, "headers", None))
            else:
                answer = _answered_body(response)
            if answer is None:
                if return_raw:
                    outcome.raw = response
                    outcome.unreadable = exc
                raise
            outcome.exc = exc
            outcome.raw = response
            return answer
        return response if return_raw else parsed

    def _failed(exc: Exception) -> Any:
        """The answer a failed call still carries, or re-raise."""
        completion = _billed_completion_of(exc)
        if completion is None:
            raise exc
        outcome.exc = exc
        return completion

    def _finish(response: Any, t0: float) -> Any:
        if outcome.exc is None:
            return response
        latency_ms = int((time.monotonic() - t0) * 1000)
        # ``response`` is the answer the post_call was built from. When its
        # own stop reason already filed the llm_error (openai 3.x hands a
        # content-filtered completion to ContentFilterFinishReasonError, so
        # the post_call sees finish_reason content_filter), the exception
        # is the same failure and is not reported a second time.
        if not _stop_reason_already_reported(provider, response):
            base._emit_error(session, provider, outcome.exc, latency_ms, kwargs)
        if return_raw:
            return outcome.raw
        raise outcome.exc

    if is_async:

        async def _wrapped_async(**call_kwargs: Any) -> Any:
            try:
                return _answered(await real_fn(**call_kwargs))
            except Exception as exc:
                return _failed(exc)

        async def _async_parse() -> Any:
            t0 = time.monotonic()
            try:
                response = await base.call_async(_wrapped_async, kwargs, session, provider)
            except Exception as exc:
                if outcome.unreadable is not None and exc is outcome.unreadable:
                    return outcome.raw
                raise
            return _finish(response, t0)

        return _async_parse()

    def _wrapped(**call_kwargs: Any) -> Any:
        try:
            return _answered(real_fn(**call_kwargs))
        except Exception as exc:
            return _failed(exc)

    t0 = time.monotonic()
    try:
        response = base.call(_wrapped, kwargs, session, provider)
    except Exception as exc:
        if outcome.unreadable is not None and exc is outcome.unreadable:
            return outcome.raw
        raise
    return _finish(response, t0)


def _parse_via_raw(
    resource: Any,
    kwargs: dict[str, Any],
    session: Session,
    provider: OpenAIProvider,
    *,
    is_async: bool,
) -> Any:
    """``parse()`` on a chat-completions or Responses resource, fetched
    through the resource's own raw-response closure so the sensor sees
    the response before the SDK parses it (see :func:`_call_parse`). The
    caller gets the parsed object, or the SDK's exception, exactly as
    from the plain ``parse()``. A resource that is itself a raw-response
    wrapper (a client reached through ``with_raw_response``) has no
    ``with_raw_response`` of its own; its caller asked for the raw
    response and gets it, as for ``create``."""
    raw_resource = getattr(resource, "with_raw_response", None)
    if raw_resource is None:
        return _call_parse(
            resource.parse, kwargs, session, provider, is_async=is_async, return_raw=True
        )
    return _call_parse(
        raw_resource.parse, kwargs, session, provider, is_async=is_async, return_raw=False
    )


def _is_sdk_stream(obj: Any) -> bool:
    """Whether a parsed view response is the SDK's event stream."""
    if _openai_module is None:
        return False
    return isinstance(obj, (_openai_module.Stream, _openai_module.AsyncStream))


def _given(kwargs: dict[str, Any]) -> dict[str, Any]:
    """``kwargs`` without the SDK's not-given sentinels. The SDK's
    ``.stream()`` helpers pass every parameter of ``create`` explicitly,
    the unset ones as ``NOT_GIVEN`` / ``omit``; the request is the same
    without them, and the sensor must not meet them as request values
    (they are not JSON)."""
    sentinels = tuple(
        cls
        for cls in (
            getattr(_openai_module, "NotGiven", None),
            getattr(_openai_module, "Omit", None),
        )
        if isinstance(cls, type)
    )
    if not sentinels:
        return kwargs
    return {key: value for key, value in kwargs.items() if not isinstance(value, sentinels)}


class _HelperRequest:
    """``self`` for the SDK's own ``.stream()`` helper. The helper builds
    its request by calling ``self.create(..., stream=True)`` and wraps the
    raw stream it gets back in its event stream (``ChatCompletionStream``
    / ``ResponseStream``). Run with this object as ``self``, that call
    reaches the sensor proxy's ``create``, so the request takes the
    stream guard and the helper reads its raw events through the guard;
    the caller gets the SDK's own manager and event stream. Every other
    attribute (``retrieve`` for resuming a stored response) is the
    proxy's. The guards the helper opened are kept so the manager's exit
    can settle them."""

    def __init__(self, proxy: Any) -> None:
        self._proxy = proxy
        self.guards: list[Any] = []

    def create(self, **kwargs: Any) -> Any:
        result = self._proxy.create(**_given(kwargs))
        if inspect.iscoroutine(result):

            async def _opened() -> Any:
                guard = await result
                self.guards.append(guard)
                return guard

            return _opened()
        self.guards.append(result)
        return result

    def __getattr__(self, name: str) -> Any:
        return getattr(self._proxy, name)


class _HelperStreamManager:
    """The SDK's ``.stream()`` manager, whose exit also settles the stream
    guard the helper read through. The SDK's exit closes the HTTP
    response, which the guard does not see; leaving it to the guard's
    finalizer would delay the post_call of a stream the caller left early
    until the next intercepted call. The guard's exit takes the same
    exception the caller's block raised, so a provider failure, an early
    exit and a full read are reported as on every other stream."""

    def __init__(self, manager: Any, request: _HelperRequest) -> None:
        self._manager = manager
        self._request = request

    def _adopt(self, helper: Any) -> Any:
        """Point the guard at the helper's own assembly: the helper keeps
        the SDK's stream state for the events it reads through the guard,
        so the guard does not assemble them a second time. Done before
        the helper reads its first event."""
        for guard in self._request.guards:
            guard.use_accumulator(helper_stream_accumulator(helper))
        return helper

    def __enter__(self) -> Any:
        return self._adopt(self._manager.__enter__())

    def __exit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> Any:
        try:
            return self._manager.__exit__(exc_type, exc_val, exc_tb)
        finally:
            for guard in self._request.guards:
                guard.__exit__(exc_type, exc_val, exc_tb)

    async def __aenter__(self) -> Any:
        return self._adopt(await self._manager.__aenter__())

    async def __aexit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> Any:
        try:
            return await self._manager.__aexit__(exc_type, exc_val, exc_tb)
        finally:
            for guard in self._request.guards:
                await guard.__aexit__(exc_type, exc_val, exc_tb)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._manager, name)


def _helper_stream(proxy: Any, real: Any, kwargs: dict[str, Any]) -> Any:
    """``real.stream(**kwargs)`` with its request sent through ``proxy``
    (see :class:`_HelperRequest`). A resource whose class has no
    ``stream`` helper is called as it is."""
    helper = getattr(type(real), "stream", None)
    if not callable(helper):
        return real.stream(**kwargs)
    request = _HelperRequest(proxy)
    return _HelperStreamManager(helper(request, **kwargs), request)


def _stream_options_for(kwargs: dict[str, Any]) -> tuple[dict[str, Any], Any]:
    """A chat request with ``stream=True`` gets ``stream_options
    .include_usage`` (see :func:`_inject_stream_options`) and the guard
    hides the usage chunk from a caller who did not ask for it. Returns
    the kwargs to send and the guard's ``hide_chunk``."""
    if not kwargs.get("stream"):
        return kwargs, None
    call_kwargs, caller_asked_for_usage = _inject_stream_options(kwargs)
    return call_kwargs, (None if caller_asked_for_usage else _is_usage_only_chunk)


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

        Async streaming is supported via
        :func:`base.call_stream_async`. Sync and async streaming go through
        guarded wrappers that measure TTFT, chunk count, and abort
        reasons.
        """
        if raw_views.body_unread(kwargs):
            # A streaming-view call, or a raw-view call with stream=True:
            # metered when the caller parses the response.
            call_kwargs, hide_chunk = _stream_options_for(kwargs)
            return raw_views.send_deferred(
                self._real.create,
                call_kwargs,
                self._session,
                self._provider,
                is_async=self._is_async,
                is_stream=_is_sdk_stream,
                hide_chunk=hide_chunk,
            )
        if kwargs.get("stream"):
            # A caller who did not ask for usage gets the stream exactly as
            # it would be without the sensor; the guard keeps the usage.
            call_kwargs, hide_chunk = _stream_options_for(kwargs)
            if self._is_async:
                # Native ``AsyncOpenAI.chat.completions.create(stream=
                # True)`` returns a coroutine that resolves to an
                # ``AsyncStream``, so the guarded call is wrapped in a
                # coroutine too; returning the guard synchronously would
                # make ``await client.chat.completions.create(stream=
                # True)`` raise ``TypeError: GuardedAsyncStream object
                # can't be awaited``.
                async def _async_stream_create() -> base.GuardedAsyncStream:
                    guard = base.call_stream_async(
                        self._real.create,
                        call_kwargs,
                        self._session,
                        self._provider,
                        hide_chunk=hide_chunk,
                    )
                    # Opened eagerly so provider errors surface at the
                    # awaited create(), as on the unguarded SDK.
                    return await guard.open()

                return _async_stream_create()
            return base.call_stream(
                self._real.create,
                call_kwargs,
                self._session,
                self._provider,
                hide_chunk=hide_chunk,
            ).open()

        real_fn = self._real.create
        if self._is_async:
            return base.call_async(real_fn, kwargs, self._session, self._provider)
        return base.call(real_fn, kwargs, self._session, self._provider)

    def parse(self, **kwargs: Any) -> Any:
        """Intercept chat.completions.parse() (structured outputs).

        Same pre/post intercept as a non-streaming ``create()``; the
        returned ``ParsedChatCompletion`` carries the usual ``usage`` and
        the request id the SDK stamps on it. A completion the provider
        billed but the SDK could not parse (``LengthFinishReasonError``,
        ``ContentFilterFinishReasonError``, a schema failure) lands as a
        ``post_call`` followed by the ``llm_error``; see
        :func:`_call_parse`.
        """
        return _view_aware_parse(
            self._real, kwargs, self._session, self._provider, is_async=self._is_async
        )

    def stream(self, **kwargs: Any) -> Any:
        """Intercept chat.completions.stream(): the SDK's own helper,
        whose request goes through :meth:`create` with ``stream=True`` and
        so takes the stream guard. The caller gets the SDK's manager and
        ``ChatCompletionStream`` (its events, ``get_final_completion()``
        and ``current_completion_snapshot`` unchanged)."""
        return _helper_stream(self, self._real, kwargs)

    @property
    def with_streaming_response(self) -> Any:
        """The SDK's streaming view built over this proxy: its ``create``
        and ``parse`` reach this proxy with the view's header and are
        metered when the caller parses the response."""
        return type(self._real.with_streaming_response)(self)

    @property
    def with_raw_response(self) -> _SensorRawResponseWrapper:
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
        ``.create()`` and ``.parse()`` run the sensor pre/post intercept
        around the captured raw-response closures. The closures still
        inject the ``X-Stainless-Raw-Response`` header so the framework
        gets the same return shape it expects (``LegacyAPIResponse``).
        """
        return _SensorRawResponseWrapper(
            self._real.with_raw_response,
            self._session,
            self._provider,
            is_async=self._is_async,
            chat=True,
        )

    def __getattr__(self, name: str) -> Any:
        return getattr(self._real, name)


def _view_aware_parse(
    real: Any,
    kwargs: dict[str, Any],
    session: Session,
    provider: OpenAIProvider,
    *,
    is_async: bool,
) -> Any:
    """``parse()`` on a chat-completions or Responses resource. Through
    the streaming view (whose body is unread) it is metered when the
    caller parses the response; through a client-level raw view the
    caller gets the raw response, metered as the resource's own
    ``with_raw_response.parse()`` is; otherwise see
    :func:`_parse_via_raw`."""
    mode = raw_views.raw_response_mode(kwargs)
    if mode == raw_views.RAW_MODE_STREAM:
        return raw_views.send_deferred(
            real.parse, kwargs, session, provider, is_async=is_async, is_stream=_is_sdk_stream
        )
    if mode in raw_views.RAW_MODES_READ:
        return _call_parse(
            real.parse, kwargs, session, provider, is_async=is_async, return_raw=True
        )
    return _parse_via_raw(real, kwargs, session, provider, is_async=is_async)


class _SensorRawResponseWrapper:
    """Sensor proxy for the SDK's ``*WithRawResponse`` resource wrappers
    (``CompletionsWithRawResponse`` on the langchain-openai path,
    ``ResponsesWithRawResponse``, and their async counterparts).

    Wraps the SDK's raw-response wrapper instance and runs the sensor's
    pre/post intercept around its ``create`` and ``parse`` closures. Each
    closure is the result of ``_legacy_response.to_raw_response_wrapper``
    over the real bound method -- treating it as the ``real_fn`` passed
    into ``base.call`` / ``base.call_async`` produces the same intercept
    behavior the direct ``create()`` path provides, while preserving the
    SDK's raw-response return shape (``LegacyAPIResponse``), whose
    headers carry the rate-limit and request-id metadata.

    Pass-through ``__getattr__`` delegates ``.retrieve``, ``.update``,
    ``.list``, ``.delete``, ``.cancel`` etc to the underlying SDK wrapper
    unchanged: ``create`` and ``parse`` are the methods that make an LLM
    call worth metering.
    """

    def __init__(
        self,
        real_wrapper: Any,
        session: Session,
        provider: OpenAIProvider,
        *,
        is_async: bool = False,
        chat: bool = False,
    ) -> None:
        self._real = real_wrapper
        self._session = session
        self._provider = provider
        self._is_async = is_async
        # Chat streams need stream_options.include_usage to carry usage;
        # Responses streams carry it on their terminal event.
        self._chat = chat

    def create(self, **kwargs: Any) -> Any:
        """Intercept the raw-response create closure with the sensor pipeline.

        With ``stream=True`` the body is the event stream, unread when the
        caller gets the raw response: the call is metered when the caller
        parses it, and the parsed stream takes the stream guard (see
        :mod:`flightdeck_sensor.interceptor.raw_views`). langchain-openai
        takes this path with ``include_response_headers=True``.
        """
        real_fn = self._real.create
        if kwargs.get("stream"):
            call_kwargs, hide_chunk = _stream_options_for(kwargs) if self._chat else (kwargs, None)
            return raw_views.send_deferred(
                real_fn,
                call_kwargs,
                self._session,
                self._provider,
                is_async=self._is_async,
                is_stream=_is_sdk_stream,
                hide_chunk=hide_chunk,
            )
        if self._is_async:
            return base.call_async(real_fn, kwargs, self._session, self._provider)
        return base.call(real_fn, kwargs, self._session, self._provider)

    def parse(self, **kwargs: Any) -> Any:
        """Intercept the raw-response parse closure with the sensor pipeline.

        The raw response is parsed eagerly so a billed-but-failed parse is
        reported here rather than silently at the caller's ``.parse()``;
        see :func:`_call_parse`.
        """
        return _call_parse(
            self._real.parse,
            kwargs,
            self._session,
            self._provider,
            is_async=self._is_async,
            return_raw=True,
        )

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
    def completions(self) -> Any:
        """Return a :class:`SensorCompletions` proxy -- or the SDK's own
        ``completions`` resource while an outer interceptor (litellm) is
        making the call, since that interceptor already meters it (see
        ``base.outer_intercept``). Typed ``Any`` for every caller: the
        two results share no named type, and callers use either as the
        SDK's ``completions`` resource."""
        if base.outer_intercept_active():
            return self._real.completions
        return SensorCompletions(
            self._real.completions,
            self._session,
            self._provider,
            is_async=self._is_async,
        )

    def __getattr__(self, name: str) -> Any:
        return getattr(self._real, name)


class SensorResponses:
    """Proxy for ``client.responses`` -- intercepts ``create()``, ``parse()``
    and ``with_raw_response``.

    OpenAI's Responses API (March 2025 and recommended for all new
    projects) lives at ``OpenAI.responses``, a direct sibling of
    ``OpenAI.chat``. ``create(stream=True)`` calls take the stream guard, and so
    does the ``responses.stream()`` helper, whose request goes through
    ``create``.

    Token usage extraction is handled by :class:`OpenAIProvider` which
    falls back to ``usage.input_tokens`` / ``usage.output_tokens``
    (the Responses API shape) when the chat shape is absent, and whose
    tool-invocation extraction covers the tool call items in
    ``response.output``; the shared post-call path in
    :mod:`flightdeck_sensor.interceptor.base` emits one ``tool_call``
    event per invocation.
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
        """Intercept responses.create() -- sync or async dispatch.

        ``stream=True`` takes the stream guard: Responses streams carry
        their usage on the ``response.completed`` event, which the guard
        reads as the chunk passes through. No ``stream_options`` injection
        is needed on this API.
        """
        real_fn = self._real.create
        if raw_views.body_unread(kwargs):
            return raw_views.send_deferred(
                real_fn,
                kwargs,
                self._session,
                self._provider,
                is_async=self._is_async,
                is_stream=_is_sdk_stream,
            )
        if kwargs.get("stream"):
            if self._is_async:

                async def _async_stream_create() -> base.GuardedAsyncStream:
                    guard = base.call_stream_async(real_fn, kwargs, self._session, self._provider)
                    # Opened eagerly so provider errors surface at create().
                    return await guard.open()

                return _async_stream_create()
            return base.call_stream(real_fn, kwargs, self._session, self._provider).open()
        if self._is_async:
            return base.call_async(real_fn, kwargs, self._session, self._provider)
        return base.call(real_fn, kwargs, self._session, self._provider)

    def parse(self, **kwargs: Any) -> Any:
        """Intercept responses.parse() (structured outputs).

        Same pre/post intercept as a non-streaming ``create()``; the
        returned ``ParsedResponse`` carries the usual ``usage`` and the
        request id the SDK stamps on it. A response that fails the
        caller's ``text_format`` schema lands as a ``post_call`` followed
        by the ``llm_error``; see :func:`_call_parse`.
        """
        return _view_aware_parse(
            self._real, kwargs, self._session, self._provider, is_async=self._is_async
        )

    def stream(self, **kwargs: Any) -> Any:
        """Intercept responses.stream(): the SDK's own helper, whose
        request for a new response goes through :meth:`create` with
        ``stream=True`` and so takes the stream guard. Resuming a stored
        response (``stream(response_id=...)``) re-reads one that was
        already generated and passes through to the SDK's ``retrieve``."""
        return _helper_stream(self, self._real, kwargs)

    @property
    def with_streaming_response(self) -> Any:
        """The SDK's streaming view built over this proxy (see
        :attr:`SensorCompletions.with_streaming_response`)."""
        return type(self._real.with_streaming_response)(self)

    @property
    def with_raw_response(self) -> _SensorRawResponseWrapper:
        """Return an intercept wrapper for ``responses.with_raw_response``.

        As on chat completions, the SDK's ``ResponsesWithRawResponse``
        captures the unwrapped ``create`` / ``parse`` bound methods at
        construction time, so letting ``__getattr__`` fall through to it
        would bypass the sensor for every raw-response call.
        """
        return _SensorRawResponseWrapper(
            self._real.with_raw_response,
            self._session,
            self._provider,
            is_async=self._is_async,
        )

    def __getattr__(self, name: str) -> Any:
        # Pass through: retrieve, delete, cancel, connect, compact,
        # input_items, input_tokens.
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

        Emits ``event_type="embeddings"`` (not the generic
        ``post_call``) so the dashboard can render embedding calls
        distinctly. Token accounting stays identical -- embeddings carry
        input tokens only, ``output_tokens=0`` as returned by
        :meth:`OpenAIProvider.extract_usage`.
        """
        real_fn = self._real.create
        # An outer interceptor (litellm) making this call already meters
        # it: hand the call to the SDK untouched (see base.outer_intercept).
        if base.outer_intercept_active():
            return real_fn(**kwargs)
        if raw_views.body_unread(kwargs):
            # The streaming view: metered when the caller parses it.
            return raw_views.send_deferred(
                real_fn,
                kwargs,
                self._session,
                self._provider,
                is_async=self._is_async,
                is_stream=_is_sdk_stream,
                event_type=EventType.EMBEDDINGS,
            )
        if self._is_async:
            return base.call_async(
                real_fn,
                kwargs,
                self._session,
                self._provider,
                event_type=EventType.EMBEDDINGS,
            )
        return base.call(
            real_fn,
            kwargs,
            self._session,
            self._provider,
            event_type=EventType.EMBEDDINGS,
        )

    @property
    def with_streaming_response(self) -> Any:
        """The SDK's streaming view built over this proxy (see
        :attr:`SensorCompletions.with_streaming_response`)."""
        return type(self._real.with_streaming_response)(self)

    @property
    def with_raw_response(self) -> Any:
        """The SDK's raw view built over this proxy; its ``create`` reaches
        this proxy with the view's header and is metered like a plain
        call."""
        return type(self._real.with_raw_response)(self)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._real, name)


class SensorBeta:
    """Proxy for ``client.beta`` on a ``wrap()``-built client --
    intercepts ``.chat`` (``beta.chat.completions.parse()`` /
    ``.stream()``); every other beta resource passes through."""

    def __init__(
        self,
        real_beta: Any,
        session: Session,
        provider: OpenAIProvider,
        *,
        is_async: bool = False,
    ) -> None:
        self._real = real_beta
        self._session = session
        self._provider = provider
        self._is_async = is_async

    @property
    def chat(self) -> Any:
        """A :class:`SensorChat` over the beta ``chat`` resource; the
        resource itself when the class patch already wrapped it, so a
        client that is both wrapped and patched is metered once."""
        real_chat = self._real.chat
        if isinstance(real_chat, SensorChat):
            return real_chat
        return SensorChat(real_chat, self._session, self._provider, is_async=self._is_async)

    def __getattr__(self, name: str) -> Any:
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
        self._provider = provider or _provider_for(client, session)

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

    @property
    def beta(self) -> SensorBeta:
        """Return a :class:`SensorBeta` proxy that intercepts ``beta.chat``."""
        return SensorBeta(
            self._client.beta,
            self._session,
            self._provider,
            is_async=self._is_async,
        )

    def with_options(self, **kwargs: Any) -> SensorOpenAI:
        """Return a new SensorOpenAI wrapping a client with updated options."""
        new_client = self._client.with_options(**kwargs)
        return SensorOpenAI(new_client, self._session, self._provider)

    @property
    def with_raw_response(self) -> Any:
        """The SDK's raw client view built over this proxy, so
        ``client.with_raw_response.chat.completions.create`` reaches the
        sensor's resource proxies with the view's header, as on a
        class-patched client."""
        return type(self._client.with_raw_response)(self)

    @property
    def with_streaming_response(self) -> Any:
        """The SDK's streaming client view built over this proxy (see
        :attr:`with_raw_response`)."""
        return type(self._client.with_streaming_response)(self)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._client, name)


def _inject_stream_options(kwargs: dict[str, Any]) -> tuple[dict[str, Any], bool]:
    """Inject ``stream_options={"include_usage": True}`` into a copy of kwargs.

    OpenAI does not return token usage in streaming responses by default.
    This option makes the final chunk carry a ``usage`` field. Returns the
    kwargs to send and whether the caller had asked for usage themselves,
    in which case that chunk is theirs; otherwise the guard absorbs it.
    """
    result = copy.copy(kwargs)
    existing = result.get("stream_options")
    caller_asked = isinstance(existing, dict) and bool(existing.get("include_usage"))
    if isinstance(existing, dict):
        existing = {**existing, "include_usage": True}
        result["stream_options"] = existing
    else:
        result["stream_options"] = {"include_usage": True}
    return result, caller_asked


def _is_usage_only_chunk(chunk: Any) -> bool:
    """The chunk OpenAI appends when usage was requested: it carries
    ``usage`` and an empty ``choices`` list, which the usual loop body
    (``chunk.choices[0]``) does not expect."""
    return getattr(chunk, "usage", None) is not None and not getattr(chunk, "choices", None)


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

    The Anthropic interceptor patches the resource classes instead (see
    ``interceptor/anthropic.py``). On first access on a given instance,
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

    def _client_of(self, instance: Any) -> Any:
        """The client whose endpoint the provider is attributed to."""
        return instance

    def __get__(self, instance: Any, owner: type | None = None) -> Any:
        if instance is None:
            return self

        raw = self._original.func(instance)

        session = _current_session()
        if session is None:
            return raw

        provider = _provider_for(self._client_of(instance), session)
        wrapped = SensorChat(
            raw,
            session,
            provider,
            is_async=self._is_async,
        )

        if self._attr_name is not None:
            instance.__dict__[self._attr_name] = wrapped

        return wrapped


class _OpenAIBetaChatDescriptor(_OpenAIChatDescriptor):
    """Replacement for the ``chat`` cached_property on the SDK's ``Beta``
    / ``AsyncBeta`` resource (``client.beta.chat``), so
    ``client.beta.chat.completions.parse()`` and ``.stream()`` are
    intercepted as ``client.chat.completions`` is. The instance is the
    beta resource; the provider is attributed to the client it holds."""

    def _client_of(self, instance: Any) -> Any:
        return getattr(instance, "_client", instance)


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

        provider = _provider_for(instance, session)
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

        provider = _provider_for(instance, session)
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

# The ``chat`` resource on ``Beta`` / ``AsyncBeta`` (``client.beta.chat``)
# and the sentinel holding its original cached_property. Patched on the
# beta resource classes rather than the client classes, so it sits
# outside the client table above.
BETA_CHAT_ATTR = "chat"
_BETA_CHAT_SENTINEL = "_flightdeck_patched_beta_chat"


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
    ``embeddings``. See :data:`_OPENAI_PATCH_RESOURCES`. The ``chat``
    resource of ``client.beta`` is patched on the SDK's ``Beta`` /
    ``AsyncBeta`` classes the same way, where the SDK has it.

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
    for beta_cls, is_async in ((_OrigBeta, False), (_OrigAsyncBeta, True)):
        # Only where the installed SDK's beta resource has a ``chat``.
        if beta_cls is not None and BETA_CHAT_ATTR in beta_cls.__dict__:
            _patch_one_resource(
                beta_cls,
                attr_name=BETA_CHAT_ATTR,
                sentinel_attr=_BETA_CHAT_SENTINEL,
                descriptor_cls=_OpenAIBetaChatDescriptor,
                is_async=is_async,
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
    for beta_cls in (_OrigBeta, _OrigAsyncBeta):
        if beta_cls is not None:
            _unpatch_one_resource(
                beta_cls, attr_name=BETA_CHAT_ATTR, sentinel_attr=_BETA_CHAT_SENTINEL
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
