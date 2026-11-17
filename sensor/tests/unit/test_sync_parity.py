"""A sensored sync client behaves like an unsensored one at every sync
entry point the sensor patches or proxies: each introspects alike
(``inspect.iscoroutinefunction``, ``inspect.signature``, name, qualified
name, docstring and module) and rejects a missing or an unknown argument
with the same exception at the same moment, when the call is made or when
its result is used (a stream manager or a streaming view entered, a raw
response parsed). An Anthropic ``messages.stream()`` also sends the
request the unsensored SDK sends, built when that SDK release builds it,
and stores what it sent.

Each entry point is driven over the same mocked provider (respx): on a
client the sensor never saw, with no session and the SDKs unpatched, then
on a sensored one, with a session active and the SDK patched, or wrapped
by ``flightdeck_sensor.wrap()``. The expectations come from the
unsensored SDK in the same environment, so they hold for the release each
lane installs (anthropic 0.86 builds a ``stream()`` request when
``stream()`` is called, anthropic 2.x when the manager is entered).
"""

from __future__ import annotations

import asyncio
import gc
import inspect
import json
from typing import TYPE_CHECKING, Any
from unittest.mock import MagicMock

import anthropic
import httpx
import openai
import pytest
import respx

import flightdeck_sensor
from flightdeck_sensor.core.policy import PolicyCache
from flightdeck_sensor.core.session import Session
from flightdeck_sensor.core.types import SensorConfig
from flightdeck_sensor.interceptor import base
from flightdeck_sensor.interceptor.anthropic import (
    patch_anthropic_classes,
    unpatch_anthropic_classes,
)
from flightdeck_sensor.interceptor.openai import patch_openai_classes, unpatch_openai_classes
from flightdeck_sensor.providers import openai as openai_provider
from flightdeck_sensor.transport.body_limit import serialize_event
from flightdeck_sensor.transport.client import ControlPlaneClient

if TYPE_CHECKING:
    from collections.abc import Callable, Iterator

pytestmark = [
    pytest.mark.filterwarnings("error::RuntimeWarning"),
    pytest.mark.filterwarnings("error::pytest.PytestUnraisableExceptionWarning"),
]

ANTHROPIC_MODEL = "claude-haiku-4-5"
OPENAI_MODEL = "gpt-4o-mini"
HI = [{"role": "user", "content": "hi"}]
ANTHROPIC_OK: dict[str, Any] = {"model": ANTHROPIC_MODEL, "max_tokens": 10, "messages": HI}
CHAT_OK: dict[str, Any] = {"model": OPENAI_MODEL, "messages": HI}
RESPONSES_OK: dict[str, Any] = {"model": OPENAI_MODEL, "input": "hi"}
EMBEDDINGS_OK: dict[str, Any] = {"model": "text-embedding-3-small", "input": "hi"}
# Where the Vertex client sends a call: the model is in the path.
VERTEX_URL = r"https://us-east5-aiplatform\.googleapis\.com/.*"

MESSAGE = {
    "id": "msg_parity",
    "type": "message",
    "role": "assistant",
    "model": ANTHROPIC_MODEL,
    "content": [{"type": "text", "text": "Hello"}],
    "stop_reason": "end_turn",
    "stop_sequence": None,
    "usage": {"input_tokens": 3, "output_tokens": 2},
}
COMPLETION = {
    "id": "chatcmpl-parity",
    "object": "chat.completion",
    "created": 1,
    "model": OPENAI_MODEL,
    "choices": [
        {"index": 0, "message": {"role": "assistant", "content": "Hello"}, "finish_reason": "stop"}
    ],
    "usage": {"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5},
}
RESPONSE = {
    "id": "resp_parity",
    "object": "response",
    "created_at": 1,
    "model": OPENAI_MODEL,
    "status": "completed",
    "output": [],
    "usage": {"input_tokens": 3, "output_tokens": 2, "total_tokens": 5},
    "parallel_tool_calls": True,
    "tool_choice": "auto",
    "tools": [],
}
EMBEDDINGS = {
    "object": "list",
    "data": [{"object": "embedding", "index": 0, "embedding": [0.1]}],
    "model": "text-embedding-3-small",
    "usage": {"prompt_tokens": 1, "total_tokens": 1},
}


def _anthropic_reply(request: httpx.Request) -> httpx.Response:
    """The canned message, or (for a request that asks to stream, which a
    Vertex request says in its path) the same message as server-sent
    events."""
    streamed = json.loads(request.content or b"{}").get("stream") is True
    if not streamed and not request.url.path.endswith(":streamRawPredict"):
        return httpx.Response(200, json=MESSAGE)
    start = {**MESSAGE, "content": [], "stop_reason": None}
    frames = [
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
                "usage": {"output_tokens": 2},
            },
        ),
        ("message_stop", {"type": "message_stop"}),
    ]
    body = "".join(f"event: {name}\ndata: {json.dumps(data)}\n\n" for name, data in frames)
    return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=body.encode())


