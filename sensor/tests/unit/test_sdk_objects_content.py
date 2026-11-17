"""SDK objects a caller hands back as a call's arguments are stored as the
JSON the provider received.

A tool-use loop appends the model's reply to the conversation as the SDK
returned it: an OpenAI ``ChatCompletionMessage`` (with its tool call
objects), Responses output items passed back as ``input``, Anthropic
``Message.content`` blocks. The SDK writes such a pydantic model into the
request as its JSON dump of the fields that were set; content capture
stores that JSON, the estimate counts it, and the SDK still gets the
caller's own objects (ARCHITECTURE.md, the content capture section).

Each row drives a real SDK client over respx, the reply objects coming
from the same SDK parsing a mocked response, so their set fields are
those a real reply has. The rows cover each object kind once per
provider path (the content, the estimate and the hand-over to the SDK go
through one code path, ``base.materialise_iterators``, for every entry
point); sync and async, and one streamed call per provider, check that the
async and stream intercepts reach it too. The oracle is the request the
mocked provider received, in the same environment, so a row holds for the
SDK release the lane installs (anthropic 0.86 writes a model by field
name, 2.x by alias).
"""

from __future__ import annotations

import asyncio
import json
from typing import TYPE_CHECKING, Any

import anthropic
import httpx
import openai
import pydantic
import pytest

from flightdeck_sensor.interceptor import base
from flightdeck_sensor.transport.body_limit import serialize_event

from .test_one_shot_iterables import (
    ANTHROPIC_MODEL,
    OPENAI_MODEL,
    _client,
    _events,
    _finish,
    _sensored,
    provider,  # noqa: F401 (the fixture)
)

if TYPE_CHECKING:
    import pathlib
    from collections.abc import Callable

    import respx

    from flightdeck_sensor.core.session import Session

pytestmark = [
    pytest.mark.filterwarnings("error::RuntimeWarning"),
    pytest.mark.filterwarnings("error::pytest.PytestUnraisableExceptionWarning"),
]

PROMPT = "SECRET-PROMPT-sdk-objects-3f9a: what is the weather in Paris?"

