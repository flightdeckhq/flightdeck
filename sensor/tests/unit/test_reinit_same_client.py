"""A client or framework object kept across ``teardown()`` and a new
``init()``: every call reports to the session active when it is made, and
with the sensor torn down it goes to the SDK untouched (ARCHITECTURE.md,
"A new session after teardown").

Driven through the real ``init`` / ``patch`` / ``teardown`` against the
local control-plane stub, with the provider mocked at the HTTP boundary
(respx), so the SDKs build their own resources, raw and streaming views
and streams. Every event the sensor builds is recorded with its session,
including events built for a session that has already ended, whose queue
no longer delivers them: a call made while torn down must build none.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import TYPE_CHECKING, Any

import anthropic
import httpx
import openai
import pytest
import respx

import flightdeck_sensor
from flightdeck_sensor.core.policy import PolicyCache
from flightdeck_sensor.core.session import Session
from flightdeck_sensor.interceptor.anthropic import unpatch_anthropic_classes
from flightdeck_sensor.interceptor.openai import unpatch_openai_classes

if TYPE_CHECKING:
    from collections.abc import Callable, Iterator

ANTHROPIC_MODEL = "claude-haiku-4-5"
OPENAI_MODEL = "gpt-4o-mini"
PROMPT = "SECRET-PROMPT-reinit-6b2e"
HI = [{"role": "user", "content": PROMPT}]
ANTHROPIC_REQUEST: dict[str, Any] = {"model": ANTHROPIC_MODEL, "max_tokens": 10, "messages": HI}
OPENAI_REQUEST: dict[str, Any] = {"model": OPENAI_MODEL, "messages": HI}

# The events one metered call builds (a session's own start and end are
# not calls).
CALL_EVENTS = frozenset({"pre_call", "post_call", "embeddings", "llm_error", "tool_call"})

# The control-plane variables a developer's shell may carry; init() reads
# them over its kwargs.
_SENSOR_ENV = (
    "FLIGHTDECK_SERVER",
    "FLIGHTDECK_TOKEN",
    "FLIGHTDECK_API_URL",
    "FLIGHTDECK_SESSION_ID",
    "FLIGHTDECK_CAPTURE_PROMPTS",
)


# ----- the provider, at the HTTP boundary -----------------------------------


def _sse(frames: list[tuple[str | None, Any]]) -> httpx.Response:
    body = ""
    for event, data in frames:
        head = f"event: {event}\n" if event else ""
        body += f"{head}data: {data if isinstance(data, str) else json.dumps(data)}\n\n"
    return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=body.encode())


MESSAGE: dict[str, Any] = {
    "id": "msg_reinit",
    "type": "message",
    "role": "assistant",
    "model": ANTHROPIC_MODEL,
    "content": [{"type": "text", "text": "Hello"}],
    "stop_reason": "end_turn",
    "stop_sequence": None,
    "usage": {"input_tokens": 12, "output_tokens": 9},
}


def _anthropic_reply(request: httpx.Request) -> httpx.Response:
    if json.loads(request.content or b"{}").get("stream") is not True:
        return httpx.Response(200, json=MESSAGE, headers={"request-id": "req_reinit"})
    start = {**MESSAGE, "content": [], "stop_reason": None}
    start["usage"] = {"input_tokens": 12, "output_tokens": 1}
    return _sse(
        [
            ("message_start", {"type": "message_start", "message": start}),
            (
                "content_block_start",
                {
                    "type": "content_block_start",
                    "index": 0,
                    "content_block": {"type": "text", "text": ""},
                },
            ),
            (
                "content_block_delta",
                {
                    "type": "content_block_delta",
                    "index": 0,
                    "delta": {"type": "text_delta", "text": "Hello"},
                },
            ),
            ("content_block_stop", {"type": "content_block_stop", "index": 0}),
            (
                "message_delta",
                {
                    "type": "message_delta",
                    "delta": {"stop_reason": "end_turn", "stop_sequence": None},
                    "usage": {"output_tokens": 9},
                },
            ),
            ("message_stop", {"type": "message_stop"}),
        ]
    )


USAGE = {"prompt_tokens": 12, "completion_tokens": 9, "total_tokens": 21}


def _chunk(delta: dict[str, Any], finish: str | None) -> dict[str, Any]:
    return {
        "id": "chatcmpl-reinit",
        "object": "chat.completion.chunk",
        "created": 1,
        "model": OPENAI_MODEL,
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
    }


def _openai_reply(request: httpx.Request) -> httpx.Response:
    if json.loads(request.content or b"{}").get("stream") is not True:
        return httpx.Response(
            200,
            json={
                "id": "chatcmpl-reinit",
                "object": "chat.completion",
                "created": 1,
                "model": OPENAI_MODEL,
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": "Hello"},
                        "finish_reason": "stop",
                    }
                ],
                "usage": USAGE,
            },
        )
    usage_chunk = {**_chunk({}, None), "choices": [], "usage": USAGE}
    return _sse(
        [
            (None, _chunk({"role": "assistant", "content": "Hel"}, None)),
            (None, _chunk({"content": "lo"}, None)),
            (None, _chunk({}, "stop")),
            (None, usage_chunk),
            (None, "[DONE]"),
        ]
    )


EMBEDDINGS = {
    "object": "list",
    "data": [{"object": "embedding", "index": 0, "embedding": [0.1, 0.2]}],
    "model": "text-embedding-3-small",
    "usage": {"prompt_tokens": 4, "total_tokens": 4},
}


@pytest.fixture
def provider() -> Iterator[respx.MockRouter]:
    with respx.mock(assert_all_called=False) as router:
        router.post("https://api.anthropic.com/v1/messages").mock(side_effect=_anthropic_reply)
        router.post("https://api.openai.com/v1/chat/completions", name="chat").mock(
            side_effect=_openai_reply
        )
        router.post("https://api.openai.com/v1/embeddings").mock(
            return_value=httpx.Response(200, json=EMBEDDINGS)
        )
        yield router


# ----- the sensor, through its public lifecycle -----------------------------


class _ControlPlane(BaseHTTPRequestHandler):
    """Answers every control-plane request with an empty envelope. Which
    session each event belongs to is read where the sensor builds it."""

    def _ok(self) -> None:
        self.rfile.read(int(self.headers.get("Content-Length", 0)))
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"status": "ok", "directive": null}')

    def do_POST(self) -> None:
        self._ok()

    def do_GET(self) -> None:
        self._ok()

    def log_message(self, *_args: Any) -> None:
        pass


# How often the stub's serve loop checks for shutdown (the default is half
# a second), so the module's teardown does not wait on it.
_STUB_POLL_SECS = 0.05


@pytest.fixture(scope="module")
def control_plane() -> Iterator[str]:
    """One local control-plane stub for the module: every test starts and
    ends two sessions against it."""
    server = ThreadingHTTPServer(("127.0.0.1", 0), _ControlPlane)
    thread = threading.Thread(
        target=server.serve_forever, kwargs={"poll_interval": _STUB_POLL_SECS}, daemon=True
    )
    thread.start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()
    server.server_close()


class _Sensor:
    """``init`` / ``patch`` / ``teardown`` against the control-plane stub,
    naming each session; ``run`` returns the call events a call built, as
    ``(session name, event type)`` pairs."""

    def __init__(self, url: str, built: list[dict[str, Any]]) -> None:
        self._url = url
        self._built = built
        self.names: dict[str, str] = {}

    def start(self, name: str, *, capture: bool = False, patch: bool = True) -> None:
        flightdeck_sensor.init(
            server=self._url + "/ingest", token="tok", quiet=True, capture_prompts=capture
        )
        if patch:
            flightdeck_sensor.patch(quiet=True)
        session = flightdeck_sensor._session
        assert session is not None
        self.names[session.config.session_id] = name

    def stop(self) -> None:
        flightdeck_sensor.teardown()

    def run(self, call: Callable[[], Any]) -> list[tuple[str, str]]:
        return [
            (self.names.get(p["session_id"], "?"), p["event_type"]) for p in self.payloads(call)
        ]

    def payloads(self, call: Callable[[], Any]) -> list[dict[str, Any]]:
        start = len(self._built)
        result = call()
        if asyncio.iscoroutine(result):
            asyncio.run(result)
        return [p for p in self._built[start:] if p["event_type"] in CALL_EVENTS]


@pytest.fixture
def sensor(control_plane: str, monkeypatch: pytest.MonkeyPatch) -> Iterator[_Sensor]:
    for name in _SENSOR_ENV:
        monkeypatch.delenv(name, raising=False)
    # The runtime context (host, git, orchestration probes) is not what
    # these tests are about, and collecting it twice per test is most of
    # their time.
    monkeypatch.setattr(flightdeck_sensor, "_collect_context", dict)
    built: list[dict[str, Any]] = []
    build = Session._build_payload

    def _recording(self: Session, event_type: Any, **extra: Any) -> dict[str, Any]:
        payload = build(self, event_type, **extra)
        built.append(payload)
        return payload

    monkeypatch.setattr(Session, "_build_payload", _recording)
    yield _Sensor(control_plane, built)
    with contextlib.suppress(Exception):
        flightdeck_sensor.teardown()
    unpatch_anthropic_classes()
    unpatch_openai_classes()


def _names(events: list[tuple[str, str]], name: str) -> list[tuple[str, str]]:
    return [(name, kind) for _, kind in events]


def _assert_follows_the_session(sensor: _Sensor, call: Callable[[], Any]) -> None:
    """Session one, then torn down, then session two, the same call each
    time: it reports to the session active at the call, and nothing while
    the sensor is down."""
    first = sensor.run(call)
    assert first, "the call was not metered under the first session"
    assert first == _names(first, "s1")
    sensor.stop()

    assert sensor.run(call) == []

    sensor.start("s2")
    assert sensor.run(call) == _names(first, "s2")


# ----- the SDK clients, every call path ------------------------------------


def _anthropic_clients() -> tuple[Any, Any]:
    return (
        anthropic.Anthropic(api_key="k", max_retries=0),
        anthropic.AsyncAnthropic(api_key="k", max_retries=0),
    )


def _openai_clients() -> tuple[Any, Any]:
    return (
        openai.OpenAI(api_key="k", max_retries=0),
        openai.AsyncOpenAI(api_key="k", max_retries=0),
    )


def _a_stream_helper(clients: tuple[Any, Any]) -> None:
    with clients[0].messages.stream(**ANTHROPIC_REQUEST) as stream:
        stream.get_final_message()


async def _a_async_stream_helper(clients: tuple[Any, Any]) -> None:
    async with clients[1].messages.stream(**ANTHROPIC_REQUEST) as stream:
        await stream.get_final_message()


def _a_streaming_view(clients: tuple[Any, Any]) -> None:
    with clients[0].messages.with_streaming_response.create(**ANTHROPIC_REQUEST) as response:
        response.parse()


async def _a_async_raw_view(clients: tuple[Any, Any]) -> None:
    response = await clients[1].messages.with_raw_response.create(**ANTHROPIC_REQUEST)
    parsed = response.parse()
    if asyncio.iscoroutine(parsed):
        await parsed


ANTHROPIC_CALLS: dict[str, Callable[[tuple[Any, Any]], Any]] = {
    "create": lambda c: c[0].messages.create(**ANTHROPIC_REQUEST),
    "create-stream": lambda c: list(c[0].messages.create(**ANTHROPIC_REQUEST, stream=True)),
    "stream-helper": _a_stream_helper,
    "raw-view": lambda c: c[0].messages.with_raw_response.create(**ANTHROPIC_REQUEST).parse(),
    "raw-view-stream": lambda c: list(
        c[0].messages.with_raw_response.create(**ANTHROPIC_REQUEST, stream=True).parse()
    ),
    "streaming-view": _a_streaming_view,
    "beta-raw-view": lambda c: (
        c[0].beta.messages.with_raw_response.create(**ANTHROPIC_REQUEST).parse()
    ),
    "async-create": lambda c: c[1].messages.create(**ANTHROPIC_REQUEST),
    "async-stream-helper": _a_async_stream_helper,
    "async-raw-view": _a_async_raw_view,
}


def _o_stream_helper(clients: tuple[Any, Any]) -> None:
    with clients[0].chat.completions.stream(**OPENAI_REQUEST) as stream:
        stream.get_final_completion()


async def _o_async_stream(clients: tuple[Any, Any]) -> None:
    stream = await clients[1].chat.completions.create(**OPENAI_REQUEST, stream=True)
    async for _ in stream:
        pass


OPENAI_CALLS: dict[str, Callable[[tuple[Any, Any]], Any]] = {
    "create": lambda c: c[0].chat.completions.create(**OPENAI_REQUEST),
    "create-stream": lambda c: list(c[0].chat.completions.create(**OPENAI_REQUEST, stream=True)),
    "stream-helper": _o_stream_helper,
    "raw-view": lambda c: c[0].chat.completions.with_raw_response.create(**OPENAI_REQUEST).parse(),
    "client-raw-view": lambda c: (
        c[0].with_raw_response.chat.completions.create(**OPENAI_REQUEST).parse()
    ),
    "embeddings": lambda c: c[0].embeddings.create(model="text-embedding-3-small", input="x"),
    "async-create": lambda c: c[1].chat.completions.create(**OPENAI_REQUEST),
    "async-create-stream": _o_async_stream,
}


@pytest.mark.parametrize("built", ["before-init", "under-the-first-session"])
@pytest.mark.parametrize("name", sorted(ANTHROPIC_CALLS))
def test_an_anthropic_client_kept_across_teardown_reports_to_the_active_session(
    sensor: _Sensor, provider: respx.MockRouter, name: str, built: str
) -> None:
    clients = _anthropic_clients() if built == "before-init" else None
    sensor.start("s1")
    kept = clients or _anthropic_clients()
    _assert_follows_the_session(sensor, lambda: ANTHROPIC_CALLS[name](kept))


@pytest.mark.parametrize("built", ["before-init", "under-the-first-session"])
@pytest.mark.parametrize("name", sorted(OPENAI_CALLS))
def test_an_openai_client_kept_across_teardown_reports_to_the_active_session(
    sensor: _Sensor, provider: respx.MockRouter, name: str, built: str
) -> None:
    clients = _openai_clients() if built == "before-init" else None
    sensor.start("s1")
    kept = clients or _openai_clients()
    _assert_follows_the_session(sensor, lambda: OPENAI_CALLS[name](kept))


def test_a_kept_chat_completions_resource_reports_to_the_active_session(
    sensor: _Sensor, provider: respx.MockRouter
) -> None:
    """langchain-openai keeps ``client.chat.completions`` for the model's
    lifetime; the proxy it got under the first session follows on."""
    sensor.start("s1")
    completions = openai.OpenAI(api_key="k", max_retries=0).chat.completions
    _assert_follows_the_session(
        sensor, lambda: completions.with_raw_response.create(**OPENAI_REQUEST).parse()
    )


def test_a_raw_view_first_built_while_torn_down_is_metered_in_the_next_session(
    sensor: _Sensor, provider: respx.MockRouter
) -> None:
    """An SDK view caches what it wraps on first access; built while the
    sensor is down over a client the patch already wrapped, it still holds
    the sensor's proxies, so the next session meters it."""
    sensor.start("s1")
    client = openai.OpenAI(api_key="k", max_retries=0)
    assert sensor.run(lambda: client.chat.completions.create(**OPENAI_REQUEST))
    sensor.stop()

    view = client.with_raw_response.chat.completions
    assert sensor.run(lambda: view.create(**OPENAI_REQUEST).parse()) == []

    sensor.start("s2")
    assert sensor.run(lambda: view.create(**OPENAI_REQUEST).parse()) == [
        ("s2", "pre_call"),
        ("s2", "post_call"),
    ]


