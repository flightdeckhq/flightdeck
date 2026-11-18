"""Every object the sensor hands a caller of a stream helper, a streamed
call or a raw / streaming view has the protocol of the SDK object it
stands for, at each stage: the call's result, what entering it gives and
what ``parse()`` gives. OpenAI and Anthropic (every path below), litellm
(``completion`` / ``acompletion`` with ``stream=True``) and google-genai
(``generate_content_stream``).

A protocol is the presence of ``__enter__`` / ``__exit__``,
``__aenter__`` / ``__aexit__``, ``__iter__`` / ``__next__``,
``__aiter__`` / ``__anext__`` and ``__await__``, on the object and on its
class (the interpreter looks a protocol up on the class), and what
``copy.copy``, ``copy.deepcopy`` and ``pickle.dumps`` do with the object
(work, or raise which exception). A stream helper's manager (OpenAI
``chat.completions.stream()`` / ``responses.stream()``, Anthropic
``messages.stream()``) is also named as the SDK's class, so a misuse
(``async with`` on a sync manager, iterating a manager before entering
it) raises the exception the SDK's manager raises, at the same moment;
the message is the same word for word where Python names a class without
its module (3.11 to 3.13).

Driven with the real SDK clients over fake transports; the oracle is the
same call without the sensor, in the same environment.
"""

from __future__ import annotations

import asyncio
import copy
import gc
import inspect
import json
import pickle
import sys
import warnings
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


def _outcome(fn: Callable[[], Any]) -> str:
    """``"works"``, or the type of the exception ``fn`` raises."""
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            fn()
    except Exception as exc:
        return type(exc).__name__
    return "works"


def _copying(obj: Any) -> dict[str, str]:
    """What copying and pickling ``obj`` do."""
    return {
        "copy": _outcome(lambda: copy.copy(obj)),
        "deepcopy": _outcome(lambda: copy.deepcopy(obj)),
        "pickle": _outcome(lambda: pickle.dumps(obj)),
    }


async def _resolve(value: Any) -> Any:
    return await value if inspect.isawaitable(value) else value


async def _drain(stream: Any) -> None:
    if hasattr(type(stream), "__aiter__"):
        async for _ in stream:
            pass
    else:
        for _ in stream:
            pass


async def _stages(
    name: str, is_async: bool, probe: Callable[[Any], Any] = _protocol
) -> list[tuple[str, Any]]:
    """``probe`` of each stage, using the result as its caller would."""
    sdk, call, how = _PATHS[name]
    made = call(_client(sdk, is_async))
    seen = [("call", probe(made))]
    if how in ("manager", "view", "view-stream"):
        if is_async:
            async with made as entered:
                seen.append(("entered", probe(entered)))
                await _use(entered, how, seen, probe)
        else:
            with made as entered:
                seen.append(("entered", probe(entered)))
                await _use(entered, how, seen, probe)
        return seen
    result = await _resolve(made)
    seen.append(("awaited", probe(result)))
    if how == "stream":
        await _drain(result)
    else:
        parsed = await _resolve(result.parse())
        seen.append(("parsed", probe(parsed)))
        if how == "raw-stream":
            await _drain(parsed)
    return seen


async def _use(entered: Any, how: str, seen: list[Any], probe: Callable[[Any], Any]) -> None:
    if how == "manager":
        await _drain(entered)
        return
    parsed = await _resolve(entered.parse())
    seen.append(("parsed", probe(parsed)))
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


# A deep copy of an SDK object that holds a client builds part of the
# client before it fails; that part's finalizer then complains, with or
# without the sensor.
_PARTIAL_COPIES = [
    pytest.mark.filterwarnings("ignore::pytest.PytestUnraisableExceptionWarning"),
    pytest.mark.filterwarnings("ignore::RuntimeWarning"),
]


