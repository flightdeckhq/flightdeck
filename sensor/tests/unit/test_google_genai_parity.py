"""A sensored google-genai client behaves like an unsensored one.

The same call, made once with the sensor torn down and once with a
session active (capture on), must send the provider the same requests
(URL and body bytes, recorded at the HTTP boundary), raise the same
exception at the same moment, and look the same to introspection. The
arguments the sensor reads (``contents``) given as one-shot iterables
reach the provider intact, a policy block holds whatever they do, and
the stored content is what the provider received.
"""

from __future__ import annotations

import asyncio
import contextlib
import inspect
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import TYPE_CHECKING, Any

import pytest

pytest.importorskip("google.genai")

import httpx
from google import genai
from google.genai import models as genai_models
from google.genai import types

import flightdeck_sensor
from flightdeck_sensor.core.exceptions import BudgetExceededError
from flightdeck_sensor.core.policy import PolicyCache
from flightdeck_sensor.core.session import Session
from flightdeck_sensor.interceptor import google_genai as interceptor

if TYPE_CHECKING:
    from collections.abc import Callable, Iterator

MODEL = "gemini-3.1-flash-lite"
SIGNATURE = b"\x00\x01signature\xff"
_STUB_POLL_SECS = 0.05
_SENSOR_ENV = (
    "FLIGHTDECK_SERVER",
    "FLIGHTDECK_TOKEN",
    "FLIGHTDECK_API_URL",
    "FLIGHTDECK_SESSION_ID",
    "FLIGHTDECK_CAPTURE_PROMPTS",
    "FLIGHTDECK_CAPTURE_TOOL_INPUTS",
)


def _whole(body: dict[str, Any]) -> dict[str, Any]:
    """The answer to a ``generateContent`` request: a function call while
    the request offers tools and has not answered one, else text with a
    thought signature."""
    last = (body.get("contents") or [{}])[-1]
    answered = any("functionResponse" in p for p in last.get("parts", []))
    if body.get("tools") and not answered:
        parts: list[dict[str, Any]] = [
            {"functionCall": {"id": "c1", "name": "get_weather", "args": {"city": "Paris"}}}
        ]
    else:
        parts = [{"text": "Hello", "thoughtSignature": "c2ln"}]
    return {
        "candidates": [{"content": {"role": "model", "parts": parts}, "finishReason": "STOP"}],
        "usageMetadata": {"promptTokenCount": 4, "candidatesTokenCount": 2},
        "modelVersion": MODEL,
    }


def _answer(request: httpx.Request) -> httpx.Response:
    body = json.loads(request.content)
    if request.url.path.endswith(":batchEmbedContents"):
        return httpx.Response(200, json={"embeddings": [{"values": [0.5]}] * len(body["requests"])})
    whole = _whole(body)
    if request.url.path.endswith(":streamGenerateContent"):
        sse = f"data: {json.dumps(whole)}\n\n".encode()
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=sse)
    return httpx.Response(200, json=whole)


