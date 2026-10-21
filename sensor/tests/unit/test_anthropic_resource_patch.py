"""Resource-level Anthropic patch: every SDK client class crossed with
every call path, driven through the real SDK classes over a mocked HTTP
transport (``httpx.MockTransport``), so the matrix exercises the SDK's
own resource construction, raw and streaming views,
URL rewriting and auth plumbing of the cloud clients, and the event
stream decoding -- everything short of the network.

Also here: the deferred metering of the streaming view (parse
settles, close settles, never-parsed reports the estimate, a parsed
stream is handed to the guard), the async ``await parse()`` path,
platform attribution, ``wrap()`` on cloud clients, and the module-layout
canary that fails when the SDK moves the classes the patch relies on.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import warnings
from typing import Any
from unittest.mock import MagicMock

import anthropic
import httpx
import pytest
from anthropic._base_client import AsyncAPIClient, BaseClient
from anthropic._streaming import SSEDecoder
from anthropic.lib.bedrock._client import AnthropicBedrock, AsyncAnthropicBedrock

import flightdeck_sensor
from flightdeck_sensor.core.policy import PolicyCache
from flightdeck_sensor.core.session import Session
from flightdeck_sensor.core.types import SensorConfig
from flightdeck_sensor.interceptor import anthropic as ai
from flightdeck_sensor.interceptor import base
from flightdeck_sensor.providers.anthropic import AnthropicProvider
from flightdeck_sensor.transport.client import ControlPlaneClient

MODEL = "claude-haiku-4-5"
HI = [{"role": "user", "content": "hi"}]
INPUT_TOKENS = 12
CACHE_READ_TOKENS = 4
OUTPUT_TOKENS = 9

MESSAGE: dict[str, Any] = {
    "id": "msg_1",
    "type": "message",
    "role": "assistant",
    "model": MODEL,
    "content": [{"type": "text", "text": "Hello"}],
    "stop_reason": "end_turn",
    "stop_sequence": None,
    "usage": {
        "input_tokens": INPUT_TOKENS,
        "output_tokens": OUTPUT_TOKENS,
        "cache_read_input_tokens": CACHE_READ_TOKENS,
        "cache_creation_input_tokens": 0,
    },
}


def _sse(event: str, data: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


SSE_BODY = "".join(
    [
        _sse(
            "message_start",
            {
                "type": "message_start",
                "message": {
                    **MESSAGE,
                    "content": [],
                    "stop_reason": None,
                    "usage": {**MESSAGE["usage"], "output_tokens": 1},
                },
            },
        ),
        _sse(
            "content_block_start",
            {
                "type": "content_block_start",
                "index": 0,
                "content_block": {"type": "text", "text": ""},
            },
        ),
        _sse(
            "content_block_delta",
            {
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "text_delta", "text": "Hello"},
            },
        ),
        _sse("content_block_stop", {"type": "content_block_stop", "index": 0}),
        _sse(
            "message_delta",
            {
                "type": "message_delta",
                "delta": {"stop_reason": "end_turn", "stop_sequence": None},
                "usage": {"output_tokens": OUTPUT_TOKENS},
            },
        ),
        _sse("message_stop", {"type": "message_stop"}),
    ]
).encode()


class _LazyBody(httpx.SyncByteStream, httpx.AsyncByteStream):
    """A response body that is read only when iterated, like a body still
    on the wire: httpx marks an in-memory body as consumed at
    construction, which would make every unread response look read."""

    def __init__(self, content: bytes) -> None:
        self._content = content

    def __iter__(self) -> Any:
        yield self._content

    async def __aiter__(self) -> Any:
        yield self._content


class _Transport:
    """Answers every request with the canned message, or the canned event
    stream when the request asks for one (``stream: true`` in the body,
    or Bedrock's / Vertex's streaming routes), and records it. With
    ``lazy`` the body is delivered only when read."""

    def __init__(self, status: int = 200, *, lazy: bool = False) -> None:
        self.requests: list[httpx.Request] = []
        self.status = status
        self.lazy = lazy

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.status != 200:
            return httpx.Response(
                self.status, json={"error": {"type": "server", "message": "boom"}}
            )
        body = json.loads(request.content or b"{}")
        streamed = body.get("stream") is True or "stream" in request.url.path.lower()
        headers = {"request-id": "req_test", "anthropic-ratelimit-tokens-remaining": "1000"}
        if streamed:
            headers["content-type"] = "text/event-stream"
            payload = SSE_BODY
        else:
            headers["content-type"] = "application/json"
            payload = json.dumps(MESSAGE).encode()
        if self.lazy:
            return httpx.Response(200, headers=headers, stream=_LazyBody(payload))
        return httpx.Response(200, headers=headers, content=payload)


# Every client class the SDK exports, by name as ``anthropic.<name>``.
# ``Client`` / ``AsyncClient`` are aliases of ``Anthropic`` /
# ``AsyncAnthropic``; they stay in the matrix because callers use them by
# that name.
CLIENT_NAMES: tuple[str, ...] = tuple(
    sorted(
        name
        for name in dir(anthropic)
        if isinstance(getattr(anthropic, name), type)
        and issubclass(getattr(anthropic, name), BaseClient)
    )
)

EXPECTED_CLIENT_NAMES = frozenset(
    {
        "Anthropic",
        "AsyncAnthropic",
        "Client",
        "AsyncClient",
        "AnthropicBedrock",
        "AsyncAnthropicBedrock",
        "AnthropicBedrockMantle",
        "AsyncAnthropicBedrockMantle",
        "AnthropicVertex",
        "AsyncAnthropicVertex",
        "AnthropicFoundry",
        "AsyncAnthropicFoundry",
        "AnthropicAWS",
        "AsyncAnthropicAWS",
    }
)


def _expected_platform(name: str) -> str:
    if name.endswith("BedrockMantle"):
        return "bedrock-mantle"
    if name.endswith("Bedrock"):
        return "bedrock"
    if name.endswith("Vertex"):
        return "vertex"
    if name.endswith("Foundry"):
        return "foundry"
    if name.endswith("AWS"):
        return "aws"
    return "anthropic"


def _build(name: str, transport: _Transport) -> Any:
    """Construct ``anthropic.<name>`` over the mock transport with the
    credentials each cloud client needs to build a request offline."""
    cls = getattr(anthropic, name)
    if issubclass(cls, AsyncAPIClient):
        http_client: Any = httpx.AsyncClient(transport=httpx.MockTransport(transport))
    else:
        http_client = httpx.Client(transport=httpx.MockTransport(transport))
    kwargs: dict[str, Any] = {"http_client": http_client, "max_retries": 0}
    if name.endswith("BedrockMantle") or name.endswith("Bedrock"):
        kwargs.update(api_key="bearer", aws_region="us-east-1")
    elif name.endswith("Vertex"):
        kwargs.update(access_token="token", project_id="proj", region="us-east5")
    elif name.endswith("Foundry"):
        kwargs.update(api_key="key", base_url="https://res.services.ai.azure.com/anthropic/")
    elif name.endswith("AWS"):
        kwargs.update(api_key="key", aws_region="us-east-1", workspace_id="ws")
    else:
        kwargs.update(api_key="key")
    return cls(**kwargs)


def _is_async(client: Any) -> bool:
    return isinstance(client, AsyncAPIClient)


# ----- fixtures ---------------------------------------------------------------


@pytest.fixture(autouse=True)
def _bedrock_streams_as_sse(monkeypatch: pytest.MonkeyPatch) -> None:
    """Bedrock streams arrive in AWS's binary event-stream framing, which
    the SDK decodes with botocore before the sensor ever sees an event.
    The sensor meters the decoded events, so the canned stream is served
    as SSE and the Bedrock decoder stubbed to the SDK's SSE decoder."""
    for cls in (AnthropicBedrock, AsyncAnthropicBedrock):
        monkeypatch.setattr(cls, "_make_sse_decoder", lambda self: SSEDecoder())


