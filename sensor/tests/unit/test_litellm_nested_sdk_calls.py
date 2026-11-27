"""An SDK call made while a litellm call is in flight is an ordinary call,
and litellm's own request is still reported once.

A litellm call runs under its mark, and the SDK interceptors hand the one
provider request litellm itself sends through the OpenAI SDK on the
call's behalf to the SDK untouched, since the litellm wrapper reports it.
Every other SDK call made while the litellm call is in flight -- by a
litellm callback (here ``CustomLogger.log_pre_api_call``, which litellm
runs inside the call, before its request), by a task or thread that
callback starts in a copy of the call's context, through the OpenAI,
Anthropic or google-genai SDK -- is policed when made, reported once, and
captured as the session's capture setting says. A litellm call made from
inside an SDK call is a call of its own, and so is its own request
counted once.

Every provider is a mock transport recording the requests it received;
nothing leaves the process.
"""

from __future__ import annotations

import asyncio
import contextlib
import contextvars
import importlib.util
import inspect
import json
import threading
import types
from typing import TYPE_CHECKING, Any

import pytest

litellm = pytest.importorskip("litellm")

import anthropic  # noqa: E402
import httpx  # noqa: E402
import openai  # noqa: E402
from litellm.integrations.custom_logger import CustomLogger  # noqa: E402

import flightdeck_sensor  # noqa: E402
from flightdeck_sensor.core.exceptions import BudgetExceededError  # noqa: E402
from flightdeck_sensor.core.policy import PolicyCache  # noqa: E402
from flightdeck_sensor.interceptor import base  # noqa: E402
from flightdeck_sensor.interceptor.anthropic import (  # noqa: E402
    patch_anthropic_classes,
    unpatch_anthropic_classes,
)
from flightdeck_sensor.interceptor.litellm import (  # noqa: E402
    patch_litellm_functions,
    unpatch_litellm_functions,
)
from flightdeck_sensor.interceptor.openai import (  # noqa: E402
    patch_openai_classes,
    unpatch_openai_classes,
)

from ._stream_parity_fakes import events_of, make_session  # noqa: E402

if TYPE_CHECKING:
    from collections.abc import Callable, Iterator

    from flightdeck_sensor.core.session import Session

litellm.suppress_debug_info = True

MESSAGES = [{"role": "user", "content": "hi"}]
# The models the outer litellm call and the inner SDK call name, so each
# event says whose it is.
OUTER_MODEL = "gpt-4o-mini"
INNER_MODEL = "gpt-4.1-nano"
INNER_ANTHROPIC_MODEL = "claude-haiku-4-5"
INNER_GEMINI_MODEL = "gemini-3.1-flash-lite"
# The inner call's prompt: text no other call sends, so its stored
# content is recognisable.
INNER_PROMPT = "the callback's own question"
# A prompt whose estimate alone is over a 200-token limit.
LONG_PROMPT = "word " * 2000
# (input, output) every fake reports.
USAGE = (31, 4)


class _Provider:
    """One provider's mock transport: answers every request with ``reply``
    and records the request bodies."""

    def __init__(self, reply: Callable[[dict[str, Any], str], httpx.Response]) -> None:
        self._reply = reply
        self.bodies: list[dict[str, Any]] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content or b"{}")
        self.bodies.append(body)
        return self._reply(body, request.url.path)


def _openai_reply(body: dict[str, Any], path: str) -> httpx.Response:
    prompt, completion = USAGE
    usage = {
        "prompt_tokens": prompt,
        "completion_tokens": completion,
        "total_tokens": prompt + completion,
    }
    if path.endswith("/embeddings"):
        data = [{"object": "embedding", "index": 0, "embedding": [0.5, 0.25]}]
        return httpx.Response(
            200,
            json={"object": "list", "data": data, "model": body["model"], "usage": usage},
        )
    head = {"id": "cmpl-nested", "created": 1700000000, "model": body["model"]}
    legacy = not path.endswith("/chat/completions")
    if body.get("stream"):
        if legacy:
            events: list[dict[str, Any]] = [
                {
                    **head,
                    "object": "text_completion",
                    "choices": [
                        {"text": "ok", "index": 0, "logprobs": None, "finish_reason": "stop"}
                    ],
                }
            ]
        else:
            events = [
                {
                    **head,
                    "object": "chat.completion.chunk",
                    "choices": [
                        {
                            "index": 0,
                            "delta": {"role": "assistant", "content": "ok"},
                            "finish_reason": "stop",
                        }
                    ],
                }
            ]
        if (body.get("stream_options") or {}).get("include_usage"):
            events.append({**head, "object": events[0]["object"], "choices": [], "usage": usage})
        sse = "".join(f"data: {json.dumps(e)}\n\n" for e in events) + "data: [DONE]\n\n"
        return httpx.Response(
            200, content=sse.encode(), headers={"content-type": "text/event-stream"}
        )
    if legacy:
        choice: dict[str, Any] = {
            "text": "ok",
            "index": 0,
            "logprobs": None,
            "finish_reason": "stop",
        }
        return httpx.Response(
            200, json={**head, "object": "text_completion", "choices": [choice], "usage": usage}
        )
    choice = {
        "index": 0,
        "message": {"role": "assistant", "content": "ok"},
        "finish_reason": "stop",
    }
    return httpx.Response(
        200, json={**head, "object": "chat.completion", "choices": [choice], "usage": usage}
    )


