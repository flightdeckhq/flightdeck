"""Streamed calls through the REAL sensor land with the token counts the
provider sent inside the stream.

Provider HTTP is mocked at the network boundary with respx serving
server-sent events exactly as api.anthropic.com and api.openai.com do;
the SDK parses them, the sensor guard meters them, and everything from
the sensor to Postgres runs for real against the dev stack.
"""

from __future__ import annotations

import asyncio
import json
import os
import urllib.error
import urllib.request
import uuid
from collections.abc import Iterator
from typing import Any

import anthropic
import httpx
import openai
import pytest
import respx

import flightdeck_sensor

from .conftest import (
    API_URL,
    INGESTION_URL,
    TOKEN,
    auth_headers,
    delete_flavor_data,
    wait_until,
)
from .test_sensor_e2e import (
    _force_reset_sensor,
    _query_events_for_flavor,
    _query_session_for_flavor,
)


@pytest.fixture
def sensor_reset() -> Iterator[None]:
    """Clean sensor state before and after each test. Same shape as the
    fixture in test_sensor_e2e.py; defined here so this module imports
    helpers only, never another module's fixtures."""
    _force_reset_sensor()
    yield
    _force_reset_sensor()


@pytest.fixture
def unique_flavor() -> Iterator[str]:
    """A unique flavor per test; every row it produced is deleted after."""
    flavor = f"e2e-{uuid.uuid4().hex[:10]}"
    os.environ["AGENT_FLAVOR"] = flavor
    try:
        yield flavor
    finally:
        os.environ.pop("AGENT_FLAVOR", None)
        delete_flavor_data(flavor)


def _sse(events: list[tuple[str, dict[str, Any]]]) -> httpx.Response:
    body = "".join(
        f"event: {name}\ndata: {json.dumps(data)}\n\n" for name, data in events
    )
    return httpx.Response(
        200, headers={"content-type": "text/event-stream"}, content=body.encode()
    )


def _events_the_sdk_yields(events: list[tuple[str, dict[str, Any]]]) -> int:
    """Count the SSE frames that reach the caller as stream events.

    The Anthropic SDK's decoder swallows ``ping`` keep-alive frames and
    raises on an ``error`` frame instead of yielding it, so the sensor's
    chunk counters see neither. Deriving the expectation here keeps the
    wire fixture realistic (real streams carry pings) without hard-coding
    a count that drifts when the fixture changes.
    """
    return sum(1 for name, _ in events if name not in {"ping", "error"})


def _anthropic_events(
    fail_after: int | None = None,
    delta_usage: dict[str, int] | None = None,
) -> list[tuple[str, dict[str, Any]]]:
    events: list[tuple[str, dict[str, Any]]] = [
        (
            "message_start",
            {
                "type": "message_start",
                "message": {
                    "id": "msg_s1",
                    "type": "message",
                    "role": "assistant",
                    "model": "claude-sonnet-4-6",
                    "content": [],
                    "stop_reason": None,
                    "stop_sequence": None,
                    "usage": {
                        "input_tokens": 11,
                        "output_tokens": 1,
                        "cache_read_input_tokens": 0,
                        "cache_creation_input_tokens": 0,
                    },
                },
            },
        ),
        ("ping", {"type": "ping"}),
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
        (
            "content_block_delta",
            {
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "text_delta", "text": " there"},
            },
        ),
        ("content_block_stop", {"type": "content_block_stop", "index": 0}),
        (
            "message_delta",
            {
                "type": "message_delta",
                "delta": {"stop_reason": "end_turn", "stop_sequence": None},
                "usage": delta_usage or {"output_tokens": 5},
            },
        ),
        ("message_stop", {"type": "message_stop"}),
    ]
    if fail_after is not None:
        events = events[:fail_after] + [
            (
                "error",
                {
                    "type": "error",
                    "error": {"type": "overloaded_error", "message": "Overloaded"},
                },
            )
        ]
    return events