def _make_session(capture_prompts: bool = False) -> Session:
    config = SensorConfig(
        server="http://localhost:9999",
        token="tok",
        agent_flavor="test",
        agent_type="production",
        quiet=True,
        capture_prompts=capture_prompts,
    )
    client = MagicMock(spec=ControlPlaneClient)
    client.post_event.return_value = (None, False)
    # Inject the queue so no drain threads start for a test session.
    session = Session(config=config, client=client, event_queue=MagicMock())
    session.policy = PolicyCache(token_limit=None, block_at_pct=100)
    return session


@pytest.fixture
def session(monkeypatch: pytest.MonkeyPatch) -> Any:
    """An active session (what ``init()`` leaves behind) with the resource
    patch installed; unpatched after the test."""
    session = _make_session()
    monkeypatch.setattr(flightdeck_sensor, "_session", session)
    ai.patch_anthropic_classes(quiet=True)
    yield session
    ai.unpatch_anthropic_classes()


def _events_of(session: Session, event_type: str) -> list[dict[str, Any]]:
    queue = session.event_queue
    assert isinstance(queue, MagicMock)
    return [
        c.args[0] for c in queue.enqueue.call_args_list if c.args[0].get("event_type") == event_type
    ]


def _post_calls(session: Session) -> list[dict[str, Any]]:
    return _events_of(session, "post_call")