# ----- torn down: the SDK gets the call untouched ---------------------------


def test_a_streamed_chat_call_while_torn_down_reaches_the_sdk_unchanged(
    sensor: _Sensor, provider: respx.MockRouter
) -> None:
    """The sensor adds ``stream_options.include_usage`` to every streamed
    chat call and hides the usage chunk from a caller who did not ask for
    it; with the sensor torn down neither happens."""
    route = provider.routes["chat"]
    sensor.start("s1")
    client = openai.OpenAI(api_key="k", max_retries=0)
    list(client.chat.completions.create(**OPENAI_REQUEST, stream=True))
    assert json.loads(route.calls.last.request.content)["stream_options"] == {"include_usage": True}
    sensor.stop()

    chunks = list(client.chat.completions.create(**OPENAI_REQUEST, stream=True))
    assert "stream_options" not in json.loads(route.calls.last.request.content)
    # The SDK's own stream, usage chunk included, as without the sensor.
    assert type(chunks[-1]).__name__ == "ChatCompletionChunk"
    assert chunks[-1].usage is not None


def test_a_block_policy_of_the_ended_session_never_blocks_a_call_while_torn_down(
    sensor: _Sensor, provider: respx.MockRouter
) -> None:
    """Calls made with the sensor torn down are not policed: the policy of
    the session that ended is gone with it."""
    sensor.start("s1")
    client = openai.OpenAI(api_key="k", max_retries=0)
    client.chat.completions.create(**OPENAI_REQUEST)
    session = flightdeck_sensor._session
    assert session is not None
    session.policy = PolicyCache(token_limit=1, block_at_pct=1)
    with pytest.raises(flightdeck_sensor.BudgetExceededError):
        client.chat.completions.create(**OPENAI_REQUEST)
    sensor.stop()

    completion = client.chat.completions.create(**OPENAI_REQUEST)
    assert completion.choices[0].message.content == "Hello"