def _openai_chat_sse() -> httpx.Response:
    chunks = [
        {
            "id": "chatcmpl-s1",
            "object": "chat.completion.chunk",
            "created": 1,
            "model": "gpt-4o",
            "choices": [
                {
                    "index": 0,
                    "delta": {"role": "assistant", "content": "Hi"},
                    "finish_reason": None,
                }
            ],
        },
        {
            "id": "chatcmpl-s1",
            "object": "chat.completion.chunk",
            "created": 1,
            "model": "gpt-4o",
            "choices": [
                {"index": 0, "delta": {"content": " there"}, "finish_reason": None}
            ],
            "usage": None,
        },
        {
            "id": "chatcmpl-s1",
            "object": "chat.completion.chunk",
            "created": 1,
            "model": "gpt-4o",
            "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
        },
        {
            "id": "chatcmpl-s1",
            "object": "chat.completion.chunk",
            "created": 1,
            "model": "gpt-4o",
            "choices": [],
            "usage": {
                "prompt_tokens": 9,
                "completion_tokens": 4,
                "total_tokens": 13,
                "prompt_tokens_details": {"cached_tokens": 0},
            },
        },
    ]
    body = "".join(f"data: {json.dumps(c)}\n\n" for c in chunks) + "data: [DONE]\n\n"
    return httpx.Response(
        200, headers={"content-type": "text/event-stream"}, content=body.encode()
    )


def _openai_responses_sse() -> httpx.Response:
    base = {
        "id": "resp_s1",
        "object": "response",
        "created_at": 1.0,
        "model": "gpt-4o",
        "output": [],
        "parallel_tool_calls": True,
        "tool_choice": "auto",
        "tools": [],
        "status": "in_progress",
    }
    completed = dict(
        base,
        status="completed",
        output=[
            {
                "id": "msg_1",
                "type": "message",
                "role": "assistant",
                "status": "completed",
                "content": [
                    {"type": "output_text", "text": "Hi there", "annotations": []}
                ],
            }
        ],
        usage={
            "input_tokens": 7,
            "output_tokens": 3,
            "total_tokens": 10,
            "input_tokens_details": {"cached_tokens": 0},
            "output_tokens_details": {"reasoning_tokens": 0},
        },
    )
    events = [
        (
            "response.created",
            {"type": "response.created", "sequence_number": 0, "response": base},
        ),
        (
            "response.output_text.delta",
            {
                "type": "response.output_text.delta",
                "sequence_number": 1,
                "item_id": "msg_1",
                "output_index": 0,
                "content_index": 0,
                "delta": "Hi there",
                "logprobs": [],
            },
        ),
        (
            "response.completed",
            {"type": "response.completed", "sequence_number": 2, "response": completed},
        ),
    ]
    return _sse(events)


def _teardown_and_expect_one(flavor: str, event_type: str) -> dict[str, Any]:
    """Tear the sensor down, wait until both the session_end row and an
    ``event_type`` row have landed (the sensor flushes its queue before
    session_end, but the workers process in parallel, so the rows can
    land in either order), and return the single ``event_type`` row."""
    flightdeck_sensor.teardown()

    def _landed() -> bool:
        types = [e["event_type"] for e in _query_events_for_flavor(flavor)]
        return "session_end" in types and event_type in types

    wait_until(_landed, timeout=15, msg=f"no session_end and {event_type} for {flavor}")
    rows = [
        e for e in _query_events_for_flavor(flavor) if e["event_type"] == event_type
    ]
    assert len(rows) == 1, f"expected exactly one {event_type}, got {len(rows)}"
    return rows[0]


