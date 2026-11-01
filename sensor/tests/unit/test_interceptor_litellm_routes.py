"""litellm ``text_completion`` / ``atext_completion`` and ``responses`` /
``aresponses`` through the sensor: one ``post_call`` per call on every
route, streaming included, with no double count where litellm serves the
call through the OpenAI SDK or bridges it through its own
``completion``; both capture states; positional arguments.

Driven with litellm's and the OpenAI SDK's real classes over mocked
transport: an ``httpx.MockTransport`` behind a real ``openai.OpenAI``
client for the route litellm serves through the SDK, and behind
litellm's own ``HTTPHandler`` for its httpx routes (Anthropic, the
native Responses API). No request leaves the process.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import types
import warnings
from typing import TYPE_CHECKING, Any

import httpx
import litellm
import pytest
from litellm.llms.custom_httpx.http_handler import AsyncHTTPHandler, HTTPHandler

import flightdeck_sensor
from flightdeck_sensor.interceptor import base
from flightdeck_sensor.interceptor import litellm as litellm_interceptor
from flightdeck_sensor.interceptor.litellm import (
    SensorLitellm,
    _is_bridge_hop,
    _is_text_usage_only_chunk,
    _named_arguments,
    _positional_names,
    patch_litellm_functions,
    unpatch_litellm_functions,
)
from flightdeck_sensor.interceptor.openai import patch_openai_classes, unpatch_openai_classes
from flightdeck_sensor.providers.litellm import (
    LitellmResponsesProvider,
    LitellmTextCompletionProvider,
)

from .test_interceptor_litellm import (
    MSG,
    SDK_COMPLETION_TOKENS,
    SDK_PROMPT_TOKENS,
    _anthropic_message_body,
    _async_sdk_client,
    _events_of,
    _post_calls,
    _sdk_client,
    _Transport,
    requires_litellm_responses,
)
from .test_interceptor_litellm import _session as _make_session
from .test_raw_stream_capture import _anthropic_frames

if TYPE_CHECKING:
    from collections.abc import Iterator

    from flightdeck_sensor.core.session import Session

litellm.suppress_debug_info = True

PROMPT = "SECRET-LITELLM-PROMPT-4d2e"
INSTRUCTIONS = "SECRET-LITELLM-INSTRUCTIONS-8a1f"
TOOL_CITY = "SECRET-LITELLM-CITY-60b9"
# What the mocked Responses API reports (sync body / streamed events).
RESPONSES_INPUT_TOKENS = 13
RESPONSES_OUTPUT_TOKENS = 6
ANTHROPIC_MODEL = "anthropic/claude-3-5-haiku-20241022"


def _wire(session: Session) -> str:
    queue = session.event_queue
    return json.dumps([c.args[0] for c in queue.enqueue.call_args_list], default=str)


def _assert_nothing_captured(session: Session) -> None:
    """Capture off: no event carries content, and no prompt, instruction
    or tool-input text appears anywhere in any payload."""
    queue = session.event_queue
    events = [c.args[0] for c in queue.enqueue.call_args_list]
    assert events
    for event in events:
        assert not event.get("has_content")
        assert event.get("content") is None
    wire = _wire(session)
    for secret in (PROMPT, INSTRUCTIONS, TOOL_CITY):
        assert secret not in wire


def _patched_session(monkeypatch: pytest.MonkeyPatch, *, capture: bool) -> Iterator[Session]:
    """A session with a recording queue installed as the active one, with
    litellm and the OpenAI SDK patched the way ``flightdeck_sensor.patch``
    does -- both interceptors live, so a double count would show."""
    s = _make_session(capture_prompts=capture)
    monkeypatch.setattr(flightdeck_sensor, "_session", s)
    patch_litellm_functions(quiet=True)
    patch_openai_classes(quiet=True)
    yield s
    unpatch_litellm_functions(quiet=True)
    unpatch_openai_classes()


@pytest.fixture
def session(monkeypatch: pytest.MonkeyPatch) -> Iterator[Session]:
    yield from _patched_session(monkeypatch, capture=False)


@pytest.fixture
def capture_session(monkeypatch: pytest.MonkeyPatch) -> Iterator[Session]:
    yield from _patched_session(monkeypatch, capture=True)


# ----- litellm's own httpx routes ---------------------------------------------


def _function_call_item() -> dict[str, Any]:
    return {
        "type": "function_call",
        "id": "fc_1",
        "call_id": "call_1",
        "name": "get_weather",
        "arguments": json.dumps({"city": TOOL_CITY}),
        "status": "completed",
    }


def _response_obj(status: str, *, tool: bool = False) -> dict[str, Any]:
    output: list[dict[str, Any]] = [
        {
            "type": "message",
            "id": "m1",
            "status": "completed",
            "role": "assistant",
            "content": [{"type": "output_text", "text": "hello", "annotations": []}],
        }
    ]
    if tool:
        output.append(_function_call_item())
    body: dict[str, Any] = {
        "id": "resp_1",
        "object": "response",
        "created_at": 1,
        "status": status,
        "model": "gpt-4o-mini",
        "output": output if status != "in_progress" else [],
        "parallel_tool_calls": True,
        "tool_choice": "auto",
        "tools": [],
    }
    if status != "in_progress":
        body["usage"] = {
            "input_tokens": RESPONSES_INPUT_TOKENS,
            "output_tokens": RESPONSES_OUTPUT_TOKENS,
            "total_tokens": RESPONSES_INPUT_TOKENS + RESPONSES_OUTPUT_TOKENS,
            "input_tokens_details": {"cached_tokens": 4},
            "output_tokens_details": {"reasoning_tokens": 2},
        }
    return body


def _responses_sse(*, tool: bool = False) -> bytes:
    events = [
        {
            "type": "response.created",
            "sequence_number": 0,
            "response": _response_obj("in_progress"),
        },
        {
            "type": "response.output_text.delta",
            "sequence_number": 1,
            "item_id": "m1",
            "output_index": 0,
            "content_index": 0,
            "delta": "hello",
            "logprobs": [],
        },
        {
            "type": "response.completed",
            "sequence_number": 2,
            "response": _response_obj("completed", tool=tool),
        },
    ]
    return "".join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in events).encode()


def _anthropic_sse() -> bytes:
    return "".join(
        f"event: {name}\ndata: {json.dumps(data)}\n\n"
        for name, data in _anthropic_frames(tool=False)
    ).encode()


class _HttpRoutes:
    """Serves litellm's httpx routes: the native Responses API and the
    Anthropic messages API, streamed or not. Records the paths and the
    outer-call mark at each request."""

    def __init__(self, *, tool: bool = False) -> None:
        self.paths: list[str] = []
        self.bodies: list[dict[str, Any]] = []
        self.marks: list[bool] = []
        self._tool = tool

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.paths.append(request.url.path)
        self.marks.append(base.outer_intercept_active())
        payload = json.loads(request.content or b"{}")
        self.bodies.append(payload)
        sse = {"content-type": "text/event-stream"}
        if request.url.path.endswith("/responses"):
            if payload.get("stream"):
                return httpx.Response(200, content=_responses_sse(tool=self._tool), headers=sse)
            return httpx.Response(200, json=_response_obj("completed", tool=self._tool))
        if payload.get("stream"):
            return httpx.Response(200, content=_anthropic_sse(), headers=sse)
        return httpx.Response(200, json=_anthropic_message_body())


def _handler(routes: _HttpRoutes) -> HTTPHandler:
    handler = HTTPHandler()
    handler.client = httpx.Client(transport=httpx.MockTransport(routes))
    return handler


def _async_handler(routes: _HttpRoutes) -> AsyncHTTPHandler:
    handler = AsyncHTTPHandler()
    handler.client = httpx.AsyncClient(transport=httpx.MockTransport(routes))
    return handler


async def _drain(stream: Any) -> list[Any]:
    return [c async for c in stream]


# ----- text_completion: one report per call ----------------------------------


async def test_atext_completion_through_the_openai_sdk_is_reported_once(session: Session) -> None:
    transport = _Transport()
    response = await litellm.atext_completion(
        model="gpt-4o-mini", prompt="hi", client=_async_sdk_client(transport)
    )
    assert response.choices[0].text == "hello"
    assert transport.marks == [True]
    assert len(_events_of(session, "pre_call")) == 1
    (pc,) = _post_calls(session)
    assert (pc["tokens_input"], pc["tokens_output"]) == (SDK_PROMPT_TOKENS, SDK_COMPLETION_TOKENS)


@pytest.mark.parametrize("is_async", [False, True], ids=["sync", "async"])
def test_text_completion_on_litellms_httpx_route_is_reported_once(
    session: Session, is_async: bool
) -> None:
    """Anthropic is served by litellm's own httpx handler, which no SDK
    interceptor sees; the text_completion wrapper reports it."""
    routes = _HttpRoutes()
    if is_async:
        response = asyncio.run(
            litellm.atext_completion(
                model=ANTHROPIC_MODEL,
                prompt="hi",
                client=_async_handler(routes),
                api_key="test-key",
            )
        )
    else:
        response = litellm.text_completion(
            model=ANTHROPIC_MODEL, prompt="hi", client=_handler(routes), api_key="test-key"
        )
    assert response.choices[0].text == "hello"
    assert routes.paths == ["/v1/messages"]
    (pc,) = _post_calls(session)
    assert (pc["tokens_input"], pc["tokens_output"]) == (SDK_PROMPT_TOKENS, SDK_COMPLETION_TOKENS)
    assert pc["model"] == "claude-3-5-haiku-20241022"  # the model served


def test_text_completion_stream_meters_usage_and_hides_the_usage_chunk(session: Session) -> None:
    transport = _Transport()
    stream = litellm.text_completion(
        model="gpt-4o-mini", prompt="hi", stream=True, client=_sdk_client(transport)
    )
    assert isinstance(stream, base.GuardedStream)
    chunks = list(stream)
    assert "".join(c.choices[0].text or "" for c in chunks) == "hello"
    assert not any(_is_text_usage_only_chunk(c) for c in chunks)
    sent = json.loads(transport.requests[-1].content)
    assert sent["stream_options"] == {"include_usage": True}
    (pc,) = _post_calls(session)
    assert (pc["tokens_input"], pc["tokens_output"]) == (SDK_PROMPT_TOKENS, SDK_COMPLETION_TOKENS)
    assert pc["streaming"]["final_outcome"] == "completed"
    assert pc["streaming"]["chunk_count"] == len(chunks)


def test_text_completion_stream_keeps_the_usage_chunk_for_a_caller_who_asked(
    session: Session,
) -> None:
    transport = _Transport()
    chunks = list(
        litellm.text_completion(
            model="gpt-4o-mini",
            prompt="hi",
            stream=True,
            stream_options={"include_usage": True},
            client=_sdk_client(transport),
        )
    )
    assert any(_is_text_usage_only_chunk(c) for c in chunks)
    (pc,) = _post_calls(session)
    assert pc["tokens_output"] == SDK_COMPLETION_TOKENS


async def test_atext_completion_stream_meters_usage(session: Session) -> None:
    transport = _Transport()
    stream = await litellm.atext_completion(
        model="gpt-4o-mini", prompt="hi", stream=True, client=_async_sdk_client(transport)
    )
    assert isinstance(stream, base.GuardedAsyncStream)
    chunks = await _drain(stream)
    assert "".join(c.choices[0].text or "" for c in chunks) == "hello"
    (pc,) = _post_calls(session)
    assert pc["tokens_output"] == SDK_COMPLETION_TOKENS
    assert pc["streaming"]["final_outcome"] == "completed"


@pytest.mark.parametrize("stream", [False, True], ids=["plain", "stream"])
def test_text_completion_capture_on_stores_the_prompt_and_the_text(
    capture_session: Session, stream: bool
) -> None:
    transport = _Transport()
    result = litellm.text_completion(
        model="gpt-4o-mini", prompt=PROMPT, stream=stream, client=_sdk_client(transport)
    )
    if stream:
        list(result)
    (pc,) = _post_calls(capture_session)
    assert pc["has_content"] is True
    content = pc["content"]
    assert content["input"] == PROMPT
    assert content["messages"] == []
    assert content["response"]["choices"][0]["text"] == "hello"


@pytest.mark.parametrize("stream", [False, True], ids=["plain", "stream"])
def test_text_completion_capture_off_stores_nothing(session: Session, stream: bool) -> None:
    transport = _Transport()
    result = litellm.text_completion(
        model="gpt-4o-mini", prompt=PROMPT, stream=stream, client=_sdk_client(transport)
    )
    if stream:
        list(result)
    assert len(_post_calls(session)) == 1
    _assert_nothing_captured(session)


# ----- positional arguments ------------------------------------------------


def test_completion_with_positional_arguments_is_metered(session: Session) -> None:
    """``litellm.completion(model, messages)`` works under the patch, as
    without it, and is reported once."""
    transport = _Transport()
    response = litellm.completion("gpt-4o-mini", MSG, client=_sdk_client(transport))
    assert response.choices[0].message.content == "hello"
    (pc,) = _post_calls(session)
    assert pc["model"] == "gpt-4o-mini"
    assert pc["tokens_input"] == SDK_PROMPT_TOKENS


async def test_atext_completion_with_positional_arguments_is_metered(session: Session) -> None:
    """``atext_completion`` takes ``*args``; its positional arguments are
    ``text_completion``'s, which names them."""
    transport = _Transport()
    response = await litellm.atext_completion(
        "hi", "gpt-4o-mini", client=_async_sdk_client(transport)
    )
    assert response.choices[0].text == "hello"
    (pc,) = _post_calls(session)
    assert pc["model"] == "gpt-4o-mini"