def _anthropic_reply(body: dict[str, Any], _path: str) -> httpx.Response:
    prompt, completion = USAGE
    return httpx.Response(
        200,
        json={
            "id": "msg_nested",
            "type": "message",
            "role": "assistant",
            "model": body["model"],
            "content": [{"type": "text", "text": "ok"}],
            "stop_reason": "end_turn",
            "stop_sequence": None,
            "usage": {"input_tokens": prompt, "output_tokens": completion},
        },
    )


def _gemini_reply(_body: dict[str, Any], _path: str) -> httpx.Response:
    prompt, completion = USAGE
    return httpx.Response(
        200,
        json={
            "candidates": [
                {"content": {"parts": [{"text": "ok"}], "role": "model"}, "finishReason": "STOP"}
            ],
            "usageMetadata": {
                "promptTokenCount": prompt,
                "candidatesTokenCount": completion,
                "totalTokenCount": prompt + completion,
            },
            "modelVersion": INNER_GEMINI_MODEL,
        },
    )


def _openai_client(provider: _Provider, *, is_async: bool = False) -> Any:
    transport = httpx.MockTransport(provider)
    if is_async:
        return openai.AsyncOpenAI(api_key="k", http_client=httpx.AsyncClient(transport=transport))
    return openai.OpenAI(api_key="k", http_client=httpx.Client(transport=transport))


def _azure_client(provider: _Provider, *, is_async: bool = False) -> Any:
    options = {"api_key": "k", "api_version": "2024-10-21", "azure_endpoint": AZURE_ENDPOINT}
    transport = httpx.MockTransport(provider)
    if is_async:
        return openai.AsyncAzureOpenAI(
            **options, http_client=httpx.AsyncClient(transport=transport)
        )
    return openai.AzureOpenAI(**options, http_client=httpx.Client(transport=transport))


AZURE_ENDPOINT = "https://fd-nested.openai.azure.com"
AZURE = {"api_key": "k", "api_version": "2024-10-21", "api_base": AZURE_ENDPOINT}


@contextlib.contextmanager
def _callback(callback: CustomLogger) -> Iterator[None]:
    """``callback`` registered with litellm for the block. litellm copies
    ``litellm.callbacks`` into its other callback lists at each call, so
    every one is put back as it was afterwards, or the callback would run
    in later tests."""
    lists = {
        name: list(value)
        for name, value in vars(litellm).items()
        if name.endswith(("callback", "callbacks")) and isinstance(value, list)
    }
    litellm.callbacks = [*litellm.callbacks, callback]
    try:
        yield
    finally:
        for name, value in lists.items():
            getattr(litellm, name)[:] = value


def _patch() -> None:
    from flightdeck_sensor.interceptor import google_genai

    patch_litellm_functions(quiet=True)
    patch_openai_classes(quiet=True)
    patch_anthropic_classes(quiet=True)
    google_genai.patch_google_genai(quiet=True)


def _unpatch() -> None:
    from flightdeck_sensor.interceptor import google_genai

    unpatch_litellm_functions(quiet=True)
    unpatch_openai_classes()
    unpatch_anthropic_classes()
    google_genai.unpatch_google_genai()


@pytest.fixture
def sensor(monkeypatch: pytest.MonkeyPatch) -> Iterator[Callable[..., Session]]:
    """``sensor(capture_prompts=...)``: a recording session, active, with
    every SDK patched as ``flightdeck_sensor.patch()`` patches them."""

    def _start(*, capture_prompts: bool = False) -> Session:
        session = make_session(capture_prompts=capture_prompts)
        monkeypatch.setattr(flightdeck_sensor, "_session", session)
        _patch()
        return session

    try:
        yield _start
    finally:
        _unpatch()


def _calls(session: Session) -> list[tuple[str, str | None]]:
    """(event type, model) of every call event, in order."""
    kinds = ("pre_call", "post_call", "llm_error", "embeddings")
    queue: Any = session.event_queue
    return [
        (c.args[0]["event_type"], c.args[0].get("model"))
        for c in queue.enqueue.call_args_list
        if c.args[0].get("event_type") in kinds
    ]