def _json_or_events(body: dict[str, Any]) -> Callable[[httpx.Request], httpx.Response]:
    """The canned body, or (for a request that asks to stream) a stream
    that ends at once."""

    def reply(request: httpx.Request) -> httpx.Response:
        if json.loads(request.content or b"{}").get("stream") is True:
            return httpx.Response(
                200, headers={"content-type": "text/event-stream"}, content=b"data: [DONE]\n\n"
            )
        return httpx.Response(200, json=body)

    return reply


@pytest.fixture
def provider() -> Iterator[respx.MockRouter]:
    with respx.mock(assert_all_called=False) as router:
        router.post("https://api.anthropic.com/v1/messages", name="anthropic").mock(
            side_effect=_anthropic_reply
        )
        router.post(url__regex=VERTEX_URL, name="vertex").mock(side_effect=_anthropic_reply)
        router.post("https://api.openai.com/v1/chat/completions").mock(
            side_effect=_json_or_events(COMPLETION)
        )
        router.post("https://api.openai.com/v1/responses").mock(
            side_effect=_json_or_events(RESPONSE)
        )
        router.post("https://api.openai.com/v1/embeddings").mock(
            return_value=httpx.Response(200, json=EMBEDDINGS)
        )
        yield router


@pytest.fixture(autouse=True)
def _estimate_without_tiktoken(monkeypatch: pytest.MonkeyPatch) -> None:
    """No test here compares estimates: the OpenAI estimate takes its
    char/4 fallback on every machine, so none depends on whether
    tiktoken's encoding data is cached (the unit suite blocks sockets)."""
    monkeypatch.setattr(openai_provider, "_try_tiktoken_count", lambda messages, model: None)


def _session(*, capture: bool = False) -> Session:
    config = SensorConfig(
        server="http://localhost:9999",
        token="tok",
        agent_flavor="parity",
        agent_type="production",
        quiet=True,
        capture_prompts=capture,
    )
    client = MagicMock(spec=ControlPlaneClient)
    client.post_event.return_value = (None, False)
    session = Session(config=config, client=client, event_queue=MagicMock())
    session.policy = PolicyCache(token_limit=None, block_at_pct=100)
    return session


@pytest.fixture(autouse=True)
def _sdks_unpatched() -> Iterator[None]:
    yield
    unpatch_anthropic_classes()
    unpatch_openai_classes()


def _client(sdk: str, *, is_async: bool = False) -> Any:
    if sdk == "anthropic-vertex":
        vertex: Any = anthropic.AsyncAnthropicVertex if is_async else anthropic.AnthropicVertex
        return vertex(region="us-east5", project_id="parity", access_token="t", max_retries=0)
    if sdk == "anthropic-bedrock":
        bedrock: Any = anthropic.AsyncAnthropicBedrock if is_async else anthropic.AnthropicBedrock
        return bedrock(
            aws_access_key="a", aws_secret_key="s", aws_region="us-east-1", max_retries=0
        )
    if sdk == "anthropic":
        cls: Any = anthropic.AsyncAnthropic if is_async else anthropic.Anthropic
    else:
        cls = openai.AsyncOpenAI if is_async else openai.OpenAI
    return cls(api_key="k", max_retries=0)


def _sensored(
    mode: str,
    sdk: str,
    session: Session,
    monkeypatch: pytest.MonkeyPatch,
    *,
    is_async: bool = False,
) -> Any:
    monkeypatch.setattr(flightdeck_sensor, "_session", session)
    if mode == "patched":
        patch_anthropic_classes(quiet=True)
        patch_openai_classes(quiet=True)
        return _client(sdk, is_async=is_async)
    return flightdeck_sensor.wrap(_client(sdk, is_async=is_async))


