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

The tests that compare estimates run on both of the OpenAI estimate's
paths, on every machine: tiktoken, and its char/4 fallback, forced. Which
one a call takes otherwise depends on the machine: tiktoken downloads its
encoding data on first use and the unit suite blocks sockets, so a fresh
CI runner takes the fallback while a developer machine with the data
cached takes tiktoken. The tiktoken runs skip, saying so, where the data
is not there.
"""

from __future__ import annotations

import asyncio
import collections.abc
import copy
import functools
import gc
import inspect
import io
import json
import pickle
import sys
import types
import warnings
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
from flightdeck_sensor.providers import openai as openai_provider
from flightdeck_sensor.providers.anthropic import AnthropicProvider
from flightdeck_sensor.providers.openai import OpenAIProvider
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


@functools.cache
def _tiktoken_unavailable() -> str | None:
    """Why tiktoken cannot encode for :data:`OPENAI_MODEL` here, or None."""
    try:
        import tiktoken

        tiktoken.encoding_for_model(OPENAI_MODEL).encode("x")
    except Exception as exc:
        return f"{type(exc).__name__}: {exc}"
    return None


@pytest.fixture(params=["tiktoken", "char-4 fallback"])
def estimate_path(request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch) -> str:
    """The OpenAI estimate's path for the test: tiktoken, or the char/4
    fallback it takes when tiktoken cannot count (see the module
    docstring)."""
    if request.param == "tiktoken":
        reason = _tiktoken_unavailable()
        if reason is not None:
            pytest.skip(f"tiktoken has no encoding data for {OPENAI_MODEL} here: {reason}")
    else:
        monkeypatch.setattr(openai_provider, "_try_tiktoken_count", lambda messages, model: None)
    return str(request.param)


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
    # Looked up on the type: a stream guard opens its stream to answer
    # an attribute it does not have.
    if callable(getattr(type(value), "parse", None)):
        steps.append("parse")
        _read(value.parse(), steps)
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
    if callable(getattr(type(value), "parse", None)):
        steps.append("parse")
        await _read_async(value.parse(), steps)
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


def _empty(items: list[Any]) -> Any:
    """What is left of an iterator the SDK has read already."""
    return []


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


def _call_events(session: Session) -> list[str]:
    """The types of the call events the session emitted, in order."""
    kinds = ("pre_call", "post_call", "embeddings", "llm_error")
    return [e["event_type"] for e in _events(session) if e["event_type"] in kinds]


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


def _pre_calls(counted: list[tuple[str, Any, Any]]) -> list[tuple[str, Any]]:
    """The estimate of each ``pre_call`` among :func:`_what_was_counted`."""
    return [c[:2] for c in counted if c[0] == "pre_call"]


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


class _Readers:
    """Generators that note who started reading them: the sensor (inside
    ``base.materialise_iterators``) or the SDK, which reads an argument
    before the sensor when it checks it in a helper that then calls the
    sensored method (the OpenAI SDK's async chat ``stream()`` checks
    ``tools`` when it is called)."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self.first: list[str] = []
        self._sensor_reading = 0
        materialise = base.materialise_iterators

        def spy(kwargs: dict[str, Any], real_fn: Callable[..., Any], *rest: Any) -> base.Arguments:
            self._sensor_reading += 1
            try:
                return materialise(kwargs, real_fn, *rest)
            finally:
                self._sensor_reading -= 1

        monkeypatch.setattr(base, "materialise_iterators", spy)

    def generator(self, items: list[Any]) -> Any:
        def noted() -> Any:
            self.first.append("sensor" if self._sensor_reading else "sdk")
            yield from items

        return noted()


def _expected_estimate(
    readers: _Readers,
    sent_as_with_lists: bool,
    with_lists: Session,
    rerun_with_empty: Callable[[], Session],
) -> list[tuple[str, Any]]:
    """The estimate a sensored call with a generator makes: that of the
    same call made with lists when the sensor read the caller's items.
    When the SDK read the generator first, the sensor read what the SDK
    then handed on: the items in a list of the SDK's own when the request
    is the one the call with lists sends (openai 3.26's ``stream()``),
    else what was left, an empty list (openai 2.x's async ``stream()``)."""
    if readers.first[:1] == ["sdk"] and not sent_as_with_lists:
        return _pre_calls(_what_was_counted(rerun_with_empty()))
    return _pre_calls(_what_was_counted(with_lists))