def test_named_arguments_bind_positionals_and_refuse_what_litellm_would_reject() -> None:
    def entry(model: str, messages: list[Any] | None = None, **kwargs: Any) -> None:
        return None

    names = _positional_names(entry)
    assert names == ("model", "messages")
    assert _named_arguments(names, (), {"model": "m"}) == {"model": "m"}
    assert _named_arguments(names, ("m", MSG), {"stream": True}) == {
        "model": "m",
        "messages": MSG,
        "stream": True,
    }
    assert _named_arguments(names, ("m",), {"model": "other"}) is None  # given twice
    assert _named_arguments(names, ("m", MSG, "extra"), {}) is None  # too many
    assert _positional_names(len) == ("obj",)  # a builtin's signature is read too


def test_a_call_litellm_itself_rejects_raises_as_without_the_sensor(session: Session) -> None:
    with pytest.raises(TypeError):
        litellm.completion("gpt-4o-mini", model="gpt-4o-mini")
    assert _events_of(session, "pre_call") == []


# ----- responses: one report per call -----------------------------------------


@requires_litellm_responses
async def test_aresponses_on_a_native_route_is_reported_once(session: Session) -> None:
    routes = _HttpRoutes()
    response = await litellm.aresponses(
        model="gpt-4o-mini", input="hi", client=_async_handler(routes), api_key="test-key"
    )
    assert response.usage.input_tokens == RESPONSES_INPUT_TOKENS
    assert routes.paths == ["/v1/responses"]
    (pc,) = _post_calls(session)
    assert (pc["tokens_input"], pc["tokens_output"]) == (
        RESPONSES_INPUT_TOKENS,
        RESPONSES_OUTPUT_TOKENS,
    )


