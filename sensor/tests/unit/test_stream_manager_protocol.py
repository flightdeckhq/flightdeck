"""Every object the sensor hands a caller of a stream helper, a streamed
``create`` or a raw / streaming view has the protocol of the SDK object it
stands for, at each stage: the call's result, what entering it gives and
what ``parse()`` gives.

A protocol is the presence of ``__enter__`` / ``__exit__``,
``__aenter__`` / ``__aexit__``, ``__iter__`` / ``__next__``,
``__aiter__`` / ``__anext__`` and ``__await__``, on the object and on its
class (the interpreter looks a protocol up on the class). A stream
helper's manager (OpenAI ``chat.completions.stream()`` /
``responses.stream()``, Anthropic ``messages.stream()``) is also named as
the SDK's class, so what the interpreter raises for the wrong protocol
(``async with`` on a sync manager, iterating a manager before entering
it) is what it raises without the sensor, word for word.

Driven with the real ``openai`` / ``anthropic`` clients over respx; the
oracle is the same call without the sensor, in the same environment.
"""

from __future__ import annotations

import asyncio
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
from flightdeck_sensor.core.exceptions import BudgetExceededError
from flightdeck_sensor.core.policy import PolicyCache
from flightdeck_sensor.core.session import Session
from flightdeck_sensor.core.types import SensorConfig
from flightdeck_sensor.interceptor.anthropic import (
    patch_anthropic_classes,
    unpatch_anthropic_classes,
)
from flightdeck_sensor.interceptor.openai import patch_openai_classes, unpatch_openai_classes
from flightdeck_sensor.transport.client import ControlPlaneClient

if TYPE_CHECKING:
    from collections.abc import Callable, Iterator


PROTOCOL = (
    "__enter__",
    "__exit__",
    "__aenter__",
    "__aexit__",
    "__iter__",
    "__next__",
    "__aiter__",
    "__anext__",
    "__await__",
)
SERVED = "gpt-4o-mini-2024-07-18"
CHAT = {
    "id": "c",
    "object": "chat.completion",
    "created": 1,
    "model": SERVED,
    "choices": [
        {"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": "Hi"}}
    ],
    "usage": {"prompt_tokens": 3, "completion_tokens": 1, "total_tokens": 4},
}
RESPONSE = {
    "id": "r",
    "object": "response",
    "created_at": 1,
    "model": SERVED,
    "status": "completed",
    "output": [],
    "usage": {"input_tokens": 3, "output_tokens": 1, "total_tokens": 4},
    "parallel_tool_calls": True,
    "tool_choice": "auto",
    "tools": [],
}
MESSAGE = {
    "id": "m",
    "type": "message",
    "role": "assistant",
    "model": "claude-haiku-4-5-20251001",
    "content": [{"type": "text", "text": "Hi"}],
    "stop_reason": "end_turn",
    "stop_sequence": None,
    "usage": {"input_tokens": 3, "output_tokens": 1},
}
HI = [{"role": "user", "content": "hi"}]
CHAT_KW: dict[str, Any] = {"model": "gpt-4o-mini", "messages": HI}
RESPONSES_KW: dict[str, Any] = {"model": "gpt-4o-mini", "input": "hi"}
MESSAGES_KW: dict[str, Any] = {"model": "claude-haiku-4-5", "max_tokens": 8, "messages": HI}


def _sse(events: list[tuple[str | None, Any]]) -> bytes:
    out = ""
    for name, data in events:
        if name:
            out += f"event: {name}\n"
        out += f"data: {data if isinstance(data, str) else json.dumps(data)}\n\n"
    return out.encode()


def _streams(request: httpx.Request) -> bool:
    return json.loads(request.content or b"{}").get("stream") is True


def _event_stream(body: bytes) -> httpx.Response:
    return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=body)


def _chat(request: httpx.Request) -> httpx.Response:
    if not _streams(request):
        return httpx.Response(200, json=CHAT)
    base = {"id": "c", "object": "chat.completion.chunk", "created": 1, "model": SERVED}
    chunks = [
        {**base, "choices": [{"index": 0, "delta": {"content": "Hi"}, "finish_reason": None}]},
        {**base, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]},
        {**base, "choices": [], "usage": CHAT["usage"]},
    ]
    return _event_stream(_sse([(None, c) for c in chunks] + [(None, "[DONE]")]))