def test_anthropic_raw_stream_plain_iteration_lands_real_usage(
    sensor_reset: None,
    unique_flavor: str,
) -> None:
    flavor = unique_flavor
    with respx.mock(assert_all_called=False, assert_all_mocked=True) as rmock:
        rmock.post("https://api.anthropic.com/v1/messages").mock(
            return_value=_sse(_anthropic_events())
        )
        flightdeck_sensor.init(server=INGESTION_URL, token=TOKEN)
        client = flightdeck_sensor.wrap(anthropic.Anthropic(api_key="test-key"))

        texts = []
        for event in client.messages.create(
            model="claude-sonnet-4-6",
            messages=[{"role": "user", "content": "Hello"}],
            max_tokens=50,
            stream=True,
        ):
            if event.type == "content_block_delta":
                texts.append(event.delta.text)
        assert "".join(texts) == "Hello there"

        post_call = _teardown_and_expect_one(flavor, "post_call")
        assert post_call["tokens_input"] == 11
        assert post_call["tokens_output"] == 5
        assert post_call["tokens_total"] == 16
        assert post_call["payload"]["streaming"]["chunk_count"] == (
            _events_the_sdk_yields(_anthropic_events())
        )
        assert post_call["payload"]["streaming"]["final_outcome"] == "completed"


def test_anthropic_helper_stream_with_block_lands_real_usage(
    sensor_reset: None,
    unique_flavor: str,
) -> None:
    flavor = unique_flavor
    with respx.mock(assert_all_called=False, assert_all_mocked=True) as rmock:
        rmock.post("https://api.anthropic.com/v1/messages").mock(
            return_value=_sse(_anthropic_events())
        )
        flightdeck_sensor.init(server=INGESTION_URL, token=TOKEN)
        client = flightdeck_sensor.wrap(anthropic.Anthropic(api_key="test-key"))

        with client.messages.stream(
            model="claude-sonnet-4-6",
            messages=[{"role": "user", "content": "Hello"}],
            max_tokens=50,
        ) as stream:
            text = "".join(stream.text_stream)
        assert text == "Hello there"

        post_call = _teardown_and_expect_one(flavor, "post_call")
        assert post_call["tokens_input"] == 11
        assert post_call["tokens_output"] == 5


def test_anthropic_async_helper_text_stream_lands_real_usage(
    sensor_reset: None,
    unique_flavor: str,
) -> None:
    flavor = unique_flavor
    with respx.mock(assert_all_called=False, assert_all_mocked=True) as rmock:
        rmock.post("https://api.anthropic.com/v1/messages").mock(
            return_value=_sse(_anthropic_events())
        )
        flightdeck_sensor.init(server=INGESTION_URL, token=TOKEN)
        client = flightdeck_sensor.wrap(anthropic.AsyncAnthropic(api_key="test-key"))

        async def _run() -> str:
            async with client.messages.stream(
                model="claude-sonnet-4-6",
                messages=[{"role": "user", "content": "Hello"}],
                max_tokens=50,
            ) as stream:
                return "".join([t async for t in stream.text_stream])

        assert asyncio.run(_run()) == "Hello there"

        post_call = _teardown_and_expect_one(flavor, "post_call")
        assert post_call["tokens_input"] == 11
        assert post_call["tokens_output"] == 5
        assert post_call["payload"]["streaming"]["final_outcome"] == "completed"


def test_anthropic_error_event_mid_stream_lands_one_llm_error(
    sensor_reset: None,
    unique_flavor: str,
) -> None:
    flavor = unique_flavor
    with respx.mock(assert_all_called=False, assert_all_mocked=True) as rmock:
        rmock.post("https://api.anthropic.com/v1/messages").mock(
            return_value=_sse(_anthropic_events(fail_after=4))
        )
        flightdeck_sensor.init(server=INGESTION_URL, token=TOKEN)
        client = flightdeck_sensor.wrap(anthropic.Anthropic(api_key="test-key"))

        with pytest.raises(anthropic.APIError):
            for _ in client.messages.create(
                model="claude-sonnet-4-6",
                messages=[{"role": "user", "content": "Hello"}],
                max_tokens=50,
                stream=True,
            ):
                pass

        err = _teardown_and_expect_one(flavor, "llm_error")
        assert err["payload"]["error"]["error_type"] == "stream_error"
        assert err["payload"]["error"]["abort_reason"] == "error_mid_stream"
        assert err["payload"]["error"]["partial_chunks"] == (
            _events_the_sdk_yields(_anthropic_events(fail_after=4))
        )
        assert err["payload"]["error"]["partial_tokens_input"] == 11
        assert [
            e
            for e in _query_events_for_flavor(flavor)
            if e["event_type"] == "post_call"
        ] == []