@pytest.mark.parametrize("is_async", [False, True], ids=["sync", "async"])
@pytest.mark.parametrize("mode", ["patched", "wrapped"])
@pytest.mark.parametrize("name", sorted(CASES))
def test_an_iterator_argument_reaches_the_provider_as_without_the_sensor(
    provider: respx.MockRouter,
    monkeypatch: pytest.MonkeyPatch,
    estimate_path: str,
    name: str,
    mode: str,
    is_async: bool,
) -> None:
    sdk, route, build, call = CASES[name]
    routed = provider.routes[ROUTE[route]]

    plain = _client(sdk, is_async)
    unsensored = _outcome(lambda: call(plain, build(_generator)), is_async, routed, route)

    readers = _Readers(monkeypatch)
    with_lists, listed = _sensored(mode, sdk, is_async, monkeypatch, capture=True)
    as_lists = _outcome(lambda: call(listed, build(_as_list)), is_async, routed, route)
    with_iterators, client = _sensored(mode, sdk, is_async, monkeypatch, capture=True)
    sensored = _outcome(lambda: call(client, build(readers.generator)), is_async, routed, route)

    assert sensored == unsensored
    counted = _what_was_counted(with_iterators)
    if sensored[0] == "sent":
        # The stored content holds what the provider received, also where
        # the SDK reads an iterator twice and sends what is left (the
        # OpenAI SDK's chat parse() checks ``tools`` before it builds the
        # request).
        assert any(e.get("has_content") for e in _llm_events(with_iterators))
        assert _stored_as_sent(with_iterators, sensored[1])

    def rerun_with_empty() -> Session:
        session, emptied = _sensored(mode, sdk, is_async, monkeypatch, capture=True)
        assert _outcome(lambda: call(emptied, build(_empty)), is_async, routed, route) == sensored
        return session

    expected = _expected_estimate(readers, sensored == as_lists, with_lists, rerun_with_empty)
    assert _pre_calls(counted) == expected
    if sensored == as_lists:
        # The SDK read each iterator once: everything the sensor counted
        # is what the same call made with lists counts.
        assert counted == _what_was_counted(with_lists)


@pytest.mark.parametrize("is_async", [False, True], ids=["sync", "async"])
@pytest.mark.parametrize("name", sorted(CASES))
def test_with_capture_off_an_iterator_argument_reaches_the_provider_and_no_content_is_kept(
    provider: respx.MockRouter,
    monkeypatch: pytest.MonkeyPatch,
    estimate_path: str,
    name: str,
    is_async: bool,
) -> None:
    sdk, route, build, call = CASES[name]
    routed = provider.routes[ROUTE[route]]
    plain = _client(sdk, is_async)
    unsensored = _outcome(lambda: call(plain, build(_generator)), is_async, routed, route)
    readers = _Readers(monkeypatch)
    with_lists, listed = _sensored("patched", sdk, is_async, monkeypatch, capture=False)
    as_lists = _outcome(lambda: call(listed, build(_as_list)), is_async, routed, route)
    session, client = _sensored("patched", sdk, is_async, monkeypatch, capture=False)
    sensored = _outcome(lambda: call(client, build(readers.generator)), is_async, routed, route)
    assert sensored == unsensored

    def rerun_with_empty() -> Session:
        emptied_session, emptied = _sensored("patched", sdk, is_async, monkeypatch, capture=False)
        _outcome(lambda: call(emptied, build(_empty)), is_async, routed, route)
        return emptied_session

    expected = _expected_estimate(readers, sensored == as_lists, with_lists, rerun_with_empty)
    assert _pre_calls(_what_was_counted(session)) == expected
    events = _llm_events(session)
    assert events
    assert not any(e.get("has_content") for e in events)
    assert all(e.get("content") is None for e in events)
    assert PROMPT not in json.dumps(events, default=str)
    assert SYSTEM not in json.dumps(events, default=str)


# ----- other kinds of iterator ----------------------------------------------------
#
# The SDK gets an iterator of the sensor's in place of the caller's; for
# any kind of iterator it reads, copies, rejects and names it as it does
# the caller's.


def _same(item: Any) -> Any:
    return item