@requires_litellm_responses
def test_responses_native_route_reads_the_cache_and_reasoning_counts(session: Session) -> None:
    routes = _HttpRoutes()
    litellm.responses(model="gpt-4o-mini", input="hi", client=_handler(routes), api_key="k")
    (pc,) = _post_calls(session)
    assert pc["tokens_cache_read"] == 4
    assert pc["tokens_reasoning"] == 2


@requires_litellm_responses
@pytest.mark.parametrize("is_async", [False, True], ids=["sync", "async"])
def test_responses_native_stream_is_metered_from_the_terminal_event(
    session: Session, is_async: bool
) -> None:
    routes = _HttpRoutes()
    if is_async:

        async def _read() -> list[Any]:
            stream = await litellm.aresponses(
                model="gpt-4o-mini",
                input="hi",
                stream=True,
                client=_async_handler(routes),
                api_key="test-key",
            )
            assert isinstance(stream, base.GuardedAsyncStream)
            return await _drain(stream)

        events = asyncio.run(_read())
    else:
        stream = litellm.responses(
            model="gpt-4o-mini", input="hi", stream=True, client=_handler(routes), api_key="k"
        )
        assert isinstance(stream, base.GuardedStream)
        events = list(stream)
    assert events[-1].type == "response.completed"
    assert "stream_options" not in routes.bodies[-1]  # nothing added to a Responses request
    (pc,) = _post_calls(session)
    assert (pc["tokens_input"], pc["tokens_output"]) == (
        RESPONSES_INPUT_TOKENS,
        RESPONSES_OUTPUT_TOKENS,
    )
    assert pc["streaming"]["final_outcome"] == "completed"
    assert pc["streaming"]["chunk_count"] == len(events)