def _reported_once(session: Session, model: str) -> dict[str, Any]:
    """The one post_call for ``model``, after its one pre_call."""
    pre_calls = [e for e in events_of(session, "pre_call") if e.get("model") == model]
    post_calls = [e for e in events_of(session, "post_call") if e.get("model") == model]
    assert len(pre_calls) == 1, _calls(session)
    assert len(post_calls) == 1, _calls(session)
    return post_calls[0]


# ----- the callback's SDK call, made in the call, in a task, in a thread -----


def _inner_openai(provider: _Provider, prompt: str = INNER_PROMPT) -> Callable[[], Any]:
    client = _openai_client(provider)

    def _call() -> Any:
        return client.chat.completions.create(
            model=INNER_MODEL, messages=[{"role": "user", "content": prompt}]
        )

    return _call


def _inner_anthropic(provider: _Provider, prompt: str = INNER_PROMPT) -> Callable[[], Any]:
    client = anthropic.Anthropic(
        api_key="k", http_client=httpx.Client(transport=httpx.MockTransport(provider))
    )

    def _call() -> Any:
        return client.messages.create(
            model=INNER_ANTHROPIC_MODEL,
            max_tokens=8,
            messages=[{"role": "user", "content": prompt}],
        )

    return _call


def _inner_gemini(provider: _Provider, prompt: str = INNER_PROMPT) -> Callable[[], Any]:
    from google import genai
    from google.genai import types

    client = genai.Client(
        api_key="k",
        http_options=types.HttpOptions(
            httpx_client=httpx.Client(transport=httpx.MockTransport(provider))
        ),
    )

    def _call() -> Any:
        return client.models.generate_content(model=INNER_GEMINI_MODEL, contents=prompt)

    return _call


INNER = {
    "openai": (_inner_openai, _openai_reply, INNER_MODEL),
    "anthropic": (_inner_anthropic, _anthropic_reply, INNER_ANTHROPIC_MODEL),
    "google": (_inner_gemini, _gemini_reply, INNER_GEMINI_MODEL),
}


def _google_genai_installed() -> bool:
    try:
        return importlib.util.find_spec("google.genai") is not None
    except ModuleNotFoundError:
        return False


# The SDK-majors lane installs no google-genai.
_GOOGLE = pytest.param(
    "google",
    marks=pytest.mark.skipif(not _google_genai_installed(), reason="google-genai not installed"),
)
SDKS = ["openai", "anthropic", _GOOGLE]


class _SDKCallInTheCall(CustomLogger):  # type: ignore[misc]
    """A callback litellm runs inside the call, before its request, that
    makes an SDK call of its own: in the call itself, in a thread started
    in a copy of the call's context, or in a task it creates, which runs
    while the call awaits its request (``release`` is set once the task's
    call is made, and the outer provider answers only then). Whether the
    call's mark is active is read where the SDK call runs."""

    def __init__(
        self, inner: Callable[[], Any], where: str, release: asyncio.Event | None = None
    ) -> None:
        super().__init__()
        self._inner = inner
        self._where = where
        self._release = release
        self.marked: list[bool] = []
        self.raised: list[BaseException] = []
        self.task: asyncio.Task[Any] | None = None

    def _run(self) -> Any:
        self.marked.append(base.outer_intercept_active())
        try:
            return self._inner()
        except BaseException as exc:
            self.raised.append(exc)
            raise

    def log_pre_api_call(self, model: Any, messages: Any, kwargs: Any) -> None:
        if self._where == "in the call":
            self._run()
        elif self._where == "in a thread with the call's context":
            context = contextvars.copy_context()
            thread = threading.Thread(target=context.run, args=(self._run,))
            thread.start()
            thread.join()
        elif self._where == "in a task created in the call":
            # A task inherits a copy of the call's context.
            self.task = asyncio.get_running_loop().create_task(self._in_a_task())

    async def _in_a_task(self) -> None:
        try:
            await asyncio.to_thread(self._run)
        finally:
            assert self._release is not None
            self._release.set()


class _HeldProvider(_Provider):
    """An async provider that answers once ``release`` is set."""

    def __init__(self, reply: Callable[[dict[str, Any], str], httpx.Response]) -> None:
        super().__init__(reply)
        self.release = asyncio.Event()

    async def __call__(self, request: httpx.Request) -> httpx.Response:  # type: ignore[override]
        response = super().__call__(request)
        await self.release.wait()
        return response


WHERE_SYNC = ("in the call", "in a thread with the call's context")


