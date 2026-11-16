"""A one-shot iterable (an iterator: a generator) passed as a call's argument
reaches the provider as it would without the sensor.

The SDKs type ``messages``, ``system`` blocks, ``tools``, a Responses or
embeddings ``input`` and a message's ``content`` as ``Iterable``, so a
caller may hand them a generator. The sensor reads the arguments before
the SDK does (the token estimate, content capture), so it reads each
iterator once into a list for itself and hands the SDK a generator over
the same items (ARCHITECTURE.md, the content capture section). Each case
is driven over the same mocked provider (respx), on a client the sensor
never saw and on a sensored one (patched, or wrapped by
``flightdeck_sensor.wrap()``): the call comes to the same outcome (the
same request body, or the same exception), and the sensor's estimate and
stored content are those of the same call made with lists.
"""

from __future__ import annotations

import asyncio
import inspect
import io
import json
import sys
import types
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
from flightdeck_sensor.interceptor.openai import (
    SensorCompletions,
    patch_openai_classes,
    unpatch_openai_classes,
)
from flightdeck_sensor.providers.anthropic import AnthropicProvider
from flightdeck_sensor.providers.openai import OpenAIProvider
from flightdeck_sensor.transport.client import ControlPlaneClient

if TYPE_CHECKING:
    from collections.abc import Callable, Iterator

pytestmark = [
    pytest.mark.filterwarnings("error::RuntimeWarning"),
    pytest.mark.filterwarnings("error::pytest.PytestUnraisableExceptionWarning"),
]

ANTHROPIC_MODEL = "claude-haiku-4-5"
OPENAI_MODEL = "gpt-4o-mini"
EMBEDDING_MODEL = "text-embedding-3-small"
# Long enough that no estimate of something else (a generator's repr) can
# come to the same count.
PROMPT = "SECRET-PROMPT-one-shot-5c1d: " + " ".join(["the quick brown fox jumps"] * 12)
SYSTEM = "SECRET-SYSTEM-one-shot-7a2e"

MESSAGE = {
    "id": "msg_oneshot",
    "type": "message",
    "role": "assistant",
    "model": ANTHROPIC_MODEL,
    "content": [{"type": "text", "text": "Hello"}],
    "stop_reason": "end_turn",
    "stop_sequence": None,
    "usage": {"input_tokens": 3, "output_tokens": 2},
}
COMPLETION = {
    "id": "chatcmpl-oneshot",
    "object": "chat.completion",
    "created": 1,
    "model": OPENAI_MODEL,
    "choices": [
        {"index": 0, "message": {"role": "assistant", "content": "Hello"}, "finish_reason": "stop"}
    ],
    "usage": {"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5},
}
RESPONSE = {
    "id": "resp_oneshot",
    "object": "response",
    "created_at": 1,
    "model": OPENAI_MODEL,
    "status": "completed",
    "output": [
        {
            "type": "message",
            "id": "msg_1",
            "status": "completed",
            "role": "assistant",
            "content": [{"type": "output_text", "text": "Hello", "annotations": []}],
        }
    ],
    "usage": {"input_tokens": 3, "output_tokens": 2, "total_tokens": 5},
    "parallel_tool_calls": True,
    "tool_choice": "auto",
    "tools": [],
}
EMBEDDINGS = {
    "object": "list",
    "data": [{"object": "embedding", "index": 0, "embedding": [0.1]}],
    "model": EMBEDDING_MODEL,
    "usage": {"prompt_tokens": 1, "total_tokens": 1},
}


def _sse(frames: list[tuple[str | None, Any]]) -> httpx.Response:
    body = ""
    for event, data in frames:
        head = f"event: {event}\n" if event else ""
        body += f"{head}data: {data if isinstance(data, str) else json.dumps(data)}\n\n"
    return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=body.encode())