@requires_litellm_responses
def test_responses_bridged_stream_is_reported_once(session: Session) -> None:
    """A streamed Responses call on Anthropic is bridged through the
    package-level ``litellm.completion(stream=True)``, which passes it
    through under the mark: one report, by the responses wrapper."""
    routes = _HttpRoutes()
    events = list(
        litellm.responses(
            model=ANTHROPIC_MODEL, input="hi", stream=True, client=_handler(routes), api_key="k"
        )
    )
    assert routes.paths == ["/v1/messages"]
    assert routes.marks == [True]
    assert any(getattr(e, "type", None) == "response.completed" for e in events)
    assert len(_events_of(session, "pre_call")) == 1
    (pc,) = _post_calls(session)
    assert pc["streaming"]["final_outcome"] == "completed"
    assert pc["tokens_output"] > 0


def test_capturing_a_bridged_responses_object_prints_no_serializer_warning() -> None:
    """litellm's bridged Responses object (Anthropic, live) holds ``usage``
    as a plain dict carrying the chat counters and the cost, which
    pydantic reports when the object is dumped. Content capture dumps it;
    that must not print a warning the call does not print without the
    sensor."""
    from litellm.types.llms.openai import ResponsesAPIResponse

    bridged_usage = {
        "completion_tokens": 3,
        "prompt_tokens": 13,
        "total_tokens": 16,
        "cost": 3.75e-06,
    }
    response = ResponsesAPIResponse.model_construct(
        id="resp_1",
        created_at=1,
        model="claude-haiku-4-5",
        object="response",
        output=[],
        status="completed",
        usage=bridged_usage,
    )
    provider = LitellmResponsesProvider(capture_prompts=True)
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        content = provider.extract_content({"model": "m", "input": PROMPT}, response)
    assert [str(w.message) for w in caught] == []
    assert content is not None
    assert content.input == PROMPT
    assert content.response["usage"] == bridged_usage