def test_anthropic_rate_limit_on_stream_open_raises_at_create(
    sensor_reset: None,
    unique_flavor: str,
) -> None:
    flavor = unique_flavor
    with respx.mock(assert_all_called=False, assert_all_mocked=True) as rmock:
        rmock.post("https://api.anthropic.com/v1/messages").mock(
            return_value=httpx.Response(
                429,
                headers={"retry-after": "7"},
                json={
                    "type": "error",
                    "error": {"type": "rate_limit_error", "message": "slow down"},
                },
            )
        )
        flightdeck_sensor.init(server=INGESTION_URL, token=TOKEN)
        client = flightdeck_sensor.wrap(
            anthropic.Anthropic(api_key="test-key", max_retries=0)
        )

        with pytest.raises(anthropic.RateLimitError):
            client.messages.create(
                model="claude-sonnet-4-6",
                messages=[{"role": "user", "content": "Hello"}],
                max_tokens=50,
                stream=True,
            )

        err = _teardown_and_expect_one(flavor, "llm_error")
        assert err["payload"]["error"]["error_type"] == "rate_limit"
        assert err["payload"]["error"]["abort_reason"] == "error_before_stream"
        assert err["payload"]["error"]["retry_after"] == 7


def test_openai_chat_stream_lands_usage_from_final_chunk(
    sensor_reset: None,
    unique_flavor: str,
) -> None:
    flavor = unique_flavor
    with respx.mock(assert_all_called=False, assert_all_mocked=True) as rmock:
        route = rmock.post("https://api.openai.com/v1/chat/completions").mock(
            return_value=_openai_chat_sse()
        )
        flightdeck_sensor.init(server=INGESTION_URL, token=TOKEN)
        client = flightdeck_sensor.wrap(openai.OpenAI(api_key="test-key"))

        pieces = []
        with client.chat.completions.create(
            model="gpt-4o",
            messages=[{"role": "user", "content": "Hello"}],
            stream=True,
        ) as stream:
            for chunk in stream:
                assert chunk.choices, "the injected usage chunk must stay hidden"
                if chunk.choices[0].delta.content:
                    pieces.append(chunk.choices[0].delta.content)
        assert "".join(pieces) == "Hi there"
        assert '"include_usage"' in route.calls.last.request.read().decode()

        post_call = _teardown_and_expect_one(flavor, "post_call")
        assert post_call["tokens_input"] == 9
        assert post_call["tokens_output"] == 4
        assert (
            post_call["payload"]["streaming"]["chunk_count"] == 3
        )  # the usage chunk is absorbed


def test_openai_responses_stream_lands_usage_from_completed_event(
    sensor_reset: None,
    unique_flavor: str,
) -> None:
    flavor = unique_flavor
    with respx.mock(assert_all_called=False, assert_all_mocked=True) as rmock:
        rmock.post("https://api.openai.com/v1/responses").mock(
            return_value=_openai_responses_sse()
        )
        flightdeck_sensor.init(server=INGESTION_URL, token=TOKEN)
        client = flightdeck_sensor.wrap(openai.OpenAI(api_key="test-key"))

        seen = [
            event.type
            for event in client.responses.create(
                model="gpt-4o", input="Hello", stream=True
            )
        ]
        assert "response.completed" in seen

        post_call = _teardown_and_expect_one(flavor, "post_call")
        assert post_call["tokens_input"] == 7
        assert post_call["tokens_output"] == 3


