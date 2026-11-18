"""The google-genai interceptor, through the sensor's public lifecycle.

Driven with the SDK's own ``genai.Client`` (``models``, ``aio.models``,
``chats``, ``aio.chats``), its automatic function calling and its streams
over a fake Gemini API at the HTTP boundary (an ``httpx.MockTransport``
the client is built with), with ``init`` / ``patch`` / ``teardown``
against a local control-plane stub. Every event the sensor builds is
recorded where it is built. No request leaves the process.
"""

from __future__ import annotations

import asyncio
import contextlib
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
from google.oauth2.credentials import Credentials as OAuthCredentials

import flightdeck_sensor
from flightdeck_sensor.core.exceptions import BudgetExceededError, DirectiveError
from flightdeck_sensor.core.policy import PolicyCache
from flightdeck_sensor.core.session import Session
from flightdeck_sensor.interceptor import google_genai as interceptor

if TYPE_CHECKING:
    from collections.abc import Callable, Iterator

MODEL = "gemini-3.1-flash-lite"
EMBED_MODEL = "gemini-embedding-001"
PROMPT = "SECRET-PROMPT-gemini-5c1d"
# The function the model is answered with a call to when it is offered
# one: content, so it may leave the process only with capture on.
TOOL_ARG = "SECRET-TOOL-ARG-gemini-8e2a"
USAGE = {
    "promptTokenCount": 12,
    "candidatesTokenCount": 5,
    "thoughtsTokenCount": 7,
    "cachedContentTokenCount": 4,
    "totalTokenCount": 24,
}
# The events one metered call builds.
CALL_EVENTS = frozenset({"pre_call", "post_call", "embeddings", "llm_error", "tool_call"})
_SENSOR_ENV = (
    "FLIGHTDECK_SERVER",
    "FLIGHTDECK_TOKEN",
    "FLIGHTDECK_API_URL",
    "FLIGHTDECK_SESSION_ID",
    "FLIGHTDECK_CAPTURE_PROMPTS",
    "FLIGHTDECK_CAPTURE_TOOL_INPUTS",
)
# How often the stub's serve loop checks for shutdown.
_STUB_POLL_SECS = 0.05


# ----- the Gemini API, at the HTTP boundary ----------------------------------


class _Body(httpx.SyncByteStream, httpx.AsyncByteStream):
    """A streamed body that sends ``chunks`` and then, when ``fail`` is
    set, fails the read as a dropped connection does."""

    def __init__(self, chunks: list[bytes], fail: bool) -> None:
        self._chunks = chunks
        self._fail = fail

    def __iter__(self) -> Iterator[bytes]:
        yield from self._chunks
        if self._fail:
            raise httpx.ReadError("connection reset")

    async def __aiter__(self) -> Any:
        for chunk in self._chunks:
            yield chunk
        if self._fail:
            raise httpx.ReadError("connection reset")


