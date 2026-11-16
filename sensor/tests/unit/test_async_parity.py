"""A sensored async client behaves like an unsensored one at every async
entry point the sensor patches or proxies: each introspects alike
(``inspect.iscoroutinefunction``, ``inspect.signature``, name, qualified
name, docstring and module) and rejects a missing or an unknown argument
with the same exception at the same moment, when the call is made or
when it is awaited. ``inspect.isfunction`` on the object behind a
coroutine function's stand-in is the one difference ARCHITECTURE states.

Each entry point is driven twice over the same mocked provider (respx):
on a client the sensor never saw, with no session and the SDKs unpatched,
then on a sensored one, with a session active and the SDK patched, or
wrapped by ``flightdeck_sensor.wrap()``. A coroutine left unawaited fails
the test (``RuntimeWarning`` is an error here).
"""

from __future__ import annotations

import asyncio
import gc
import inspect
import json
import weakref
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
from flightdeck_sensor.interceptor import anthropic as anthropic_interceptor
from flightdeck_sensor.interceptor import base
from flightdeck_sensor.interceptor.anthropic import (
    patch_anthropic_classes,
    unpatch_anthropic_classes,
)
from flightdeck_sensor.interceptor.openai import patch_openai_classes, unpatch_openai_classes
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
        router.post("https://api.anthropic.com/v1/messages").mock(
            side_effect=_json_or_events(MESSAGE)
        )
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


