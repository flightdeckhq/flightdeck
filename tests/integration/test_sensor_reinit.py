"""A client kept across ``teardown()`` and a new ``init()`` reports each
call to the session active when it is made, end to end: the real sensor,
the provider mocked at the network boundary (respx), and the stack
storing what lands. A call made while the sensor is torn down reaches the
provider and lands nowhere.
"""

from __future__ import annotations

import json
import os
import uuid
from typing import TYPE_CHECKING, Any

import anthropic
import flightdeck_sensor
import httpx
import openai
import pytest
import respx

from .conftest import INGESTION_URL, TOKEN, delete_flavor_data, wait_until
from .test_sensor_e2e import _force_reset_sensor, _query_events_for_flavor

if TYPE_CHECKING:
    from collections.abc import Callable, Iterator

ANTHROPIC_MODEL = "claude-haiku-4-5"
OPENAI_MODEL = "gpt-4o-mini"
HI = [{"role": "user", "content": "hi"}]


@pytest.fixture
def sensor_reset() -> Iterator[None]:
    """Clean sensor state before and after each test (the shape of the
    fixture in test_sensor_e2e.py)."""
    _force_reset_sensor()
    yield
    _force_reset_sensor()


@pytest.fixture
def unique_flavor() -> Iterator[str]:
    """A unique flavor per test; every row it produced is deleted after."""
    flavor = f"e2e-reinit-{uuid.uuid4().hex[:10]}"
    os.environ["AGENT_FLAVOR"] = flavor
    try:
        yield flavor
    finally:
        os.environ.pop("AGENT_FLAVOR", None)
        delete_flavor_data(flavor)


def _sse(frames: list[tuple[str | None, Any]]) -> httpx.Response:
    body = ""
    for event, data in frames:
        head = f"event: {event}\n" if event else ""
        body += f"{head}data: {data if isinstance(data, str) else json.dumps(data)}\n\n"
    return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=body.encode())


MESSAGE: dict[str, Any] = {
    "id": "msg_reinit",
    "type": "message",
    "role": "assistant",
    "model": ANTHROPIC_MODEL,
    "content": [{"type": "text", "text": "Hello"}],
    "stop_reason": "end_turn",
    "stop_sequence": None,
    "usage": {"input_tokens": 12, "output_tokens": 9},
}


def _anthropic_reply(request: httpx.Request) -> httpx.Response:
    if json.loads(request.content or b"{}").get("stream") is not True:
        return httpx.Response(200, json=MESSAGE)
    start = {**MESSAGE, "content": [], "stop_reason": None}
    start["usage"] = {"input_tokens": 12, "output_tokens": 1}
    block = {"type": "text", "text": ""}
    return _sse(
        [
            ("message_start", {"type": "message_start", "message": start}),
            (
                "content_block_start",
                {"type": "content_block_start", "index": 0, "content_block": block},
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
                    "usage": {"output_tokens": 9},
                },
            ),
            ("message_stop", {"type": "message_stop"}),
        ]
    )


USAGE = {"prompt_tokens": 12, "completion_tokens": 9, "total_tokens": 21}


def _chunk(delta: dict[str, Any], finish: str | None) -> dict[str, Any]:
    return {
        "id": "chatcmpl-reinit",
        "object": "chat.completion.chunk",
        "created": 1,
        "model": OPENAI_MODEL,
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
    }


def _openai_reply(request: httpx.Request) -> httpx.Response:
    if json.loads(request.content or b"{}").get("stream") is not True:
        message = {"role": "assistant", "content": "Hello"}
        return httpx.Response(
            200,
            json={
                "id": "chatcmpl-reinit",
                "object": "chat.completion",
                "created": 1,
                "model": OPENAI_MODEL,
                "choices": [{"index": 0, "message": message, "finish_reason": "stop"}],
                "usage": USAGE,
            },
        )
    return _sse(
        [
            (None, _chunk({"role": "assistant", "content": "Hello"}, None)),
            (None, _chunk({}, "stop")),
            (None, {**_chunk({}, None), "choices": [], "usage": USAGE}),
            (None, "[DONE]"),
        ]
    )


def _start() -> str:
    flightdeck_sensor.init(server=INGESTION_URL, token=TOKEN, quiet=True)
    flightdeck_sensor.patch(quiet=True)
    session = flightdeck_sensor._session
    assert session is not None
    return session.config.session_id