# ----- the call paths ---------------------------------------------------------


def _resource(client: Any, beta: bool) -> Any:
    return client.beta.messages if beta else client.messages


async def _path_create(client: Any, beta: bool, session: Session) -> Any:
    result = _resource(client, beta).create(model=MODEL, max_tokens=8, messages=HI)
    if inspect.isawaitable(result):
        result = await result
    return result


async def _path_parse(client: Any, beta: bool, session: Session) -> Any:
    result = _resource(client, beta).parse(model=MODEL, max_tokens=8, messages=HI)
    if inspect.isawaitable(result):
        result = await result
    return result


async def _path_stream_helper(client: Any, beta: bool, session: Session) -> Any:
    resource = _resource(client, beta)
    if _is_async(client):
        async with resource.stream(model=MODEL, max_tokens=8, messages=HI) as stream:
            async for _ in stream:
                pass
            return await stream.get_final_message()
    with resource.stream(model=MODEL, max_tokens=8, messages=HI) as stream:
        for _ in stream:
            pass
        return stream.get_final_message()


async def _path_create_stream(client: Any, beta: bool, session: Session) -> Any:
    stream = _resource(client, beta).create(model=MODEL, max_tokens=8, messages=HI, stream=True)
    events = []
    if inspect.isawaitable(stream):
        stream = await stream
        async for event in stream:
            events.append(event)
    else:
        for event in stream:
            events.append(event)
    return events


async def _path_raw_response(client: Any, beta: bool, session: Session) -> Any:
    raw = _resource(client, beta).with_raw_response.create(model=MODEL, max_tokens=8, messages=HI)
    if inspect.isawaitable(raw):
        raw = await raw
    assert raw.headers["request-id"] == "req_test"
    return raw.parse()


async def _path_streaming_response(client: Any, beta: bool, session: Session) -> Any:
    manager = _resource(client, beta).with_streaming_response.create(
        model=MODEL, max_tokens=8, messages=HI
    )
    if hasattr(manager, "__aenter__"):
        async with manager as response:
            assert not _post_calls(session), "metering must wait for parse()"
            assert response.headers["request-id"] == "req_test"
            message = await response.parse()
            assert len(_post_calls(session)) == 1, "parse() settles the call"
        return message
    with manager as response:
        assert not _post_calls(session), "metering must wait for parse()"
        assert response.headers["request-id"] == "req_test"
        message = response.parse()
        assert len(_post_calls(session)) == 1, "parse() settles the call"
    return message