ITERATOR_KINDS: dict[str, Callable[[list[Any]], Any]] = {
    "generator": _generator,
    "list iterator": lambda items: iter(list(items)),
    "map": lambda items: map(_same, items),
}
KIND_CASES = sorted(
    n
    for n in CASES
    if any(f" {entry} " in f" {n} " for entry in ("create", "parse", "stream()"))
    or "responses.create input" in n
)


def _detailed_outcome(
    make: Callable[[], Any], is_async: bool, routed: Any, route: str
) -> tuple[str, Any]:
    """:func:`_outcome` with an exception's message as well as its type."""
    sent = routed.call_count
    try:
        _finish(make(), is_async)
    except Exception as exc:
        return ("raised", f"{type(exc).__name__}: {exc}")
    assert routed.call_count == sent + 1
    return ("sent", _body(routed.calls.last.request, route))


@pytest.mark.parametrize("is_async", [False, True], ids=["sync", "async"])
@pytest.mark.parametrize("kind", sorted(ITERATOR_KINDS))
@pytest.mark.parametrize("name", KIND_CASES)
def test_every_kind_of_iterator_comes_to_what_it_comes_to_without_the_sensor(
    provider: respx.MockRouter,
    monkeypatch: pytest.MonkeyPatch,
    name: str,
    kind: str,
    is_async: bool,
) -> None:
    sdk, route, build, call = CASES[name]
    routed = provider.routes[ROUTE[route]]
    seq = ITERATOR_KINDS[kind]
    plain = _client(sdk, is_async)
    unsensored = _detailed_outcome(lambda: call(plain, build(seq)), is_async, routed, route)
    session, client = _sensored("patched", sdk, is_async, monkeypatch, capture=True)
    sensored = _detailed_outcome(lambda: call(client, build(seq)), is_async, routed, route)
    assert sensored == unsensored
    if sensored[0] == "sent":
        assert _stored_as_sent(session, sensored[1])


def test_the_sdk_gets_an_iterator_that_behaves_as_the_callers() -> None:
    """The replay is an iterator and nothing more, named as the caller's
    iterator; copying it copies the items not yet read, or fails as
    copying the caller's iterator fails."""
    for make, copyable in ((_generator, False), (lambda items: iter(list(items)), True)):
        original = make([1, 2, 3])
        kind = type(original).__name__
        arguments = base.materialise_iterators({"input": original}, lambda **kwargs: kwargs)
        replay = arguments.send(**arguments.kwargs)["input"]
        assert isinstance(replay, collections.abc.Iterator)
        assert not isinstance(replay, (list, tuple, str, collections.abc.Sequence))
        assert type(replay).__name__ == kind
        assert next(replay) == 1
        if copyable:
            assert list(copy.deepcopy(replay)) == [2, 3]
            assert list(pickle.loads(pickle.dumps(replay))) == [2, 3]
        else:
            with pytest.raises(TypeError) as copied:
                copy.deepcopy(replay)
            with pytest.raises(TypeError) as of_the_callers:
                copy.deepcopy(make([1]))
            assert str(copied.value) == str(of_the_callers.value)
        assert list(replay) == [2, 3]
        assert list(replay) == []


def test_the_stored_content_holds_what_the_sdks_last_read_yielded() -> None:
    """One read is the items; a second read over the exhausted replay is
    what the SDK sends then, an empty list; a replay the SDK never read
    is the items the caller's iterator held."""
    for reads, expected in ((1, [TOOL_OPENAI]), (2, []), (0, [TOOL_OPENAI])):
        kwargs = {"model": OPENAI_MODEL, "tools": _generator([TOOL_OPENAI])}

        def real_fn(reads: int = reads, **call_kwargs: Any) -> None:
            for _ in range(reads):
                list(call_kwargs["tools"])

        arguments = base.materialise_iterators(kwargs, real_fn)
        arguments.send(**arguments.kwargs)
        assert base.as_received(arguments.kwargs)["tools"] == expected


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