@requires_litellm_responses
@pytest.mark.parametrize("stream", [False, True], ids=["plain", "stream"])
def test_responses_tool_call_lands_as_a_tool_call_event(session: Session, stream: bool) -> None:
    routes = _HttpRoutes(tool=True)
    result = litellm.responses(
        model="gpt-4o-mini", input="hi", stream=stream, client=_handler(routes), api_key="k"
    )
    if stream:
        list(result)
    (tool_call,) = _events_of(session, "tool_call")
    assert tool_call["tool_name"] == "get_weather"
    _assert_nothing_captured(session)  # the tool's input is content


@requires_litellm_responses
@pytest.mark.parametrize("stream", [False, True], ids=["plain", "stream"])
def test_responses_capture_on_stores_instructions_input_and_response(
    capture_session: Session, stream: bool
) -> None:
    routes = _HttpRoutes()
    result = litellm.responses(
        model="gpt-4o-mini",
        input=PROMPT,
        instructions=INSTRUCTIONS,
        stream=stream,
        client=_handler(routes),
        api_key="k",
    )
    if stream:
        list(result)
    (pc,) = _post_calls(capture_session)
    content = pc["content"]
    assert content["system"] == INSTRUCTIONS
    assert content["input"] == PROMPT
    assert content["messages"] == []
    assert content["response"]["output"][0]["content"][0]["text"] == "hello"