def _across_two_sessions(
    flavor: str,
    build: Callable[[], Any],
    calls: Callable[[Any], int],
    *,
    last_chat_call_streams: bool = False,
) -> None:
    """Build the objects under a first session, make the calls there,
    tear down, make them again, start a second session and make them a
    third time. ``calls`` returns how many post_calls one round lands.
    Each session must hold exactly its own round, and nothing else in
    the flavor may land. With ``last_chat_call_streams`` the round's last
    OpenAI call is a plain SDK stream, which the sensor would have asked
    for usage on: torn down, the request must reach the provider as the
    caller wrote it."""
    with respx.mock(assert_all_called=False, assert_all_mocked=True) as rmock:
        rmock.post("https://api.anthropic.com/v1/messages").mock(side_effect=_anthropic_reply)
        chat_route = rmock.post("https://api.openai.com/v1/chat/completions").mock(
            side_effect=_openai_reply
        )
        first = _start()
        kept = build()
        per_round = calls(kept)
        flightdeck_sensor.teardown()

        sent = len(rmock.calls)
        assert calls(kept) == per_round
        # The provider got the calls made while torn down.
        assert len(rmock.calls) > sent
        if last_chat_call_streams:
            assert "stream_options" not in json.loads(chat_route.calls.last.request.content)

        second = _start()
        assert calls(kept) == per_round
        flightdeck_sensor.teardown()

    def _landed() -> bool:
        rows = _query_events_for_flavor(flavor)
        ends = {e["session_id"] for e in rows if e["event_type"] == "session_end"}
        posts = [e["session_id"] for e in rows if e["event_type"] == "post_call"]
        return {first, second} <= ends and len(posts) >= 2 * per_round

    wait_until(_landed, timeout=20, msg=f"both sessions of {flavor} never landed")
    rows = _query_events_for_flavor(flavor)
    assert {e["session_id"] for e in rows} == {first, second}
    for session_id in (first, second):
        posts = [
            e for e in rows if e["session_id"] == session_id and e["event_type"] == "post_call"
        ]
        assert len(posts) == per_round, (session_id, len(posts))
        assert all(e["tokens_input"] == 12 and e["tokens_output"] == 9 for e in posts)


def test_sdk_clients_kept_across_teardown_report_to_each_session(
    sensor_reset: None, unique_flavor: str
) -> None:
    def build() -> tuple[Any, Any]:
        return (
            anthropic.Anthropic(api_key="test-key", max_retries=0),
            openai.OpenAI(api_key="test-key", max_retries=0),
        )

    def calls(clients: tuple[Any, Any]) -> int:
        claude, gpt = clients
        claude.messages.create(model=ANTHROPIC_MODEL, max_tokens=10, messages=HI)
        claude.messages.with_raw_response.create(
            model=ANTHROPIC_MODEL, max_tokens=10, messages=HI
        ).parse()
        list(claude.messages.create(model=ANTHROPIC_MODEL, max_tokens=10, messages=HI, stream=True))
        gpt.chat.completions.create(model=OPENAI_MODEL, messages=HI)
        gpt.chat.completions.with_raw_response.create(model=OPENAI_MODEL, messages=HI).parse()
        list(gpt.chat.completions.create(model=OPENAI_MODEL, messages=HI, stream=True))
        return 6

    _across_two_sessions(unique_flavor, build, calls, last_chat_call_streams=True)


def test_langchain_models_kept_across_teardown_report_to_each_session(
    sensor_reset: None, unique_flavor: str
) -> None:
    """langchain-anthropic sends every request through the raw view of
    the client it builds once; langchain-openai keeps the client's
    ``chat.completions``. Both are reused, as an application reuses a
    model across sensor sessions."""
    langchain_anthropic = pytest.importorskip("langchain_anthropic")
    langchain_openai = pytest.importorskip("langchain_openai")

    def build() -> tuple[Any, Any]:
        return (
            langchain_anthropic.ChatAnthropic(
                model=ANTHROPIC_MODEL, api_key="test-key", max_tokens=10, max_retries=0
            ),
            langchain_openai.ChatOpenAI(model=OPENAI_MODEL, api_key="test-key", max_retries=0),
        )

    def calls(models: tuple[Any, Any]) -> int:
        for model in models:
            model.invoke("hi")
            list(model.stream("hi"))
        return 4

    _across_two_sessions(unique_flavor, build, calls)


def test_a_stream_manager_reports_to_the_session_it_is_entered_in(
    sensor_reset: None, unique_flavor: str
) -> None:
    """The OpenAI ``.stream()`` helper sends its request when its manager
    is entered. Two managers built under the first session: the one
    entered with the sensor torn down reaches the provider and lands
    nowhere, the one entered in the second session lands there."""
    flavor = unique_flavor
    with respx.mock(assert_all_called=False, assert_all_mocked=True) as rmock:
        chat_route = rmock.post("https://api.openai.com/v1/chat/completions").mock(
            side_effect=_openai_reply
        )
        first = _start()
        client = openai.OpenAI(api_key="test-key", max_retries=0)
        entered_torn_down = client.chat.completions.stream(model=OPENAI_MODEL, messages=HI)
        entered_later = client.chat.completions.stream(model=OPENAI_MODEL, messages=HI)
        client.chat.completions.create(model=OPENAI_MODEL, messages=HI)
        flightdeck_sensor.teardown()

        with entered_torn_down as stream:
            assert stream.get_final_completion().choices[0].message.content == "Hello"
        assert "stream_options" not in json.loads(chat_route.calls.last.request.content)

        second = _start()
        with entered_later as stream:
            stream.get_final_completion()
        flightdeck_sensor.teardown()

    def _landed() -> bool:
        rows = _query_events_for_flavor(flavor)
        ends = {e["session_id"] for e in rows if e["event_type"] == "session_end"}
        posts = [e for e in rows if e["event_type"] == "post_call"]
        return {first, second} <= ends and len(posts) >= 2

    wait_until(_landed, timeout=20, msg=f"both sessions of {flavor} never landed")
    rows = _query_events_for_flavor(flavor)
    posts = {
        session_id: [
            e for e in rows if e["session_id"] == session_id and e["event_type"] == "post_call"
        ]
        for session_id in (first, second)
    }
    assert {e["session_id"] for e in rows} == {first, second}
    assert [len(posts[first]), len(posts[second])] == [1, 1]
    (streamed,) = posts[second]
    assert (streamed["tokens_input"], streamed["tokens_output"]) == (12, 9)