@pytest.mark.parametrize("is_async", [False, True], ids=["sync", "async"])
def test_an_iterator_litellm_can_copy_reaches_the_provider_as_without_the_sensor(
    provider: respx.MockRouter, monkeypatch: pytest.MonkeyPatch, is_async: bool
) -> None:
    """litellm copies a call's arguments: a list iterator copies, so the
    request goes out, the same request with the sensor as without it, and
    the content holds the items the copy carried."""
    litellm = pytest.importorskip("litellm")
    from flightdeck_sensor.interceptor.litellm import (
        patch_litellm_functions,
        unpatch_litellm_functions,
    )

    routed = provider.routes["chat"]

    def call() -> Any:
        kwargs = {
            "model": OPENAI_MODEL,
            "messages": iter([{"role": "user", "content": PROMPT}]),
            "client": _client("openai", is_async),
        }
        if is_async:
            return litellm.acompletion(**kwargs)
        return litellm.completion(**kwargs)

    def outcome() -> tuple[str, Any]:
        # litellm 1.83 leaves an async call's success-logging coroutine
        # queued on the call's event loop once it closes, and drops it,
        # never awaited, when the next call runs on a new loop: with or
        # without the sensor, inside this test, which makes the call twice.
        # What its logging worker still holds when the test ends is retired
        # by the suite's fixture (tests/litellm_logging_worker.py).
        with warnings.catch_warnings():
            warnings.filterwarnings(
                "ignore",
                message="coroutine 'Logging.async_success_handler' was never awaited",
                category=RuntimeWarning,
            )
            result = _outcome(call, is_async, routed, "chat")
            gc.collect()
        return result

    unsensored = outcome()
    session = _session(capture=True)
    monkeypatch.setattr(flightdeck_sensor, "_session", session)
    patch_litellm_functions(quiet=True)
    try:
        sensored = outcome()
    finally:
        unpatch_litellm_functions()
    assert sensored == unsensored
    assert sensored[0] == "sent"
    assert sensored[1]["messages"] == [{"role": "user", "content": PROMPT}]
    assert _stored_as_sent(session, sensored[1])


# ----- the caller's arguments ----------------------------------------------------


def test_lists_keep_their_identity_and_the_callers_arguments_are_not_changed() -> None:
    nested = [{"type": "text", "text": PROMPT}]
    message = {"role": "user", "content": nested}
    messages = [message]
    kwargs = {"model": OPENAI_MODEL, "messages": messages, "tools": (TOOL_OPENAI,)}
    real_fn = MagicMock()
    assert base.materialise_iterators(kwargs, real_fn) == (kwargs, real_fn, True, {})

    iterator = _generator([{"type": "text", "text": PROMPT}])
    with_iterator = {"model": OPENAI_MODEL, "messages": [{"role": "user", "content": iterator}]}
    original_message = with_iterator["messages"][0]
    arguments = base.materialise_iterators(with_iterator, lambda **kwargs: None)
    assert arguments.readable
    read = arguments.kwargs
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
    assert base.materialise_iterators(kwargs, real_fn) == (kwargs, real_fn, True, {})
    assert upload.tell() == 0


def test_arguments_that_hold_themselves_are_handed_on_as_they_are() -> None:
    """The SDK rejects them, as it does without the sensor."""
    messages: list[Any] = [{"role": "user", "content": PROMPT}]
    messages.append(messages)
    kwargs = {"model": OPENAI_MODEL, "messages": messages}
    real_fn = MagicMock()
    assert base.materialise_iterators(kwargs, real_fn) == (kwargs, real_fn, True, {})


def test_an_iterator_beside_arguments_that_hold_themselves_is_read() -> None:
    """The walk stops at a fixed depth, so a branch that holds itself
    does not stop the sensor reading an iterator elsewhere; that branch
    reaches the SDK as the same object, which rejects it."""
    cycle: list[Any] = []
    cycle.append(cycle)
    kwargs = {"model": OPENAI_MODEL, "messages": _generator([{"role": "user"}]), "extra": cycle}
    received: dict[str, Any] = {}
    arguments = base.materialise_iterators(
        kwargs, lambda **call_kwargs: received.update(call_kwargs)
    )
    assert arguments.readable
    assert arguments.kwargs["messages"] == [{"role": "user"}]
    assert arguments.kwargs["extra"] is cycle
    arguments.send(**arguments.kwargs)
    assert received["extra"] is cycle
    assert list(received["messages"]) == [{"role": "user"}]
    assert base.as_received(arguments.kwargs)["extra"] is cycle


def test_an_iterator_deeper_than_the_walk_goes_is_passed_on_unread() -> None:
    deep = iter([1])
    nested: Any = deep
    for _ in range(base._MAX_ARGUMENT_DEPTH + 1):
        nested = [nested]
    kwargs = {"model": OPENAI_MODEL, "messages": nested}
    real_fn = MagicMock()
    assert base.materialise_iterators(kwargs, real_fn) == (kwargs, real_fn, True, {})
    assert list(deep) == [1]