@requires_litellm_responses
@pytest.mark.parametrize("stream", [False, True], ids=["plain", "stream"])
def test_responses_capture_off_stores_nothing(session: Session, stream: bool) -> None:
    routes = _HttpRoutes()
    result = litellm.responses(
        model="gpt-4o-mini",
        input=PROMPT,
        instructions=INSTRUCTIONS,
        stream=stream,
        client=_handler(routes),
        api_key="k",
    )
    if stream:
        list(result)
    assert len(_post_calls(session)) == 1
    _assert_nothing_captured(session)


# ----- nested litellm calls: only the bridge passes through --------------------


def test_a_nested_litellm_call_from_a_callback_is_policed_and_reported(
    session: Session,
) -> None:
    """A callback that calls ``litellm.completion`` while a litellm call is
    in flight makes a call of its own: it gets its own pre_call (policy
    check) and post_call, and the outer call is still reported once."""
    from litellm.integrations.custom_logger import CustomLogger

    hook_transport = _Transport()
    nested: list[Any] = []

    class _Hook(CustomLogger):
        def log_pre_api_call(self, model: Any, messages: Any, kwargs: Any) -> None:
            if nested:  # once: the nested call runs this hook too
                return
            nested.append(None)
            nested[0] = litellm.completion(
                model="gpt-4o-mini", messages=MSG, client=_sdk_client(hook_transport)
            )

    transport = _Transport()
    previous = litellm.callbacks
    litellm.callbacks = [_Hook()]
    try:
        litellm.completion(model="gpt-4o-mini", messages=MSG, client=_sdk_client(transport))
    finally:
        litellm.callbacks = previous
    assert len(nested) == 1
    assert len(hook_transport.requests) == 1
    assert len(transport.requests) == 1
    assert len(_events_of(session, "pre_call")) == 2
    assert len(_post_calls(session)) == 2


def test_a_litellm_call_made_under_a_bare_mark_is_reported(session: Session) -> None:
    """The mark alone does not silence a litellm entry point: only a call
    from litellm's bridge does."""
    transport = _Transport()
    with base.outer_intercept():
        litellm.completion(model="gpt-4o-mini", messages=MSG, client=_sdk_client(transport))
    assert len(_post_calls(session)) == 1


def test_only_the_bridge_modules_are_a_bridge_hop() -> None:
    def frame_in(module: str) -> Any:
        return types.SimpleNamespace(f_globals={"__name__": module})

    bridge = "litellm.responses.litellm_completion_transformation.handler"
    assert not _is_bridge_hop(frame_in(bridge))  # no outer call in flight
    with base.outer_intercept():
        assert _is_bridge_hop(frame_in(bridge))
        assert _is_bridge_hop(
            frame_in("litellm.completion_extras.litellm_responses_transformation.handler")
        )
        assert not _is_bridge_hop(frame_in("litellm.litellm_core_utils.fallback_utils"))
        assert not _is_bridge_hop(frame_in("my_app.callbacks"))
        assert not _is_bridge_hop(None)