# ----- the capture setting is the active session's ------------------------


@pytest.mark.parametrize(
    ("first", "second"), [(True, False), (False, True)], ids=["on-then-off", "off-then-on"]
)
@pytest.mark.parametrize("sdk", ["anthropic", "openai"])
def test_a_kept_client_takes_the_capture_setting_of_the_active_session(
    sensor: _Sensor, provider: respx.MockRouter, sdk: str, first: bool, second: bool
) -> None:
    """The proxy built under a session with capture on must not carry
    content into a later session with capture off, and the reverse."""
    sensor.start("s1", capture=first)
    if sdk == "anthropic":
        client: Any = anthropic.Anthropic(api_key="k", max_retries=0)

        def call() -> Any:
            return client.messages.with_raw_response.create(**ANTHROPIC_REQUEST).parse()

    else:
        client = openai.OpenAI(api_key="k", max_retries=0)

        def call() -> Any:
            return client.chat.completions.create(**OPENAI_REQUEST)

    for capture, name in ((first, "s1"), (second, "s2")):
        if name == "s2":
            sensor.stop()
            sensor.start("s2", capture=second)
        (post_call,) = [p for p in sensor.payloads(call) if p["event_type"] == "post_call"]
        assert sensor.names[post_call["session_id"]] == name
        wire = json.dumps(post_call, default=str)
        if capture:
            assert post_call.get("has_content")
            assert PROMPT in wire
        else:
            assert not post_call.get("has_content")
            assert post_call.get("content") is None
            assert PROMPT not in wire