def _anthropic(get: Callable[[Any], Any], *, streamed: bool = False) -> tuple[Any, ...]:
    """An Anthropic entry point: a valid call's arguments, and the same
    call missing what the SDK requires."""
    extra = {"stream": True} if streamed else {}
    return ("anthropic", get, {**ANTHROPIC_OK, **extra}, {"model": ANTHROPIC_MODEL, **extra})


def _chat(get: Callable[[Any], Any], *, streamed: bool = False) -> tuple[Any, ...]:
    extra = {"stream": True} if streamed else {}
    return ("openai", get, {**CHAT_OK, **extra}, {"model": OPENAI_MODEL, **extra})


def _responses(get: Callable[[Any], Any], *, streamed: bool = False) -> tuple[Any, ...]:
    # Nothing in a Responses call is required.
    extra = {"stream": True} if streamed else {}
    return ("openai", get, {**RESPONSES_OK, **extra}, extra)


def _embeddings(get: Callable[[Any], Any]) -> tuple[Any, ...]:
    return ("openai", get, EMBEDDINGS_OK, {"model": "text-embedding-3-small"})


# name -> (sdk, the entry point on a client, a valid call's arguments, the
# same call missing what the SDK requires)
ENTRY_POINTS: dict[str, tuple[Any, ...]] = {
    "anthropic messages.create": _anthropic(lambda c: c.messages.create),
    "anthropic messages.create(stream=True)": _anthropic(
        lambda c: c.messages.create, streamed=True
    ),
    "anthropic messages.parse": _anthropic(lambda c: c.messages.parse),
    "anthropic messages.stream": _anthropic(lambda c: c.messages.stream),
    "anthropic messages.with_raw_response.create": _anthropic(
        lambda c: c.messages.with_raw_response.create
    ),
    "anthropic messages.with_raw_response.parse": _anthropic(
        lambda c: c.messages.with_raw_response.parse
    ),
    "anthropic messages.with_streaming_response.create": _anthropic(
        lambda c: c.messages.with_streaming_response.create
    ),
    "anthropic beta.messages.create": _anthropic(lambda c: c.beta.messages.create),
    "anthropic beta.messages.parse": _anthropic(lambda c: c.beta.messages.parse),
    "anthropic beta.messages.stream": _anthropic(lambda c: c.beta.messages.stream),
    "anthropic beta.messages.with_raw_response.create": _anthropic(
        lambda c: c.beta.messages.with_raw_response.create
    ),
    "anthropic beta.messages.with_raw_response.parse": _anthropic(
        lambda c: c.beta.messages.with_raw_response.parse
    ),
    "anthropic beta.messages.with_streaming_response.create": _anthropic(
        lambda c: c.beta.messages.with_streaming_response.create
    ),
    "anthropic with_raw_response.messages.create": _anthropic(
        lambda c: c.with_raw_response.messages.create
    ),
    "anthropic with_raw_response.beta.messages.create": _anthropic(
        lambda c: c.with_raw_response.beta.messages.create
    ),
    "anthropic with_streaming_response.messages.create": _anthropic(
        lambda c: c.with_streaming_response.messages.create
    ),
    "anthropic with_streaming_response.beta.messages.create": _anthropic(
        lambda c: c.with_streaming_response.beta.messages.create
    ),
    "anthropic with_options().messages.stream": _anthropic(
        lambda c: c.with_options(timeout=5).messages.stream
    ),
    "anthropic-vertex beta.messages.create": (
        "anthropic-vertex",
        *_anthropic(lambda c: c.beta.messages.create)[1:],
    ),
    "anthropic-vertex beta.messages.stream": (
        "anthropic-vertex",
        *_anthropic(lambda c: c.beta.messages.stream)[1:],
    ),
    "anthropic-bedrock beta.messages.create": (
        "anthropic-bedrock",
        *_anthropic(lambda c: c.beta.messages.create)[1:],
    ),
    "openai chat.completions.create": _chat(lambda c: c.chat.completions.create),
    "openai chat.completions.create(stream=True)": _chat(
        lambda c: c.chat.completions.create, streamed=True
    ),
    "openai chat.completions.parse": _chat(lambda c: c.chat.completions.parse),
    "openai chat.completions.stream": _chat(lambda c: c.chat.completions.stream),
    "openai chat.completions.with_raw_response.create": _chat(
        lambda c: c.chat.completions.with_raw_response.create
    ),
    "openai chat.completions.with_raw_response.parse": _chat(
        lambda c: c.chat.completions.with_raw_response.parse
    ),
    "openai chat.completions.with_streaming_response.create": _chat(
        lambda c: c.chat.completions.with_streaming_response.create
    ),
    "openai chat.completions.with_streaming_response.parse": _chat(
        lambda c: c.chat.completions.with_streaming_response.parse
    ),
    "openai beta.chat.completions.create": _chat(lambda c: c.beta.chat.completions.create),
    "openai beta.chat.completions.parse": _chat(lambda c: c.beta.chat.completions.parse),
    "openai beta.chat.completions.stream": _chat(lambda c: c.beta.chat.completions.stream),
    "openai with_raw_response.chat.completions.create": _chat(
        lambda c: c.with_raw_response.chat.completions.create
    ),
    "openai with_streaming_response.chat.completions.create": _chat(
        lambda c: c.with_streaming_response.chat.completions.create
    ),
    "openai with_options().chat.completions.create": _chat(
        lambda c: c.with_options(timeout=5).chat.completions.create
    ),
    "openai responses.create": _responses(lambda c: c.responses.create),
    "openai responses.create(stream=True)": _responses(lambda c: c.responses.create, streamed=True),
    "openai responses.parse": _responses(lambda c: c.responses.parse),
    "openai responses.stream": _responses(lambda c: c.responses.stream),
    "openai responses.with_raw_response.create": _responses(
        lambda c: c.responses.with_raw_response.create
    ),
    "openai responses.with_raw_response.parse": _responses(
        lambda c: c.responses.with_raw_response.parse
    ),
    "openai responses.with_streaming_response.create": _responses(
        lambda c: c.responses.with_streaming_response.create
    ),
    "openai with_raw_response.responses.create": _responses(
        lambda c: c.with_raw_response.responses.create
    ),
    "openai embeddings.create": _embeddings(lambda c: c.embeddings.create),
    "openai embeddings.with_raw_response.create": _embeddings(
        lambda c: c.embeddings.with_raw_response.create
    ),
    "openai embeddings.with_streaming_response.create": _embeddings(
        lambda c: c.embeddings.with_streaming_response.create
    ),
    "openai with_streaming_response.embeddings.create": _embeddings(
        lambda c: c.with_streaming_response.embeddings.create
    ),
}