@requires_litellm_responses
def test_completion_bridged_through_responses_is_reported_once(session: Session) -> None:
    """A Responses-only model (``openai/responses/...``) makes
    ``completion`` bridge through ``litellm.responses``, which passes the
    call through: one pre_call and one post_call, with the Responses
    usage, reported by the completion wrapper. (litellm's async bridge
    does not forward ``client``, so only the sync form can be driven over
    the mocked handler; the async frame check is covered below and by
    the aresponses-to-acompletion bridge test.)"""
    routes = _HttpRoutes()
    response = litellm.completion(
        model="openai/responses/gpt-4o-mini",
        messages=MSG,
        api_key="k",
        client=_handler(routes),
    )
    assert response.choices[0].message.content == "hello"
    assert routes.paths == ["/v1/responses"]
    assert len(_events_of(session, "pre_call")) == 1
    (pc,) = _post_calls(session)
    assert (pc["tokens_input"], pc["tokens_output"]) == (
        RESPONSES_INPUT_TOKENS,
        RESPONSES_OUTPUT_TOKENS,
    )


def _caller_in(module: str) -> dict[str, Any]:
    """A namespace whose functions run with ``module`` as their module
    name, as litellm's bridge code does, calling the patched entry
    points through the package attribute."""
    namespace: dict[str, Any] = {"__name__": module, "litellm": litellm}
    exec(  # noqa: S102 -- a fixed snippet, to give the frames a module name
        "def hop(**kw):\n"
        "    return litellm.completion(**kw)\n"
        "async def ahop(**kw):\n"
        "    return await litellm.acompletion(**kw)\n",
        namespace,
    )
    return namespace


@pytest.mark.parametrize("is_async", [False, True], ids=["sync", "async"])
@pytest.mark.parametrize(
    ("module", "reported"),
    [
        ("litellm.responses.litellm_completion_transformation.handler", 0),
        ("litellm.litellm_core_utils.fallback_utils", 1),
    ],
    ids=["bridge", "other-litellm-module"],
)
def test_under_an_outer_call_only_a_bridge_caller_passes_through(
    session: Session, is_async: bool, module: str, reported: int
) -> None:
    namespace = _caller_in(module)
    transport = _Transport()
    with base.outer_intercept():
        if is_async:
            asyncio.run(
                namespace["ahop"](
                    model="gpt-4o-mini", messages=MSG, client=_async_sdk_client(transport)
                )
            )
        else:
            namespace["hop"](model="gpt-4o-mini", messages=MSG, client=_sdk_client(transport))
    assert len(transport.requests) == 1
    assert len(_events_of(session, "pre_call")) == reported
    assert len(_post_calls(session)) == reported


# ----- patch / unpatch / per-callsite wrapper ---------------------------------

_ENTRY_POINTS = (
    "completion",
    "acompletion",
    "text_completion",
    "atext_completion",
    "responses",
    "aresponses",
    "embedding",
    "aembedding",
)


def test_patch_swaps_every_entry_point_and_unpatch_restores_it() -> None:
    originals = {name: getattr(litellm, name) for name in _ENTRY_POINTS}
    patch_litellm_functions(quiet=True)
    try:
        for name in _ENTRY_POINTS:
            patched = getattr(litellm, name)
            assert patched is not originals[name]
            # The wrapper keeps litellm's signature and async-ness.
            assert inspect.signature(patched) == inspect.signature(originals[name])
            assert inspect.iscoroutinefunction(patched) == inspect.iscoroutinefunction(
                originals[name]
            )
        patch_litellm_functions(quiet=True)  # idempotent
        assert litellm.text_completion.__wrapped__ is originals["text_completion"]
    finally:
        unpatch_litellm_functions(quiet=True)
    for name in _ENTRY_POINTS:
        assert getattr(litellm, name) is originals[name]
        assert not hasattr(litellm, f"_flightdeck_orig_{name}")
    assert not hasattr(litellm, "_flightdeck_patched")


def test_sensor_litellm_wrapper_covers_text_completion() -> None:
    s = _make_session()
    transport = _Transport()
    wrapper = SensorLitellm(s)
    response = wrapper.text_completion(
        model="gpt-4o-mini", prompt="hi", client=_sdk_client(transport)
    )
    assert response.choices[0].text == "hello"
    (pc,) = _post_calls(s)
    assert pc["tokens_output"] == SDK_COMPLETION_TOKENS


