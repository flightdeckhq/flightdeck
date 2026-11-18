"""A call through an SDK's raw view (``with_raw_response``) reports the
event a plain call with the same reply reports: the stored response is the
message the wrapper's ``parse()`` returns, dumped as the plain call's is,
and the model is the served one (ARCHITECTURE.md, the response side of the
stored content under "``PromptContent`` dataclass").

Every row drives a real ``openai`` / ``anthropic`` client over respx, so
the SDK builds the raw-response wrapper the sensor sees: ``LegacyAPIResponse``
on every OpenAI raw view and on the anthropic 0.x one, ``APIResponse`` /
``AsyncAPIResponse`` on anthropic 2.x. The oracle is the plain call with
the same reply in the same environment, so a row holds for the SDK release
the lane installs. Beside the event, the rows pin what the caller observes
of the wrapper (its parse, headers, body and errors), which must not change
because the sensor read it first, and what is stored for a response that is
not a message: never an object's attributes or its string form.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import logging
from typing import TYPE_CHECKING, Any
from unittest.mock import MagicMock

import anthropic
import httpx
import openai
import pydantic
import pytest
import respx

import flightdeck_sensor
from flightdeck_sensor.core.exceptions import BudgetExceededError
from flightdeck_sensor.core.policy import PolicyCache
from flightdeck_sensor.core.session import Session
from flightdeck_sensor.core.types import EventType, SensorConfig
from flightdeck_sensor.interceptor.anthropic import (
    patch_anthropic_classes,
    unpatch_anthropic_classes,
)
from flightdeck_sensor.interceptor.openai import patch_openai_classes, unpatch_openai_classes
from flightdeck_sensor.providers._access import DROPPED_STREAM
from flightdeck_sensor.providers.anthropic import AnthropicProvider
from flightdeck_sensor.providers.openai import OpenAIProvider
from flightdeck_sensor.transport import body_limit
from flightdeck_sensor.transport.body_limit import serialize_event
from flightdeck_sensor.transport.client import ControlPlaneClient

if TYPE_CHECKING:
    from collections.abc import Callable, Iterator

pytestmark = [
    # A coroutine the sensor created and never awaited (an async parse()
    # called on the hot path) fails the row.
    pytest.mark.filterwarnings("error::RuntimeWarning"),
    pytest.mark.filterwarnings("error::pytest.PytestUnraisableExceptionWarning"),
]

OPENAI_MODEL, OPENAI_SERVED = "gpt-4o-mini", "gpt-4o-mini-2024-07-18"
ANTHROPIC_MODEL, ANTHROPIC_SERVED = "claude-haiku-4-5", "claude-haiku-4-5-20251001"
REQUEST_ID = "req_raw_content"
HEADERS = {"x-request-id": REQUEST_ID, "request-id": REQUEST_ID}
CHAT_URL = "https://api.openai.com/v1/chat/completions"
RESPONSES_URL = "https://api.openai.com/v1/responses"
EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings"
MESSAGES_URL = "https://api.anthropic.com/v1/messages"
URLS = {"chat": CHAT_URL, "responses": RESPONSES_URL, "messages": MESSAGES_URL}
MESSAGES = [{"role": "user", "content": "SECRET-PROMPT-raw-content: weather in Paris?"}]

# A strict tool, so the SDKs' ``parse()`` accepts it and parses the call.
TOOL = {
    "type": "function",
    "function": {
        "name": "get_weather",
        "strict": True,
        "parameters": {
            "type": "object",
            "properties": {"city": {"type": "string"}},
            "required": ["city"],
            "additionalProperties": False,
        },
    },
}
CHAT_KW: dict[str, Any] = {"model": OPENAI_MODEL, "messages": MESSAGES, "tools": [TOOL]}
RESPONSES_KW: dict[str, Any] = {"model": OPENAI_MODEL, "input": "hi", "max_output_tokens": 16}
EMBEDDINGS_KW: dict[str, Any] = {"model": "text-embedding-3-small", "input": "hi"}
MESSAGES_KW: dict[str, Any] = {"model": ANTHROPIC_MODEL, "max_tokens": 16, "messages": MESSAGES}

# Replies whose served model differs from the requested alias and which
# call a tool, so the model, the stop reason and the tool_call events all
# depend on reading the message.
CHAT = {
    "id": "chatcmpl-raw",
    "object": "chat.completion",
    "created": 1,
    "model": OPENAI_SERVED,
    "choices": [
        {
            "index": 0,
            "finish_reason": "tool_calls",
            "message": {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": "call_1",
                        "type": "function",
                        "function": {"name": "get_weather", "arguments": '{"city": "Paris"}'},
                    }
                ],
            },
        }
    ],
    "usage": {"prompt_tokens": 11, "completion_tokens": 7, "total_tokens": 18},
}
RESPONSE = {
    "id": "resp_raw",
    "object": "response",
    "created_at": 1,
    "model": OPENAI_SERVED,
    "status": "completed",
    "output": [
        {
            "type": "function_call",
            "id": "fc_1",
            "call_id": "call_1",
            "name": "get_weather",
            "arguments": '{"city": "Paris"}',
            "status": "completed",
        }
    ],
    "usage": {"input_tokens": 11, "output_tokens": 7, "total_tokens": 18},
    "parallel_tool_calls": True,
    "tool_choice": "auto",
    "tools": [],
}
EMBEDDINGS = {
    "object": "list",
    "model": "text-embedding-3-small",
    "data": [{"object": "embedding", "index": 0, "embedding": [0.1, 0.2]}],
    "usage": {"prompt_tokens": 3, "total_tokens": 3},
}
MESSAGE = {
    "id": "msg_raw",
    "type": "message",
    "role": "assistant",
    "model": ANTHROPIC_SERVED,
    "content": [
        {"type": "tool_use", "id": "toolu_1", "name": "get_weather", "input": {"city": "Paris"}}
    ],
    "stop_reason": "tool_use",
    "stop_sequence": None,
    "usage": {"input_tokens": 11, "output_tokens": 7},
}
NOT_JSON = b"this body is not JSON"

# The SDKs' raw-response wrappers keep these as instance attributes; none
# is a field of any message.
WRAPPER_ATTRIBUTES = frozenset({"_stream", "_stream_cls", "_is_sse_stream", "retries_taken"})


def _reply(body: dict[str, Any]) -> httpx.Response:
    return httpx.Response(200, json=body, headers=HEADERS)


@pytest.fixture
def router() -> Iterator[respx.MockRouter]:
    with respx.mock(assert_all_called=False) as mocked:
        mocked.post(CHAT_URL, name="chat").mock(return_value=_reply(CHAT))
        mocked.post(RESPONSES_URL, name="responses").mock(return_value=_reply(RESPONSE))
        mocked.post(EMBEDDINGS_URL, name="embeddings").mock(return_value=_reply(EMBEDDINGS))
        mocked.post(MESSAGES_URL, name="messages").mock(return_value=_reply(MESSAGE))
        yield mocked


def _not_json(router: respx.MockRouter) -> None:
    """Answer every route with a 200 whose body is not the JSON it claims."""
    for name in ("chat", "responses", "embeddings", "messages"):
        router.routes[name].mock(
            return_value=httpx.Response(
                200, content=NOT_JSON, headers={"content-type": "application/json", **HEADERS}
            )
        )


def _session(*, capture: bool) -> Session:
    config = SensorConfig(
        server="http://localhost:9999",
        token="tok",
        agent_flavor="raw-content",
        agent_type="production",
        quiet=True,
        capture_prompts=capture,
    )
    client = MagicMock(spec=ControlPlaneClient)
    client.post_event.return_value = (None, False)
    session = Session(config=config, client=client, event_queue=MagicMock())
    session.policy = PolicyCache(token_limit=None, block_at_pct=100)
    return session


@pytest.fixture
def sensored(monkeypatch: pytest.MonkeyPatch) -> Iterator[Callable[..., Session]]:
    """Install a session and patch both SDKs; unpatched again after."""

    def _install(*, capture: bool = True) -> Session:
        session = _session(capture=capture)
        monkeypatch.setattr(flightdeck_sensor, "_session", session)
        patch_anthropic_classes(quiet=True)
        patch_openai_classes(quiet=True)
        return session

    yield _install
    unpatch_anthropic_classes()
    unpatch_openai_classes()


def _unsensored() -> None:
    unpatch_anthropic_classes()
    unpatch_openai_classes()
    flightdeck_sensor._session = None


def _client(sdk: str, is_async: bool) -> Any:
    if sdk == "anthropic":
        cls: Any = anthropic.AsyncAnthropic if is_async else anthropic.Anthropic
    else:
        cls = openai.AsyncOpenAI if is_async else openai.OpenAI
    return cls(api_key="k", max_retries=0)


async def _resolve(value: Any) -> Any:
    return await value if inspect.isawaitable(value) else value


def _run(make: Callable[[], Any]) -> Any:
    """``make()``'s result, awaited when it is awaitable, on a fresh loop."""
    return asyncio.run(_resolve(make()))