def _use(result: Any) -> None:
    """Use what a sync call returned as a caller would: enter a stream
    manager or a streaming view, parse a raw response, close a stream."""
    if hasattr(result, "__enter__"):
        with result:
            return
    if callable(getattr(type(result), "parse", None)):
        result.parse()
        return
    close = getattr(result, "close", None)
    if callable(close):
        close()


def _moment(entry: Callable[..., Any], kwargs: dict[str, Any]) -> str:
    """The exception a call raises and when: ``call:<type>`` when the
    call is made, ``use:<type>`` when its result is used, or ``none``."""
    try:
        result = entry(**kwargs)
    except Exception as exc:
        return f"call:{type(exc).__name__}"
    try:
        _use(result)
    except Exception as exc:
        return f"use:{type(exc).__name__}"
    return "none"


def _profile(
    entry: Callable[[], Any], ok: dict[str, Any], missing: dict[str, Any]
) -> dict[str, Any]:
    method = entry()
    profile = {
        "coroutine function": inspect.iscoroutinefunction(method),
        "signature": str(inspect.signature(method)),
        "name": method.__name__,
        "qualified name": method.__qualname__,
        "docstring": method.__doc__,
        "module": method.__module__,
        "unknown argument": _moment(entry(), {**ok, "not_a_parameter": True}),
        "missing argument": _moment(entry(), missing),
    }
    gc.collect()
    return profile