@requires_litellm_responses
async def test_sensor_litellm_wrapper_covers_aresponses() -> None:
    s = _make_session()
    routes = _HttpRoutes()
    await SensorLitellm(s).aresponses(
        model="gpt-4o-mini", input="hi", client=_async_handler(routes), api_key="k"
    )
    (pc,) = _post_calls(s)
    assert pc["tokens_output"] == RESPONSES_OUTPUT_TOKENS


def test_sensor_litellm_wrapper_names_a_missing_entry_point(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(litellm_interceptor, "_OrigResponses", None)
    with pytest.raises(RuntimeError, match=r"litellm\.responses"):
        SensorLitellm(_make_session()).responses(model="gpt-4o-mini", input="hi")


# ----- the adapters -----------------------------------------------------------


def test_text_completion_adapter_estimates_every_prompt_form() -> None:
    provider = LitellmTextCompletionProvider()
    for prompt in ("say hello to the world", ["say hello", "to the world"], [[1, 2, 3, 4, 5]]):
        count, source = provider.estimate_tokens({"model": "gpt-4o-mini", "prompt": prompt})
        assert count > 0, prompt
        assert source in ("tiktoken", "heuristic")


def test_text_completion_adapter_reads_usage_only_from_the_usage_chunk() -> None:
    provider = LitellmTextCompletionProvider()
    content_chunk = litellm.TextCompletionResponse(
        choices=[{"text": "hi", "index": 0, "finish_reason": None}]
    )
    usage_chunk = litellm.TextCompletionResponse(
        choices=[{"text": None, "index": 0, "finish_reason": None}],
        usage=litellm.Usage(prompt_tokens=5, completion_tokens=2, total_tokens=7),
    )
    assert provider.usage_from_stream_chunk(content_chunk) is None
    assert provider.chunk_completes_stream(content_chunk) is False
    usage = provider.usage_from_stream_chunk(usage_chunk)
    assert usage is not None and (usage.input_tokens, usage.output_tokens) == (5, 2)
    assert provider.chunk_completes_stream(usage_chunk) is True
    assert _is_text_usage_only_chunk(usage_chunk)
    assert not _is_text_usage_only_chunk(content_chunk)


def test_responses_adapter_reads_both_usage_shapes_and_the_stop_reason() -> None:
    provider = LitellmResponsesProvider()
    usage = provider.extract_usage(
        {
            "usage": {
                "input_tokens": 10,
                "output_tokens": 3,
                "input_tokens_details": {"cached_tokens": 6},
                "output_tokens_details": {"reasoning_tokens": 1},
            }
        }
    )
    assert (usage.input_tokens, usage.output_tokens) == (10, 3)
    assert (usage.cache_read_tokens, usage.reasoning_tokens) == (6, 1)
    chat_shape = provider.extract_usage(
        litellm.ModelResponse(usage=litellm.Usage(prompt_tokens=4, completion_tokens=2))
    )
    assert (chat_shape.input_tokens, chat_shape.output_tokens) == (4, 2)
    assert provider.extract_usage(object()).total == 0
    assert (
        provider.response_stop_reason(
            {"status": "incomplete", "incomplete_details": {"reason": "max_output_tokens"}}
        )
        == "max_output_tokens"
    )
    assert provider.response_stop_reason({"status": "completed"}) is None
    incomplete_event = {
        "type": "response.incomplete",
        "response": {"status": "incomplete", "incomplete_details": {"reason": "content_filter"}},
    }
    assert provider.stop_reason_from_stream_chunk(incomplete_event) == "content_filter"
    assert provider.chunk_completes_stream(incomplete_event) is True


def test_responses_adapter_capture_off_returns_no_content() -> None:
    provider = LitellmResponsesProvider(capture_prompts=False)
    assert provider.extract_content({"input": PROMPT}, {"output": []}) is None
    assert LitellmTextCompletionProvider().extract_content({"prompt": PROMPT}, {}) is None