class Recorder:
    """The client under test and the requests it sent."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        transport = httpx.MockTransport(self._record)
        self.client = genai.Client(
            api_key="test-key",
            http_options=types.HttpOptions(
                httpx_client=httpx.Client(transport=transport),
                httpx_async_client=httpx.AsyncClient(transport=transport),
            ),
        )

    def _record(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return _answer(request)

    def sent(self) -> list[tuple[str, bytes]]:
        return [(str(r.url), r.content) for r in self.requests]


class _ControlPlane(BaseHTTPRequestHandler):
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


@pytest.fixture(scope="module")
def control_plane() -> Iterator[str]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), _ControlPlane)
    thread = threading.Thread(
        target=server.serve_forever, kwargs={"poll_interval": _STUB_POLL_SECS}, daemon=True
    )
    thread.start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()
    server.server_close()


class Sensor:
    def __init__(self, url: str, built: list[dict[str, Any]]) -> None:
        self.url = url
        self.built = built

    def start(self, *, capture: bool = True) -> Session:
        flightdeck_sensor.init(
            server=self.url + "/ingest", token="tok", quiet=True, capture_prompts=capture
        )
        flightdeck_sensor.patch(quiet=True)
        session = flightdeck_sensor._session
        assert session is not None
        return session

    def content(self, event_type: str = "post_call") -> list[dict[str, Any]]:
        return [p["content"] for p in self.built if p["event_type"] == event_type]


@pytest.fixture
def sensor(control_plane: str, monkeypatch: pytest.MonkeyPatch) -> Iterator[Sensor]:
    for name in _SENSOR_ENV:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(flightdeck_sensor, "_collect_context", dict)
    built: list[dict[str, Any]] = []
    build = Session._build_payload

    def _recording(self: Session, event_type: Any, **extra: Any) -> dict[str, Any]:
        payload = build(self, event_type, **extra)
        built.append(payload)
        return payload

    monkeypatch.setattr(Session, "_build_payload", _recording)
    yield Sensor(control_plane, built)
    with contextlib.suppress(Exception):
        flightdeck_sensor.teardown()
    interceptor.unpatch_google_genai()


def get_weather(city: str) -> str:
    """The weather in a city."""
    return f"sunny in {city}"


# The SDK converts a tool's arguments by its annotations; google-genai 1.64
# cannot read the strings ``from __future__ import annotations`` makes of
# them.
get_weather.__annotations__ = {"city": str, "return": str}


def _signed_history() -> list[Any]:
    """A conversation as a chat keeps it: SDK objects, one carrying the
    thought signature the model's reply came with (bytes), one with a
    field set to None after it was built, which the SDK leaves out of the
    request."""
    first = types.Part(text="hi")
    first.thought = None
    return [
        types.Content(role="user", parts=[first]),
        types.Content(role="model", parts=[types.Part(text="Hello", thought_signature=SIGNATURE)]),
        types.Content(role="user", parts=[types.Part.from_text(text="again")]),
    ]


def _contents_generator() -> Iterator[Any]:
    yield "first"
    yield types.Part.from_text(text="second")


# Each case: (name, call). A call is made the same way unsensored and
# sensored; ``contents`` is built fresh for each (a generator is read once).
CASES: list[tuple[str, Callable[[genai.Client], Any]]] = [
    ("string", lambda c: c.models.generate_content(model=MODEL, contents="hi")),
    ("sdk objects", lambda c: c.models.generate_content(model=MODEL, contents=_signed_history())),
    (
        "generator",
        lambda c: c.models.generate_content(model=MODEL, contents=_contents_generator()),
    ),
    (
        "iterator over a list",
        lambda c: c.models.generate_content(model=MODEL, contents=iter(["a", "b"])),
    ),
    (
        "dict config",
        lambda c: c.models.generate_content(
            model=MODEL,
            contents=[{"role": "user", "parts": [{"text": "hi"}]}],
            config={"system_instruction": "Be brief", "temperature": 0.1, "max_output_tokens": 8},
        ),
    ),
    (
        "automatic function calling",
        lambda c: c.models.generate_content(
            model=MODEL,
            contents="weather?",
            config=types.GenerateContentConfig(tools=[get_weather]),
        ),
    ),
    (
        "stream of a generator",
        lambda c: list(
            c.models.generate_content_stream(model=MODEL, contents=_contents_generator())
        ),
    ),
    ("chat", lambda c: c.chats.create(model=MODEL).send_message("hi")),
    (
        "embed generator",
        lambda c: c.models.embed_content(model="m", contents=_contents_generator()),
    ),
    (
        "async generator contents",
        lambda c: c.aio.models.generate_content(model=MODEL, contents=_contents_generator()),
    ),
    (
        "async stream",
        lambda c: _adrain(c.aio.models.generate_content_stream(model=MODEL, contents="hi")),
    ),
    (
        "async embed",
        lambda c: c.aio.models.embed_content(model="m", contents=["a", "b"]),
    ),
    # The SDK's union swallows the iterator's exception here and sends
    # what it read instead, with the sensor as without it.
    ("embed failing iterator", lambda c: c.models.embed_content(model="m", contents=_failing())),
]


async def _adrain(stream: Any) -> list[Any]:
    return [chunk async for chunk in await stream]


def _made(call: Callable[[genai.Client], Any], client: genai.Client) -> Any:
    result = call(client)
    if asyncio.iscoroutine(result):
        return asyncio.run(result)
    return result


def _sent_by(call: Callable[[genai.Client], Any]) -> tuple[list[tuple[str, bytes]], str]:
    """The requests one call sent, and the type of the exception it
    raised ("" for none): a release that rejects a case (google-genai
    1.64 reads a stream's contents before its request method) must reject
    it the same way with the sensor."""
    recorder = Recorder()
    try:
        _made(call, recorder.client)
    except Exception as exc:
        return recorder.sent(), type(exc).__name__
    return recorder.sent(), ""


@pytest.mark.parametrize(("name", "call"), CASES, ids=[c[0] for c in CASES])
def test_the_provider_receives_the_same_requests(
    sensor: Sensor, name: str, call: Callable[[genai.Client], Any]
) -> None:
    unsensored = _sent_by(call)
    sensor.start()
    assert _sent_by(call) == unsensored
    if not unsensored[1]:
        assert any(p["event_type"] in ("post_call", "embeddings") for p in sensor.built)


def test_a_custom_iterator_reaches_the_sdk_as_the_callers_does(sensor: Sensor) -> None:
    # The SDK's union reads an object of the caller's own iterator class
    # by its attributes, not as a list; so does it read the sensor's.
    class Lines:
        def __init__(self) -> None:
            self._items = iter(["a", "b"])

        def __iter__(self) -> Lines:
            return self

        def __next__(self) -> str:
            return next(self._items)

    unsensored = Recorder()
    unsensored.client.models.generate_content(model=MODEL, contents=Lines())
    sensor.start()
    sensored = Recorder()
    sensored.client.models.generate_content(model=MODEL, contents=Lines())
    assert sensored.sent() == unsensored.sent()


# ----- exceptions, at the same moment ---------------------------------------


class Broken(Exception):
    pass


def _failing() -> Iterator[str]:
    yield "fine"
    raise Broken("the caller's iterator failed")


def _outcome(call: Callable[[], Any]) -> tuple[str, str]:
    """Where a call failed: at the call, or later (iterating a stream,
    awaiting a coroutine), and with which exception type."""
    try:
        result = call()
    except Exception as exc:
        return "call", type(exc).__name__
    try:
        if asyncio.iscoroutine(result):
            asyncio.run(result)
        elif inspect.isgenerator(result):
            list(result)
        elif hasattr(result, "__aiter__"):
            asyncio.run(_adrain_iter(result))
    except Exception as exc:
        return "later", type(exc).__name__
    return "none", ""


async def _adrain_iter(stream: Any) -> None:
    async for _ in stream:
        pass


FAILURES: list[tuple[str, Callable[[genai.Client], Any]]] = [
    ("failing iterator", lambda c: c.models.generate_content(model=MODEL, contents=_failing())),
    (
        "failing iterator, stream",
        lambda c: c.models.generate_content_stream(model=MODEL, contents=_failing()),
    ),
    (
        "failing iterator, async",
        lambda c: c.aio.models.generate_content(model=MODEL, contents=_failing()),
    ),
    ("unknown argument", lambda c: c.models.generate_content(model=MODEL, contents="x", tools=[])),
    (
        "unknown argument, async",
        lambda c: c.aio.models.generate_content(model=MODEL, contents="x", tools=[]),
    ),
    ("invalid contents", lambda c: c.models.generate_content(model=MODEL, contents=12)),
    (
        "invalid contents, stream",
        lambda c: c.models.generate_content_stream(model=MODEL, contents=12),
    ),
]


@pytest.mark.parametrize(("name", "call"), FAILURES, ids=[f[0] for f in FAILURES])
def test_the_same_exception_at_the_same_moment(
    sensor: Sensor, name: str, call: Callable[[genai.Client], Any]
) -> None:
    unsensored = _outcome(lambda: call(Recorder().client))
    sensor.start()
    sensored = _outcome(lambda: call(Recorder().client))
    assert sensored == unsensored
    assert unsensored[0] != "none"


@pytest.mark.parametrize(
    "call",
    [
        lambda c: c.models.generate_content(model=MODEL, contents=_failing()),
        lambda c: c.models.generate_content_stream(model=MODEL, contents=_failing()),
        lambda c: c.aio.models.generate_content(model=MODEL, contents=_failing()),
        lambda c: c.models.embed_content(model="m", contents=_failing()),
    ],
    ids=["generate", "stream", "async", "embed"],
)
def test_a_block_holds_whatever_the_arguments_do(
    sensor: Sensor, call: Callable[[genai.Client], Any]
) -> None:
    session = sensor.start()
    session.policy = PolicyCache(token_limit=1, block_at_pct=1)
    recorder = Recorder()
    with pytest.raises(BudgetExceededError):
        _made(lambda c: _drained(call(c)), recorder.client)
    assert recorder.requests == []


def _drained(result: Any) -> Any:
    return list(result) if inspect.isgenerator(result) else result


def test_a_failing_iterator_is_reported_as_a_call_the_sdk_rejected(sensor: Sensor) -> None:
    sensor.start()
    # The SDK reads the failed iterator as no contents and says so.
    with pytest.raises(ValueError, match="contents are required"):
        Recorder().client.models.generate_content(model=MODEL, contents=_failing())
    kinds = [p["event_type"] for p in sensor.built if p["event_type"] in ("pre_call", "llm_error")]
    assert kinds == ["pre_call", "llm_error"]


# ----- introspection ----------------------------------------------------------


def test_introspection_is_the_sdks(sensor: Sensor) -> None:
    public = {
        cls: {
            name: cls.__dict__[name]
            for name in ("generate_content", "generate_content_stream", "embed_content")
        }
        for cls in (genai_models.Models, genai_models.AsyncModels)
    }
    originals = {
        cls: {name: cls.__dict__[name] for name in interceptor._PATCHED_METHODS}
        for cls in (genai_models.Models, genai_models.AsyncModels)
    }
    sensor.start()
    for cls, methods in public.items():
        # The public methods are the SDK's own objects.
        assert all(cls.__dict__[name] is method for name, method in methods.items())
    for cls, methods in originals.items():
        for name, original in methods.items():
            patched = cls.__dict__[name]
            assert patched is not original
            assert inspect.iscoroutinefunction(patched) == inspect.iscoroutinefunction(original)
            assert inspect.signature(patched) == inspect.signature(original)
            assert (patched.__name__, patched.__qualname__, patched.__doc__) == (
                original.__name__,
                original.__qualname__,
                original.__doc__,
            )


# ----- stored content == what the provider received ---------------------------
#
# Each argument kind, made through each entry point, with content capture
# on: every request the call sent (an automatic-function-calling run sends
# two) is a post_call whose stored pieces equal that request body's own
# (contents, the system instruction's parts, tools) and whose stored
# response equals the fake endpoint's answer to it.


def _pil_image() -> Any:
    image_module = pytest.importorskip("PIL.Image", reason="pillow is not installed in this lane")
    return image_module.new("RGB", (2, 2), (255, 0, 0))


def _declared_tool() -> types.Tool:
    return types.Tool(
        function_declarations=[
            types.FunctionDeclaration(
                name="lookup",
                description="Looks a word up.",
                parameters=types.Schema(
                    type=types.Type.OBJECT,
                    properties={"word": types.Schema(type=types.Type.STRING)},
                ),
            )
        ]
    )


# Each kind: (contents, config), built fresh for every call (a generator is
# read once). ``None`` config sends none.
KINDS: dict[str, Callable[[], tuple[Any, Any]]] = {
    "string": lambda: ("hi", None),
    "list of strings": lambda: (["a", "b"], None),
    "dict contents": lambda: ([{"role": "user", "parts": [{"text": "hi"}]}], None),
    "sdk objects with a thought signature": lambda: (_signed_history(), None),
    "Part.from_bytes": lambda: (
        [
            types.Part.from_text(text="look"),
            types.Part.from_bytes(data=b"\x89PNG\x00\xff\xfe", mime_type="image/png"),
        ],
        None,
    ),
    "PIL image": lambda: (["look", _pil_image()], None),
    "a generator": lambda: (_contents_generator(), None),
    "dict config, string system": lambda: (
        "hi",
        {"system_instruction": "Be brief", "temperature": 0.1, "max_output_tokens": 8},
    ),
    "config, Content system": lambda: (
        "hi",
        types.GenerateContentConfig(
            system_instruction=types.Content(parts=[types.Part(text="Be brief")])
        ),
    ),
    "config, Part system": lambda: (
        "hi",
        types.GenerateContentConfig(system_instruction=types.Part(text="Be brief")),
    ),
    "config, list system": lambda: (
        "hi",
        types.GenerateContentConfig(system_instruction=["Be brief.", "Be kind."]),
    ),
    "tool declarations": lambda: ("hi", types.GenerateContentConfig(tools=[_declared_tool()])),
    "callables under automatic function calling": lambda: (
        "weather?",
        types.GenerateContentConfig(tools=[get_weather]),
    ),
}


def _call(mode: str, client: genai.Client, contents: Any, config: Any) -> None:
    if mode == "sync":
        client.models.generate_content(model=MODEL, contents=contents, config=config)
    elif mode == "async":
        asyncio.run(
            client.aio.models.generate_content(model=MODEL, contents=contents, config=config)
        )
    elif mode == "stream":
        list(client.models.generate_content_stream(model=MODEL, contents=contents, config=config))
    else:
        asyncio.run(
            _adrain(
                client.aio.models.generate_content_stream(
                    model=MODEL, contents=contents, config=config
                )
            )
        )


def _chat(mode: str, client: genai.Client) -> None:
    history = _signed_history()
    if mode == "sync":
        client.chats.create(model=MODEL, history=history).send_message("again")
    elif mode == "async":
        asyncio.run(client.aio.chats.create(model=MODEL, history=history).send_message("again"))
    elif mode == "stream":
        list(client.chats.create(model=MODEL, history=history).send_message_stream("again"))
    else:

        async def _streamed() -> None:
            chat = client.aio.chats.create(model=MODEL, history=history)
            async for _ in await chat.send_message_stream("again"):
                pass

        asyncio.run(_streamed())


MODES = ("sync", "async", "stream", "async stream")


def _assert_stored_as_sent(sensor: Sensor, recorder: Recorder) -> None:
    bodies = [json.loads(r.content) for r in recorder.requests]
    stored = sensor.content()
    assert bodies and len(stored) == len(bodies)
    for content, body in zip(stored, bodies, strict=True):
        assert content["input"] == body["contents"]
        system = body.get("systemInstruction")
        assert content["system"] == (system["parts"] if system is not None else None)
        assert content["tools"] == body.get("tools")
        assert content["response"] == _whole(body)


@pytest.mark.parametrize("mode", MODES)
@pytest.mark.parametrize("kind", list(KINDS))
def test_the_stored_content_is_the_request_and_response_on_the_wire(
    sensor: Sensor, kind: str, mode: str
) -> None:
    contents, config = KINDS[kind]()
    unsensored = Recorder()
    try:
        _call(mode, unsensored.client, *KINDS[kind]())
    except Exception as exc:  # noqa: BLE001 - the release rejects the case
        pytest.skip(f"this google-genai release rejects it: {type(exc).__name__}")
    sensor.start()
    recorder = Recorder()
    _call(mode, recorder.client, contents, config)
    assert recorder.sent() == unsensored.sent()
    _assert_stored_as_sent(sensor, recorder)


@pytest.mark.parametrize("mode", MODES)
def test_a_chat_stores_its_history_as_sent(sensor: Sensor, mode: str) -> None:
    sensor.start()
    recorder = Recorder()
    _chat(mode, recorder.client)
    _assert_stored_as_sent(sensor, recorder)
    # The history the chat sent, the model's thought signature included,
    # in the encoding the SDK sent it with.
    (content,) = sensor.content()
    assert (
        content["input"][1]["parts"][0]["thoughtSignature"]
        == (json.loads(recorder.requests[0].content)["contents"][1]["parts"][0]["thoughtSignature"])
    )


def test_the_stored_content_is_copied_when_the_call_is_sent(sensor: Sensor) -> None:
    sensor.start()
    recorder = Recorder()
    history = _signed_history()
    recorder.client.models.generate_content(model=MODEL, contents=history)
    history.append(types.Content(role="user", parts=[types.Part(text="added after the call")]))
    history[0].parts[0].text = "changed after the call"
    (content,) = sensor.content()
    assert content["input"] == json.loads(recorder.requests[0].content)["contents"]
    assert len(content["input"]) == 3
    assert content["input"][0] == {"parts": [{"text": "hi"}], "role": "user"}


def test_an_embeddings_call_stores_its_contents_as_sent(sensor: Sensor) -> None:
    sensor.start()
    recorder = Recorder()
    recorder.client.models.embed_content(model="m", contents=_contents_generator())
    (content,) = sensor.content("embeddings")
    body = json.loads(recorder.requests[0].content)
    assert content["input"] == [r["content"] for r in body["requests"]]


def test_capture_off_stores_nothing(sensor: Sensor) -> None:
    sensor.start(capture=False)
    recorder = Recorder()
    _call("sync", recorder.client, "hi", types.GenerateContentConfig(system_instruction="S"))
    calls = [p for p in sensor.built if p["event_type"] == "post_call"]
    assert len(calls) == 1
    assert calls[0].get("content") is None
    assert calls[0].get("has_content") is False