# name -> (sdk, plain call, raw-view call). The plain call is the oracle:
# the same request through the same resource without the view.
_PATHS: dict[str, tuple[str, Callable[[Any], Any], Callable[[Any], Any]]] = {
    "chat.completions.with_raw_response.create": (
        "openai",
        lambda c: c.chat.completions.create(**CHAT_KW),
        lambda c: c.chat.completions.with_raw_response.create(**CHAT_KW),
    ),
    "client.with_raw_response.chat.completions.create": (
        "openai",
        lambda c: c.chat.completions.create(**CHAT_KW),
        lambda c: c.with_raw_response.chat.completions.create(**CHAT_KW),
    ),
    "chat.completions.with_raw_response.parse": (
        "openai",
        lambda c: c.chat.completions.parse(**CHAT_KW),
        lambda c: c.chat.completions.with_raw_response.parse(**CHAT_KW),
    ),
    "responses.with_raw_response.create": (
        "openai",
        lambda c: c.responses.create(**RESPONSES_KW),
        lambda c: c.responses.with_raw_response.create(**RESPONSES_KW),
    ),
    "client.with_raw_response.responses.create": (
        "openai",
        lambda c: c.responses.create(**RESPONSES_KW),
        lambda c: c.with_raw_response.responses.create(**RESPONSES_KW),
    ),
    "responses.with_raw_response.parse": (
        "openai",
        lambda c: c.responses.parse(**RESPONSES_KW),
        lambda c: c.responses.with_raw_response.parse(**RESPONSES_KW),
    ),
    "embeddings.with_raw_response.create": (
        "openai",
        lambda c: c.embeddings.create(**EMBEDDINGS_KW),
        lambda c: c.embeddings.with_raw_response.create(**EMBEDDINGS_KW),
    ),
    "messages.with_raw_response.create": (
        "anthropic",
        lambda c: c.messages.create(**MESSAGES_KW),
        lambda c: c.messages.with_raw_response.create(**MESSAGES_KW),
    ),
    "client.with_raw_response.messages.create": (
        "anthropic",
        lambda c: c.messages.create(**MESSAGES_KW),
        lambda c: c.with_raw_response.messages.create(**MESSAGES_KW),
    ),
    "beta.messages.with_raw_response.create": (
        "anthropic",
        lambda c: c.beta.messages.create(**MESSAGES_KW),
        lambda c: c.beta.messages.with_raw_response.create(**MESSAGES_KW),
    ),
    "client.with_raw_response.beta.messages.create": (
        "anthropic",
        lambda c: c.beta.messages.create(**MESSAGES_KW),
        lambda c: c.with_raw_response.beta.messages.create(**MESSAGES_KW),
    ),
}
# The paths whose wrapper is read at the call, not through the parse
# intercept (which reports an unparseable body as an llm_error alone).
_CREATE_PATHS = sorted(name for name in _PATHS if name.endswith(".create"))
_MESSAGE_PATHS = sorted(name for name in _PATHS if not name.startswith("embeddings"))
_SERVED = {"openai": OPENAI_SERVED, "anthropic": ANTHROPIC_SERVED}
_REQUESTED = {"openai": OPENAI_MODEL, "anthropic": ANTHROPIC_MODEL}