PATHS: dict[str, Any] = {
    "create": _path_create,
    "stream_helper": _path_stream_helper,
    "create_stream_true": _path_create_stream,
    "raw_response": _path_raw_response,
    "streaming_response": _path_streaming_response,
    "parse": _path_parse,
}
STREAMED_PATHS = frozenset({"stream_helper", "create_stream_true"})
RAW_VIEW_PATHS = frozenset({"raw_response", "streaming_response"})
# The resource method each path needs to exist.
PATH_METHOD = {
    "create": "create",
    "stream_helper": "stream",
    "create_stream_true": "create",
    "raw_response": "create",
    "streaming_response": "create",
    "parse": "parse",
}


# ----- the matrix -------------------------------------------------------------


@pytest.mark.parametrize("beta", [False, True], ids=["messages", "beta.messages"])
@pytest.mark.parametrize("path", sorted(PATHS))
@pytest.mark.parametrize("name", CLIENT_NAMES)
def test_every_client_class_on_every_path(
    session: Session, name: str, path: str, beta: bool
) -> None:
    """One request leaves, one pre_call and one post_call land, the
    post_call carries the usage the provider sent (not the estimate) and
    the platform the client talks to, and only streamed calls carry the
    streaming block."""
    transport = _Transport()
    client = _build(name, transport)
    resource = _resource(client, beta)
    if not hasattr(resource, PATH_METHOD[path]):
        # The SDK's own surface: Bedrock's beta resource has no stream()
        # or parse(), Vertex's no parse(). The canary pins these sets.
        pytest.skip(
            f"{type(resource).__module__}.{type(resource).__name__} has no {PATH_METHOD[path]}"
        )

    result = asyncio.run(PATHS[path](client, beta, session))

    assert result is not None
    assert len(transport.requests) == 1
    assert len(_events_of(session, "pre_call")) == 1
    posts = _post_calls(session)
    assert len(posts) == 1, f"{name}.{path}: expected one post_call, got {len(posts)}"
    post = posts[0]
    assert post["tokens_input"] == INPUT_TOKENS + CACHE_READ_TOKENS
    assert post["tokens_output"] == OUTPUT_TOKENS
    assert post["tokens_cache_read"] == CACHE_READ_TOKENS
    assert post["model"] == MODEL
    assert post["provider_metadata"]["platform"] == _expected_platform(name)
    assert ("streaming" in post) == (path in STREAMED_PATHS)
    if path in RAW_VIEW_PATHS:
        # Only the raw views expose the HTTP headers; a parsed Message
        # carries none.
        assert post["provider_metadata"]["request_id"] == "req_test"
    assert not _events_of(session, "llm_error")


@pytest.mark.parametrize("name", CLIENT_NAMES)
def test_without_a_session_the_patched_resource_is_a_pass_through(
    monkeypatch: pytest.MonkeyPatch, name: str
) -> None:
    """Patched but not initialised: the SDK call runs untouched and no
    guard state is created."""
    monkeypatch.setattr(flightdeck_sensor, "_session", None)
    ai.patch_anthropic_classes(quiet=True)
    try:
        transport = _Transport()
        client = _build(name, transport)
        monkeypatch.setattr(base, "call", MagicMock(side_effect=AssertionError("intercepted")))
        monkeypatch.setattr(
            base, "call_async", MagicMock(side_effect=AssertionError("intercepted"))
        )
        result = asyncio.run(_path_create(client, False, _make_session()))
        assert result.usage.output_tokens == OUTPUT_TOKENS
        assert len(transport.requests) == 1
    finally:
        ai.unpatch_anthropic_classes()


# ----- deferred metering on the streaming view -----------------------