# ----- unpatched, or initialised without patch() -----------------------------


@pytest.mark.parametrize("sdk", ["anthropic", "openai"])
def test_a_kept_client_reports_only_while_its_sdk_is_patched(
    sensor: _Sensor, provider: respx.MockRouter, sdk: str
) -> None:
    """``unpatch()`` with the session still active stops the kept proxy
    and the bound raw view from metering; ``patch()`` again resumes."""
    sensor.start("s1")
    if sdk == "anthropic":
        view = anthropic.Anthropic(api_key="k", max_retries=0).messages.with_raw_response

        def call() -> Any:
            return view.create(**ANTHROPIC_REQUEST).parse()

    else:
        client = openai.OpenAI(api_key="k", max_retries=0)

        def call() -> Any:
            return client.chat.completions.create(**OPENAI_REQUEST)

    metered = [("s1", "pre_call"), ("s1", "post_call")]
    assert sensor.run(call) == metered
    flightdeck_sensor.unpatch()
    assert sensor.run(call) == []
    flightdeck_sensor.patch(quiet=True)
    assert sensor.run(call) == metered


@pytest.mark.parametrize("sdk", ["anthropic", "openai"])
def test_a_new_init_without_patch_leaves_a_kept_client_unmetered(
    sensor: _Sensor, provider: respx.MockRouter, sdk: str
) -> None:
    sensor.start("s1")
    if sdk == "anthropic":
        view = anthropic.Anthropic(api_key="k", max_retries=0).messages.with_raw_response

        def call() -> Any:
            return view.create(**ANTHROPIC_REQUEST).parse()

    else:
        client = openai.OpenAI(api_key="k", max_retries=0)

        def call() -> Any:
            return client.chat.completions.create(**OPENAI_REQUEST)

    assert sensor.run(call)
    sensor.stop()
    sensor.start("s2", patch=False)
    assert sensor.run(call) == []