# The call event's fields that depend on the reply.
_FIELDS = (
    "event_type",
    "model",
    "model_requested",
    "model_served",
    "tokens_input",
    "tokens_output",
    "tokens_total",
    "stop_reason",
    "provider_metadata",
    "output_dimensions",
    "has_content",
)
# Fields of the stored content that differ from one call to the next.
_PER_CALL_CONTENT_FIELDS = frozenset({"captured_at", "event_id", "session_id"})


def _sent(session: Session, start: int) -> list[dict[str, Any]]:
    """The events enqueued since ``start``, as the transport sends them."""
    calls = session.event_queue.enqueue.call_args_list  # type: ignore[attr-defined]
    return [json.loads(serialize_event(dict(c.args[0]))) for c in calls[start:]]


def _mark(session: Session) -> int:
    return len(session.event_queue.enqueue.call_args_list)  # type: ignore[attr-defined]


def _call_event(events: list[dict[str, Any]]) -> dict[str, Any]:
    calls = [e for e in events if e["event_type"] in ("post_call", "embeddings")]
    assert len(calls) == 1, [e["event_type"] for e in events]
    return calls[0]


def _report(events: list[dict[str, Any]]) -> dict[str, Any]:
    """What the session reported for one call: the call event's reply
    fields, its stored content and the tool_call events it emitted."""
    event = _call_event(events)
    fields = {name: event.get(name) for name in _FIELDS}
    metadata = dict(fields["provider_metadata"] or {})
    # The plain Anthropic call reads no response header (see the
    # request-id rows below).
    metadata.pop("request_id", None)
    fields["provider_metadata"] = metadata
    content = event.get("content")
    if isinstance(content, dict):
        content = {k: v for k, v in content.items() if k not in _PER_CALL_CONTENT_FIELDS}
    tools = sorted(e["tool_name"] for e in events if e["event_type"] == "tool_call")
    errors = [e for e in events if e["event_type"] == "llm_error"]
    return {"fields": fields, "content": content, "tools": tools, "errors": len(errors)}