# Replies as the APIs send them, explicit nulls included: the reply
# objects' set fields, and so what the SDK sends back, follow them.
CHAT_TOOL_REPLY = {
    "id": "chatcmpl-1",
    "object": "chat.completion",
    "created": 1,
    "model": OPENAI_MODEL,
    "choices": [
        {
            "index": 0,
            "finish_reason": "tool_calls",
            "logprobs": None,
            "message": {
                "role": "assistant",
                "content": None,
                "refusal": None,
                "annotations": [],
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
    "usage": {"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5},
    "system_fingerprint": None,
}
RESPONSES_TOOL_REPLY = {
    "id": "resp_1",
    "object": "response",
    "created_at": 1,
    "model": OPENAI_MODEL,
    "status": "completed",
    "output": [
        {"type": "reasoning", "id": "rs_1", "summary": [{"type": "summary_text", "text": "hm"}]},
        {
            "type": "function_call",
            "id": "fc_1",
            "call_id": "call_1",
            "name": "get_weather",
            "arguments": '{"city": "Paris"}',
            "status": "completed",
        },
        {
            "type": "message",
            "id": "msg_1",
            "status": "completed",
            "role": "assistant",
            "content": [{"type": "output_text", "text": "Checking", "annotations": []}],
        },
    ],
    "usage": {"input_tokens": 3, "output_tokens": 2, "total_tokens": 5},
    "parallel_tool_calls": True,
    "tool_choice": "auto",
    "tools": [],
}
ANTHROPIC_TOOL_REPLY = {
    "id": "msg_1",
    "type": "message",
    "role": "assistant",
    "model": ANTHROPIC_MODEL,
    "content": [
        {"type": "thinking", "thinking": "The user wants weather", "signature": "sig_1"},
        {"type": "text", "text": "Let me check", "citations": None},
        {"type": "tool_use", "id": "toolu_1", "name": "get_weather", "input": {"city": "Paris"}},
        {
            "type": "server_tool_use",
            "id": "srvtoolu_1",
            "name": "web_search",
            "input": {"query": "Paris weather"},
        },
        {
            "type": "web_search_tool_result",
            "tool_use_id": "srvtoolu_1",
            "content": [
                {
                    "type": "web_search_result",
                    "url": "https://example.com/paris",
                    "title": "Paris",
                    "encrypted_content": "enc",
                    "page_age": None,
                }
            ],
        },
    ],
    "stop_reason": "tool_use",
    "stop_sequence": None,
    "usage": {"input_tokens": 3, "output_tokens": 2},
}


class UserMessage(pydantic.BaseModel):
    """A caller's own model given as a message, with a field under an
    alias: the SDKs write it by field name, anthropic 2.x by alias."""

    model_config = pydantic.ConfigDict(populate_by_name=True)
    role: str
    text_: str = pydantic.Field(alias="content")


@pytest.fixture
def replies(provider: respx.MockRouter) -> dict[str, Any]:  # noqa: F811
    """Reply objects as the SDKs parse them from a tool-use reply."""
    routes = {name: provider.routes[name] for name in ("chat", "responses", "anthropic")}
    saved = {name: route.side_effect for name, route in routes.items()}
    saved_returns = {name: route.return_value for name, route in routes.items()}
    try:
        for name, body in (
            ("chat", CHAT_TOOL_REPLY),
            ("responses", RESPONSES_TOOL_REPLY),
            ("anthropic", ANTHROPIC_TOOL_REPLY),
        ):
            routes[name].side_effect = None
            routes[name].return_value = httpx.Response(200, json=body)
        oa, an = _client("openai", False), _client("anthropic", False)
        question = [{"role": "user", "content": PROMPT}]
        chat = oa.chat.completions.create(model=OPENAI_MODEL, messages=question)
        responses = oa.responses.create(model=OPENAI_MODEL, input=PROMPT)
        message = an.messages.create(model=ANTHROPIC_MODEL, max_tokens=10, messages=question)
        beta = an.beta.messages.create(model=ANTHROPIC_MODEL, max_tokens=10, messages=question)
    finally:
        for name, route in routes.items():
            route.return_value = saved_returns[name]
            route.side_effect = saved[name]
    return {
        "chat message": chat.choices[0].message,
        "responses output": list(responses.output),
        "anthropic content": list(message.content),
        "beta content": list(beta.content),
    }


# row -> (sdk, route, the argument stored, the call's arguments from the
# reply objects)
Row = tuple[str, str, str, "Callable[[dict[str, Any]], dict[str, Any]]"]
ROWS: dict[str, Row] = {
    "openai chat: the reply ChatCompletionMessage with its tool calls": (
        "openai",
        "chat",
        "messages",
        lambda r: {
            "model": OPENAI_MODEL,
            "messages": [
                {"role": "user", "content": PROMPT},
                r["chat message"],
                {"role": "tool", "tool_call_id": "call_1", "content": "sunny"},
            ],
        },
    ),
    "openai chat: the reply's tool call objects in a dict message": (
        "openai",
        "chat",
        "messages",
        lambda r: {
            "model": OPENAI_MODEL,
            "messages": [
                {"role": "user", "content": PROMPT},
                {"role": "assistant", "tool_calls": r["chat message"].tool_calls},
                {"role": "tool", "tool_call_id": "call_1", "content": "sunny"},
            ],
        },
    ),
    "openai chat: a caller's model": (
        "openai",
        "chat",
        "messages",
        lambda r: {"model": OPENAI_MODEL, "messages": [UserMessage(role="user", content=PROMPT)]},
    ),
    "openai chat: a left-out value inside a message": (
        "openai",
        "chat",
        "messages",
        lambda r: {
            "model": OPENAI_MODEL,
            "messages": [{"role": "user", "content": PROMPT, "name": openai.NOT_GIVEN}],
        },
    ),
    "openai responses: output items passed back as input": (
        "openai",
        "responses",
        "input",
        lambda r: {
            "model": OPENAI_MODEL,
            "input": [
                {"role": "user", "content": PROMPT},
                *r["responses output"],
                {"type": "function_call_output", "call_id": "call_1", "output": "sunny"},
            ],
        },
    ),
    "anthropic: the reply's content blocks": (
        "anthropic",
        "anthropic",
        "messages",
        lambda r: {
            "model": ANTHROPIC_MODEL,
            "max_tokens": 10,
            "messages": [
                {"role": "user", "content": PROMPT},
                {"role": "assistant", "content": r["anthropic content"]},
                {
                    "role": "user",
                    "content": [{"type": "tool_result", "tool_use_id": "toolu_1", "content": "ok"}],
                },
            ],
        },
    ),
    "anthropic: a caller's model": (
        "anthropic",
        "anthropic",
        "messages",
        lambda r: {
            "model": ANTHROPIC_MODEL,
            "max_tokens": 10,
            "messages": [UserMessage(role="user", content=PROMPT)],
        },
    ),
    "anthropic: a left-out value inside a message": (
        "anthropic",
        "anthropic",
        "messages",
        lambda r: {
            "model": ANTHROPIC_MODEL,
            "max_tokens": 10,
            "messages": [{"role": "user", "content": PROMPT, "name": anthropic.NOT_GIVEN}],
        },
    ),
}
BETA_ROW = "anthropic beta: the reply's beta content blocks"


def _call(sdk: str, route: str, kwargs: dict[str, Any], *, beta: bool = False) -> Any:
    def make(client: Any) -> Any:
        if sdk == "anthropic":
            return (client.beta.messages if beta else client.messages).create(**kwargs)
        if route == "responses":
            return client.responses.create(**kwargs)
        return client.chat.completions.create(**kwargs)

    return make


def _sent(router: respx.MockRouter, route: str) -> dict[str, Any]:
    body: dict[str, Any] = json.loads(router.routes[route].calls.last.request.content)
    return body


def _on_the_wire(session: Session) -> list[dict[str, Any]]:
    """The session's call events as the transport writes them."""
    kinds = ("pre_call", "post_call", "llm_error")
    return [
        json.loads(serialize_event(dict(event)))
        for event in _events(session)
        if event["event_type"] in kinds
    ]


def _run(
    router: respx.MockRouter,
    monkeypatch: pytest.MonkeyPatch,
    sdk: str,
    route: str,
    make: Callable[[Any], Any],
    *,
    is_async: bool,
    capture: bool,
) -> tuple[dict[str, Any], dict[str, Any], list[dict[str, Any]]]:
    """The unsensored request, the sensored one, and the sensored call's
    events on the wire."""
    _finish(make(_client(sdk, is_async)), is_async)
    unsensored = _sent(router, route)
    session, client = _sensored("patched", sdk, is_async, monkeypatch, capture=capture)
    _finish(make(client), is_async)
    return unsensored, _sent(router, route), _on_the_wire(session)


def _stored(events: list[dict[str, Any]], field: str) -> Any:
    (post_call,) = [e for e in events if e["event_type"] == "post_call"]
    assert post_call.get("has_content") is True
    return post_call["content"][field]


@pytest.mark.parametrize("is_async", [False, True], ids=["sync", "async"])
@pytest.mark.parametrize("name", [*sorted(ROWS), BETA_ROW])
def test_an_sdk_object_is_stored_as_the_json_the_provider_received(
    provider: respx.MockRouter,  # noqa: F811
    replies: dict[str, Any],
    monkeypatch: pytest.MonkeyPatch,
    name: str,
    is_async: bool,
) -> None:
    if name == BETA_ROW:
        sdk, route, field, build = ROWS["anthropic: the reply's content blocks"]
        kwargs = build({**replies, "anthropic content": replies["beta content"]})
        make = _call(sdk, route, kwargs, beta=True)
    else:
        sdk, route, field, build = ROWS[name]
        make = _call(sdk, route, build(replies))
    unsensored, sensored, events = _run(
        provider, monkeypatch, sdk, route, make, is_async=is_async, capture=True
    )
    assert sensored == unsensored
    assert _stored(events, field) == sensored[field]


@pytest.mark.parametrize("name", sorted(ROWS))
def test_with_capture_off_an_sdk_object_is_sent_and_nothing_is_stored(
    provider: respx.MockRouter,  # noqa: F811
    replies: dict[str, Any],
    monkeypatch: pytest.MonkeyPatch,
    name: str,
) -> None:
    sdk, route, _field, build = ROWS[name]
    unsensored, sensored, events = _run(
        provider,
        monkeypatch,
        sdk,
        route,
        _call(sdk, route, build(replies)),
        is_async=False,
        capture=False,
    )
    assert sensored == unsensored
    assert events
    assert not any(e.get("has_content") or e.get("content") for e in events)
    assert PROMPT not in json.dumps(events)


# A left-out value stays in the arguments the estimate reads (the
# tiktoken count adds the few tokens of its name); only content capture
# drops it, as the SDK does.
ESTIMATED_ROWS = sorted(name for name in ROWS if "left-out" not in name)


@pytest.mark.parametrize("name", ESTIMATED_ROWS)
def test_the_estimate_counts_what_is_stored(
    provider: respx.MockRouter,  # noqa: F811
    replies: dict[str, Any],
    monkeypatch: pytest.MonkeyPatch,
    name: str,
) -> None:
    """The estimate of a call holding SDK objects is that of the same call
    with the JSON the provider received in their place."""
    sdk, route, field, build = ROWS[name]
    kwargs = build(replies)
    _u, sent, events = _run(
        provider,
        monkeypatch,
        sdk,
        route,
        _call(sdk, route, kwargs),
        is_async=False,
        capture=False,
    )
    with_json = {**kwargs, field: sent[field]}
    _u2, _s2, json_events = _run(
        provider,
        monkeypatch,
        sdk,
        route,
        _call(sdk, route, with_json),
        is_async=False,
        capture=False,
    )

    def estimate(on_the_wire: list[dict[str, Any]]) -> Any:
        return [e["tokens_input"] for e in on_the_wire if e["event_type"] == "pre_call"]

    assert estimate(events) == estimate(json_events)


def test_a_streamed_call_stores_the_json_too(
    provider: respx.MockRouter,  # noqa: F811
    replies: dict[str, Any],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The stream intercepts read the arguments through the same code."""
    for name, stream in (
        ("openai chat: the reply ChatCompletionMessage with its tool calls", "create"),
        ("anthropic: the reply's content blocks", "stream"),
    ):
        sdk, route, field, build = ROWS[name]
        kwargs = build(replies)

        def make(client: Any, sdk: str = sdk, kwargs: dict[str, Any] = kwargs) -> Any:
            if sdk == "anthropic":
                return client.messages.stream(**kwargs)
            return client.chat.completions.create(**kwargs, stream=True)

        unsensored, sensored, events = _run(
            provider, monkeypatch, sdk, route, make, is_async=False, capture=True
        )
        unsensored.pop("stream_options", None)
        sensored.pop("stream_options", None)
        assert sensored == unsensored, stream
        assert _stored(events, field) == sensored[field]


def test_the_sdk_gets_the_callers_own_objects_unchanged(replies: dict[str, Any]) -> None:
    message = replies["chat message"]
    blocks = replies["anthropic content"]
    before = (message.model_dump(), [block.model_dump() for block in blocks])
    caller_messages = [{"role": "user", "content": PROMPT}, message]
    received: dict[str, Any] = {}
    kwargs = {"model": OPENAI_MODEL, "messages": caller_messages, "tools": blocks}
    arguments = base.materialise_iterators(
        kwargs, lambda **call_kwargs: received.update(call_kwargs), "openai"
    )
    assert arguments.kwargs is not kwargs
    arguments.send(**arguments.kwargs)
    assert received["messages"][1] is message
    assert all(sent is block for sent, block in zip(received["tools"], blocks, strict=True))
    assert caller_messages[1] is message
    assert (message.model_dump(), [block.model_dump() for block in blocks]) == before


def test_an_object_the_sdk_reads_itself_leaves_the_event_without_content(
    provider: respx.MockRouter,  # noqa: F811
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: pathlib.Path,
) -> None:
    """An image the SDK reads from a file and sends base64-encoded: the
    sensor does not read the caller's file, so it cannot store what was
    sent, and the event goes without its content, never with a string
    form of the path."""
    image = tmp_path / "pixel.png"
    image.write_bytes(b"\x89PNG not really")
    kwargs = {
        "model": ANTHROPIC_MODEL,
        "max_tokens": 10,
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {"type": "base64", "media_type": "image/png", "data": image},
                    },
                    {"type": "text", "text": PROMPT},
                ],
            }
        ],
    }
    unsensored, sensored, events = _run(
        provider,
        monkeypatch,
        "anthropic",
        "anthropic",
        _call("anthropic", "anthropic", kwargs),
        is_async=False,
        capture=True,
    )
    assert sensored == unsensored
    (post_call,) = [e for e in events if e["event_type"] == "post_call"]
    assert post_call.get("content") is None
    assert not post_call.get("has_content")
    assert str(image) not in json.dumps(events)
    assert "PosixPath" not in json.dumps(events)


def test_a_dumped_object_is_counted_by_each_estimate(
    provider: respx.MockRouter,  # noqa: F811
    replies: dict[str, Any],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The OpenAI estimate counts the reply message's tool call, which it
    skipped as an object it could not read."""
    sdk, route, _field, build = ROWS[
        "openai chat: the reply ChatCompletionMessage with its tool calls"
    ]
    kwargs = build(replies)
    without_reply = {**kwargs, "messages": [kwargs["messages"][0], kwargs["messages"][2]]}
    _u, _s, with_events = _run(
        provider, monkeypatch, sdk, route, _call(sdk, route, kwargs), is_async=False, capture=False
    )
    _u2, _s2, without_events = _run(
        provider,
        monkeypatch,
        sdk,
        route,
        _call(sdk, route, without_reply),
        is_async=False,
        capture=False,
    )

    def estimate(on_the_wire: list[dict[str, Any]]) -> int:
        (value,) = [e["tokens_input"] for e in on_the_wire if e["event_type"] == "pre_call"]
        return int(value)

    tool_call = json.dumps(kwargs["messages"][1].tool_calls[0].model_dump(mode="json"))
    assert estimate(with_events) - estimate(without_events) > len(tool_call) // 8


def test_an_object_that_fails_to_dump_is_never_stored_as_a_string(
    provider: respx.MockRouter,  # noqa: F811
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A model whose dump raises is left as it is: the SDK meets it as it
    would without the sensor, and the sensor stores no string form."""

    class Unwritable(pydantic.BaseModel):
        role: str

        def model_dump(self, **_kwargs: Any) -> Any:
            raise ValueError("cannot be dumped")

    message = Unwritable(role="user")
    kwargs = {"model": OPENAI_MODEL, "messages": [message]}
    arguments = base.materialise_iterators(kwargs, lambda **call_kwargs: call_kwargs, "openai")
    assert arguments.kwargs["messages"][0] is message
    assert base.as_received(arguments.kwargs)["messages"][0] is message


def test_an_async_call_is_read_when_it_is_awaited(
    replies: dict[str, Any],
) -> None:
    """Making an async call reads nothing; the objects are read when the
    call runs, as for an iterator."""
    message = replies["chat message"]
    seen: list[Any] = []

    async def real_fn(**kwargs: Any) -> None:
        seen.append(kwargs["messages"][0])

    from flightdeck_sensor.providers.openai import OpenAIProvider

    from .test_one_shot_iterables import _session

    session = _session(capture=True)
    pending = base.call_async(
        real_fn,
        {"model": OPENAI_MODEL, "messages": [message]},
        session,
        OpenAIProvider(capture_prompts=True),
    )
    asyncio.run(pending)
    assert seen == [message]
    assert seen[0] is message


@pytest.mark.parametrize("sdk", ["openai", "anthropic"])
def test_a_list_the_caller_appends_to_after_the_call_is_stored_as_it_was_sent(
    provider: respx.MockRouter,  # noqa: F811
    replies: dict[str, Any],
    monkeypatch: pytest.MonkeyPatch,
    sdk: str,
) -> None:
    """A tool-use loop appends the reply and the tool's result to the very
    list it sent; the event is written as JSON later, so the stored
    content must be the list as it was when the call was made."""
    route = "chat" if sdk == "openai" else "anthropic"
    conversation: list[Any] = [{"role": "user", "content": PROMPT}]
    session, client = _sensored("patched", sdk, False, monkeypatch, capture=True)
    if sdk == "openai":
        client.chat.completions.create(model=OPENAI_MODEL, messages=conversation)
        conversation.append(replies["chat message"])
        conversation.append({"role": "tool", "tool_call_id": "call_1", "content": "sunny"})
    else:
        client.messages.create(model=ANTHROPIC_MODEL, max_tokens=10, messages=conversation)
        conversation.append({"role": "assistant", "content": replies["anthropic content"]})
    sent = _sent(provider, route)["messages"]
    assert (
        _stored(_on_the_wire(session), "messages") == sent == [{"role": "user", "content": PROMPT}]
    )


def _changed(conversation: list[Any]) -> None:
    """What a caller may do to its conversation while a stream is open:
    edit a message in place and append another."""
    conversation[0]["content"] = "CHANGED WHILE STREAMING"
    conversation.append({"role": "user", "content": "APPENDED WHILE STREAMING"})


def _drain(stream: Any) -> None:
    for _ in stream:
        pass


async def _adrain(stream: Any) -> None:
    async for _ in stream:
        pass


def _stream_paths() -> dict[str, tuple[str, str, Callable[[Any, list[Any]], None]]]:
    """Streamed and deferred-view calls, each changing the conversation
    after the request went out and before the caller reads the result:
    path -> (sdk, route, the call)."""
    oa = {"model": OPENAI_MODEL}
    an = {"model": ANTHROPIC_MODEL, "max_tokens": 10}

    def oa_stream(client: Any, conversation: list[Any]) -> None:
        stream = client.chat.completions.create(**oa, messages=conversation, stream=True)
        _changed(conversation)
        _drain(stream)

    def oa_raw_stream(client: Any, conversation: list[Any]) -> None:
        raw = client.chat.completions.with_raw_response.create(
            **oa, messages=conversation, stream=True
        )
        _changed(conversation)
        _drain(raw.parse())

    def oa_streaming_view(client: Any, conversation: list[Any]) -> None:
        with client.chat.completions.with_streaming_response.create(
            **oa, messages=conversation
        ) as response:
            _changed(conversation)
            response.parse()

    def an_stream(client: Any, conversation: list[Any]) -> None:
        with client.messages.stream(**an, messages=conversation) as stream:
            _changed(conversation)
            _drain(stream)

    def an_create_stream(client: Any, conversation: list[Any]) -> None:
        stream = client.messages.create(**an, messages=conversation, stream=True)
        _changed(conversation)
        _drain(stream)

    def oa_async_stream(client: Any, conversation: list[Any]) -> None:
        async def run() -> None:
            stream = await client.chat.completions.create(**oa, messages=conversation, stream=True)
            _changed(conversation)
            await _adrain(stream)

        asyncio.run(run())

    def oa_async_streaming_view(client: Any, conversation: list[Any]) -> None:
        async def run() -> None:
            async with client.chat.completions.with_streaming_response.create(
                **oa, messages=conversation
            ) as response:
                _changed(conversation)
                await response.parse()

        asyncio.run(run())

    def an_async_stream(client: Any, conversation: list[Any]) -> None:
        async def run() -> None:
            async with client.messages.stream(**an, messages=conversation) as stream:
                _changed(conversation)
                await _adrain(stream)

        asyncio.run(run())

    return {
        "openai create(stream=True)": ("openai", "chat", oa_stream),
        "openai with_raw_response.create(stream=True)": ("openai", "chat", oa_raw_stream),
        "openai with_streaming_response.create": ("openai", "chat", oa_streaming_view),
        "anthropic stream()": ("anthropic", "anthropic", an_stream),
        "anthropic create(stream=True)": ("anthropic", "anthropic", an_create_stream),
        "openai async create(stream=True)": ("openai", "chat", oa_async_stream),
        "openai async with_streaming_response.create": ("openai", "chat", oa_async_streaming_view),
        "anthropic async stream()": ("anthropic", "anthropic", an_async_stream),
    }


@pytest.mark.parametrize("path", sorted(_stream_paths()))
def test_a_list_changed_while_a_stream_is_open_is_stored_as_it_was_sent(
    provider: respx.MockRouter,  # noqa: F811
    monkeypatch: pytest.MonkeyPatch,
    path: str,
) -> None:
    """On a streamed or deferred-view call the caller has its conversation
    back before the call settles; the stored content is the request the
    provider received, copied when the call was handed to the SDK."""
    sdk, route, call = _stream_paths()[path]
    is_async = " async " in f" {path} "
    session, client = _sensored("patched", sdk, is_async, monkeypatch, capture=True)
    conversation: list[Any] = [{"role": "user", "content": PROMPT}]
    call(client, conversation)
    sent = _sent(provider, route)["messages"]
    assert sent == [{"role": "user", "content": PROMPT}]
    assert _stored(_on_the_wire(session), "messages") == sent


def test_a_list_changed_before_a_stream_manager_is_entered_is_stored_as_sent(
    provider: respx.MockRouter,  # noqa: F811
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The guard calls the SDK's ``stream()`` when the manager is entered,
    and the SDK builds the request then: a change made before entering is
    in the request, and in the stored content."""
    session, client = _sensored("patched", "anthropic", False, monkeypatch, capture=True)
    conversation: list[Any] = [{"role": "user", "content": PROMPT}]
    manager = client.messages.stream(model=ANTHROPIC_MODEL, max_tokens=10, messages=conversation)
    conversation.append({"role": "assistant", "content": "before entering"})
    with manager as stream:
        _drain(stream)
    sent = _sent(provider, "anthropic")["messages"]
    assert _stored(_on_the_wire(session), "messages") == sent