def test_streaming_response_closed_unparsed_reports_the_estimate(session: Session) -> None:
    """A body the caller never read is never read by the sensor either:
    the post_call lands at close with the pre-call estimate and no
    output tokens."""
    client = _build("Anthropic", _Transport(lazy=True))
    with client.messages.with_streaming_response.create(
        model=MODEL, max_tokens=8, messages=HI
    ) as response:
        assert not response.http_response.is_stream_consumed
        assert not _post_calls(session)
    posts = _post_calls(session)
    assert len(posts) == 1
    assert posts[0]["tokens_output"] == 0
    assert posts[0]["estimated_via"] == "heuristic"
    assert posts[0]["provider_metadata"]["platform"] == "anthropic"
    assert posts[0]["provider_metadata"]["request_id"] == "req_test"


def test_streaming_response_read_without_parse_is_metered_at_close(session: Session) -> None:
    """A body the caller consumed some other way (``read()``) is parsed
    from the already-read bytes at close, so the usage is real and
    nothing is fetched from the network."""
    transport = _Transport(lazy=True)
    client = _build("Anthropic", transport)
    with client.messages.with_streaming_response.create(
        model=MODEL, max_tokens=8, messages=HI
    ) as response:
        assert not response.http_response.is_stream_consumed
        body = response.read()
        assert b"Hello" in body
        assert not _post_calls(session)
    posts = _post_calls(session)
    assert len(posts) == 1
    assert posts[0]["tokens_output"] == OUTPUT_TOKENS
    assert len(transport.requests) == 1


async def test_async_streaming_response_closed_unparsed_reports_the_estimate(
    session: Session,
) -> None:
    client = _build("AsyncAnthropic", _Transport(lazy=True))
    async with client.messages.with_streaming_response.create(
        model=MODEL, max_tokens=8, messages=HI
    ) as response:
        assert not response.http_response.is_stream_consumed
        assert not _post_calls(session)
        assert response.headers["request-id"] == "req_test"
    posts = _post_calls(session)
    assert len(posts) == 1
    assert posts[0]["tokens_output"] == 0


async def test_async_parse_is_awaited_not_called(session: Session) -> None:
    """The async streaming-response ``parse()`` is a coroutine; the sensor
    must await it through the caller, never call it and discard it."""
    client = _build("AsyncAnthropic", _Transport())
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        async with client.messages.with_streaming_response.create(
            model=MODEL, max_tokens=8, messages=HI
        ) as response:
            message = await response.parse()
        raw = await client.messages.with_raw_response.create(model=MODEL, max_tokens=8, messages=HI)
        assert raw.parse().usage.output_tokens == OUTPUT_TOKENS
    assert message.usage.output_tokens == OUTPUT_TOKENS
    assert not [w for w in caught if "never awaited" in str(w.message)]
    posts = _post_calls(session)
    assert [p["tokens_output"] for p in posts] == [OUTPUT_TOKENS, OUTPUT_TOKENS]


def test_streaming_response_with_stream_true_hands_the_stream_to_the_guard(
    session: Session,
) -> None:
    """``with_streaming_response.create(stream=True)``: ``parse()`` returns
    the SDK event stream, which the guard meters as it is iterated."""
    client = _build("Anthropic", _Transport())
    with client.messages.with_streaming_response.create(
        model=MODEL, max_tokens=8, messages=HI, stream=True
    ) as response:
        stream = response.parse()
        assert isinstance(stream, base.GuardedStream)
        events = list(stream)
    assert [e.type for e in events][0] == "message_start"
    posts = _post_calls(session)
    assert len(posts) == 1
    assert posts[0]["tokens_output"] == OUTPUT_TOKENS
    assert posts[0]["streaming"]["final_outcome"] == "completed"