def _anthropic_reply(request: httpx.Request) -> httpx.Response:
    if json.loads(request.content or b"{}").get("stream") is not True:
        return httpx.Response(200, json=MESSAGE)
    start = {**MESSAGE, "content": [], "stop_reason": None}
    block = {"type": "text", "text": ""}
    delta = {"type": "text_delta", "text": "Hello"}
    return _sse(
        [
            ("message_start", {"type": "message_start", "message": start}),
            (
                "content_block_start",
                {"type": "content_block_start", "index": 0, "content_block": block},
            ),
            ("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": delta}),
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
    )


def _count_tokens(request: httpx.Request) -> httpx.Response:
    body = json.loads(request.content)
    counted = json.dumps([body.get(key) for key in ("system", "messages", "tools")])
    return httpx.Response(200, json={"input_tokens": len(counted) // 4})


def _chunk(delta: dict[str, Any], finish: str | None) -> dict[str, Any]:
    return {
        "id": "chatcmpl-oneshot",
        "object": "chat.completion.chunk",
        "created": 1,
        "model": OPENAI_MODEL,
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
    }


def _openai_reply(request: httpx.Request) -> httpx.Response:
    if json.loads(request.content or b"{}").get("stream") is not True:
        return httpx.Response(200, json=COMPLETION)
    return _sse(
        [
            (None, _chunk({"role": "assistant", "content": "Hello"}, None)),
            (None, _chunk({}, "stop")),
            (None, {**_chunk({}, None), "choices": [], "usage": COMPLETION["usage"]}),
            (None, "[DONE]"),
        ]
    )


@pytest.fixture
def provider(monkeypatch: pytest.MonkeyPatch) -> Iterator[respx.MockRouter]:
    """The mocked provider. The Anthropic estimate's own ``count_tokens``
    call reaches it too, through a real SDK client as in production (the
    suite's default client refuses it), and is answered with a count of
    the request it received."""
    with respx.mock(assert_all_called=False) as router:
        router.post("https://api.anthropic.com/v1/messages/count_tokens", name="count").mock(
            side_effect=_count_tokens
        )
        router.post("https://api.anthropic.com/v1/messages", name="anthropic").mock(
            side_effect=_anthropic_reply
        )
        monkeypatch.setattr(
            AnthropicProvider, "_client", anthropic.Anthropic(api_key="k", max_retries=0)
        )
        router.post("https://api.openai.com/v1/chat/completions", name="chat").mock(
            side_effect=_openai_reply
        )
        router.post("https://api.openai.com/v1/responses", name="responses").mock(
            return_value=httpx.Response(200, json=RESPONSE)
        )
        router.post("https://api.openai.com/v1/embeddings", name="embeddings").mock(
            return_value=httpx.Response(200, json=EMBEDDINGS)
        )
        yield router


def _session(*, capture: bool) -> Session:
    config = SensorConfig(
        server="http://localhost:9999",
        token="tok",
        agent_flavor="one-shot",
        agent_type="production",
        quiet=True,
        capture_prompts=capture,
    )
    client = MagicMock(spec=ControlPlaneClient)
    client.post_event.return_value = (None, False)
    session = Session(config=config, client=client, event_queue=MagicMock())
    session.policy = PolicyCache(token_limit=None, block_at_pct=100)
    return session


def _events(session: Session) -> list[dict[str, Any]]:
    queue = session.event_queue
    assert isinstance(queue, MagicMock)
    return [c.args[0] for c in queue.enqueue.call_args_list]


@pytest.fixture(autouse=True)
def _sdks_unpatched() -> Iterator[None]:
    yield
    unpatch_anthropic_classes()
    unpatch_openai_classes()


# ----- the arguments the sensor reads ----------------------------------------
#
# Each takes ``seq``, which turns a list of items into what is passed: a
# generator over them, or the list itself for the reference run.

TOOL_ANTHROPIC = {
    "name": "get_weather",
    "description": "The weather in a city.",
    "input_schema": {"type": "object", "properties": {"city": {"type": "string"}}},
}
# Strict, as chat ``parse()`` and ``stream()`` require of a function tool.
TOOL_OPENAI = {
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "The weather in a city.",
        "strict": True,
        "parameters": {
            "type": "object",
            "properties": {"city": {"type": "string"}},
            "required": ["city"],
            "additionalProperties": False,
        },
    },
}

ANTHROPIC_ARGUMENTS: dict[str, Callable[[Callable[[list[Any]], Any]], dict[str, Any]]] = {
    "messages": lambda seq: {"messages": seq([{"role": "user", "content": PROMPT}])},
    "system blocks": lambda seq: {
        "system": seq([{"type": "text", "text": SYSTEM}]),
        "messages": [{"role": "user", "content": PROMPT}],
    },
    "tools": lambda seq: {
        "tools": seq([TOOL_ANTHROPIC]),
        "messages": [{"role": "user", "content": PROMPT}],
    },
    "a message's content": lambda seq: {
        "messages": [{"role": "user", "content": seq([{"type": "text", "text": PROMPT}])}]
    },
}
CHAT_ARGUMENTS: dict[str, Callable[[Callable[[list[Any]], Any]], dict[str, Any]]] = {
    "messages": lambda seq: {"messages": seq([{"role": "user", "content": PROMPT}])},
    "tools": lambda seq: {
        "tools": seq([TOOL_OPENAI]),
        "messages": [{"role": "user", "content": PROMPT}],
    },
    "a message's content": lambda seq: {
        "messages": [{"role": "user", "content": seq([{"type": "text", "text": PROMPT}])}]
    },
}
RESPONSES_ARGUMENTS: dict[str, Callable[[Callable[[list[Any]], Any]], dict[str, Any]]] = {
    "input": lambda seq: {"input": seq([{"role": "user", "content": PROMPT}])},
    "tools": lambda seq: {
        "input": PROMPT,
        "tools": seq([{**TOOL_OPENAI["function"], "type": "function"}]),
    },
}
EMBEDDINGS_ARGUMENTS: dict[str, Callable[[Callable[[list[Any]], Any]], dict[str, Any]]] = {
    "input strings": lambda seq: {"input": seq([PROMPT, "second"])},
    "input token lists": lambda seq: {"input": seq([[1, 2, 3], [4, 5]])},
}


# ----- the entry points --------------------------------------------------------
#
# Each takes a client and the call's arguments and returns what the caller
# gets back (for an async client, a coroutine or an async manager);
# _finish() then reads it as a caller would.


def _anthropic_entries() -> dict[str, Callable[[Any, dict[str, Any]], Any]]:
    head = {"model": ANTHROPIC_MODEL, "max_tokens": 10}
    return {
        "create": lambda c, kw: c.messages.create(**head, **kw),
        "create(stream=True)": lambda c, kw: c.messages.create(**head, **kw, stream=True),
        "stream()": lambda c, kw: c.messages.stream(**head, **kw),
        "with_raw_response.create": lambda c, kw: c.messages.with_raw_response.create(**head, **kw),
        "with_raw_response.create(stream=True)": lambda c, kw: c.messages.with_raw_response.create(
            **head, **kw, stream=True
        ),
        "with_streaming_response.create": lambda c, kw: c.messages.with_streaming_response.create(
            **head, **kw
        ),
        "parse": lambda c, kw: c.messages.parse(**head, **kw),
    }


def _chat_entries() -> dict[str, Callable[[Any, dict[str, Any]], Any]]:
    head = {"model": OPENAI_MODEL}
    return {
        "create": lambda c, kw: c.chat.completions.create(**head, **kw),
        "create(stream=True)": lambda c, kw: c.chat.completions.create(**head, **kw, stream=True),
        "stream()": lambda c, kw: c.chat.completions.stream(**head, **kw),
        "with_raw_response.create": lambda c, kw: c.chat.completions.with_raw_response.create(
            **head, **kw
        ),
        "with_raw_response.create(stream=True)": lambda c, kw: (
            c.chat.completions.with_raw_response.create(**head, **kw, stream=True)
        ),
        "with_streaming_response.create": lambda c, kw: (
            c.chat.completions.with_streaming_response.create(**head, **kw)
        ),
        "parse": lambda c, kw: c.chat.completions.parse(**head, **kw),
    }


def _responses_entries() -> dict[str, Callable[[Any, dict[str, Any]], Any]]:
    head = {"model": OPENAI_MODEL}
    return {
        "responses.create": lambda c, kw: c.responses.create(**head, **kw),
        "responses.parse": lambda c, kw: c.responses.parse(**head, **kw),
    }


def _embeddings_entries() -> dict[str, Callable[[Any, dict[str, Any]], Any]]:
    return {"embeddings.create": lambda c, kw: c.embeddings.create(model=EMBEDDING_MODEL, **kw)}


_MODELS = (openai.BaseModel, anthropic.BaseModel)


def _read(value: Any, steps: list[str]) -> None:
    """Read a sync call's result as a caller would: parse a raw response,
    enter a manager, iterate a stream. Each step is noted in ``steps``
    before it is taken."""
    if value is None or isinstance(value, _MODELS):
        return
    parse = getattr(value, "parse", None)
    if callable(parse):
        steps.append("parse")
        _read(parse(), steps)
        return
    if hasattr(value, "__enter__"):
        steps.append("enter")
        with value as opened:
            if opened is value:
                steps.append("iterate")
                for _ in opened:
                    pass
            else:
                _read(opened, steps)
        return
    if hasattr(value, "__iter__"):
        steps.append("iterate")
        for _ in value:
            pass


async def _read_async(value: Any, steps: list[str]) -> None:
    """:func:`_read` for an async call's result, which may first be awaited."""
    if value is None or isinstance(value, _MODELS):
        return
    if hasattr(value, "__aenter__"):
        steps.append("enter")
        async with value as opened:
            if opened is value:
                steps.append("iterate")
                async for _ in opened:
                    pass
            else:
                await _read_async(opened, steps)
        return
    if inspect.isawaitable(value):
        steps.append("await")
        await _read_async(await value, steps)
        return
    parse = getattr(value, "parse", None)
    if callable(parse):
        steps.append("parse")
        await _read_async(parse(), steps)
        return
    if hasattr(value, "__aiter__"):
        steps.append("iterate")
        async for _ in value:
            pass


def _finish(result: Any, is_async: bool, steps: list[str] | None = None) -> None:
    """Read what a call returned as a caller would: await it, enter it,
    iterate its stream, parse a raw response."""
    taken = [] if steps is None else steps
    if is_async:
        asyncio.run(_read_async(result, taken))
    else:
        _read(result, taken)


def _client(sdk: str, is_async: bool) -> Any:
    if sdk == "anthropic":
        cls: Any = anthropic.AsyncAnthropic if is_async else anthropic.Anthropic
    else:
        cls = openai.AsyncOpenAI if is_async else openai.OpenAI
    return cls(api_key="k", max_retries=0)


ROUTE = {
    "anthropic": "anthropic",
    "chat": "chat",
    "responses": "responses",
    "embeddings": "embeddings",
}

# name -> (sdk, route, the argument builder, the entry point)
CASES: dict[
    str, tuple[str, str, Callable[..., dict[str, Any]], Callable[[Any, dict[str, Any]], Any]]
] = {}
for _arg, _build in ANTHROPIC_ARGUMENTS.items():
    for _entry, _call in _anthropic_entries().items():
        CASES[f"anthropic {_entry} {_arg}"] = ("anthropic", "anthropic", _build, _call)
for _arg, _build in CHAT_ARGUMENTS.items():
    for _entry, _call in _chat_entries().items():
        CASES[f"openai chat {_entry} {_arg}"] = ("openai", "chat", _build, _call)
for _arg, _build in RESPONSES_ARGUMENTS.items():
    for _entry, _call in _responses_entries().items():
        CASES[f"openai {_entry} {_arg}"] = ("openai", "responses", _build, _call)
for _arg, _build in EMBEDDINGS_ARGUMENTS.items():
    for _entry, _call in _embeddings_entries().items():
        CASES[f"openai {_entry} {_arg}"] = ("openai", "embeddings", _build, _call)


def _generator(items: list[Any]) -> Any:
    return (item for item in items)


def _as_list(items: list[Any]) -> Any:
    return list(items)


def _body(request: httpx.Request, route: str) -> dict[str, Any]:
    body = json.loads(request.content)
    # The sensor asks a streamed chat call for its usage chunk, by design.
    if route == "chat" and body.get("stream") is True:
        body.pop("stream_options", None)
    return body


def _sensored(
    mode: str, sdk: str, is_async: bool, monkeypatch: pytest.MonkeyPatch, *, capture: bool
) -> tuple[Session, Any]:
    session = _session(capture=capture)
    monkeypatch.setattr(flightdeck_sensor, "_session", session)
    if mode == "patched":
        patch_anthropic_classes(quiet=True)
        patch_openai_classes(quiet=True)
        return session, _client(sdk, is_async)
    return session, flightdeck_sensor.wrap(_client(sdk, is_async))


def _llm_events(session: Session) -> list[dict[str, Any]]:
    return [
        e for e in _events(session) if e["event_type"] in ("pre_call", "post_call", "embeddings")
    ]


# Fields of the stored content that differ from one run to the next.
_PER_RUN_CONTENT_FIELDS = frozenset({"captured_at", "session_id"})


def _what_was_counted(session: Session) -> list[tuple[str, Any, Any]]:
    """Each call event's type, token estimate and stored content (without
    its per-run fields)."""
    out = []
    for event in _llm_events(session):
        content = event.get("content")
        if isinstance(content, dict):
            content = {k: v for k, v in content.items() if k not in _PER_RUN_CONTENT_FIELDS}
        out.append((event["event_type"], event.get("tokens_input"), content))
    return out


def _outcome(make: Callable[[], Any], is_async: bool, routed: Any, route: str) -> tuple[str, Any]:
    """What a call came to: the request the provider received, or the
    exception it raised (an SDK may not accept an iterator for an argument
    it types as a list, or may read one twice)."""
    sent = routed.call_count
    try:
        _finish(make(), is_async)
    except Exception as exc:
        return ("raised", type(exc).__name__)
    assert routed.call_count == sent + 1
    return ("sent", _body(routed.calls.last.request, route))


# The request fields the stored content holds as the provider received them.
_STORED_REQUEST_FIELDS = ("messages", "tools", "system", "input")


def _stored_as_sent(session: Session, body: dict[str, Any]) -> bool:
    """Whether the stored content holds each request field as the request
    the provider received carried it."""
    stored = [e["content"] for e in _llm_events(session) if isinstance(e.get("content"), dict)]
    return bool(stored) and all(
        content.get(field) == body[field]
        for content in stored
        for field in _STORED_REQUEST_FIELDS
        if field in body
    )


@pytest.mark.parametrize("is_async", [False, True], ids=["sync", "async"])
@pytest.mark.parametrize("mode", ["patched", "wrapped"])
@pytest.mark.parametrize("name", sorted(CASES))
def test_an_iterator_argument_reaches_the_provider_as_without_the_sensor(
    provider: respx.MockRouter,
    monkeypatch: pytest.MonkeyPatch,
    name: str,
    mode: str,
    is_async: bool,
) -> None:
    sdk, route, build, call = CASES[name]
    routed = provider.routes[ROUTE[route]]

    plain = _client(sdk, is_async)
    unsensored = _outcome(lambda: call(plain, build(_generator)), is_async, routed, route)

    with_lists, listed = _sensored(mode, sdk, is_async, monkeypatch, capture=True)
    as_lists = _outcome(lambda: call(listed, build(_as_list)), is_async, routed, route)
    with_iterators, client = _sensored(mode, sdk, is_async, monkeypatch, capture=True)
    sensored = _outcome(lambda: call(client, build(_generator)), is_async, routed, route)

    assert sensored == unsensored
    # The estimate is that of the same call made with lists. So is the
    # stored content when the provider received the same request: an SDK
    # that reads an iterator twice (chat ``stream()`` checks ``tools``
    # before it sends) sends what is left, without the sensor as with it,
    # and the content then holds what was sent.
    counted, expected = _what_was_counted(with_iterators), _what_was_counted(with_lists)
    assert [c[:2] for c in counted if c[0] == "pre_call"] == [
        e[:2] for e in expected if e[0] == "pre_call"
    ]
    if sensored[0] == "sent":
        assert any(e.get("has_content") for e in _llm_events(with_iterators))
        if sensored == as_lists:
            assert counted == expected
            assert _stored_as_sent(with_iterators, sensored[1])
        else:
            # The SDK read an iterator twice and sent what was left, without
            # the sensor as with it (the OpenAI SDK's chat parse() and
            # stream() check ``tools`` before sending). The stored content
            # holds what was sent when the SDK read the iterator first
            # (stream() checks when it is called), else the items the
            # caller's iterator yielded (parse() checks inside the call).
            assert _stored_as_sent(with_iterators, sensored[1]) or counted == expected


@pytest.mark.parametrize("is_async", [False, True], ids=["sync", "async"])
@pytest.mark.parametrize("name", sorted(CASES))
def test_with_capture_off_an_iterator_argument_reaches_the_provider_and_no_content_is_kept(
    provider: respx.MockRouter, monkeypatch: pytest.MonkeyPatch, name: str, is_async: bool
) -> None:
    sdk, route, build, call = CASES[name]
    routed = provider.routes[ROUTE[route]]
    plain = _client(sdk, is_async)
    unsensored = _outcome(lambda: call(plain, build(_generator)), is_async, routed, route)
    with_lists, listed = _sensored("patched", sdk, is_async, monkeypatch, capture=False)
    _outcome(lambda: call(listed, build(_as_list)), is_async, routed, route)
    session, client = _sensored("patched", sdk, is_async, monkeypatch, capture=False)
    sensored = _outcome(lambda: call(client, build(_generator)), is_async, routed, route)
    assert sensored == unsensored
    # The estimate is that of the same call made with lists.
    assert [c[:2] for c in _what_was_counted(session) if c[0] == "pre_call"] == [
        c[:2] for c in _what_was_counted(with_lists) if c[0] == "pre_call"
    ]
    events = _llm_events(session)
    assert events
    assert not any(e.get("has_content") for e in events)
    assert all(e.get("content") is None for e in events)
    assert PROMPT not in json.dumps(events, default=str)
    assert SYSTEM not in json.dumps(events, default=str)


# ----- litellm ------------------------------------------------------------------


# entry point -> (sync function, async function, the call's arguments)
LITELLM_ENTRIES: dict[
    str, tuple[str, str, Callable[[Callable[[list[Any]], Any]], dict[str, Any]]]
] = {
    "completion": (
        "completion",
        "acompletion",
        lambda seq: {"model": OPENAI_MODEL, "messages": seq([{"role": "user", "content": PROMPT}])},
    ),
    "text_completion": (
        "text_completion",
        "atext_completion",
        lambda seq: {"model": "gpt-3.5-turbo-instruct", "prompt": seq([PROMPT])},
    ),
    "responses": (
        "responses",
        "aresponses",
        lambda seq: {"model": OPENAI_MODEL, "input": seq([{"role": "user", "content": PROMPT}])},
    ),
    "embedding": (
        "embedding",
        "aembedding",
        lambda seq: {"model": EMBEDDING_MODEL, "input": seq([PROMPT, "second"])},
    ),
}


@pytest.mark.parametrize("is_async", [False, True], ids=["sync", "async"])
@pytest.mark.parametrize("entry", sorted(LITELLM_ENTRIES))
def test_an_iterator_given_to_litellm_fails_as_without_the_sensor(
    provider: respx.MockRouter, monkeypatch: pytest.MonkeyPatch, entry: str, is_async: bool
) -> None:
    """litellm copies a call's arguments before it sends, which fails on a
    generator: the sensored call fails the same way, nothing is sent, and
    the sensor's estimate counted the items as for the call made with a
    list."""
    litellm = pytest.importorskip("litellm")
    from flightdeck_sensor.interceptor.litellm import (
        _PATCHED_ENTRY_POINTS,
        patch_litellm_functions,
        unpatch_litellm_functions,
    )

    sync_name, async_name, build = LITELLM_ENTRIES[entry]
    name = async_name if is_async else sync_name

    def call() -> tuple[str, str]:
        result: Any = None
        try:
            result = getattr(litellm, name)(**build(_generator), api_key="k")
            if is_async:
                asyncio.run(result)
        except Exception as exc:
            return ("raised", f"{type(exc).__name__}: {exc}")
        return ("returned", type(result).__name__)

    sent = len(provider.calls)
    unsensored = call()
    session = _session(capture=True)
    monkeypatch.setattr(flightdeck_sensor, "_session", session)
    patch_litellm_functions(quiet=True)
    try:
        sensored = call()
    finally:
        unpatch_litellm_functions()
    assert sensored == unsensored
    assert unsensored[0] == "raised"
    assert len(provider.calls) == sent
    (provider_cls,) = [p for n, _a, _i, p, _s in _PATCHED_ENTRY_POINTS if n == name]
    estimate = provider_cls().estimate_tokens(build(_as_list))[0]
    counted = [e["tokens_input"] for e in _events(session) if e.get("tokens_input") is not None]
    assert counted[:1] == [estimate]
    if entry != "embedding":  # the litellm embedding estimate reads no input
        assert estimate > len(PROMPT) // 8


# ----- the caller's arguments ----------------------------------------------------


def test_lists_keep_their_identity_and_the_callers_arguments_are_not_changed() -> None:
    nested = [{"type": "text", "text": PROMPT}]
    message = {"role": "user", "content": nested}
    messages = [message]
    kwargs = {"model": OPENAI_MODEL, "messages": messages, "tools": (TOOL_OPENAI,)}
    real_fn = MagicMock()
    assert base.materialise_iterators(kwargs, real_fn) == (kwargs, real_fn)

    iterator = _generator([{"type": "text", "text": PROMPT}])
    with_iterator = {"model": OPENAI_MODEL, "messages": [{"role": "user", "content": iterator}]}
    original_message = with_iterator["messages"][0]
    read, _send = base.materialise_iterators(with_iterator, lambda **kwargs: None)
    assert read is not with_iterator
    assert read["messages"][0]["content"] == [{"type": "text", "text": PROMPT}]
    # The caller's dicts and list still hold what they held.
    assert with_iterator["messages"][0] is original_message
    assert original_message["content"] is iterator


def test_a_file_among_the_arguments_is_passed_on_as_it_is() -> None:
    """A file is an iterator of its lines, but whoever it is given to reads
    it as a file."""
    upload = io.BytesIO(b"first line\nsecond line\n")
    kwargs = {"model": OPENAI_MODEL, "messages": [], "extra_body": {"file": upload}}
    real_fn = MagicMock()
    read, send = base.materialise_iterators(kwargs, real_fn)
    assert read is kwargs
    assert send is real_fn
    assert upload.tell() == 0


def test_arguments_that_hold_themselves_are_handed_on_as_they_are() -> None:
    """The SDK rejects them, as it does without the sensor."""
    messages: list[Any] = [{"role": "user", "content": PROMPT}]
    messages.append(messages)
    kwargs = {"model": OPENAI_MODEL, "messages": messages}
    real_fn = MagicMock()
    read, send = base.materialise_iterators(kwargs, real_fn)
    assert read is kwargs
    assert send is real_fn


def test_the_sdk_gets_the_callers_own_list() -> None:
    """The sensor hands the SDK the very list the caller passed."""
    session = _session(capture=False)
    real = MagicMock()
    real.create.return_value = None
    messages = [{"role": "user", "content": PROMPT}]
    SensorCompletions(real, session, OpenAIProvider()).create(model=OPENAI_MODEL, messages=messages)
    assert real.create.call_args.kwargs["messages"] is messages


# ----- an iterator that raises midway --------------------------------------------


class _Midway(Exception):
    pass


def _raising() -> Any:
    yield {"role": "user", "content": PROMPT}
    raise _Midway("the iterator failed")


def _moment(make: Callable[[], Any], is_async: bool) -> list[str]:
    """The steps a caller took up to the one that raised the iterator's
    exception: the call itself, then each await, parse, enter and
    iteration of what it returned."""
    steps = ["call"]
    try:
        _finish(make(), is_async, steps)
    except _Midway:
        return steps
    return [*steps, "did not raise"]


RAISING_ENTRIES: dict[str, tuple[str, Callable[[Any, dict[str, Any]], Any]]] = {
    **{f"anthropic {n}": ("anthropic", c) for n, c in _anthropic_entries().items()},
    **{f"openai chat {n}": ("openai", c) for n, c in _chat_entries().items()},
}


@pytest.mark.parametrize("is_async", [False, True], ids=["sync", "async"])
@pytest.mark.parametrize("name", sorted(RAISING_ENTRIES))
def test_an_iterator_that_raises_midway_raises_as_without_the_sensor(
    provider: respx.MockRouter, monkeypatch: pytest.MonkeyPatch, name: str, is_async: bool
) -> None:
    """The same exception at the same step (the call itself, the await,
    the entering of a stream manager), and no event."""
    sdk, call = RAISING_ENTRIES[name]
    unsensored = _moment(lambda: call(_client(sdk, is_async), {"messages": _raising()}), is_async)
    session, client = _sensored("patched", sdk, is_async, monkeypatch, capture=True)
    sensored = _moment(lambda: call(client, {"messages": _raising()}), is_async)
    assert sensored == unsensored
    assert "did not raise" not in sensored
    assert _llm_events(session) == []


# ----- the argument check when the call is made ------------------------------------


def test_the_argument_check_when_an_async_call_is_made_reads_no_iterator(
    provider: respx.MockRouter, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An async call through a sensored client has the SDK check its
    arguments when the call is made; that check never reads an iterator,
    which the SDK still gets whole when the call is awaited."""
    _session_, client = _sensored("patched", "openai", True, monkeypatch, capture=False)
    messages = _generator([{"role": "user", "content": PROMPT}])
    pending = client.chat.completions.create(model=OPENAI_MODEL, messages=messages)
    assert inspect.getgeneratorstate(messages) == inspect.GEN_CREATED
    asyncio.run(pending)
    sent = json.loads(provider.routes["chat"].calls.last.request.content)
    assert sent["messages"] == [{"role": "user", "content": PROMPT}]


# ----- parity details of the SDK-shaped methods ------------------------------------


@pytest.mark.skipif(sys.version_info < (3, 12), reason="markcoroutinefunction is new in 3.12")
def test_a_function_marked_as_a_coroutine_function_is_one() -> None:
    def plain(**kwargs: Any) -> Any:
        return None

    marked = inspect.markcoroutinefunction(plain)  # type: ignore[attr-defined]
    assert base._is_coroutine_function(marked) is inspect.iscoroutinefunction(marked) is True
    shaped = base.like_sdk(marked, lambda **kwargs: None)
    assert inspect.iscoroutinefunction(shaped)


def test_a_proxy_missing_its_async_flag_still_hands_out_the_sensors_method() -> None:
    resource = types.SimpleNamespace(create=lambda **kwargs: None)
    proxy = SensorCompletions(resource, _session(capture=False), OpenAIProvider())
    del proxy._is_async
    method = proxy.create
    assert getattr(method, "__func__", None) is SensorCompletions.__dict__["create"]._function