def _plain(session: Session, name: str, is_async: bool) -> list[dict[str, Any]]:
    sdk, plain, _raw = _PATHS[name]
    start = _mark(session)
    _run(lambda: plain(_client(sdk, is_async)))
    return _sent(session, start)


def _raw(session: Session, name: str, is_async: bool) -> tuple[Any, Any, list[dict[str, Any]]]:
    """The wrapper the raw call returned, what the caller's own parse()
    gave, and the events the call emitted."""
    sdk, _plain_call, raw = _PATHS[name]
    start = _mark(session)
    wrapper = _run(lambda: raw(_client(sdk, is_async)))
    message = _run(wrapper.parse)
    return wrapper, message, _sent(session, start)


@pytest.mark.parametrize("is_async", [False, True], ids=["sync", "async"])
@pytest.mark.parametrize("name", sorted(_PATHS))
def test_a_raw_call_reports_the_plain_calls_event(
    name: str, is_async: bool, router: respx.MockRouter, sensored: Callable[..., Session]
) -> None:
    session = sensored(capture=True)
    expected = _report(_plain(session, name, is_async))
    _wrapper, _message, events = _raw(session, name, is_async)
    assert _report(events) == expected
    sdk = _PATHS[name][0]
    if name.startswith("embeddings"):
        return
    assert expected["fields"]["model"] == _SERVED[sdk]
    assert expected["tools"] == ["get_weather"]


@pytest.mark.parametrize("is_async", [False, True], ids=["sync", "async"])
@pytest.mark.parametrize("name", _MESSAGE_PATHS)
def test_the_stored_response_of_a_raw_call_is_its_message_not_the_wrapper(
    name: str, is_async: bool, router: respx.MockRouter, sensored: Callable[..., Session]
) -> None:
    """The stored response is the dump of the message the caller's own
    ``parse()`` returns, and none of it is the wrapper's own state."""
    session = sensored(capture=True)
    wrapper, message, events = _raw(session, name, is_async)
    stored = _call_event(events)["content"]["response"]
    assert stored == json.loads(json.dumps(message.model_dump(warnings=False), default=str))
    assert not set(stored) & (set(vars(wrapper)) | WRAPPER_ATTRIBUTES)