def test_arguments_the_walk_runs_out_of_stack_on_are_passed_on_unread(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A caller whose own stack is nearly used up: the walk stops, the SDK
    gets the arguments as they are, and the debug log names no value."""
    deep = iter([PROMPT])
    nested: Any = deep
    for _ in range(base._MAX_ARGUMENT_DEPTH - 4):
        nested = [nested]
    kwargs = {"model": OPENAI_MODEL, "messages": nested}
    real_fn = MagicMock()
    limit = sys.getrecursionlimit()
    caplog.set_level("DEBUG", logger="flightdeck_sensor")

    def at_depth(frames: int) -> Any:
        if frames:
            return at_depth(frames - 1)
        # Room for the logging call, not for the walk's 60 levels.
        sys.setrecursionlimit(len(inspect.stack(0)) + 45)
        try:
            return base.materialise_iterators(kwargs, real_fn)
        finally:
            sys.setrecursionlimit(limit)

    assert at_depth(5) == (kwargs, real_fn, True, {})
    assert list(deep) == [PROMPT]
    assert "passed on as they are" in caplog.text
    assert PROMPT not in caplog.text


def test_an_iterator_beside_a_self_holding_branch_reaches_the_sdk_as_without_the_sensor(
    provider: respx.MockRouter, monkeypatch: pytest.MonkeyPatch
) -> None:
    routed = provider.routes["chat"]

    def make(client: Any) -> Any:
        cycle: list[Any] = []
        cycle.append(cycle)
        return client.chat.completions.create(
            model=OPENAI_MODEL,
            messages=_generator([{"role": "user", "content": PROMPT}]),
            extra_body={"loop": cycle},
        )

    unsensored = _detailed_outcome(lambda: make(_client("openai", False)), False, routed, "chat")
    _session_, client = _sensored("patched", "openai", False, monkeypatch, capture=True)
    assert _detailed_outcome(lambda: make(client), False, routed, "chat") == unsensored


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


def test_an_iterator_that_raises_is_replayed_to_the_sdk_with_its_exception() -> None:
    """The SDK gets the items read before the failure and then the same
    exception, and nothing after the failure is read."""
    error = _Midway("the iterator failed")

    def failing() -> Any:
        yield {"role": "user", "content": PROMPT}
        raise error

    later = _generator([TOOL_OPENAI])
    kwargs = {"model": OPENAI_MODEL, "messages": failing(), "tools": later}
    received: dict[str, Any] = {}

    def real_fn(**call_kwargs: Any) -> Any:
        received.update(call_kwargs)
        return list(call_kwargs["messages"])

    arguments = base.materialise_iterators(kwargs, real_fn)
    assert not arguments.readable
    with pytest.raises(_Midway) as raised:
        arguments.send(**arguments.kwargs)
    assert raised.value is error
    assert received["tools"] is later
    assert inspect.getgeneratorstate(later) == inspect.GEN_CREATED


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
    the entering of a stream manager), nothing sent, and the call reported
    as any call the SDK rejects: an ``llm_error`` after its ``pre_call``."""
    sdk, call = RAISING_ENTRIES[name]
    routed = provider.routes["anthropic" if sdk == "anthropic" else "chat"]
    unsensored = _moment(lambda: call(_client(sdk, is_async), {"messages": _raising()}), is_async)
    session, client = _sensored("patched", sdk, is_async, monkeypatch, capture=True)
    sent = routed.call_count
    sensored = _moment(lambda: call(client, {"messages": _raising()}), is_async)
    assert sensored == unsensored
    assert "did not raise" not in sensored
    assert routed.call_count == sent
    assert _call_events(session) == ["pre_call", "llm_error"]


# ----- the policy check, and arguments the SDK does not read -------------------


def _bad() -> Any:
    """An iterator that raises as soon as it is read."""
    raise _Midway("the iterator failed")
    yield  # pragma: no cover


def _blocking(session: Session) -> Session:
    session.policy = PolicyCache(token_limit=1, block_at_pct=1)
    return session


# entry point -> (sdk, route, the call with ``where`` holding a failing
# iterator: "read" in an argument the sensor reads, "unread" in one only
# the SDK sees)
POLICED_ENTRIES: dict[str, tuple[str, str, Callable[[Any, str], Any]]] = {
    "openai chat create": (
        "openai",
        "chat",
        lambda c, where: c.chat.completions.create(model=OPENAI_MODEL, **_placed(where, "openai")),
    ),
    "openai chat create(stream=True)": (
        "openai",
        "chat",
        lambda c, where: c.chat.completions.create(
            model=OPENAI_MODEL, stream=True, **_placed(where, "openai")
        ),
    ),
    "openai chat stream()": (
        "openai",
        "chat",
        lambda c, where: c.chat.completions.stream(model=OPENAI_MODEL, **_placed(where, "openai")),
    ),
    "openai chat with_raw_response.create": (
        "openai",
        "chat",
        lambda c, where: c.chat.completions.with_raw_response.create(
            model=OPENAI_MODEL, **_placed(where, "openai")
        ),
    ),
    "openai chat with_streaming_response.create": (
        "openai",
        "chat",
        lambda c, where: c.chat.completions.with_streaming_response.create(
            model=OPENAI_MODEL, **_placed(where, "openai")
        ),
    ),
    "anthropic create": (
        "anthropic",
        "anthropic",
        lambda c, where: c.messages.create(
            model=ANTHROPIC_MODEL, max_tokens=10, **_placed(where, "anthropic")
        ),
    ),
    "anthropic stream()": (
        "anthropic",
        "anthropic",
        lambda c, where: c.messages.stream(
            model=ANTHROPIC_MODEL, max_tokens=10, **_placed(where, "anthropic")
        ),
    ),
}


def _placed(where: str, sdk: str) -> dict[str, Any]:
    """A call's arguments with a failing iterator in an argument the
    sensor reads (a message's content), or in one only the SDK sees (a
    query parameter, which the SDK stringifies without reading it)."""
    if where == "read":
        return {"messages": [{"role": "user", "content": _bad()}]}
    return {"messages": [{"role": "user", "content": PROMPT}], "extra_query": {"q": _bad()}}


@pytest.mark.parametrize("where", ["read", "unread"])
@pytest.mark.parametrize("is_async", [False, True], ids=["sync", "async"])
@pytest.mark.parametrize("name", sorted(POLICED_ENTRIES))
def test_a_blocked_call_with_a_failing_iterator_sends_nothing(
    provider: respx.MockRouter,
    monkeypatch: pytest.MonkeyPatch,
    name: str,
    is_async: bool,
    where: str,
) -> None:
    """Wherever the failing iterator is, a BLOCK sends nothing. The policy
    check runs before the request goes out, and on every entry point the
    SDK reads the iterator no earlier than that, so the BLOCK raises
    first, as for any call. One exception: Anthropic's
    ``messages.stream()`` on a release whose ``stream()`` reads its
    arguments (anthropic 0.86). That ``stream()`` raises the iterator's
    error before any request is made, so nothing is sent or refused, and
    the caller gets what it gets without the sensor at that moment: the
    call is reported as one the SDK refused (``pre_call`` and
    ``llm_error``, no policy check). A release that reads them on entry
    (2.x) returns the manager, and the BLOCK refuses the entry."""
    sdk, route, call = POLICED_ENTRIES[name]
    routed = provider.routes[route]
    refused_by_stream = name == "anthropic stream()" and _raises_at_the_call(
        lambda: call(_client(sdk, is_async), where)
    )
    session, client = _sensored("patched", sdk, is_async, monkeypatch, capture=True)
    _blocking(session)
    sent = routed.call_count
    if refused_by_stream:
        with pytest.raises(_Midway):
            call(client, where)
        assert _call_events(session) == ["pre_call", "llm_error"]
    else:
        with pytest.raises(flightdeck_sensor.BudgetExceededError):
            _finish(call(client, where), is_async)
        kinds = [e["event_type"] for e in _events(session)]
        assert kinds[-2:] == ["pre_call", "policy_block"]
    assert routed.call_count == sent


def _raises_at_the_call(make: Callable[[], Any]) -> bool:
    """Whether the call itself raises the iterator's exception, without
    the sensor; what it returns otherwise is closed, never entered."""
    try:
        made = make()
    except _Midway:
        return True
    base._discard(made)
    return False


@pytest.mark.parametrize("is_async", [False, True], ids=["sync", "async"])
def test_a_blocked_stream_helper_whose_iterator_reads_is_refused_at_entry(
    provider: respx.MockRouter, monkeypatch: pytest.MonkeyPatch, is_async: bool
) -> None:
    """An iterator ``messages.stream()`` reads without failing, when it is
    called (anthropic 0.86) or on entry (2.x): ``stream()`` returns the
    manager on either release, and the BLOCK refuses the entry before the
    request goes out, reporting the refusal."""
    routed = provider.routes["anthropic"]
    session, client = _sensored("patched", "anthropic", is_async, monkeypatch, capture=True)
    _blocking(session)
    sent = routed.call_count
    manager = client.messages.stream(
        model=ANTHROPIC_MODEL, max_tokens=10, messages=iter([{"role": "user", "content": PROMPT}])
    )
    assert _events(session) == []
    with pytest.raises(flightdeck_sensor.BudgetExceededError):
        _finish(manager, is_async)
    assert routed.call_count == sent
    kinds = [e["event_type"] for e in _events(session)]
    assert kinds == ["pre_call", "policy_block"]


@pytest.mark.parametrize("is_async", [False, True], ids=["sync", "async"])
@pytest.mark.parametrize("name", sorted(POLICED_ENTRIES))
def test_a_failing_iterator_the_sensor_does_not_read_reaches_the_sdk_untouched(
    provider: respx.MockRouter, monkeypatch: pytest.MonkeyPatch, name: str, is_async: bool
) -> None:
    """An iterator in an argument only the SDK reads (here a query
    parameter the SDK stringifies) is the SDK's: the call comes to what it
    comes to without the sensor, and a call sent is metered."""
    sdk, route, call = POLICED_ENTRIES[name]
    routed = provider.routes[route]
    unsensored = _detailed_outcome(
        lambda: call(_client(sdk, is_async), "unread"), is_async, routed, route
    )
    session, client = _sensored("patched", sdk, is_async, monkeypatch, capture=True)
    sensored = _detailed_outcome(lambda: call(client, "unread"), is_async, routed, route)
    assert sensored == unsensored
    if sensored[0] == "sent":
        assert _call_events(session) == ["pre_call", "post_call"]


@pytest.mark.parametrize("blocked", [False, True], ids=["allowed", "blocked"])
@pytest.mark.parametrize("is_async", [False, True], ids=["sync", "async"])
def test_a_failing_iterator_given_to_litellm_is_policed(
    provider: respx.MockRouter, monkeypatch: pytest.MonkeyPatch, is_async: bool, blocked: bool
) -> None:
    """litellm never reads its ``metadata``: with a failing iterator there
    the call goes out and is metered, unless the policy blocks it, when
    nothing is sent."""
    litellm = pytest.importorskip("litellm")
    from flightdeck_sensor.interceptor.litellm import (
        patch_litellm_functions,
        unpatch_litellm_functions,
    )

    routed = provider.routes["chat"]

    def call() -> Any:
        kwargs = {
            "model": OPENAI_MODEL,
            "messages": [{"role": "user", "content": PROMPT}],
            "metadata": {"k": _bad()},
            "client": _client("openai", is_async),
        }
        return litellm.acompletion(**kwargs) if is_async else litellm.completion(**kwargs)

    session = _session(capture=True)
    if blocked:
        _blocking(session)
    monkeypatch.setattr(flightdeck_sensor, "_session", session)
    patch_litellm_functions(quiet=True)
    sent = routed.call_count
    try:
        if blocked:
            with pytest.raises(flightdeck_sensor.BudgetExceededError):
                _finish(call(), is_async)
        else:
            _finish(call(), is_async)
    finally:
        unpatch_litellm_functions()
    if blocked:
        assert routed.call_count == sent
    else:
        assert routed.call_count == sent + 1
        assert "pre_call" in _call_events(session)
        assert "post_call" in _call_events(session)


@pytest.mark.parametrize("is_async", [False, True], ids=["sync", "async"])
def test_a_failing_iterator_the_sdk_never_reads_lets_the_call_through_metered(
    is_async: bool,
) -> None:
    """Should the SDK never read an argument the sensor reads, the call is
    sent and metered as any other, the estimate counting what was read."""
    session = _session(capture=False)
    response = None
    seen: dict[str, Any] = {}

    def real_fn(**kwargs: Any) -> Any:
        seen.update(kwargs)
        return response

    async def async_real_fn(**kwargs: Any) -> Any:
        return real_fn(**kwargs)

    kwargs = {"model": OPENAI_MODEL, "messages": [{"role": "user", "content": _bad()}]}
    if is_async:
        result = asyncio.run(base.call_async(async_real_fn, kwargs, session, OpenAIProvider()))
    else:
        result = base.call(real_fn, kwargs, session, OpenAIProvider())
    assert result is response
    assert type(seen["messages"][0]["content"]).__name__ == "generator"
    assert _call_events(session) == ["pre_call", "post_call"]


# ----- collections the SDKs list ------------------------------------------------


LISTED_CASES: dict[str, tuple[str, str, Callable[[Any], Any]]] = {
    "openai messages=dict_values": (
        "openai",
        "chat",
        lambda c: c.chat.completions.create(
            model=OPENAI_MODEL, messages={"a": {"role": "user", "content": PROMPT}}.values()
        ),
    ),
    "openai tools=deque": (
        "openai",
        "chat",
        lambda c: c.chat.completions.create(
            model=OPENAI_MODEL,
            messages=[{"role": "user", "content": PROMPT}],
            tools=collections.deque([TOOL_OPENAI]),
        ),
    ),
    "openai embeddings input=range": (
        "openai",
        "embeddings",
        lambda c: c.embeddings.create(model=EMBEDDING_MODEL, input=range(3)),
    ),
    "openai embeddings input=dict_keys": (
        "openai",
        "embeddings",
        lambda c: c.embeddings.create(model=EMBEDDING_MODEL, input={PROMPT: 1, "b": 2}.keys()),
    ),
    "openai embeddings input=frozenset": (
        "openai",
        "embeddings",
        lambda c: c.embeddings.create(model=EMBEDDING_MODEL, input=frozenset({PROMPT})),
    ),
    "anthropic content=dict_values": (
        "anthropic",
        "anthropic",
        lambda c: c.messages.create(
            model=ANTHROPIC_MODEL,
            max_tokens=10,
            messages=[
                {"role": "user", "content": {"a": {"type": "text", "text": PROMPT}}.values()}
            ],
        ),
    ),
    "anthropic tools=dict_values": (
        "anthropic",
        "anthropic",
        lambda c: c.messages.create(
            model=ANTHROPIC_MODEL,
            max_tokens=10,
            messages=[{"role": "user", "content": PROMPT}],
            tools={"a": TOOL_ANTHROPIC}.values(),
        ),
    ),
}


@pytest.mark.parametrize("capture", [True, False], ids=["capture on", "capture off"])
@pytest.mark.parametrize("name", sorted(LISTED_CASES))
def test_a_collection_the_sdk_lists_is_stored_as_the_list_it_sends(
    provider: respx.MockRouter, monkeypatch: pytest.MonkeyPatch, name: str, capture: bool
) -> None:
    """A dict view, a set, a deque or a range given for an ``Iterable``
    argument reaches the provider as without the sensor, and the stored
    content holds the list the SDK sent, where JSON could not write the
    collection itself."""
    sdk, route, call = LISTED_CASES[name]
    routed = provider.routes[route]
    unsensored = _outcome(lambda: call(_client(sdk, False)), False, routed, route)
    session, client = _sensored("patched", sdk, False, monkeypatch, capture=capture)
    sensored = _outcome(lambda: call(client), False, routed, route)
    assert sensored == unsensored
    assert sensored[0] == "sent"
    events = [e for e in _llm_events(session) if e["event_type"] != "pre_call"]
    if capture:
        assert _stored_as_sent(session, sensored[1])
        for event in events:
            body = json.loads(serialize_event(dict(event)))
            assert body.get("content"), "the content was dropped as not JSON"
    else:
        assert not any(e.get("has_content") for e in events)


def test_the_sdk_gets_the_callers_own_collection() -> None:
    values = {"a": {"role": "user", "content": PROMPT}}.values()
    items = {"k": "v"}.items()
    received: dict[str, Any] = {}
    kwargs = {"model": OPENAI_MODEL, "messages": values, "input": items}
    arguments = base.materialise_iterators(
        kwargs, lambda **call_kwargs: received.update(call_kwargs)
    )
    arguments.send(**arguments.kwargs)
    assert received["messages"] is values
    assert received["input"] is items
    assert base.as_received(arguments.kwargs)["input"] == [("k", "v")]


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