def test_raw_response_with_stream_true_is_metered_at_parse(session: Session) -> None:
    """``with_raw_response.create(stream=True)`` returns a response whose
    ``parse()`` yields the event stream; metering follows the stream."""
    client = _build("Anthropic", _Transport())
    raw = client.messages.with_raw_response.create(
        model=MODEL, max_tokens=8, messages=HI, stream=True
    )
    assert not _post_calls(session)
    events = list(raw.parse())
    assert events[-1].type == "message_stop"
    posts = _post_calls(session)
    assert len(posts) == 1
    assert posts[0]["tokens_output"] == OUTPUT_TOKENS
    assert "streaming" in posts[0]


async def test_async_raw_response_with_stream_true_is_metered_at_parse(session: Session) -> None:
    client = _build("AsyncAnthropic", _Transport())
    raw = await client.messages.with_raw_response.create(
        model=MODEL, max_tokens=8, messages=HI, stream=True
    )
    assert not _post_calls(session)
    stream = raw.parse()
    assert isinstance(stream, base.GuardedAsyncStream)
    async for _ in stream:
        pass
    posts = _post_calls(session)
    assert len(posts) == 1
    assert posts[0]["tokens_output"] == OUTPUT_TOKENS


@pytest.mark.parametrize("name", ["Anthropic", "AsyncAnthropic"])
def test_streaming_response_request_failure_emits_llm_error(session: Session, name: str) -> None:
    """A request that fails on the streaming view is reported
    like any other failed call, and nothing is owed afterwards."""
    client = _build(name, _Transport(status=500))

    async def _run() -> None:
        manager = client.messages.with_streaming_response.create(
            model=MODEL, max_tokens=8, messages=HI
        )
        if hasattr(manager, "__aenter__"):
            async with manager:
                pass
        else:
            with manager:
                pass

    with pytest.raises(anthropic.InternalServerError):
        asyncio.run(_run())
    assert len(_events_of(session, "llm_error")) == 1
    assert not _post_calls(session)