def test_anthropic_raw_break_then_close_lands_an_aborted_post_call(
    sensor_reset: None,
    unique_flavor: str,
) -> None:
    flavor = unique_flavor
    with respx.mock(assert_all_called=False, assert_all_mocked=True) as rmock:
        rmock.post("https://api.anthropic.com/v1/messages").mock(
            return_value=_sse(_anthropic_events())
        )
        flightdeck_sensor.init(server=INGESTION_URL, token=TOKEN)
        client = flightdeck_sensor.wrap(anthropic.Anthropic(api_key="test-key"))

        stream = client.messages.create(
            model="claude-sonnet-4-6",
            messages=[{"role": "user", "content": "Hello"}],
            max_tokens=50,
            stream=True,
        )
        for _ in stream:
            break
        stream.close()

        post_call = _teardown_and_expect_one(flavor, "post_call")
        assert (post_call["tokens_input"], post_call["tokens_output"]) == (11, 1)
        assert post_call["payload"]["streaming"]["final_outcome"] == "aborted"
        assert post_call["payload"]["streaming"]["abort_reason"] == "client_aborted"
        assert post_call["payload"]["streaming"]["chunk_count"] == 1


def test_anthropic_message_delta_with_every_counter_lands_the_same_totals(
    sensor_reset: None,
    unique_flavor: str,
) -> None:
    flavor = unique_flavor
    cumulative = {
        "input_tokens": 11,
        "output_tokens": 5,
        "cache_read_input_tokens": 0,
        "cache_creation_input_tokens": 0,
    }
    with respx.mock(assert_all_called=False, assert_all_mocked=True) as rmock:
        rmock.post("https://api.anthropic.com/v1/messages").mock(
            return_value=_sse(_anthropic_events(delta_usage=cumulative))
        )
        flightdeck_sensor.init(server=INGESTION_URL, token=TOKEN)
        client = flightdeck_sensor.wrap(anthropic.Anthropic(api_key="test-key"))

        for _ in client.messages.create(
            model="claude-sonnet-4-6",
            messages=[{"role": "user", "content": "Hello"}],
            max_tokens=50,
            stream=True,
        ):
            pass

        post_call = _teardown_and_expect_one(flavor, "post_call")
        assert (post_call["tokens_input"], post_call["tokens_output"]) == (11, 5)
        assert post_call["payload"]["streaming"]["final_outcome"] == "completed"


def test_openai_async_chat_plain_iteration_lands_usage(
    sensor_reset: None,
    unique_flavor: str,
) -> None:
    flavor = unique_flavor
    with respx.mock(assert_all_called=False, assert_all_mocked=True) as rmock:
        rmock.post("https://api.openai.com/v1/chat/completions").mock(
            return_value=_openai_chat_sse()
        )
        flightdeck_sensor.init(server=INGESTION_URL, token=TOKEN)
        client = flightdeck_sensor.wrap(openai.AsyncOpenAI(api_key="test-key"))

        async def _run() -> str:
            pieces = []
            async for chunk in await client.chat.completions.create(
                model="gpt-4o",
                messages=[{"role": "user", "content": "Hello"}],
                stream=True,
            ):
                if chunk.choices and chunk.choices[0].delta.content:
                    pieces.append(chunk.choices[0].delta.content)
            return "".join(pieces)

        assert asyncio.run(_run()) == "Hi there"

        post_call = _teardown_and_expect_one(flavor, "post_call")
        assert (post_call["tokens_input"], post_call["tokens_output"]) == (9, 4)
        assert post_call["payload"]["streaming"]["final_outcome"] == "completed"