@pytest.mark.parametrize("is_async", [False, True], ids=["sync", "async"])
@pytest.mark.parametrize("name", sorted(_PATHS))
def test_a_raw_call_with_capture_off_reports_the_served_model_and_no_content(
    name: str, is_async: bool, router: respx.MockRouter, sensored: Callable[..., Session]
) -> None:
    session = sensored(capture=False)
    expected = _report(_plain(session, name, is_async))
    _wrapper, _message, events = _raw(session, name, is_async)
    reported = _report(events)
    assert reported == expected
    assert reported["content"] is None
    assert not reported["fields"]["has_content"]
    if not name.startswith("embeddings"):
        assert reported["fields"]["model"] == _SERVED[_PATHS[name][0]]
    body = json.dumps([c.args[0] for c in session.event_queue.enqueue.call_args_list], default=str)  # type: ignore[attr-defined]
    assert "SECRET-PROMPT" not in body


class _Mine(pydantic.BaseModel):
    id: str


def _outcome(fn: Callable[[], Any]) -> tuple[str, Any]:
    try:
        return ("ok", _run(fn))
    except Exception as exc:
        return ("raised", (type(exc).__name__, str(exc)))


def _shape(outcome: tuple[str, Any]) -> Any:
    kind, value = outcome
    if kind == "raised":
        return outcome
    dump = getattr(value, "model_dump", None)
    return (type(value).__name__, json.dumps(dump(), default=str) if callable(dump) else value)


def _observe(make: Callable[[], Any], *, typed_first: bool) -> dict[str, Any]:
    """What a caller can observe of a raw call's result."""
    called = _outcome(make)
    if called[0] != "ok":
        return {"call": called}
    raw = called[1]
    http = raw.http_response
    seen: dict[str, Any] = {
        "type": type(raw).__name__,
        "headers": dict(raw.headers),
        "retries_taken": getattr(raw, "retries_taken", None),
        "http.is_closed": http.is_closed,
        "http.is_stream_consumed": getattr(http, "is_stream_consumed", None),
        "http.content": http.content,
    }
    if typed_first:
        seen["parse(to=_Mine)"] = _shape(_outcome(lambda: raw.parse(to=_Mine)))
    first, second = _outcome(raw.parse), _outcome(raw.parse)
    seen["parse()"] = _shape(first)
    seen["parse() twice"] = _shape(second)
    seen["parse() is cached"] = first[0] == second[0] == "ok" and first[1] is second[1]
    seen["parse(to=str)"] = _shape(_outcome(lambda: raw.parse(to=str)))
    if not typed_first:
        seen["parse(to=_Mine)"] = _shape(_outcome(lambda: raw.parse(to=_Mine)))
    seen["http.content after"] = http.content
    seen["http.is_closed after"] = http.is_closed
    return seen


@pytest.mark.parametrize("body", ["json", "not json"])
@pytest.mark.parametrize("is_async", [False, True], ids=["sync", "async"])
@pytest.mark.parametrize("name", sorted(_PATHS))
def test_the_caller_observes_the_same_raw_response_with_or_without_the_sensor(
    name: str,
    is_async: bool,
    body: str,
    router: respx.MockRouter,
    sensored: Callable[..., Session],
) -> None:
    """The sensor reading the wrapper first changes nothing the caller can
    see: its own ``parse()`` (the same cached object, or the same
    exception), a ``parse(to=...)`` into another type before or after,
    the headers, ``retries_taken`` and the HTTP response's body and
    state."""
    if body == "not json":
        _not_json(router)
    sdk, _plain_call, raw = _PATHS[name]

    def make() -> Any:
        return raw(_client(sdk, is_async))

    for typed_first in (False, True):
        _unsensored()
        expected = _observe(make, typed_first=typed_first)
        sensored(capture=True)
        assert _observe(make, typed_first=typed_first) == expected
    if body == "not json":
        assert expected["parse()"][0] == "raised"