def test_streaming_response_captures_the_parsed_message_when_capture_is_on(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    session = _make_session(capture_prompts=True)
    monkeypatch.setattr(flightdeck_sensor, "_session", session)
    ai.patch_anthropic_classes(quiet=True)
    try:
        client = _build("Anthropic", _Transport())
        with client.messages.with_streaming_response.create(
            model=MODEL, max_tokens=8, messages=HI
        ) as response:
            response.parse()
    finally:
        ai.unpatch_anthropic_classes()
    posts = _post_calls(session)
    assert posts[0]["has_content"] is True
    content = posts[0]["content"]
    assert content["provider"] == "anthropic"
    assert content["response"]["content"][0]["text"] == "Hello"
    assert content["messages"] == HI


def test_raw_response_stores_no_content_when_capture_is_off(session: Session) -> None:
    client = _build("Anthropic", _Transport())
    client.messages.with_raw_response.create(model=MODEL, max_tokens=8, messages=HI)
    post = _post_calls(session)[0]
    assert not post.get("has_content")
    assert post.get("content") is None


# ----- platform attribution ---------------------------------------------------


@pytest.mark.parametrize(
    ("host", "platform"),
    [
        ("api.anthropic.com", "anthropic"),
        ("bedrock-runtime.us-east-1.amazonaws.com", "bedrock"),
        ("bedrock-mantle.us-east-1.api.aws", "bedrock-mantle"),
        ("aws-external-anthropic.us-east-1.api.aws", "aws"),
        ("us-east5-aiplatform.googleapis.com", "vertex"),
        ("aiplatform.googleapis.com", "vertex"),
        ("myres.services.ai.azure.com", "foundry"),
        ("localhost", "localhost"),
        ("bifrost.internal.example", "bifrost.internal.example"),
    ],
)
def test_platform_for_host(host: str, platform: str) -> None:
    assert ai.platform_for_host(host) == platform


def test_platform_of_prefers_the_sdk_attribute_over_the_host() -> None:
    client = _build("AnthropicBedrock", _Transport())
    assert ai.platform_of(client) == "bedrock"
    client._otel_platform = "sdk-says-so"
    assert ai.platform_of(client) == "sdk-says-so"


def test_platform_of_falls_back_to_anthropic_without_a_usable_host() -> None:
    assert ai.platform_of(object()) == "anthropic"
    assert ai.platform_of(MagicMock()) == "anthropic"


def test_bare_provider_keeps_the_metadata_block_headers_only() -> None:
    assert AnthropicProvider().extract_response_metadata(object()) is None
    assert AnthropicProvider(platform="vertex").extract_response_metadata(object()) == {
        "platform": "vertex"
    }


# ----- wrap() on any client -----------------------------------------------------


@pytest.mark.parametrize("name", ["AnthropicBedrock", "AnthropicVertex", "AnthropicFoundry"])
def test_wrap_accepts_cloud_clients(monkeypatch: pytest.MonkeyPatch, name: str) -> None:
    session = _make_session()
    monkeypatch.setattr(flightdeck_sensor, "_session", session)
    client = _build(name, _Transport())
    wrapped = flightdeck_sensor.wrap(client)
    assert isinstance(wrapped, ai.SensorAnthropic)
    wrapped.messages.create(model=MODEL, max_tokens=8, messages=HI)
    posts = _post_calls(session)
    assert len(posts) == 1
    assert posts[0]["provider_metadata"]["platform"] == _expected_platform(name)


async def test_wrap_accepts_async_cloud_clients(monkeypatch: pytest.MonkeyPatch) -> None:
    session = _make_session()
    monkeypatch.setattr(flightdeck_sensor, "_session", session)
    client = _build("AsyncAnthropicVertex", _Transport())
    wrapped = flightdeck_sensor.wrap(client)
    assert isinstance(wrapped, ai.SensorAnthropic)
    message = await wrapped.messages.create(model=MODEL, max_tokens=8, messages=HI)
    assert message.usage.output_tokens == OUTPUT_TOKENS
    assert _post_calls(session)[0]["provider_metadata"]["platform"] == "vertex"


def test_wrap_then_patch_meters_each_call_once(monkeypatch: pytest.MonkeyPatch) -> None:
    session = _make_session()
    monkeypatch.setattr(flightdeck_sensor, "_session", session)
    client = _build("Anthropic", _Transport())
    wrapped = flightdeck_sensor.wrap(client)
    ai.patch_anthropic_classes(quiet=True)
    try:
        wrapped.messages.create(model=MODEL, max_tokens=8, messages=HI)
        wrapped.beta.messages.create(model=MODEL, max_tokens=8, messages=HI)
    finally:
        ai.unpatch_anthropic_classes()
    assert len(_post_calls(session)) == 2
    assert len(_events_of(session, "pre_call")) == 2


def test_wrap_is_a_noop_once_the_resources_are_patched(session: Session) -> None:
    client = _build("AnthropicBedrock", _Transport())
    assert flightdeck_sensor.wrap(client) is client


def test_wrapped_client_raw_and_streaming_views_are_metered(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Without patch(): the wrapped client's ``with_raw_response`` and
    ``with_streaming_response`` reach the proxies, on ``messages`` and
    on ``beta.messages``."""
    session = _make_session()
    monkeypatch.setattr(flightdeck_sensor, "_session", session)
    client = _build("Anthropic", _Transport())
    wrapped = flightdeck_sensor.wrap(client)

    raw = wrapped.with_raw_response.messages.create(model=MODEL, max_tokens=8, messages=HI)
    assert raw.parse().usage.output_tokens == OUTPUT_TOKENS
    with wrapped.with_streaming_response.messages.create(
        model=MODEL, max_tokens=8, messages=HI
    ) as response:
        assert len(_post_calls(session)) == 1
        response.parse()
    assert len(_post_calls(session)) == 2
    beta_raw = wrapped.with_raw_response.beta.messages.create(
        model=MODEL, max_tokens=8, messages=HI
    )
    assert beta_raw.parse().usage.output_tokens == OUTPUT_TOKENS
    with wrapped.with_streaming_response.beta.messages.create(
        model=MODEL, max_tokens=8, messages=HI
    ) as response:
        response.parse()
    posts = _post_calls(session)
    assert len(posts) == 4
    assert all(p["tokens_output"] == OUTPUT_TOKENS for p in posts)
    # Anything else on the view still reaches the SDK's own view object.
    assert wrapped.with_raw_response.models is client.with_raw_response.models


# ----- module-layout canary -----------------------------------------------------


def test_sdk_layout_the_patch_relies_on() -> None:
    """Fails when the SDK moves or reshapes what the patch depends on:
    the four resource classes with ``create`` / ``stream`` / ``parse``
    as plain functions in their own ``__dict__``, ``BaseClient`` /
    ``AsyncAPIClient`` as the client roots, the raw-response header, the
    raw and streaming views binding the resource's method at
    construction, and the set of exported client classes. A failure
    here means the matrix above needs a new row, not that the sensor
    is broken."""
    from anthropic import _constants
    from anthropic.resources.beta.messages import messages as beta_messages
    from anthropic.resources.messages import messages as top_messages

    for module in (top_messages, beta_messages):
        for cls_name in ("Messages", "AsyncMessages"):
            cls = getattr(module, cls_name)
            for method in ai._PATCHED_METHODS:
                assert inspect.isfunction(cls.__dict__.get(method)), (
                    f"{module.__name__}.{cls_name}.{method} is not a plain function"
                )
            assert "with_raw_response" in cls.__dict__
            assert "with_streaming_response" in cls.__dict__
    assert ai._OrigMessages is top_messages.Messages
    assert ai._OrigAsyncMessages is top_messages.AsyncMessages
    assert ai._OrigBetaMessages is beta_messages.Messages
    assert ai._OrigAsyncBetaMessages is beta_messages.AsyncMessages
    assert ai._OrigBaseClient is BaseClient
    assert ai._OrigAsyncAPIClient is AsyncAPIClient
    assert _constants.RAW_RESPONSE_HEADER == ai._RAW_RESPONSE_HEADER

    # The views capture ``messages.create`` when they are built, which is
    # what makes a class-level method patch reach them.
    resource = _build("Anthropic", _Transport()).messages
    raw_view = top_messages.MessagesWithRawResponse(resource)
    assert raw_view.create.__wrapped__.__self__ is resource  # type: ignore[attr-defined]
    streaming_view = top_messages.MessagesWithStreamingResponse(resource)
    assert streaming_view.create.__wrapped__.__self__ is resource  # type: ignore[attr-defined]

    assert frozenset(CLIENT_NAMES) == EXPECTED_CLIENT_NAMES, (
        "the SDK's exported client classes changed; extend the matrix"
    )

    # Bedrock and Vertex ship their own beta resources, copying the
    # first-party methods they support; the patch targets them directly.
    from anthropic.lib.bedrock import _beta_messages as bedrock_beta
    from anthropic.lib.vertex import _beta_messages as vertex_beta

    patched_classes = {cls for cls, _ in ai._resource_targets()}
    assert {
        bedrock_beta.Messages,
        bedrock_beta.AsyncMessages,
        vertex_beta.Messages,
        vertex_beta.AsyncMessages,
    } <= patched_classes
    for cls in (bedrock_beta.Messages, bedrock_beta.AsyncMessages):
        assert set(cls.__dict__) & set(ai._PATCHED_METHODS) == {"create"}
    for cls in (vertex_beta.Messages, vertex_beta.AsyncMessages):
        assert set(cls.__dict__) & set(ai._PATCHED_METHODS) == {"create", "stream"}

    # Every client hands out a patched class (or a subclass of one), for
    # messages and for beta.messages.
    for name in CLIENT_NAMES:
        client = _build(name, _Transport())
        for resource in (client.messages, client.beta.messages):
            assert patched_classes & set(type(resource).__mro__), (
                f"{name}: {type(resource)} is not covered by the patch"
            )