@pytest.mark.parametrize("sdk", SDKS)
@pytest.mark.parametrize("where", WHERE_SYNC)
def test_a_callbacks_sdk_call_is_reported_and_litellms_own_request_once(
    sensor: Callable[..., Session], sdk: str, where: str
) -> None:
    session = sensor()
    build, reply, inner_model = INNER[sdk]
    inner_provider = _Provider(reply)
    outer_provider = _Provider(_openai_reply)
    hook = _SDKCallInTheCall(build(inner_provider), where)
    with _callback(hook):
        response = litellm.completion(
            model=OUTER_MODEL, messages=MESSAGES, client=_openai_client(outer_provider)
        )
    assert response.choices[0].message.content == "ok"
    assert hook.marked == [True]  # it ran while the litellm call was in flight
    assert len(outer_provider.bodies) == 1
    assert len(inner_provider.bodies) == 1
    outer = _reported_once(session, OUTER_MODEL)
    inner = _reported_once(session, inner_model)
    assert (outer["tokens_input"], outer["tokens_output"]) == USAGE
    assert (inner["tokens_input"], inner["tokens_output"]) == USAGE
    assert len(events_of(session, "pre_call")) == 2


@pytest.mark.parametrize("stream", [False, True], ids=["whole", "stream"])
def test_a_callbacks_sdk_call_in_a_task_the_async_call_created_is_reported(
    sensor: Callable[..., Session], stream: bool
) -> None:
    """The task inherits the call's context, with the call's mark, and
    runs its SDK call while the call awaits its own request."""
    session = sensor()
    inner_provider = _Provider(_openai_reply)

    async def _run() -> None:
        outer_provider = _HeldProvider(_openai_reply)
        hook = _SDKCallInTheCall(
            _inner_openai(inner_provider), "in a task created in the call", outer_provider.release
        )
        with _callback(hook):
            made = await litellm.acompletion(
                model=OUTER_MODEL,
                messages=MESSAGES,
                stream=stream,
                client=_openai_client(outer_provider, is_async=True),
            )
            if stream:
                [chunk async for chunk in made]
        assert hook.task is not None
        await hook.task
        assert hook.marked == [True]
        assert len(outer_provider.bodies) == 1

    asyncio.run(_run())
    assert len(inner_provider.bodies) == 1
    _reported_once(session, OUTER_MODEL)
    _reported_once(session, INNER_MODEL)


# ----- policy and capture apply to the callback's call --------------------


@pytest.mark.parametrize("sdk", SDKS)
def test_block_stops_a_callbacks_sdk_call_before_its_request_leaves(
    sensor: Callable[..., Session], sdk: str
) -> None:
    """The litellm call is under the limit; the callback's call, whose
    prompt alone is over it, is refused at entry and sends nothing."""
    session = sensor()
    session.policy = PolicyCache(token_limit=200, block_at_pct=100)
    build, reply, _inner_model = INNER[sdk]
    inner_provider = _Provider(reply)
    outer_provider = _Provider(_openai_reply)
    hook = _SDKCallInTheCall(build(inner_provider, LONG_PROMPT), "in the call")
    with _callback(hook):
        litellm.completion(
            model=OUTER_MODEL, messages=MESSAGES, client=_openai_client(outer_provider)
        )
    assert len(hook.raised) == 1
    assert isinstance(hook.raised[0], BudgetExceededError)
    assert inner_provider.bodies == []  # nothing left
    assert len(outer_provider.bodies) == 1
    _reported_once(session, OUTER_MODEL)
    assert len(events_of(session, "policy_block")) == 1


@pytest.mark.parametrize("capture", [False, True], ids=["capture-off", "capture-on"])
def test_a_callbacks_sdk_call_is_captured_as_the_session_says(
    sensor: Callable[..., Session], capture: bool
) -> None:
    session = sensor(capture_prompts=capture)
    inner_provider = _Provider(_openai_reply)
    hook = _SDKCallInTheCall(_inner_openai(inner_provider), "in the call")
    with _callback(hook):
        litellm.completion(
            model=OUTER_MODEL, messages=MESSAGES, client=_openai_client(_Provider(_openai_reply))
        )
    inner = _reported_once(session, INNER_MODEL)
    if capture:
        assert inner["has_content"] is True
        assert inner["content"]["messages"] == [{"role": "user", "content": INNER_PROMPT}]
    else:
        assert inner["has_content"] is False
        assert inner.get("content") is None
        assert INNER_PROMPT not in json.dumps(events_of(session, "post_call"))


# ----- litellm's own request through the OpenAI SDK is reported once -------

# (entry point, model, client builder, extra arguments, path): every
# request litellm's OpenAI and Azure routes send through the SDK.
OWN_REQUESTS = {
    "openai chat": ("completion", OUTER_MODEL, _openai_client, {}),
    "openai legacy text": ("text_completion", "gpt-3.5-turbo-instruct", _openai_client, {}),
    "openai embedding": ("embedding", "text-embedding-3-small", _openai_client, {}),
    "azure chat": ("completion", "azure/fd-chat", _azure_client, AZURE),
    "azure legacy text": ("text_completion", "azure_text/fd-instruct", _azure_client, AZURE),
    "azure embedding": ("embedding", "azure/fd-embedder", _azure_client, AZURE),
}