@pytest.mark.parametrize("mode", ["patched", "wrapped"])
@pytest.mark.parametrize("name", sorted(ENTRY_POINTS))
def test_a_sync_entry_point_behaves_as_the_sdks_own(
    provider: respx.MockRouter, monkeypatch: pytest.MonkeyPatch, mode: str, name: str
) -> None:
    sdk, get, ok, missing = ENTRY_POINTS[name]
    plain = _client(sdk)
    try:
        get(plain)
    except AttributeError:
        pytest.skip(f"the installed SDK has no {name.split(' ', 1)[1]}")
    unsensored = _profile(lambda: get(plain), ok, missing)
    sensored_client = _sensored(mode, sdk, _session(), monkeypatch)
    sensored = _profile(lambda: get(sensored_client), ok, missing)
    assert sensored == unsensored
    # The bad call is one the SDK rejects, so the comparison means something.
    assert unsensored["unknown argument"] != "none"


# ----- Anthropic messages.stream(): what is sent, and what is stored ---------------

# The stream() resources the sensor patches: (sdk, resource, the route
# the request goes to).
STREAM_RESOURCES = {
    "messages": ("anthropic", "messages", "anthropic"),
    "beta.messages": ("anthropic", "beta.messages", "anthropic"),
    "vertex beta.messages": ("anthropic-vertex", "beta.messages", "vertex"),
}


# What the caller changes between ``stream()`` and entering the manager.
CHANGES = ("the conversation", "a reply block in place")


def _changed_before_entry(
    client: Any, resource: str, *, is_async: bool, change: str = CHANGES[0]
) -> list[Any]:
    """Call ``stream()``, change what it was given, then enter the manager
    and read the stream: the SDK release decides whether the change is in
    the request (built when ``stream()`` is called, or on entry). The
    change is to the conversation list, or to a reply block (the SDK's
    own pydantic model, as a tool-use loop passes it back) in place.
    Returns the conversation as it stood on entry, as JSON."""
    messages = client.beta.messages if resource == "beta.messages" else client.messages
    block = anthropic.types.TextBlock(type="text", text="ORIGINAL REPLY")
    conversation: list[Any] = [
        {"role": "user", "content": "ORIGINAL"},
        {"role": "assistant", "content": [block]},
        {"role": "user", "content": "go on"},
    ]
    manager = messages.stream(model=ANTHROPIC_MODEL, max_tokens=10, messages=conversation)
    if change == "a reply block in place":
        block.text = "REPLY CHANGED BEFORE ENTRY"
    else:
        conversation[0]["content"] = "CHANGED BEFORE ENTRY"
        conversation.append({"role": "assistant", "content": "APPENDED BEFORE ENTRY"})
    on_entry = json.loads(
        json.dumps(
            conversation,
            default=lambda model: model.model_dump(mode="json", exclude_unset=True),
        )
    )
    if is_async:

        async def run() -> None:
            async with manager as stream:
                await stream.get_final_message()

        asyncio.run(run())
    else:
        with manager as stream:
            stream.get_final_message()
    return on_entry


def _sent(router: respx.MockRouter, route: str) -> list[Any]:
    body: dict[str, Any] = json.loads(router.routes[route].calls.last.request.content)
    return list(body["messages"])


def _events(session: Session) -> list[dict[str, Any]]:
    """The events a session enqueued, as the sensor writes them."""
    queue = session.event_queue
    assert isinstance(queue, MagicMock)
    return [json.loads(serialize_event(dict(c.args[0]))) for c in queue.enqueue.call_args_list]


def _post_call(session: Session) -> dict[str, Any]:
    (post_call,) = [e for e in _events(session) if e["event_type"] == "post_call"]
    return post_call


@pytest.mark.parametrize("change", CHANGES)
@pytest.mark.parametrize("resource", sorted(STREAM_RESOURCES))
@pytest.mark.parametrize("is_async", [False, True], ids=["sync", "async"])
@pytest.mark.parametrize("mode", ["patched", "wrapped"])
def test_a_stream_sends_and_stores_what_the_sdk_sends(
    provider: respx.MockRouter,
    monkeypatch: pytest.MonkeyPatch,
    mode: str,
    is_async: bool,
    resource: str,
    change: str,
) -> None:
    """The sensor calls the SDK's ``stream()`` when the caller does, so the
    request is built when that release builds it, and the stored content
    is the request the provider received."""
    sdk, attribute, route = STREAM_RESOURCES[resource]
    client = _client(sdk, is_async=is_async)
    _changed_before_entry(client, attribute, is_async=is_async, change=change)
    unsensored = _sent(provider, route)
    session = _session(capture=True)
    client = _sensored(mode, sdk, session, monkeypatch, is_async=is_async)
    _changed_before_entry(client, attribute, is_async=is_async, change=change)
    sensored = _sent(provider, route)
    assert sensored == unsensored
    assert _post_call(session)["content"]["messages"] == sensored