def _content_status(event_id: str) -> tuple[int, str]:
    """``GET /v1/events/{id}/content`` status and body, outside any respx
    mock so the request really reaches the dev stack."""
    req = urllib.request.Request(
        f"{API_URL}/v1/events/{event_id}/content", headers=auth_headers()
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, resp.read().decode()
    except urllib.error.HTTPError as exc:
        return exc.code, ""


@pytest.mark.parametrize("capture", [True, False], ids=["capture-on", "capture-off"])
def test_helper_stream_content_round_trip_honours_capture(
    sensor_reset: None,
    unique_flavor: str,
    capture: bool,
) -> None:
    flavor = unique_flavor
    with respx.mock(assert_all_called=False, assert_all_mocked=True) as rmock:
        rmock.post("https://api.anthropic.com/v1/messages").mock(
            return_value=_sse(_anthropic_events())
        )
        flightdeck_sensor.init(
            server=INGESTION_URL, token=TOKEN, capture_prompts=capture
        )
        client = flightdeck_sensor.wrap(anthropic.Anthropic(api_key="test-key"))

        with client.messages.stream(
            model="claude-sonnet-4-6",
            messages=[{"role": "user", "content": "Hello"}],
            max_tokens=50,
        ) as stream:
            assert "".join(stream.text_stream) == "Hello there"

        post_call = _teardown_and_expect_one(flavor, "post_call")
        assert post_call["has_content"] is capture

    status, body = _content_status(post_call["id"])
    if capture:
        assert status == 200
        assert "Hello there" in body  # the helper's assembled response
    else:
        assert status == 404


def test_stream_still_open_at_teardown_lands_with_its_tokens_rolled_up(
    sensor_reset: None,
    unique_flavor: str,
) -> None:
    flavor = unique_flavor
    with respx.mock(assert_all_called=False, assert_all_mocked=True) as rmock:
        rmock.post("https://api.anthropic.com/v1/messages").mock(
            return_value=_sse(_anthropic_events())
        )
        flightdeck_sensor.init(server=INGESTION_URL, token=TOKEN)
        client = flightdeck_sensor.wrap(anthropic.Anthropic(api_key="test-key"))

        stream = client.messages.create(
            model="claude-sonnet-4-6",
            messages=[{"role": "user", "content": "Hello"}],
            max_tokens=50,
            stream=True,
        )
        for _ in stream:
            break  # left open on purpose: the session ends with it

        post_call = _teardown_and_expect_one(flavor, "post_call")
        assert (post_call["tokens_input"], post_call["tokens_output"]) == (11, 1)
        assert post_call["payload"]["streaming"]["final_outcome"] == "aborted"
        # Flushed before session_end, so the workers rolled it up on an
        # open session.
        wait_until(
            lambda: (
                ((_query_session_for_flavor(flavor) or {}).get("tokens_used") or 0)
                >= 12
            ),
            timeout=15,
            msg="the session's tokens never included the stream left open",
        )
        stream.close()  # already settled: a no-op


def test_langchain_anthropic_stream_is_metered(
    sensor_reset: None,
    unique_flavor: str,
) -> None:
    langchain_anthropic = pytest.importorskip("langchain_anthropic")
    flavor = unique_flavor
    with respx.mock(assert_all_called=False, assert_all_mocked=True) as rmock:
        rmock.post("https://api.anthropic.com/v1/messages").mock(
            return_value=_sse(_anthropic_events())
        )
        flightdeck_sensor.init(server=INGESTION_URL, token=TOKEN)
        flightdeck_sensor.patch(quiet=True)
        llm = langchain_anthropic.ChatAnthropic(
            model="claude-sonnet-4-6", api_key="test-key", max_tokens=50
        )
        for _ in llm.stream("Hello"):
            pass

        post_call = _teardown_and_expect_one(flavor, "post_call")
        assert (post_call["tokens_input"], post_call["tokens_output"]) == (11, 5)
        assert post_call["payload"]["streaming"]["final_outcome"] == "completed"


def test_langchain_openai_stream_is_metered(
    sensor_reset: None,
    unique_flavor: str,
) -> None:
    langchain_openai = pytest.importorskip("langchain_openai")
    flavor = unique_flavor
    with respx.mock(assert_all_called=False, assert_all_mocked=True) as rmock:
        rmock.post("https://api.openai.com/v1/chat/completions").mock(
            return_value=_openai_chat_sse()
        )
        flightdeck_sensor.init(server=INGESTION_URL, token=TOKEN)
        flightdeck_sensor.patch(quiet=True)
        llm = langchain_openai.ChatOpenAI(model="gpt-4o", api_key="test-key")
        for _ in llm.stream("Hello"):
            pass

        post_call = _teardown_and_expect_one(flavor, "post_call")
        assert (post_call["tokens_input"], post_call["tokens_output"]) == (9, 4)
        assert post_call["payload"]["streaming"]["final_outcome"] == "completed"