def _responses(request: httpx.Request) -> httpx.Response:
    if not _streams(request):
        return httpx.Response(200, json=RESPONSE)
    started = {**RESPONSE, "status": "in_progress", "usage": None}
    return _event_stream(
        _sse(
            [
                (
                    "response.created",
                    {"type": "response.created", "sequence_number": 0, "response": started},
                ),
                (
                    "response.completed",
                    {"type": "response.completed", "sequence_number": 1, "response": RESPONSE},
                ),
            ]
        )
    )


def _messages(request: httpx.Request) -> httpx.Response:
    if not _streams(request):
        return httpx.Response(200, json=MESSAGE)
    start = {**MESSAGE, "content": [], "stop_reason": None}
    text = {"type": "text", "text": ""}
    delta = {"type": "text_delta", "text": "Hi"}
    end = {"stop_reason": "end_turn", "stop_sequence": None}
    return _event_stream(
        _sse(
            [
                ("message_start", {"type": "message_start", "message": start}),
                (
                    "content_block_start",
                    {"type": "content_block_start", "index": 0, "content_block": text},
                ),
                (
                    "content_block_delta",
                    {"type": "content_block_delta", "index": 0, "delta": delta},
                ),
                ("content_block_stop", {"type": "content_block_stop", "index": 0}),
                (
                    "message_delta",
                    {"type": "message_delta", "delta": end, "usage": {"output_tokens": 1}},
                ),
                ("message_stop", {"type": "message_stop"}),
            ]
        )
    )


@pytest.fixture
def router() -> Iterator[respx.MockRouter]:
    with respx.mock(assert_all_called=False) as mocked:
        mocked.post("https://api.openai.com/v1/chat/completions", name="chat").mock(
            side_effect=_chat
        )
        mocked.post("https://api.openai.com/v1/responses", name="responses").mock(
            side_effect=_responses
        )
        mocked.post("https://api.anthropic.com/v1/messages", name="messages").mock(
            side_effect=_messages
        )
        yield mocked


def _session() -> Session:
    config = SensorConfig(
        server="http://localhost:9999",
        token="tok",
        agent_flavor="stream-protocol",
        agent_type="production",
        quiet=True,
        capture_prompts=True,
    )
    client = MagicMock(spec=ControlPlaneClient)
    client.post_event.return_value = (None, False)
    session = Session(config=config, client=client, event_queue=MagicMock())
    session.policy = PolicyCache(token_limit=None, block_at_pct=100)
    return session


@pytest.fixture
def sensor(monkeypatch: pytest.MonkeyPatch) -> Iterator[Callable[[bool], Session | None]]:
    """``sensor(True)`` installs a session and patches both SDKs;
    ``sensor(False)`` leaves them as the SDKs ship."""

    def _set(on: bool) -> Session | None:
        unpatch_anthropic_classes()
        unpatch_openai_classes()
        if not on:
            monkeypatch.setattr(flightdeck_sensor, "_session", None)
            return None
        session = _session()
        monkeypatch.setattr(flightdeck_sensor, "_session", session)
        patch_anthropic_classes(quiet=True)
        patch_openai_classes(quiet=True)
        return session

    yield _set
    unpatch_anthropic_classes()
    unpatch_openai_classes()


def _client(sdk: str, is_async: bool) -> Any:
    if sdk == "anthropic":
        cls: Any = anthropic.AsyncAnthropic if is_async else anthropic.Anthropic
    else:
        cls = openai.AsyncOpenAI if is_async else openai.OpenAI
    return cls(api_key="k", max_retries=0)