class Gemini:
    """Answers ``generateContent``, ``streamGenerateContent`` and
    ``batchEmbedContents`` the way the Gemini API does, and records every
    request. A request that offers tools and has not yet answered one is
    answered with a function call."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.status: int | None = None
        self.error: dict[str, Any] = {}
        self.finish_reason = "STOP"
        self.fail_mid_stream = False

    def _candidate(self, body: dict[str, Any], text: str = "Hello") -> dict[str, Any]:
        last = (body.get("contents") or [{}])[-1]
        answered = any("functionResponse" in p for p in last.get("parts", []))
        if body.get("tools") and not answered:
            call = {"id": "call-1", "name": "get_weather", "args": {"city": TOOL_ARG}}
            parts: list[dict[str, Any]] = [{"functionCall": call}]
        else:
            parts = [{"text": text}]
        return {
            "content": {"role": "model", "parts": parts},
            "finishReason": self.finish_reason,
            "index": 0,
        }

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        headers = {"x-gemini-service-tier": "standard"}
        if self.status is not None:
            return httpx.Response(self.status, json=self.error)
        body = json.loads(request.content)
        if request.url.path.endswith(":batchEmbedContents"):
            embeddings = [{"values": [0.1, 0.2, 0.3]} for _ in body["requests"]]
            return httpx.Response(200, json={"embeddings": embeddings})
        whole = {
            "candidates": [self._candidate(body)],
            "usageMetadata": USAGE,
            "modelVersion": MODEL,
            "responseId": "resp-1",
        }
        if not request.url.path.endswith(":streamGenerateContent"):
            return httpx.Response(200, json=whole, headers=headers)
        first = {
            "candidates": [{"content": {"role": "model", "parts": [{"text": "Hel"}]}, "index": 0}],
            "usageMetadata": {"promptTokenCount": 12, "candidatesTokenCount": 1},
            "modelVersion": MODEL,
        }
        last = {**whole, "candidates": [self._candidate(body, "lo")]}
        chunks = [first] if self.fail_mid_stream else [first, last]
        sse = [f"data: {json.dumps(chunk)}\n\n".encode() for chunk in chunks]
        return httpx.Response(
            200,
            headers={**headers, "content-type": "text/event-stream"},
            stream=_Body(sse, self.fail_mid_stream),
        )

    def sent(self) -> list[dict[str, Any]]:
        return [json.loads(r.content) for r in self.requests]


@pytest.fixture
def gemini() -> Gemini:
    return Gemini()


def _client(gemini: Gemini, **kwargs: Any) -> genai.Client:
    transport = httpx.MockTransport(gemini)
    options = types.HttpOptions(
        httpx_client=httpx.Client(transport=transport),
        httpx_async_client=httpx.AsyncClient(transport=transport),
        **kwargs.pop("http", {}),
    )
    kwargs.setdefault("api_key", "test-key")
    return genai.Client(http_options=options, **kwargs)


# ----- the sensor, through its public lifecycle -----------------------------


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
    """``init`` / ``patch`` / ``teardown`` against the stub, naming each
    session; ``run`` returns the call events a call built."""

    def __init__(self, url: str, built: list[dict[str, Any]]) -> None:
        self._url = url
        self._built = built
        self.names: dict[str, str] = {}

    def start(self, name: str = "s1", *, capture: bool = True) -> Session:
        flightdeck_sensor.init(
            server=self._url + "/ingest", token="tok", quiet=True, capture_prompts=capture
        )
        flightdeck_sensor.patch(quiet=True)
        session = flightdeck_sensor._session
        assert session is not None
        self.names[session.config.session_id] = name
        return session

    def stop(self) -> None:
        flightdeck_sensor.teardown()

    def payloads(self, call: Callable[[], Any]) -> list[dict[str, Any]]:
        start = len(self._built)
        result = call()
        if asyncio.iscoroutine(result):
            asyncio.run(result)
        return self.since(start)

    def since(self, start: int) -> list[dict[str, Any]]:
        """The call events built since the ``start``-th event."""
        return [p for p in self._built[start:] if p["event_type"] in CALL_EVENTS]

    @property
    def built(self) -> list[dict[str, Any]]:
        return self._built

    def run(self, call: Callable[[], Any]) -> list[tuple[str, str]]:
        return [
            (self.names.get(p["session_id"], "?"), p["event_type"]) for p in self.payloads(call)
        ]


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


# ----- the entry points ---------------------------------------------------


def get_weather(city: str) -> str:
    """The weather in a city."""
    return f"sunny in {city}"


# The SDK converts a tool's arguments by its annotations; google-genai 1.64
# cannot read the strings ``from __future__ import annotations`` makes of
# them.
get_weather.__annotations__ = {"city": str, "return": str}


def _drain(stream: Any) -> None:
    for _ in stream:
        pass


async def _adrain(stream: Any) -> None:
    async for _ in await stream:
        pass


def _sync_chat(client: genai.Client) -> Any:
    return client.chats.create(model=MODEL).send_message(PROMPT)


def _sync_chat_stream(client: genai.Client) -> Any:
    return _drain(client.chats.create(model=MODEL).send_message_stream(PROMPT))


async def _async_chat(client: genai.Client) -> Any:
    return await client.aio.chats.create(model=MODEL).send_message(PROMPT)


async def _async_chat_stream(client: genai.Client) -> Any:
    await _adrain(client.aio.chats.create(model=MODEL).send_message_stream(PROMPT))


# (name, call, event type, streamed)
ENTRY_POINTS: list[tuple[str, Callable[[genai.Client], Any], str, bool]] = [
    (
        "models.generate_content",
        lambda c: c.models.generate_content(model=MODEL, contents=PROMPT),
        "post_call",
        False,
    ),
    (
        "models.generate_content_stream",
        lambda c: _drain(c.models.generate_content_stream(model=MODEL, contents=PROMPT)),
        "post_call",
        True,
    ),
    (
        "models.embed_content",
        lambda c: c.models.embed_content(model=EMBED_MODEL, contents=[PROMPT, "b"]),
        "embeddings",
        False,
    ),
    ("chats.send_message", _sync_chat, "post_call", False),
    ("chats.send_message_stream", _sync_chat_stream, "post_call", True),
    (
        "aio.models.generate_content",
        lambda c: c.aio.models.generate_content(model=MODEL, contents=PROMPT),
        "post_call",
        False,
    ),
    (
        "aio.models.generate_content_stream",
        lambda c: _adrain(c.aio.models.generate_content_stream(model=MODEL, contents=PROMPT)),
        "post_call",
        True,
    ),
    (
        "aio.models.embed_content",
        lambda c: c.aio.models.embed_content(model=EMBED_MODEL, contents=[PROMPT, "b"]),
        "embeddings",
        False,
    ),
    ("aio.chats.send_message", _async_chat, "post_call", False),
    ("aio.chats.send_message_stream", _async_chat_stream, "post_call", True),
]
ENTRY_IDS = [e[0] for e in ENTRY_POINTS]


@pytest.mark.parametrize(("name", "call", "kind", "streamed"), ENTRY_POINTS, ids=ENTRY_IDS)
def test_each_entry_point_reports_one_call(
    sensor: Sensor,
    gemini: Gemini,
    name: str,
    call: Callable[[genai.Client], Any],
    kind: str,
    streamed: bool,
) -> None:
    sensor.start()
    client = _client(gemini)
    payloads = sensor.payloads(lambda: call(client))
    assert [p["event_type"] for p in payloads] == ["pre_call", kind]
    assert len(gemini.requests) == 1
    event = payloads[1]
    assert event["provider"] == "google"
    assert event["provider_metadata"]["platform"] == "gemini-api"
    assert event["billing_mode"] == "metered"
    assert event["estimated_via"] == "heuristic"
    if kind == "embeddings":
        assert event["model"] == EMBED_MODEL
        assert event["output_dimensions"] == {"count": 2, "dimension": 3}
        # The Gemini API reports no tokens for embeddings: the pre-call
        # estimate stands, as for any call whose response reports none.
        assert event["tokens_input"] == payloads[0]["tokens_input"]
        # Stored as sent: each batched request's content.
        sent = gemini.sent()[0]["requests"]
        assert event["content"]["input"] == [r["content"] for r in sent]
        assert event["content"]["input"][0] == {"parts": [{"text": PROMPT}], "role": "user"}
        return
    assert (event["model_requested"], event["model_served"]) == (MODEL, MODEL)
    assert (event["tokens_input"], event["tokens_output"]) == (12, 12)
    assert (event["tokens_reasoning"], event["tokens_cache_read"]) == (7, 4)
    assert event["service_tier"] == "standard"
    assert event["stop_reason"] == "STOP"
    content = event["content"]
    # The request as the provider received it, whatever the call's form.
    assert content["input"] == gemini.sent()[0]["contents"]
    response = content["response"]
    assert response["candidates"][0]["content"]["parts"] == [{"text": "Hello"}]
    # The REST API's names: finishReason, usageMetadata.
    assert response["candidates"][0]["finishReason"] == "STOP"
    assert response["usageMetadata"]["promptTokenCount"] == 12
    if streamed:
        assert event["streaming"]["final_outcome"] == "completed"
        assert event["streaming"]["chunk_count"] == 2
        assert event["streaming"]["ttft_ms"] is not None
    else:
        assert "streaming" not in event


# ----- automatic function calling ----------------------------------------


@pytest.mark.parametrize("asynchronous", [False, True], ids=["sync", "async"])
def test_each_automatic_function_calling_round_is_a_call(
    sensor: Sensor, gemini: Gemini, asynchronous: bool
) -> None:
    sensor.start()
    client = _client(gemini)
    config = types.GenerateContentConfig(tools=[get_weather])
    if asynchronous:
        payloads = sensor.payloads(
            lambda: client.aio.models.generate_content(model=MODEL, contents=PROMPT, config=config)
        )
    else:
        payloads = sensor.payloads(
            lambda: client.models.generate_content(model=MODEL, contents=PROMPT, config=config)
        )
    # Two requests, each billed: the function call, then the answer to it.
    assert len(gemini.requests) == 2
    assert [p["event_type"] for p in payloads] == [
        "pre_call",
        "post_call",
        "tool_call",
        "pre_call",
        "post_call",
    ]
    tool_call = payloads[2]
    assert tool_call["tool_name"] == "get_weather"
    assert tool_call["content"]["tool_input"] == {"city": TOOL_ARG}
    first, second = payloads[1], payloads[4]
    assert first["tokens_input"] == second["tokens_input"] == 12
    # Each round stores what that round sent: the second holds the call
    # and the SDK's answer to it.
    sent = gemini.sent()
    assert first["content"]["input"] == sent[0]["contents"]
    assert second["content"]["input"] == sent[1]["contents"]
    assert [c["role"] for c in second["content"]["input"]] == ["user", "model", "user"]
    function_response = second["content"]["input"][2]["parts"][0]["functionResponse"]
    assert function_response["response"] == {"result": f"sunny in {TOOL_ARG}"}
    # The function is offered as the declaration the SDK sent.
    assert first["content"]["tools"] == sent[0]["tools"]
    assert first["content"]["tools"][0]["functionDeclarations"][0]["name"] == "get_weather"


def test_a_streamed_function_call_is_a_tool_call(sensor: Sensor, gemini: Gemini) -> None:
    sensor.start(capture=False)
    client = _client(gemini)
    # A declared tool (no Python function): the SDK runs nothing, and the
    # model's call reaches the caller in the stream.
    declaration = types.FunctionDeclaration(name="get_weather", description="weather")
    config = types.GenerateContentConfig(tools=[types.Tool(function_declarations=[declaration])])
    payloads = sensor.payloads(
        lambda: _drain(
            client.models.generate_content_stream(model=MODEL, contents=PROMPT, config=config)
        )
    )
    assert [p["event_type"] for p in payloads] == ["pre_call", "post_call", "tool_call"]
    assert payloads[2]["tool_name"] == "get_weather"
    # Capture off: the call's arguments stay in the process.
    assert TOOL_ARG not in json.dumps(payloads)


# ----- failures and aborts -------------------------------------------------


RATE_LIMITED = {
    "error": {
        "code": 429,
        "message": PROMPT,
        "status": "RESOURCE_EXHAUSTED",
        "details": [
            {
                "@type": "type.googleapis.com/google.rpc.QuotaFailure",
                "violations": [{"quotaId": "GenerateRequestsPerMinutePerProjectPerModel"}],
            },
            {"@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": "13s"},
        ],
    }
}


@pytest.mark.parametrize(("name", "call", "kind", "streamed"), ENTRY_POINTS, ids=ENTRY_IDS)
def test_a_rejected_call_is_an_llm_error_and_raises_the_sdk_s_error(
    sensor: Sensor,
    gemini: Gemini,
    name: str,
    call: Callable[[genai.Client], Any],
    kind: str,
    streamed: bool,
) -> None:
    sensor.start(capture=False)
    gemini.status, gemini.error = 429, RATE_LIMITED
    client = _client(gemini)
    raised: list[BaseException] = []

    def _call() -> Any:
        try:
            result = call(client)
        except Exception as exc:
            raised.append(exc)
            return None
        if asyncio.iscoroutine(result):

            async def _awaited() -> None:
                try:
                    await result
                except Exception as exc:
                    raised.append(exc)

            return _awaited()
        return result

    payloads = sensor.payloads(_call)
    assert [type(e).__name__ for e in raised] == ["ClientError"]
    assert [p["event_type"] for p in payloads] == ["pre_call", "llm_error"]
    error = payloads[1]["error"]
    assert (error["error_type"], error["provider"], error["http_status"]) == (
        "rate_limit",
        "google",
        429,
    )
    assert (error["provider_error_code"], error["retry_after"]) == ("RESOURCE_EXHAUSTED", 13.0)
    if streamed:
        assert error["abort_reason"] == "error_before_stream"
    # Capture off: the provider's message (which can echo the prompt) stays.
    assert PROMPT not in json.dumps(payloads)


@pytest.mark.parametrize("asynchronous", [False, True], ids=["sync", "async"])
def test_a_stream_that_fails_midway_reports_its_partial_tokens(
    sensor: Sensor, gemini: Gemini, asynchronous: bool
) -> None:
    sensor.start()
    gemini.fail_mid_stream = True
    client = _client(gemini)
    if asynchronous:
        call: Callable[[], Any] = lambda: _adrain(  # noqa: E731
            client.aio.models.generate_content_stream(model=MODEL, contents=PROMPT)
        )
    else:
        call = lambda: _drain(  # noqa: E731
            client.models.generate_content_stream(model=MODEL, contents=PROMPT)
        )
    start = len(sensor.built)
    with pytest.raises(httpx.ReadError):
        sensor.payloads(call)
    payloads = sensor.since(start)
    assert [p["event_type"] for p in payloads] == ["pre_call", "llm_error"]
    error = payloads[1]["error"]
    assert (error["error_type"], error["abort_reason"]) == ("stream_error", "error_mid_stream")
    assert (error["partial_chunks"], error["partial_tokens_input"]) == (1, 12)
    assert error["partial_tokens_output"] == 1
    assert payloads[1]["billing_mode"] == "metered"


def test_a_stream_left_early_is_an_aborted_call(sensor: Sensor, gemini: Gemini) -> None:
    sensor.start()
    client = _client(gemini)

    def _leave_early() -> None:
        stream = client.models.generate_content_stream(model=MODEL, contents=PROMPT)
        next(stream)
        stream.close()

    start = len(sensor.built)
    sensor.payloads(_leave_early)
    # Closing the SDK's generator lets go of the guard; the settle its
    # collection queued runs at the session's next call or at its end.
    sensor.stop()
    post_calls = [p for p in sensor.since(start) if p["event_type"] == "post_call"]
    assert len(post_calls) == 1
    streaming = post_calls[0]["streaming"]
    assert (streaming["final_outcome"], streaming["abort_reason"]) == ("aborted", "client_aborted")
    assert streaming["chunk_count"] == 1
    assert (post_calls[0]["tokens_input"], post_calls[0]["tokens_output"]) == (12, 1)


def test_a_content_filtered_answer_is_an_llm_error_beside_its_post_call(
    sensor: Sensor, gemini: Gemini
) -> None:
    sensor.start()
    gemini.finish_reason = "SAFETY"
    client = _client(gemini)
    payloads = sensor.payloads(lambda: client.models.generate_content(model=MODEL, contents="x"))
    assert [p["event_type"] for p in payloads] == ["pre_call", "post_call", "llm_error"]
    assert payloads[1]["tokens_input"] == 12
    error = payloads[2]["error"]
    assert (error["error_type"], error["provider_error_code"]) == ("content_filter", "SAFETY")


# ----- enforcement -----------------------------------------------------------


@pytest.mark.parametrize(("name", "call", "kind", "streamed"), ENTRY_POINTS, ids=ENTRY_IDS)
@pytest.mark.parametrize("control", ["block", "shutdown"])
def test_a_block_or_the_kill_switch_stops_every_entry_point_before_its_request(
    sensor: Sensor,
    gemini: Gemini,
    control: str,
    name: str,
    call: Callable[[genai.Client], Any],
    kind: str,
    streamed: bool,
) -> None:
    session = sensor.start()
    if control == "block":
        session.policy = PolicyCache(token_limit=1, block_at_pct=1)
        expected: type[Exception] = BudgetExceededError
    else:
        with session._lock:
            session._shutdown_requested = True
        expected = DirectiveError
    client = _client(gemini)
    with pytest.raises(expected):
        result = call(client)
        if asyncio.iscoroutine(result):
            asyncio.run(result)
    assert gemini.requests == []


def test_a_degrade_swaps_the_model_of_every_request(sensor: Sensor, gemini: Gemini) -> None:
    session = sensor.start()
    session.policy.set_degrade_model("gemini-3.5-flash-lite")
    client = _client(gemini)
    config = types.GenerateContentConfig(tools=[get_weather])
    payloads = sensor.payloads(
        lambda: client.models.generate_content(model=MODEL, contents=PROMPT, config=config)
    )
    # Both rounds of the run went to the degrade target.
    assert [r.url.path.rsplit("/", 1)[-1] for r in gemini.requests] == [
        "gemini-3.5-flash-lite:generateContent"
    ] * 2
    assert [p["model_requested"] for p in payloads if p["event_type"] == "post_call"] == [
        "gemini-3.5-flash-lite"
    ] * 2


def test_a_warn_threshold_warns_and_the_call_goes_on(sensor: Sensor, gemini: Gemini) -> None:
    session = sensor.start()
    session.policy = PolicyCache(token_limit=10**9, warn_at_pct=0)
    client = _client(gemini)
    payloads = sensor.payloads(lambda: client.models.generate_content(model=MODEL, contents="x"))
    assert [p["event_type"] for p in payloads] == ["pre_call", "post_call"]
    assert any(p["event_type"] == "policy_warn" for p in sensor._built)
    assert len(gemini.requests) == 1


# ----- capture off -----------------------------------------------------------


def test_capture_off_sends_no_content(sensor: Sensor, gemini: Gemini) -> None:
    sensor.start(capture=False)
    client = _client(gemini)
    config = types.GenerateContentConfig(system_instruction=PROMPT, tools=[get_weather])
    payloads = sensor.payloads(
        lambda: client.models.generate_content(model=MODEL, contents=PROMPT, config=config)
    )
    assert payloads and all(p["has_content"] is False for p in payloads)
    dumped = json.dumps(payloads)
    assert PROMPT not in dumped and TOOL_ARG not in dumped


# ----- endpoints --------------------------------------------------------------


@pytest.mark.parametrize(
    ("kwargs", "platform", "scope", "billing"),
    [
        ({}, "gemini-api", None, "metered"),
        (
            {"vertexai": True, "project": "p", "location": "us-central1"},
            "vertex",
            "regional",
            "metered",
        ),
        ({"vertexai": True, "project": "p", "location": "global"}, "vertex", "global", "metered"),
        ({"http": {"base_url": "http://localhost:8080"}}, "localhost", None, "local"),
        (
            {"http": {"base_url": "https://gemini-proxy.example.com"}},
            "gemini-proxy.example.com",
            None,
            "metered",
        ),
    ],
)
def test_the_endpoint_is_attributed(
    sensor: Sensor,
    gemini: Gemini,
    kwargs: dict[str, Any],
    platform: str,
    scope: str | None,
    billing: str,
) -> None:
    sensor.start()
    if kwargs.get("vertexai"):
        kwargs = {**kwargs, "credentials": OAuthCredentials(token="test-token"), "api_key": None}
    client = _client(gemini, **kwargs)
    payloads = sensor.payloads(lambda: client.models.generate_content(model=MODEL, contents="x"))
    post_call = payloads[-1]
    assert post_call["provider_metadata"]["platform"] == platform
    assert post_call.get("inference_scope") == scope
    assert post_call["billing_mode"] == billing


# ----- sessions ---------------------------------------------------------------


def test_a_client_kept_across_teardown_reports_to_the_next_session(
    sensor: Sensor, gemini: Gemini
) -> None:
    sensor.start("s1")
    client = _client(gemini)

    def call() -> Any:
        return client.models.generate_content(model=MODEL, contents="x")

    assert sensor.run(call) == [("s1", "pre_call"), ("s1", "post_call")]
    sensor.stop()
    assert sensor.run(call) == []
    sensor.start("s2")
    assert sensor.run(call) == [("s2", "pre_call"), ("s2", "post_call")]


def test_an_async_call_reports_to_the_session_active_when_it_is_awaited(
    sensor: Sensor, gemini: Gemini
) -> None:
    sensor.start("s1")
    client = _client(gemini)
    pending = client.aio.models.generate_content(model=MODEL, contents="x")
    sensor.stop()
    sensor.start("s2")
    assert sensor.run(lambda: pending) == [("s2", "pre_call"), ("s2", "post_call")]


def test_unpatch_restores_the_sdk_methods(sensor: Sensor) -> None:
    originals = {
        cls: {name: cls.__dict__[name] for name in interceptor._PATCHED_METHODS}
        for cls in (genai_models.Models, genai_models.AsyncModels)
    }
    sensor.start()
    assert interceptor.is_patched()
    assert all(
        cls.__dict__[name] is not original
        for cls, methods in originals.items()
        for name, original in methods.items()
    )
    sensor.stop()
    assert not interceptor.is_patched()
    assert all(
        cls.__dict__[name] is original
        for cls, methods in originals.items()
        for name, original in methods.items()
    )
    assert "_flightdeck_patched" not in genai_models.Models.__dict__