def _forwards(value: Any) -> bool:
    """Whether :class:`_ForwardingProxy` hands ``value`` back wrapped: an
    SDK resource or a sensor proxy of one, or a method of either."""
    module = type(value).__module__ or ""
    return (
        module.startswith(("openai.resources", "flightdeck_sensor"))
        or inspect.ismethod(value)
        or inspect.isfunction(value)
    )


class _ForwardingProxy:
    """A proxy around an SDK client, as instrumentation and test doubles
    build them: it resolves every attribute in its own ``__getattr__``
    (``client.chat.completions`` included), hands back resources and
    methods wrapped in itself, forwards calls in its own ``__call__``, and
    passes for the client's class. No code of its own lies between the
    caller and the SDK."""

    def __init__(self, target: Any) -> None:
        object.__setattr__(self, "_target", target)

    @property  # type: ignore[misc]
    def __class__(self) -> type:  # noqa: D105
        return type(object.__getattribute__(self, "_target"))

    def __getattr__(self, name: str) -> Any:
        value = getattr(object.__getattribute__(self, "_target"), name)
        return _ForwardingProxy(value) if _forwards(value) else value

    def __call__(self, *args: Any, **kwargs: Any) -> Any:
        return object.__getattribute__(self, "_target")(*args, **kwargs)


# How the client litellm is handed is built: as the SDK makes it, or
# behind a forwarding proxy.
CLIENT_WRAPPERS: dict[str, Callable[[Any], Any]] = {
    "plain client": lambda client: client,
    "forwarding proxy": _ForwardingProxy,
}


def _own_rows() -> list[Any]:
    rows = []
    for wrapper in CLIENT_WRAPPERS:
        for name, (entry, *_rest) in OWN_REQUESTS.items():
            for is_async in (False, True):
                streams = (False,) if entry == "embedding" else (False, True)
                for stream in streams:
                    made = "async" if is_async else "sync"
                    shape = "stream" if stream else "whole"
                    rows.append(
                        pytest.param(
                            wrapper, name, is_async, stream, id=f"{wrapper}-{name}-{made}-{shape}"
                        )
                    )
    return rows


@pytest.mark.parametrize(("wrapper", "name", "is_async", "stream"), _own_rows())
def test_litellms_own_request_through_the_sdk_is_reported_once(
    sensor: Callable[..., Session], wrapper: str, name: str, is_async: bool, stream: bool
) -> None:
    """Also behind a proxy that forwards attribute lookups and calls: the
    walk to litellm's request function steps over its forwarding frames."""
    session = sensor()
    entry, model, build, extra = OWN_REQUESTS[name]
    provider = _Provider(_openai_reply)
    client = CLIENT_WRAPPERS[wrapper](build(provider, is_async=is_async))
    kwargs: dict[str, Any] = {"model": model, "client": client, **extra}
    if entry == "embedding":
        kwargs["input"] = ["hi"]
    elif entry == "text_completion":
        kwargs["prompt"] = "hi"
    else:
        kwargs["messages"] = MESSAGES
    if stream:
        kwargs["stream"] = True

    async def _async() -> None:
        made = await getattr(litellm, f"a{entry}")(**kwargs)
        if stream:
            [chunk async for chunk in made]

    if is_async:
        asyncio.run(_async())
    else:
        made = getattr(litellm, entry)(**kwargs)
        if stream:
            list(made)
    ends = events_of(session, "post_call") + events_of(session, "embeddings")
    assert len(events_of(session, "pre_call")) == 1, _calls(session)
    assert len(ends) == 1, _calls(session)
    assert events_of(session, "llm_error") == []
    assert len(provider.bodies) == 1


# ----- a litellm call made from inside an SDK call --------------------------


def test_a_litellm_call_made_inside_an_sdk_call_is_a_call_of_its_own(
    sensor: Callable[..., Session],
) -> None:
    """An httpx event hook on an OpenAI client runs inside that client's
    request; a litellm call it makes is reported, and litellm's own
    request inside it once."""
    session = sensor()
    nested_provider = _Provider(_openai_reply)
    nested_client = _openai_client(nested_provider)
    made: list[Any] = []

    def _on_request(_request: httpx.Request) -> None:
        if not made:
            made.append(
                litellm.completion(model=INNER_MODEL, messages=MESSAGES, client=nested_client)
            )

    outer_provider = _Provider(_openai_reply)
    client = openai.OpenAI(
        api_key="k",
        http_client=httpx.Client(
            transport=httpx.MockTransport(outer_provider),
            event_hooks={"request": [_on_request]},
        ),
    )
    client.chat.completions.create(model=OUTER_MODEL, messages=MESSAGES)
    assert len(made) == 1
    assert len(outer_provider.bodies) == 1
    assert len(nested_provider.bodies) == 1
    _reported_once(session, OUTER_MODEL)
    _reported_once(session, INNER_MODEL)