# name -> (sdk, the call, what the caller does with its result)
_PATHS: dict[str, tuple[str, Callable[[Any], Any], str]] = {
    "chat.completions.stream": (
        "openai",
        lambda c: c.chat.completions.stream(**CHAT_KW),
        "manager",
    ),
    "responses.stream": ("openai", lambda c: c.responses.stream(**RESPONSES_KW), "manager"),
    "chat.completions.create(stream=True)": (
        "openai",
        lambda c: c.chat.completions.create(**CHAT_KW, stream=True),
        "stream",
    ),
    "responses.create(stream=True)": (
        "openai",
        lambda c: c.responses.create(**RESPONSES_KW, stream=True),
        "stream",
    ),
    "chat.completions.with_raw_response.create": (
        "openai",
        lambda c: c.chat.completions.with_raw_response.create(**CHAT_KW),
        "raw",
    ),
    "chat.completions.with_raw_response.create(stream=True)": (
        "openai",
        lambda c: c.chat.completions.with_raw_response.create(**CHAT_KW, stream=True),
        "raw-stream",
    ),
    "client.with_raw_response.chat.completions.create(stream=True)": (
        "openai",
        lambda c: c.with_raw_response.chat.completions.create(**CHAT_KW, stream=True),
        "raw-stream",
    ),
    "chat.completions.with_streaming_response.create": (
        "openai",
        lambda c: c.chat.completions.with_streaming_response.create(**CHAT_KW),
        "view",
    ),
    "chat.completions.with_streaming_response.create(stream=True)": (
        "openai",
        lambda c: c.chat.completions.with_streaming_response.create(**CHAT_KW, stream=True),
        "view-stream",
    ),
    "responses.with_streaming_response.create(stream=True)": (
        "openai",
        lambda c: c.responses.with_streaming_response.create(**RESPONSES_KW, stream=True),
        "view-stream",
    ),
    "messages.stream": ("anthropic", lambda c: c.messages.stream(**MESSAGES_KW), "manager"),
    "beta.messages.stream": (
        "anthropic",
        lambda c: c.beta.messages.stream(**MESSAGES_KW),
        "manager",
    ),
    "messages.create(stream=True)": (
        "anthropic",
        lambda c: c.messages.create(**MESSAGES_KW, stream=True),
        "stream",
    ),
    "messages.with_raw_response.create": (
        "anthropic",
        lambda c: c.messages.with_raw_response.create(**MESSAGES_KW),
        "raw",
    ),
    "messages.with_raw_response.create(stream=True)": (
        "anthropic",
        lambda c: c.messages.with_raw_response.create(**MESSAGES_KW, stream=True),
        "raw-stream",
    ),
    "messages.with_streaming_response.create": (
        "anthropic",
        lambda c: c.messages.with_streaming_response.create(**MESSAGES_KW),
        "view",
    ),
    "messages.with_streaming_response.create(stream=True)": (
        "anthropic",
        lambda c: c.messages.with_streaming_response.create(**MESSAGES_KW, stream=True),
        "view-stream",
    ),
}
if hasattr(getattr(openai.OpenAI(api_key="k").beta, "chat", None), "completions"):
    # The beta chat stream helper, on the releases that still have it.
    _PATHS["beta.chat.completions.stream"] = (
        "openai",
        lambda c: c.beta.chat.completions.stream(**CHAT_KW),
        "manager",
    )
_MANAGERS = sorted(name for name, (_sdk, _call, how) in _PATHS.items() if how == "manager")


def _protocol(obj: Any) -> dict[str, tuple[bool, bool]]:
    return {name: (hasattr(obj, name), hasattr(type(obj), name)) for name in PROTOCOL}


async def _resolve(value: Any) -> Any:
    return await value if inspect.isawaitable(value) else value


async def _drain(stream: Any) -> None:
    if hasattr(type(stream), "__aiter__"):
        async for _ in stream:
            pass
    else:
        for _ in stream:
            pass


async def _stages(name: str, is_async: bool) -> list[tuple[str, dict[str, tuple[bool, bool]]]]:
    """Each stage's protocol, using the result as its caller would."""
    sdk, call, how = _PATHS[name]
    made = call(_client(sdk, is_async))
    seen = [("call", _protocol(made))]
    if how in ("manager", "view", "view-stream"):
        if is_async:
            async with made as entered:
                seen.append(("entered", _protocol(entered)))
                await _use(entered, how, seen)
        else:
            with made as entered:
                seen.append(("entered", _protocol(entered)))
                await _use(entered, how, seen)
        return seen
    result = await _resolve(made)
    seen.append(("awaited", _protocol(result)))
    if how == "stream":
        await _drain(result)
    else:
        parsed = await _resolve(result.parse())
        seen.append(("parsed", _protocol(parsed)))
        if how == "raw-stream":
            await _drain(parsed)
    return seen


async def _use(entered: Any, how: str, seen: list[Any]) -> None:
    if how == "manager":
        await _drain(entered)
        return
    parsed = await _resolve(entered.parse())
    seen.append(("parsed", _protocol(parsed)))
    if how == "view-stream":
        await _drain(parsed)