@pytest.mark.parametrize("is_async", [False, True], ids=["sync", "async"])
@pytest.mark.parametrize("name", sorted(_PATHS))
@_PARTIAL_COPIES[0]
@_PARTIAL_COPIES[1]
def test_each_stage_copies_and_pickles_as_the_sdk_object(
    name: str,
    is_async: bool,
    router: respx.MockRouter,
    sensor: Callable[[bool], Session | None],
    unentered_managers_collected: None,
) -> None:
    """A shallow copy works and a deep copy or a pickle raises the same
    exception type, as for the SDK object; the sensor's copy is the
    object itself, so the call is still metered once.

    One stage differs and is pinned as it is: an OpenAI sync client's
    streaming view returns the SDK's own ``ResponseContextManager``, which
    holds the request function it will call. Without the sensor that is
    the resource's bound method, whose deep copy and pickle reach the
    client and raise ``TypeError``; with the sensor it is the proxy's
    method, a plain function shaped like the SDK's (its name, qualified
    name and module), which ``copy`` treats as atomic and ``pickle``
    looks up by that name, finding the SDK's function instead."""
    sensor(False)
    expected = asyncio.run(_stages(name, is_async, _copying))
    session = sensor(True)
    got = asyncio.run(_stages(name, is_async, _copying))
    if "with_streaming_response" in name and not is_async and _PATHS[name][0] == "openai":
        assert got[0] == ("call", {"copy": "works", "deepcopy": "works", "pickle": "PicklingError"})
        assert expected[0] == (
            "call",
            {"copy": "works", "deepcopy": "TypeError", "pickle": "TypeError"},
        )
        got, expected = got[1:], expected[1:]
    assert got == expected
    assert session is not None
    calls = [
        c.args[0]["event_type"]
        for c in session.event_queue.enqueue.call_args_list  # type: ignore[attr-defined]
        if c.args[0]["event_type"] in ("post_call", "llm_error")
    ]
    assert calls == ["post_call"]


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


# An async client's manager made and never entered leaves one coroutine
# unawaited: the SDK's own request without the sensor (``AsyncCompletions
# .create`` / ``AsyncResponses.create`` for OpenAI, ``AsyncAPIClient.post``
# for Anthropic); with the sensor, Anthropic's is the same SDK coroutine,
# and OpenAI's is the sensor's own ``create`` (``SessionProxy._call``),
# which would have made the SDK's.
_UNENTERED_ASYNC_MANAGER = [
    pytest.mark.filterwarnings("ignore:coroutine .* was never awaited:RuntimeWarning"),
    pytest.mark.filterwarnings("ignore::pytest.PytestUnraisableExceptionWarning"),
]


@pytest.fixture
def unentered_managers_collected() -> Iterator[None]:
    """Collect the managers a test made and never entered before it ends.
    A manager held in a reference cycle (an exception's traceback) is
    otherwise collected in a later test, whose own filter can turn the
    "never awaited" RuntimeWarning of its coroutine into an error."""
    yield
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        gc.collect()


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
    unentered_managers_collected: None,
) -> None:
    """``async with`` on a sync client's manager, ``with`` on an async
    one's, and iterating a manager before entering it raise the same
    exception type as on the SDK's manager, at the same moment (the call
    returns, the misuse raises), and no request leaves. The message is the
    same word for word below Python 3.14; 3.14 prints the class with its
    module, which is the sensor's for the sensor's manager."""
    sdk, call, _how = _PATHS[name]
    outcomes = []
    for on in (False, True):
        sensor(on)
        manager = call(_client(sdk, is_async))
        outcomes.append(_raised(lambda m=manager: _MISUSES[misuse](m, is_async)))
    assert outcomes[0] is not None
    assert outcomes[1] is not None
    assert outcomes[1][0] == outcomes[0][0]
    if sys.version_info < (3, 14):
        assert outcomes[1][1] == outcomes[0][1]
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
    unentered_managers_collected: None,
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


# ----- litellm and google-genai -------------------------------------------------------


@pytest.fixture
def litellm_sensor(
    sensor: Callable[[bool], Session | None],
) -> Iterator[Callable[[bool], Session | None]]:
    """As :func:`sensor`, with litellm's functions patched too."""
    pytest.importorskip("litellm")
    from flightdeck_sensor.interceptor.litellm import (
        patch_litellm_functions,
        unpatch_litellm_functions,
    )

    def _set(on: bool) -> Session | None:
        unpatch_litellm_functions()
        session = sensor(on)
        if on:
            patch_litellm_functions(quiet=True)
        return session

    yield _set
    unpatch_litellm_functions()


def _litellm_stream(is_async: bool) -> Any:
    """``litellm.completion`` / ``acompletion`` with ``stream=True`` through
    an OpenAI client over the fake transport."""
    litellm = pytest.importorskip("litellm")
    if is_async:
        return litellm.acompletion(
            **CHAT_KW, stream=True, client=openai.AsyncOpenAI(api_key="k", max_retries=0)
        )
    return litellm.completion(
        **CHAT_KW, stream=True, client=openai.OpenAI(api_key="k", max_retries=0)
    )


async def _litellm_read(is_async: bool, how: str) -> tuple[Any, Any, Any]:
    """The stream's protocol and copying, and what reading it ``how``
    gives: its text, or the exception's type."""
    stream = await _resolve(_litellm_stream(is_async))
    seen = (_protocol(stream), _copying(stream))
    text = []
    try:
        if how == "for":
            for chunk in stream:
                text.append(_delta_text(chunk))
        else:
            async for chunk in stream:
                text.append(_delta_text(chunk))
    except Exception as exc:
        return (*seen, ("raised", type(exc).__name__))
    return (*seen, ("read", "".join(text)))