def test_a_custom_providers_sdk_request_is_reported_beside_the_litellm_call(
    sensor: Callable[..., Session],
) -> None:
    """Pins a known double count: a litellm custom provider (``CustomLLM``)
    sends its request through the OpenAI SDK from its own code, not from
    litellm's, so the one request is reported as the litellm call and as
    the SDK call rather than risk hiding a billed one."""
    session = sensor()
    provider = _Provider(_openai_reply)
    client = _openai_client(provider)

    class _Handler(litellm.CustomLLM):  # type: ignore[misc]
        def completion(self, *_args: Any, **kwargs: Any) -> Any:
            sent = client.chat.completions.create(model=INNER_MODEL, messages=kwargs["messages"])
            return litellm.ModelResponse(
                model=INNER_MODEL,
                choices=[
                    {"message": {"role": "assistant", "content": sent.choices[0].message.content}}
                ],
                usage=sent.usage.model_dump(),
            )

    kept = list(litellm.custom_provider_map)
    litellm.custom_provider_map = [{"provider": "fd-custom", "custom_handler": _Handler()}]
    try:
        litellm.completion(model="fd-custom/served", messages=MESSAGES)
    finally:
        litellm.custom_provider_map = kept
    assert len(provider.bodies) == 1
    assert len(events_of(session, "pre_call")) == 2
    assert [e["model"] for e in events_of(session, "post_call")] == [INNER_MODEL, INNER_MODEL]


class _TracingWrapper:
    """A client wrapper that puts a function of its own between its caller
    and the SDK: its ``chat.completions.create`` records the call, then
    sends it. That function could send requests of its own, so a request
    it sends is never taken for litellm's own."""

    def __init__(self, client: Any) -> None:
        self._client = client
        self.traced: list[str] = []
        self.chat = types.SimpleNamespace(
            completions=types.SimpleNamespace(create=self._create, with_raw_response=self)
        )

    def _create(self, **kwargs: Any) -> Any:
        self.traced.append(kwargs["model"])
        return self._client.chat.completions.create(**kwargs)

    def create(self, **kwargs: Any) -> Any:
        """``with_raw_response.create``, as litellm calls it."""
        self.traced.append(kwargs["model"])
        return self._client.chat.completions.with_raw_response.create(**kwargs)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._client, name)

    @property  # type: ignore[misc]
    def __class__(self) -> type:  # noqa: D105
        return type(self._client)


def test_a_request_through_a_wrapper_function_of_its_own_is_reported_twice(
    sensor: Callable[..., Session],
) -> None:
    """Pins a known double count: litellm's request reaches the SDK through
    a function of the client wrapper's own (a tracing ``create``), so the
    one request is reported as the litellm call and as the SDK call rather
    than risk hiding requests that function makes itself."""
    session = sensor()
    provider = _Provider(_openai_reply)
    wrapper = _TracingWrapper(_openai_client(provider))
    litellm.completion(model=OUTER_MODEL, messages=MESSAGES, client=wrapper)
    assert wrapper.traced == [OUTER_MODEL]
    assert len(provider.bodies) == 1
    assert len(events_of(session, "pre_call")) == 2
    assert len(events_of(session, "post_call")) == 2


def _inner_through_a_proxy(provider: _Provider, prompt: str = INNER_PROMPT) -> Callable[[], Any]:
    """The callback's OpenAI SDK call through a forwarding proxy of its
    own client: the proxy's frames are stepped over, and the callback's
    own frame decides."""
    client = _ForwardingProxy(_openai_client(provider))

    def _call() -> Any:
        return client.chat.completions.create(
            model=INNER_MODEL, messages=[{"role": "user", "content": prompt}]
        )

    return _call


@pytest.mark.parametrize("prompt", [INNER_PROMPT, LONG_PROMPT], ids=["allowed", "blocked"])
def test_a_callbacks_sdk_call_through_its_own_proxy_is_policed_and_reported(
    sensor: Callable[..., Session], prompt: str
) -> None:
    session = sensor()
    session.policy = PolicyCache(token_limit=200, block_at_pct=100)
    inner_provider = _Provider(_openai_reply)
    outer_provider = _Provider(_openai_reply)
    hook = _SDKCallInTheCall(_inner_through_a_proxy(inner_provider, prompt), "in the call")
    with _callback(hook):
        litellm.completion(
            model=OUTER_MODEL, messages=MESSAGES, client=_openai_client(outer_provider)
        )
    assert len(outer_provider.bodies) == 1
    _reported_once(session, OUTER_MODEL)
    if prompt is LONG_PROMPT:
        assert len(hook.raised) == 1
        assert isinstance(hook.raised[0], BudgetExceededError)
        assert inner_provider.bodies == []
        assert len(events_of(session, "policy_block")) == 1
    else:
        assert hook.raised == []
        assert len(inner_provider.bodies) == 1
        _reported_once(session, INNER_MODEL)