def test_an_argument_holding_an_sdk_object_reaches_the_sdk_as_the_callers_own() -> None:
    """The sensor reads a reply object in the conversation as JSON for
    itself alone: with no iterator in it, the SDK is handed the caller's
    own list, so a change made to it before the SDK builds the request
    (a 2.x manager entered later) is sent."""
    conversation: list[Any] = [
        {"role": "user", "content": "hi"},
        {"role": "assistant", "content": [anthropic.types.TextBlock(type="text", text="R")]},
    ]
    handed: dict[str, Any] = {}
    arguments = base.materialise_iterators(
        {"model": ANTHROPIC_MODEL, "messages": conversation},
        lambda **kwargs: handed.update(kwargs),
        "anthropic",
    )
    assert arguments.kwargs["messages"] is not conversation
    arguments.send(**arguments.kwargs)
    assert handed["messages"] is conversation


@pytest.mark.parametrize("is_async", [False, True], ids=["sync", "async"])
def test_with_capture_off_a_stream_copies_and_stores_nothing(
    provider: respx.MockRouter, monkeypatch: pytest.MonkeyPatch, is_async: bool
) -> None:
    """Capture off: the call is sent as without the sensor, nothing of its
    arguments is copied at the call or on entry, and no event carries
    content."""
    _changed_before_entry(_client("anthropic", is_async=is_async), "messages", is_async=is_async)
    unsensored = _sent(provider, "anthropic")

    def _never(*_args: Any, **_kwargs: Any) -> Any:
        raise AssertionError("a call's arguments were copied with capture off")

    monkeypatch.setattr(base, "_snapshot", _never)
    session = _session(capture=False)
    client = _sensored("patched", "anthropic", session, monkeypatch, is_async=is_async)
    _changed_before_entry(client, "messages", is_async=is_async)
    assert _sent(provider, "anthropic") == unsensored
    events = _events(session)
    assert [e["event_type"] for e in events] == ["pre_call", "post_call"]
    assert not any(e.get("has_content") or e.get("content") for e in events)
    assert "BEFORE ENTRY" not in json.dumps(events)
    assert "ORIGINAL" not in json.dumps(events)


@pytest.mark.parametrize(
    "failure", ["the sent request cannot be read", "comparing the copies fails"]
)
def test_a_stream_whose_sent_copy_cannot_be_told_stores_the_copy_taken_on_entry(
    provider: respx.MockRouter, monkeypatch: pytest.MonkeyPatch, failure: str
) -> None:
    """When the arguments changed between ``stream()`` and entry and the
    request the stream answered cannot settle which copy was sent, the
    copy taken on entry is stored, and the caller's stream is unaffected."""
    if failure == "the sent request cannot be read":
        monkeypatch.setattr(base, "_sent_body", lambda stream: None)
    else:

        def _fails(*_args: Any) -> bool:
            raise RuntimeError("comparison failed")

        monkeypatch.setattr(base, "_holds_as_sent", _fails)
    session = _session(capture=True)
    client = _sensored("patched", "anthropic", session, monkeypatch)
    on_entry = _changed_before_entry(client, "messages", is_async=False)
    assert _post_call(session)["content"]["messages"] == on_entry


@pytest.mark.parametrize("is_async", [False, True], ids=["sync", "async"])
def test_a_blocked_stream_raises_at_the_call_and_sends_nothing(
    provider: respx.MockRouter, monkeypatch: pytest.MonkeyPatch, is_async: bool
) -> None:
    session = _session()
    session.policy = PolicyCache(token_limit=1, block_at_pct=1)
    client = _sensored("patched", "anthropic", session, monkeypatch, is_async=is_async)
    sent = provider.routes["anthropic"].call_count
    with pytest.raises(flightdeck_sensor.BudgetExceededError):
        client.messages.stream(**ANTHROPIC_OK)
    assert provider.routes["anthropic"].call_count == sent