@pytest.mark.parametrize("is_async", [False, True], ids=["sync", "async"])
@pytest.mark.parametrize("name", _CREATE_PATHS)
def test_a_raw_response_that_does_not_parse_is_metered_on_the_estimate_without_content(
    name: str,
    is_async: bool,
    router: respx.MockRouter,
    sensored: Callable[..., Session],
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The call returns the wrapper as without the sensor and the caller's
    own ``parse()`` raises; the event keeps the pre-call estimate and the
    requested model, has no tool calls, and goes without its content, with
    one warning naming the unreadable response for any number of calls."""
    monkeypatch.setattr(body_limit, "_warned_unencodable", set())
    _not_json(router)
    session = sensored(capture=True)
    sdk, _plain_call, raw = _PATHS[name]
    for _ in range(2):
        start = _mark(session)
        with caplog.at_level(logging.WARNING, logger="flightdeck_sensor"):
            wrapper = _run(lambda: raw(_client(sdk, is_async)))
            events = _sent(session, start)
        with pytest.raises(json.JSONDecodeError):
            _run(wrapper.parse)
        event = _call_event(events)
        pre_call = next(e for e in events if e["event_type"] == "pre_call")
        assert event["tokens_input"] == pre_call["tokens_input"]
        assert event["tokens_output"] == 0
        assert event["model"] == (
            EMBEDDINGS_KW["model"] if name.startswith("embeddings") else _REQUESTED[sdk]
        )
        assert not event["has_content"]
        assert event.get("content") is None
        assert [
            e["event_type"] for e in events if e["event_type"] in ("tool_call", "llm_error")
        ] == []
    warnings = [r.getMessage() for r in caplog.records if r.levelno >= logging.WARNING]
    assert len(warnings) == 1, warnings
    assert "UnreadableResponse" in warnings[0]
    assert NOT_JSON.decode() not in warnings[0]


@pytest.mark.parametrize("is_async", [False, True], ids=["sync", "async"])
@pytest.mark.parametrize("name", sorted(_PATHS))
def test_block_stops_every_raw_path_before_the_request(
    name: str, is_async: bool, router: respx.MockRouter, sensored: Callable[..., Session]
) -> None:
    session = sensored(capture=True)
    session.policy = PolicyCache(token_limit=100, block_at_pct=50)
    session._tokens_used = 90
    sdk, _plain_call, raw = _PATHS[name]
    with pytest.raises(BudgetExceededError):
        _run(lambda: raw(_client(sdk, is_async)))
    assert all(route.call_count == 0 for route in router.routes)
    kinds = [e["event_type"] for e in _sent(session, 0)]
    assert "policy_block" in kinds
    assert not {"post_call", "embeddings"} & set(kinds)


def _view(sdk_resource: str, client: Any, **extra: Any) -> Any:
    if sdk_resource == "chat":
        return client.chat.completions.with_streaming_response.create(**CHAT_KW, **extra)
    if sdk_resource == "responses":
        return client.responses.with_streaming_response.create(**RESPONSES_KW, **extra)
    return client.messages.with_streaming_response.create(**MESSAGES_KW, **extra)


def _plain_for(sdk_resource: str, client: Any) -> Any:
    if sdk_resource == "chat":
        return client.chat.completions.create(**CHAT_KW)
    if sdk_resource == "responses":
        return client.responses.create(**RESPONSES_KW)
    return client.messages.create(**MESSAGES_KW)


def _sdk_of(sdk_resource: str) -> str:
    return "anthropic" if sdk_resource == "messages" else "openai"


async def _in_view(manager: Any, use: Callable[[Any], Any]) -> None:
    """Enter a streaming view as its caller would and ``use`` the response."""
    if hasattr(manager, "__aenter__"):
        async with manager as response:
            await _resolve(use(response))
    else:
        with manager as response:
            await _resolve(use(response))


@pytest.mark.parametrize("is_async", [False, True], ids=["sync", "async"])
@pytest.mark.parametrize("sdk_resource", ["chat", "responses", "messages"])
def test_a_streaming_view_never_read_stores_an_empty_response(
    sdk_resource: str, is_async: bool, router: respx.MockRouter, sensored: Callable[..., Session]
) -> None:
    """The body of a streaming view closed unread is never read by the
    sensor: an empty response, the pre-call estimate, the requested model,
    no stop reason and no tool calls."""
    session = sensored(capture=True)
    client = _client(_sdk_of(sdk_resource), is_async)
    asyncio.run(_in_view(_view(sdk_resource, client), lambda _response: None))
    events = _sent(session, 0)
    event = _call_event(events)
    pre_call = next(e for e in events if e["event_type"] == "pre_call")
    assert event["content"]["response"] == {}
    assert event["content"]["messages"] or event["content"]["input"]
    assert event["tokens_input"] == pre_call["tokens_input"]
    assert event["tokens_output"] == 0
    assert event["model"] == _REQUESTED[_sdk_of(sdk_resource)]
    assert event.get("stop_reason") is None
    assert [e for e in events if e["event_type"] == "tool_call"] == []


async def _read_http(response: Any) -> None:
    """Parse into the HTTP response, which leaves the body unread, then
    read the body through it."""
    http = await _resolve(response.parse(to=httpx.Response))
    if isinstance(http.stream, httpx.AsyncByteStream):
        await http.aread()
    else:
        http.read()


@pytest.mark.parametrize(
    "use",
    ["parse(to=str)", "parse(to=httpx.Response), then read"],
)
@pytest.mark.parametrize("is_async", [False, True], ids=["sync", "async"])
@pytest.mark.parametrize("sdk_resource", ["chat", "responses", "messages"])
def test_a_streaming_view_parsed_into_the_callers_own_type_reports_the_message(
    sdk_resource: str,
    is_async: bool,
    use: str,
    router: respx.MockRouter,
    sensored: Callable[..., Session],
) -> None:
    """A ``parse(to=...)`` into the caller's own type reads the body some
    other way than the SDK's message: the call is reported from the
    message the body holds, as the plain call is, once the body is read
    (at that parse, or at the view's close)."""
    session = sensored(capture=True)
    sdk = _sdk_of(sdk_resource)
    start = _mark(session)
    _run(lambda: _plain_for(sdk_resource, _client(sdk, is_async)))
    expected = _report(_sent(session, start))

    start = _mark(session)
    user: Callable[[Any], Any] = (
        (lambda response: response.parse(to=str)) if use == "parse(to=str)" else _read_http
    )
    asyncio.run(_in_view(_view(sdk_resource, _client(sdk, is_async)), user))
    assert _report(_sent(session, start)) == expected


def test_a_failed_raw_parse_stores_the_http_body_as_the_provider_returned_it(
    router: respx.MockRouter, sensored: Callable[..., Session]
) -> None:
    """A raw ``parse()`` whose structured output the SDK rejects is metered
    from the HTTP body (no parsed message exists); that body is what is
    stored, field for field."""
    filtered = {
        **CHAT,
        "choices": [{**CHAT["choices"][0], "finish_reason": "content_filter"}],  # type: ignore[index]
    }
    router.routes["chat"].mock(return_value=_reply(filtered))
    session = sensored(capture=True)

    class City(pydantic.BaseModel):
        city: str

    wrapper = _client("openai", False).chat.completions.with_raw_response.parse(
        model=OPENAI_MODEL, messages=MESSAGES, response_format=City
    )
    with pytest.raises(openai.ContentFilterFinishReasonError) as raised:
        wrapper.parse()
    # openai 3.x hands the exception the completion it parsed; that
    # message is then what is stored.
    carried = getattr(raised.value, "completion", None)
    expected = (
        filtered
        if carried is None
        else json.loads(json.dumps(carried.model_dump(warnings=False), default=str))
    )
    event = _call_event(_sent(session, 0))
    assert event["content"]["response"] == expected
    assert event["model"] == OPENAI_SERVED


class _Unknown:
    """An object that is not a message, with attributes of its own."""

    def __init__(self) -> None:
        self.secret_state = "not part of any reply"


def _stored(provider: Any, response: Any) -> Any:
    content = provider.extract_content({"model": "m", "messages": MESSAGES}, response)
    assert content is not None
    return content.response


def _providers() -> dict[str, Any]:
    from flightdeck_sensor.providers.litellm import LitellmProvider

    return {
        "openai": OpenAIProvider(capture_prompts=True),
        "anthropic": AnthropicProvider(capture_prompts=True),
        "litellm": LitellmProvider(capture_prompts=True),
    }


@pytest.mark.parametrize("provider_name", ["openai", "anthropic", "litellm"])
def test_a_response_that_is_no_message_is_stored_as_it_is_or_empty(provider_name: str) -> None:
    """No response is stored as an empty one; a dict as it is; any other
    object as itself (sent only if JSON can write it), never as its
    attributes or its string form."""
    provider = _providers()[provider_name]
    assert _stored(provider, None) == {}
    assert _stored(provider, {"id": "x", "choices": []}) == {"id": "x", "choices": []}
    if provider_name == "litellm":
        # litellm's own objects are its responses and its stream wrapper,
        # whose allowlisted summary is stored (see its provider).
        return
    unknown = _Unknown()
    assert _stored(provider, unknown) is unknown
    assert _stored(provider, DROPPED_STREAM) == {}


@pytest.mark.parametrize("provider_name", ["openai", "anthropic"])
def test_an_unknown_response_object_leaves_the_event_without_content_and_warns_once(
    provider_name: str, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setattr(body_limit, "_warned_unencodable", set())
    provider = _providers()[provider_name]
    sent = []
    with caplog.at_level(logging.DEBUG, logger="flightdeck_sensor"):
        for _ in range(3):
            payload = {
                "event_type": EventType.POST_CALL.value,
                "tokens_input": 5,
                "has_content": True,
                "content": {"messages": MESSAGES, "response": _stored(provider, _Unknown())},
            }
            sent.append(json.loads(serialize_event(payload)))
    assert all(not e["has_content"] and e.get("content") is None for e in sent)
    assert all(e["tokens_input"] == 5 for e in sent)
    named = [r for r in caplog.records if "_Unknown" in r.getMessage()]
    assert [r.levelno for r in named] == [logging.WARNING, logging.DEBUG, logging.DEBUG]
    assert "not part of any reply" not in caplog.text


@pytest.mark.parametrize("is_async", [False, True], ids=["sync", "async"])
@pytest.mark.parametrize("sdk", ["openai", "anthropic"])
def test_a_raw_event_stream_never_iterated_stores_an_empty_response(
    sdk: str, is_async: bool, router: respx.MockRouter
) -> None:
    """The SDKs' raw ``Stream`` / ``AsyncStream`` assembled nothing."""
    client = _client(sdk, is_async)
    sse = httpx.Response(200, content=b"", headers={"content-type": "text/event-stream"})
    for name in ("chat", "messages"):
        router.routes[name].mock(return_value=sse)
    if sdk == "openai":
        stream = _run(lambda: client.chat.completions.create(**CHAT_KW, stream=True))
    else:
        stream = _run(lambda: client.messages.create(**MESSAGES_KW, stream=True))
    assert _stored(_providers()[sdk], stream) == {}
    _run(stream.close)


@pytest.mark.parametrize("is_async", [False, True], ids=["sync", "async"])
def test_a_message_stream_helper_never_iterated_stores_an_empty_response(
    is_async: bool, router: respx.MockRouter
) -> None:
    """A ``messages.stream()`` helper with no snapshot yet assembled
    nothing; its private state is not a response."""
    router.routes["messages"].mock(
        return_value=httpx.Response(200, content=b"", headers={"content-type": "text/event-stream"})
    )
    client = _client("anthropic", is_async)
    manager = client.messages.stream(**MESSAGES_KW)

    async def entered() -> Any:
        if is_async:
            stream = await manager.__aenter__()
            stored = _stored(_providers()["anthropic"], stream)
            await manager.__aexit__(None, None, None)
            return stored
        with manager as stream:
            return _stored(_providers()["anthropic"], stream)

    assert asyncio.run(entered()) == {}