# ----- an SDK call an Anthropic resource override makes ---------------------
#
# A wrap()-built Anthropic client whose messages resource overrides
# ``create`` and calls ``super()`` runs the override under a mark of the
# Anthropic patch's own, so the patched base method it re-enters hands
# the request through. That mark owns the Anthropic SDK's calls only: a
# call the override makes through another SDK is an ordinary one.

CLAUDE_MODEL = "claude-haiku-4-5"
OTHER_SDKS = ["openai", _GOOGLE]


def _claude_client(provider: _Provider, *, is_async: bool) -> Any:
    transport = httpx.MockTransport(provider)
    if is_async:
        return anthropic.AsyncAnthropic(
            api_key="k", http_client=httpx.AsyncClient(transport=transport)
        )
    return anthropic.Anthropic(api_key="k", http_client=httpx.Client(transport=transport))


def _overriding_messages(
    inner: Callable[[], Any], raised: list[BaseException], is_async: bool
) -> Any:
    from anthropic.resources.messages.messages import AsyncMessages, Messages

    def _ask() -> None:
        try:
            inner()
        except BudgetExceededError as exc:
            raised.append(exc)

    if is_async:

        class _AsyncOverriding(AsyncMessages):
            async def create(self, **kwargs: Any) -> Any:  # type: ignore[override]
                _ask()
                return await super().create(**kwargs)

        return _AsyncOverriding

    class _Overriding(Messages):
        def create(self, **kwargs: Any) -> Any:  # type: ignore[override]
            _ask()
            return super().create(**kwargs)

    return _Overriding


def _through_the_override(
    session: Session, inner: Callable[[], Any], *, is_async: bool
) -> tuple[_Provider, list[BaseException]]:
    from flightdeck_sensor.interceptor.anthropic import SensorAnthropic

    claude = _Provider(_anthropic_reply)
    client = _claude_client(claude, is_async=is_async)
    raised: list[BaseException] = []
    client.messages = _overriding_messages(inner, raised, is_async)(client)
    wrapped = SensorAnthropic(client, session)
    result = wrapped.messages.create(model=CLAUDE_MODEL, max_tokens=8, messages=MESSAGES)
    if inspect.isawaitable(result):

        async def _await() -> Any:
            return await result

        asyncio.run(_await())
    return claude, raised


@pytest.mark.parametrize("capture", [False, True], ids=["capture-off", "capture-on"])
@pytest.mark.parametrize("is_async", [False, True], ids=["sync", "async"])
@pytest.mark.parametrize("sdk", OTHER_SDKS)
def test_another_sdks_call_an_anthropic_override_makes_is_reported_once(
    sensor: Callable[..., Session], sdk: str, is_async: bool, capture: bool
) -> None:
    session = sensor(capture_prompts=capture)
    build, reply, inner_model = INNER[sdk]
    inner_provider = _Provider(reply)
    claude, raised = _through_the_override(session, build(inner_provider), is_async=is_async)
    assert raised == []
    assert len(claude.bodies) == 1
    assert len(inner_provider.bodies) == 1
    _reported_once(session, CLAUDE_MODEL)
    inner = _reported_once(session, inner_model)
    assert (inner["tokens_input"], inner["tokens_output"]) == USAGE
    if capture:
        assert inner["has_content"] is True
        assert INNER_PROMPT in json.dumps(inner["content"])
    else:
        assert inner["has_content"] is False
        assert inner.get("content") is None
        assert INNER_PROMPT not in json.dumps(events_of(session, "post_call"))


@pytest.mark.parametrize("sdk", OTHER_SDKS)
def test_block_stops_another_sdks_call_an_anthropic_override_makes(
    sensor: Callable[..., Session], sdk: str
) -> None:
    session = sensor()
    session.policy = PolicyCache(token_limit=200, block_at_pct=100)
    build, reply, _inner_model = INNER[sdk]
    inner_provider = _Provider(reply)
    claude, raised = _through_the_override(
        session, build(inner_provider, LONG_PROMPT), is_async=False
    )
    assert len(raised) == 1
    assert inner_provider.bodies == []  # nothing left
    assert len(events_of(session, "policy_block")) == 1
    assert len(claude.bodies) == 1
    _reported_once(session, CLAUDE_MODEL)


class _SDKCallWhenTheRequestIsSent(CustomLogger):  # type: ignore[misc]
    """A callback litellm runs once a request has been sent
    (``log_post_api_call``), which makes an SDK call of its own. For a
    stream that sends its request at its first read (Gemini's routes),
    that is inside the first read, which runs under the litellm call's
    mark."""

    def __init__(self, inner: Callable[[], Any]) -> None:
        super().__init__()
        self._inner = inner
        self.marked: list[bool] = []

    def log_post_api_call(
        self, kwargs: Any, response_obj: Any, start_time: Any, end_time: Any
    ) -> None:
        self.marked.append(base.outer_intercept_active())
        self._inner()