# ----- wrap() ----------------------------------------------------------------


@pytest.mark.parametrize(
    ("sdk", "name"),
    [("anthropic", n) for n in ("create", "create-stream", "raw-view", "async-create")]
    + [("openai", n) for n in ("create", "create-stream", "raw-view", "async-create")],
)
def test_a_wrapped_client_kept_across_teardown_reports_to_the_active_session(
    sensor: _Sensor, provider: respx.MockRouter, sdk: str, name: str
) -> None:
    sensor.start("s1", patch=False)
    raw = _anthropic_clients() if sdk == "anthropic" else _openai_clients()
    wrapped = (flightdeck_sensor.wrap(raw[0]), flightdeck_sensor.wrap(raw[1]))
    calls = ANTHROPIC_CALLS if sdk == "anthropic" else OPENAI_CALLS
    first = sensor.run(lambda: calls[name](wrapped))
    assert first == _names(first, "s1") and first
    sensor.stop()
    assert sensor.run(lambda: calls[name](wrapped)) == []
    sensor.start("s2", patch=False)
    assert sensor.run(lambda: calls[name](wrapped)) == _names(first, "s2")


# ----- framework objects that keep a client --------------------------------


def _chat_model(kind: str) -> Any:
    if kind == "ChatAnthropic":
        langchain_anthropic = pytest.importorskip("langchain_anthropic")
        return langchain_anthropic.ChatAnthropic(
            model=ANTHROPIC_MODEL, api_key="k", max_tokens=10, max_retries=0
        )
    langchain_openai = pytest.importorskip("langchain_openai")
    return langchain_openai.ChatOpenAI(model=OPENAI_MODEL, api_key="k", max_retries=0)