def _delta_text(chunk: Any) -> str:
    choices = getattr(chunk, "choices", None) or []
    return (getattr(choices[0].delta, "content", None) or "") if choices else ""


def _call_events(session: Session) -> list[str]:
    calls = session.event_queue.enqueue.call_args_list  # type: ignore[attr-defined]
    return [c.args[0]["event_type"] for c in calls if c.args[0]["event_type"] != "pre_call"]


@pytest.mark.parametrize("how", ["for", "async for"])
@pytest.mark.parametrize("is_async", [False, True], ids=["completion", "acompletion"])
@_PARTIAL_COPIES[0]
@_PARTIAL_COPIES[1]
def test_a_litellm_stream_has_the_protocol_of_litellms_and_reads_either_way_as_it(
    is_async: bool,
    how: str,
    router: respx.MockRouter,
    litellm_sensor: Callable[[bool], Session | None],
    unentered_managers_collected: None,
) -> None:
    """litellm's ``CustomStreamWrapper`` iterates both ways and is no
    context manager, whichever call made it; the stream the sensor
    returns has that protocol, copies and pickles as it does, and read
    either way gives what reading litellm's own gives (its text, or the
    same exception), reported once."""
    litellm_sensor(False)
    expected = asyncio.run(_litellm_read(is_async, how))
    session = litellm_sensor(True)
    assert session is not None
    got = asyncio.run(_litellm_read(is_async, how))
    assert got == expected
    events = _call_events(session)
    assert len(events) == 1, events
    assert events[0] == ("post_call" if got[2][0] == "read" else "llm_error")


@pytest.mark.parametrize("is_async", [False, True], ids=["completion", "acompletion"])
def test_block_refuses_a_litellm_stream_before_any_request(
    is_async: bool,
    router: respx.MockRouter,
    litellm_sensor: Callable[[bool], Session | None],
) -> None:
    session = litellm_sensor(True)
    assert session is not None
    session.policy = PolicyCache(token_limit=100, block_at_pct=50)
    session._tokens_used = 90
    with pytest.raises(BudgetExceededError):
        asyncio.run(_resolve(_litellm_stream(is_async)))
    assert all(route.call_count == 0 for route in router.routes)


def _gemini(request: httpx.Request) -> httpx.Response:
    chunk = {
        "candidates": [
            {"content": {"role": "model", "parts": [{"text": "Hi"}]}, "finishReason": "STOP"}
        ],
        "usageMetadata": {"promptTokenCount": 3, "candidatesTokenCount": 1, "totalTokenCount": 4},
        "modelVersion": "gemini-2.5-flash",
    }
    return httpx.Response(
        200,
        headers={"content-type": "text/event-stream"},
        content=f"data: {json.dumps(chunk)}\n\n".encode(),
    )


@pytest.mark.parametrize("is_async", [False, True], ids=["sync", "async"])
@_PARTIAL_COPIES[0]
@_PARTIAL_COPIES[1]
def test_a_google_genai_stream_has_the_protocol_of_the_sdks(
    is_async: bool,
    monkeypatch: pytest.MonkeyPatch,
    unentered_managers_collected: None,
) -> None:
    """google-genai's ``generate_content_stream`` hands back the SDK's own
    generator (the sensor guards the request beneath it): the same
    protocol and copying, read as without the sensor."""
    genai = pytest.importorskip("google.genai")
    from google.genai import types

    from flightdeck_sensor.interceptor import google_genai

    transport = httpx.MockTransport(_gemini)
    options = types.HttpOptions(
        httpx_client=httpx.Client(transport=transport),
        httpx_async_client=httpx.AsyncClient(transport=transport),
    )

    async def read() -> tuple[Any, Any, str]:
        client = genai.Client(api_key="k", http_options=options)
        if is_async:
            stream = await client.aio.models.generate_content_stream(
                model="gemini-2.5-flash", contents="hi"
            )
            seen = (_protocol(stream), _copying(stream))
            text = [chunk.text or "" async for chunk in stream]
        else:
            stream = client.models.generate_content_stream(model="gemini-2.5-flash", contents="hi")
            seen = (_protocol(stream), _copying(stream))
            text = [chunk.text or "" for chunk in stream]
        return (*seen, "".join(text))

    monkeypatch.setattr(flightdeck_sensor, "_session", None)
    expected = asyncio.run(read())
    session = _session()
    monkeypatch.setattr(flightdeck_sensor, "_session", session)
    google_genai.patch_google_genai(quiet=True)
    try:
        got = asyncio.run(read())
    finally:
        google_genai.unpatch_google_genai()
    assert got == expected
    assert _call_events(session) == ["post_call"]