def test_a_callbacks_sdk_call_during_a_no_session_streams_first_read_is_reported(
    sensor: Callable[..., Session], monkeypatch: pytest.MonkeyPatch
) -> None:
    """A Gemini stream made while no session was active finds its session
    at its first read and reads under a litellm mark of its own; a
    callback's SDK call made during that read is the callback's,
    reported."""
    from litellm.llms.custom_httpx.http_handler import HTTPHandler

    from ._stream_parity_fakes import GEMINI_USAGE, GeminiServer

    session = sensor()
    monkeypatch.setattr(flightdeck_sensor, "_session", None)
    gemini = GeminiServer()
    handler = HTTPHandler()
    handler.client = httpx.Client(transport=httpx.MockTransport(gemini))
    inner_provider = _Provider(_openai_reply)
    hook = _SDKCallWhenTheRequestIsSent(_inner_openai(inner_provider))
    with _callback(hook):
        stream = litellm.completion(
            model="gemini/gemini-2.0-flash",
            messages=MESSAGES,
            stream=True,
            client=handler,
            api_key="k",
        )
        assert gemini.bodies == []  # sent at the first read
        monkeypatch.setattr(flightdeck_sensor, "_session", session)
        list(stream)
    assert hook.marked == [True]
    assert len(gemini.bodies) == 1
    assert len(inner_provider.bodies) == 1
    # The stream's pre_call names the model asked for, its post_call the
    # model that answered; the callback's call sits between them.
    assert _calls(session) == [
        ("pre_call", "gemini/gemini-2.0-flash"),
        ("pre_call", INNER_MODEL),
        ("post_call", INNER_MODEL),
        ("post_call", "gemini-2.0-flash"),
    ]
    outer = events_of(session, "post_call")[-1]
    assert (outer["tokens_input"], outer["tokens_output"]) == GEMINI_USAGE


# ----- a litellm Router's stream --------------------------------------------
#
# A Router stream is litellm's own stream class, handed back by the sensor
# as an instance of a subclass under litellm's own module. Its reads, and
# a Router's fetch of a stream that sends at its first read, run under
# the attempt's litellm mark; the walk that tells litellm's own request
# apart reads the calling functions, not the stream's class.


@pytest.mark.parametrize("is_async", [False, True], ids=["sync", "async"])
@pytest.mark.parametrize("group", ["chat", "gemini"], ids=["openai-sdk-route", "gemini-route"])
def test_a_router_streams_own_request_is_reported_once_and_a_callbacks_call_beside_it(
    sensor: Callable[..., Session], group: str, is_async: bool
) -> None:
    """litellm's own request for a Router attempt (through the OpenAI SDK on
    the chat route) is reported once, as the attempt; a callback's SDK
    call made once that request is sent (on the Gemini route, inside the
    Router's fetch or the stream's first read) is reported beside it."""
    from litellm.litellm_core_utils.streaming_handler import CustomStreamWrapper

    from ._router_fakes import TEXT, FakeProvider
    from ._router_fakes import USAGE as ROUTER_USAGE

    session = sensor()
    inner_provider = _Provider(_openai_reply)
    hook = _SDKCallWhenTheRequestIsSent(_inner_openai(inner_provider))
    with FakeProvider() as fake, _callback(hook):
        router = litellm.Router(
            model_list=[
                {
                    "model_name": "chat",
                    "litellm_params": {
                        "model": "openai/fd-chat",
                        "api_base": f"{fake.base}/v1",
                        "api_key": "k",
                    },
                },
                {
                    "model_name": "gemini",
                    "litellm_params": {
                        "model": "gemini/gemini-2.0-flash",
                        "api_base": fake.base,
                        "api_key": "k",
                    },
                },
            ],
            num_retries=0,
        )
        litellm.in_memory_llm_clients_cache.flush_cache()
        if is_async:

            async def _read() -> tuple[Any, list[Any]]:
                made = await router.acompletion(model=group, messages=MESSAGES, stream=True)
                return made, [chunk async for chunk in made]

            stream, chunks = asyncio.run(_read())
        else:
            stream = router.completion(model=group, messages=MESSAGES, stream=True)
            chunks = list(stream)
        sent = fake.paths()
    assert isinstance(stream, CustomStreamWrapper)
    assert "".join(c.choices[0].delta.content or "" for c in chunks) == "".join(TEXT)
    assert len(sent) == 1
    assert hook.marked == [True]
    assert len(inner_provider.bodies) == 1
    _reported_once(session, INNER_MODEL)
    attempts = [e for e in events_of(session, "post_call") if e.get("model") != INNER_MODEL]
    assert len(attempts) == 1
    assert (attempts[0]["tokens_input"], attempts[0]["tokens_output"]) == ROUTER_USAGE
    assert len(events_of(session, "pre_call")) == 2