async def _astream(model: Any) -> None:
    async for _ in model.astream("hi"):
        pass


MODEL_CALLS: dict[str, Callable[[Any], Any]] = {
    "invoke": lambda m: m.invoke("hi"),
    "stream": lambda m: list(m.stream("hi")),
    "ainvoke": lambda m: m.ainvoke("hi"),
    "astream": _astream,
}


@pytest.mark.parametrize("name", sorted(MODEL_CALLS))
@pytest.mark.parametrize("kind", ["ChatAnthropic", "ChatOpenAI"])
def test_a_langchain_model_kept_across_teardown_reports_to_the_active_session(
    sensor: _Sensor, provider: respx.MockRouter, kind: str, name: str
) -> None:
    """langchain-anthropic sends every request through the raw view of a
    client it builds once; langchain-openai keeps ``chat.completions``.
    Both are built under the first session here: a ``ChatOpenAI`` built
    before any ``patch()`` keeps the SDK's own resource and is never
    metered (the pre-existing instance limitation)."""
    sensor.start("s1")
    model = _chat_model(kind)
    _assert_follows_the_session(sensor, lambda: MODEL_CALLS[name](model))


def test_a_chat_anthropic_built_before_init_reports_to_each_session(
    sensor: _Sensor, provider: respx.MockRouter
) -> None:
    model = _chat_model("ChatAnthropic")
    sensor.start("s1")
    _assert_follows_the_session(sensor, lambda: model.invoke("hi"))


def test_an_openai_client_handed_to_litellm_reports_through_litellm_in_each_session(
    sensor: _Sensor, provider: respx.MockRouter
) -> None:
    """litellm serves the call through the OpenAI client it is given (or
    one it caches); while torn down that client must not report on its
    own, and in each session the call is reported once, by litellm."""
    litellm = pytest.importorskip("litellm")
    client = openai.OpenAI(api_key="k", max_retries=0)

    def call() -> Any:
        return litellm.completion(model=OPENAI_MODEL, messages=HI, client=client)

    sensor.start("s1")
    _assert_follows_the_session(sensor, call)