def _session() -> Session:
    config = SensorConfig(
        server="http://localhost:9999",
        token="tok",
        agent_flavor="parity",
        agent_type="production",
        quiet=True,
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


def _client(sdk: str) -> Any:
    if sdk == "anthropic":
        return anthropic.AsyncAnthropic(api_key="k", max_retries=0)
    return openai.AsyncOpenAI(api_key="k", max_retries=0)


# name -> (sdk, the entry point on a client, a valid call's arguments, the
# same call missing what the SDK requires)
ENTRY_POINTS: dict[str, tuple[str, Callable[[Any], Any], dict[str, Any], dict[str, Any]]] = {
    "anthropic messages.create": (
        "anthropic",
        lambda c: c.messages.create,
        ANTHROPIC_OK,
        {"model": ANTHROPIC_MODEL},
    ),
    "anthropic messages.parse": (
        "anthropic",
        lambda c: c.messages.parse,
        ANTHROPIC_OK,
        {"model": ANTHROPIC_MODEL},
    ),
    "anthropic messages.stream": (
        "anthropic",
        lambda c: c.messages.stream,
        ANTHROPIC_OK,
        {"model": ANTHROPIC_MODEL},
    ),
    "anthropic messages.with_raw_response.create": (
        "anthropic",
        lambda c: c.messages.with_raw_response.create,
        ANTHROPIC_OK,
        {"model": ANTHROPIC_MODEL},
    ),
    "anthropic messages.with_raw_response.parse": (
        "anthropic",
        lambda c: c.messages.with_raw_response.parse,
        ANTHROPIC_OK,
        {"model": ANTHROPIC_MODEL},
    ),
    "anthropic messages.with_streaming_response.create": (
        "anthropic",
        lambda c: c.messages.with_streaming_response.create,
        ANTHROPIC_OK,
        {"model": ANTHROPIC_MODEL},
    ),
    "anthropic beta.messages.create": (
        "anthropic",
        lambda c: c.beta.messages.create,
        ANTHROPIC_OK,
        {"model": ANTHROPIC_MODEL},
    ),
    "anthropic beta.messages.parse": (
        "anthropic",
        lambda c: c.beta.messages.parse,
        ANTHROPIC_OK,
        {"model": ANTHROPIC_MODEL},
    ),
    "anthropic beta.messages.stream": (
        "anthropic",
        lambda c: c.beta.messages.stream,
        ANTHROPIC_OK,
        {"model": ANTHROPIC_MODEL},
    ),
    "anthropic with_raw_response.messages.create": (
        "anthropic",
        lambda c: c.with_raw_response.messages.create,
        ANTHROPIC_OK,
        {"model": ANTHROPIC_MODEL},
    ),
    "openai chat.completions.create": (
        "openai",
        lambda c: c.chat.completions.create,
        CHAT_OK,
        {"model": OPENAI_MODEL},
    ),
    "openai chat.completions.parse": (
        "openai",
        lambda c: c.chat.completions.parse,
        CHAT_OK,
        {"model": OPENAI_MODEL},
    ),
    "openai chat.completions.stream": (
        "openai",
        lambda c: c.chat.completions.stream,
        CHAT_OK,
        {"model": OPENAI_MODEL},
    ),
    "openai chat.completions.with_raw_response.create": (
        "openai",
        lambda c: c.chat.completions.with_raw_response.create,
        CHAT_OK,
        {"model": OPENAI_MODEL},
    ),
    "openai chat.completions.with_raw_response.parse": (
        "openai",
        lambda c: c.chat.completions.with_raw_response.parse,
        CHAT_OK,
        {"model": OPENAI_MODEL},
    ),
    "openai chat.completions.with_streaming_response.create": (
        "openai",
        lambda c: c.chat.completions.with_streaming_response.create,
        CHAT_OK,
        {"model": OPENAI_MODEL},
    ),
    "openai beta.chat.completions.parse": (
        "openai",
        lambda c: c.beta.chat.completions.parse,
        CHAT_OK,
        {"model": OPENAI_MODEL},
    ),
    "openai with_raw_response.chat.completions.create": (
        "openai",
        lambda c: c.with_raw_response.chat.completions.create,
        CHAT_OK,
        {"model": OPENAI_MODEL},
    ),
    "openai responses.create": (
        "openai",
        lambda c: c.responses.create,
        RESPONSES_OK,
        {},
    ),
    "openai responses.parse": (
        "openai",
        lambda c: c.responses.parse,
        RESPONSES_OK,
        {},
    ),
    "openai responses.stream": (
        "openai",
        lambda c: c.responses.stream,
        RESPONSES_OK,
        {},
    ),
    "openai responses.with_raw_response.create": (
        "openai",
        lambda c: c.responses.with_raw_response.create,
        RESPONSES_OK,
        {},
    ),
    "openai embeddings.create": (
        "openai",
        lambda c: c.embeddings.create,
        EMBEDDINGS_OK,
        {"model": "text-embedding-3-small"},
    ),
    "openai embeddings.with_raw_response.create": (
        "openai",
        lambda c: c.embeddings.with_raw_response.create,
        EMBEDDINGS_OK,
        {"model": "text-embedding-3-small"},
    ),
    "openai embeddings.with_streaming_response.create": (
        "openai",
        lambda c: c.embeddings.with_streaming_response.create,
        EMBEDDINGS_OK,
        {"model": "text-embedding-3-small"},
    ),
}


async def _settle(result: Any) -> None:
    """Await what a call returned, or enter it (a stream manager, a
    streaming view), as a caller would."""
    if hasattr(result, "__aenter__"):
        async with result:
            return
    if inspect.isawaitable(result):
        value = await result
        close = getattr(value, "close", None)
        if inspect.iscoroutinefunction(close):
            await close()


def _moment(entry: Callable[..., Any], kwargs: dict[str, Any]) -> str:
    """The exception a call raises and when: ``call:<type>`` when the
    call is made, ``await:<type>`` when it is awaited (or entered), or
    ``none``."""
    try:
        result = entry(**kwargs)
    except Exception as exc:
        return f"call:{type(exc).__name__}"
    try:
        asyncio.run(_settle(result))
    except Exception as exc:
        return f"await:{type(exc).__name__}"
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
def test_an_async_entry_point_behaves_as_the_sdks_own(
    provider: respx.MockRouter, monkeypatch: pytest.MonkeyPatch, mode: str, name: str
) -> None:
    sdk, get, ok, missing = ENTRY_POINTS[name]
    plain = _client(sdk)
    try:
        get(plain)
    except AttributeError:
        pytest.skip(f"the installed {sdk} SDK has no {name.split(' ', 1)[1]}")
    unsensored = _profile(lambda: get(plain), ok, missing)

    monkeypatch.setattr(flightdeck_sensor, "_session", _session())
    if mode == "patched":
        patch_anthropic_classes(quiet=True)
        patch_openai_classes(quiet=True)
        sensored_client = _client(sdk)
    else:
        sensored_client = flightdeck_sensor.wrap(_client(sdk))
    sensored = _profile(lambda: get(sensored_client), ok, missing)

    assert sensored == unsensored


def test_the_patched_async_resource_methods_introspect_as_the_sdks_own() -> None:
    """The class attributes themselves: the patch installs on the async
    resource classes a ``create`` that is a plain function (the SDK's is a
    synchronous wrapper returning the coroutine), a ``parse`` that is a
    coroutine function as the SDK's ``async def`` is, and a ``stream``
    that is a plain function, each with the SDK's signature."""
    classes = [cls for cls, is_async in anthropic_interceptor._resource_targets() if is_async]
    methods = ("create", "parse", "stream")

    def profile() -> dict[tuple[str, str], tuple[bool, inspect.Signature]]:
        return {
            (cls.__qualname__, method): (
                inspect.iscoroutinefunction(getattr(cls, method)),
                inspect.signature(getattr(cls, method)),
            )
            for cls in classes
            for method in methods
            if callable(getattr(cls, method, None))
        }

    unpatched = profile()
    patch_anthropic_classes(quiet=True)
    assert profile() == unpatched


# How many wrap()'d clients the signature-cache test drops.
_CLIENTS = 5


def test_wrapped_clients_that_streamed_are_collected_once_dropped(
    provider: respx.MockRouter, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The async ``stream()`` binds its arguments against the SDK's
    signature, cached per SDK function: the cache holds one entry however
    many clients stream, and no client stays alive in it."""
    monkeypatch.setattr(flightdeck_sensor, "_session", _session())
    base._signature.cache_clear()
    alive: list[weakref.ref[Any]] = []

    async def _stream(client: Any) -> None:
        async with client.messages.stream(**ANTHROPIC_OK):
            pass

    for _ in range(_CLIENTS):
        raw = _client("anthropic")
        alive.append(weakref.ref(raw))
        wrapped = flightdeck_sensor.wrap(raw)
        asyncio.run(_stream(wrapped))
        del raw, wrapped
    gc.collect()

    assert [ref() for ref in alive] == [None] * _CLIENTS
    info = base._signature.cache_info()
    assert (info.currsize, info.misses, info.hits) == (1, 1, _CLIENTS - 1)