@pytest.mark.parametrize("is_async", [False, True], ids=["sync", "async"])
@pytest.mark.parametrize("name", sorted(_PATHS))
# Every stage is used to its end, so a coroutine left unawaited fails the row.
@pytest.mark.filterwarnings("error::RuntimeWarning")
@pytest.mark.filterwarnings("error::pytest.PytestUnraisableExceptionWarning")
def test_each_stage_has_the_protocol_of_the_sdk_object(
    name: str,
    is_async: bool,
    router: respx.MockRouter,
    sensor: Callable[[bool], Session | None],
) -> None:
    sensor(False)
    expected = asyncio.run(_stages(name, is_async))
    sensor(True)
    assert asyncio.run(_stages(name, is_async)) == expected


def _raised(fn: Callable[[], Any]) -> tuple[str, str] | None:
    try:
        fn()
    except Exception as exc:
        return type(exc).__name__, str(exc)
    return None


async def _async_with(manager: Any) -> None:
    async with manager:
        pass


def _with(manager: Any) -> None:
    with manager:
        pass


async def _async_for(manager: Any) -> None:
    async for _ in manager:
        pass


# What a caller can get wrong with a manager: the other client kind's
# context protocol, or iterating it before entering it.
_MISUSES: dict[str, Callable[[Any, bool], Any]] = {
    "the other client kind's with": lambda m, is_async: (
        _with(m) if is_async else asyncio.run(_async_with(m))
    ),
    "iterating before entering": lambda m, is_async: (
        asyncio.run(_async_for(m)) if is_async else list(m)
    ),
}


# An async client's manager made and never entered leaves the coroutine
# the SDK built for its request unawaited, with or without the sensor.
_UNENTERED_ASYNC_MANAGER = [
    pytest.mark.filterwarnings("ignore:coroutine .* was never awaited:RuntimeWarning"),
    pytest.mark.filterwarnings("ignore::pytest.PytestUnraisableExceptionWarning"),
]


@pytest.mark.parametrize("misuse", sorted(_MISUSES))
@pytest.mark.parametrize("is_async", [False, True], ids=["sync", "async"])
@pytest.mark.parametrize("name", _MANAGERS)
@_UNENTERED_ASYNC_MANAGER[0]
@_UNENTERED_ASYNC_MANAGER[1]
def test_a_misused_manager_raises_what_the_sdk_manager_raises_and_sends_nothing(
    name: str,
    is_async: bool,
    misuse: str,
    router: respx.MockRouter,
    sensor: Callable[[bool], Session | None],
) -> None:
    """``async with`` on a sync client's manager, ``with`` on an async
    one's, and iterating a manager before entering it raise the same
    exception, with the same message, as on the SDK's manager, and no
    request leaves."""
    sdk, call, _how = _PATHS[name]
    outcomes = []
    for on in (False, True):
        sensor(on)
        manager = call(_client(sdk, is_async))
        outcomes.append(_raised(lambda m=manager: _MISUSES[misuse](m, is_async)))
    assert outcomes[0] is not None
    assert outcomes[1] == outcomes[0]
    assert all(route.call_count == 0 for route in router.routes)


@pytest.mark.parametrize("misuse", [None, *sorted(_MISUSES)])
@pytest.mark.parametrize("is_async", [False, True], ids=["sync", "async"])
@pytest.mark.parametrize("name", _MANAGERS)
@_UNENTERED_ASYNC_MANAGER[0]
@_UNENTERED_ASYNC_MANAGER[1]
def test_block_refuses_every_form_of_a_stream_helper_before_any_request(
    name: str,
    is_async: bool,
    misuse: str | None,
    router: respx.MockRouter,
    sensor: Callable[[bool], Session | None],
) -> None:
    """A BLOCK decision stops a stream helper used the right way and
    every misuse of its manager with no request sent: at the call
    (Anthropic, whose ``stream()`` is checked when called) or at entry
    (OpenAI, whose manager builds its request then); a misuse the
    interpreter refuses first sends nothing either."""
    session = sensor(True)
    assert session is not None
    session.policy = PolicyCache(token_limit=100, block_at_pct=50)
    session._tokens_used = 90
    sdk, call, _how = _PATHS[name]

    def use() -> None:
        manager = call(_client(sdk, is_async))
        if misuse is not None:
            _MISUSES[misuse](manager, is_async)
        elif is_async:
            asyncio.run(_async_with(manager))
        else:
            _with(manager)

    with pytest.raises((BudgetExceededError, TypeError)) as raised:
        use()
    if misuse is None:
        assert raised.type is BudgetExceededError
    assert all(route.call_count == 0 for route in router.routes)
