"""Calls through the REAL sensor on paths it newly meters land as exactly
one ``post_call`` each:

* ``client.beta.chat.completions.parse()`` (structured output on the
  OpenAI SDK's beta resource);
* an async streaming view (``with_streaming_response``) whose event
  stream is parsed and never read, reported as an aborted stream with no
  chunks;
* litellm ``text_completion`` (served through the OpenAI SDK, which the
  OpenAI patch also intercepts, so a double count would show) and
  ``responses`` on its native route and on the route it bridges through
  ``litellm.completion`` (which the litellm patch also intercepts),
  streamed and not, with the content round trip for both capture states.

Provider HTTP is mocked at the network boundary with respx serving the
bodies and server-sent events the providers send; the SDKs, litellm, the
sensor and everything from the sensor to Postgres run for real against
the dev stack. Parallel-safe: a unique flavor per test, whose rows are
the only ones deleted after it.
"""

from __future__ import annotations

import asyncio
import json
import os
import uuid
from collections.abc import Iterator
from typing import Any

import httpx
import litellm
import openai
import pydantic
import pytest
import respx

import flightdeck_sensor

from .conftest import INGESTION_URL, TOKEN, delete_flavor_data
from .test_sensor_e2e import _force_reset_sensor
from .test_sensor_streaming import (
    _anthropic_events,
    _content_status,
    _openai_chat_sse,
    _openai_responses_sse,
    _sse,
    _teardown_and_expect_one,
)

litellm.suppress_debug_info = True

PROMPT = "integration-secret-prompt-5c7a"


@pytest.fixture
def sensor_reset() -> Iterator[None]:
    """Clean sensor state before and after each test; the patches are
    removed too so later modules see the raw SDKs."""
    _force_reset_sensor()
    yield
    flightdeck_sensor.unpatch()
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


def _chat_completion(content: str) -> dict[str, Any]:
    return {
        "id": "chatcmpl-i1",
        "object": "chat.completion",
        "created": 1,
        "model": "gpt-4o",
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": content, "refusal": None},
                "finish_reason": "stop",
            }
        ],
        "usage": {"prompt_tokens": 12, "completion_tokens": 5, "total_tokens": 17},
    }


def _responses_body() -> dict[str, Any]:
    return {
        "id": "resp_i1",
        "object": "response",
        "created_at": 1.0,
        "status": "completed",
        "model": "gpt-4o",
        "output": [
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
        "parallel_tool_calls": True,
        "tool_choice": "auto",
        "tools": [],
        "usage": {
            "input_tokens": 7,
            "output_tokens": 3,
            "total_tokens": 10,
            "input_tokens_details": {"cached_tokens": 0},
            "output_tokens_details": {"reasoning_tokens": 0},
        },
    }


class Weather(pydantic.BaseModel):
    city: str


# ----- OpenAI SDK ------------------------------------------------------------


def test_beta_chat_parse_lands_one_post_call(
    sensor_reset: None, unique_flavor: str
) -> None:
    flavor = unique_flavor
    with respx.mock(assert_all_called=False, assert_all_mocked=True) as rmock:
        rmock.post("https://api.openai.com/v1/chat/completions").mock(
            return_value=httpx.Response(
                200, json=_chat_completion(json.dumps({"city": "Paris"}))
            )
        )
        flightdeck_sensor.init(server=INGESTION_URL, token=TOKEN)
        flightdeck_sensor.patch(quiet=True)
        client = openai.OpenAI(api_key="test-key")
        completion = client.beta.chat.completions.parse(
            model="gpt-4o",
            messages=[{"role": "user", "content": "Weather?"}],
            response_format=Weather,
        )
        assert completion.choices[0].message.parsed == Weather(city="Paris")
        post_call = _teardown_and_expect_one(flavor, "post_call")
    assert (post_call["tokens_input"], post_call["tokens_output"]) == (12, 5)


def test_async_streaming_view_closed_unread_lands_an_aborted_post_call(
    sensor_reset: None, unique_flavor: str
) -> None:
    flavor = unique_flavor

    async def _open_and_leave() -> None:
        client = openai.AsyncOpenAI(api_key="test-key")
        async with client.chat.completions.with_streaming_response.create(
            model="gpt-4o", messages=[{"role": "user", "content": "Hello"}], stream=True
        ) as response:
            await response.parse()

    with respx.mock(assert_all_called=False, assert_all_mocked=True) as rmock:
        rmock.post("https://api.openai.com/v1/chat/completions").mock(
            return_value=_openai_chat_sse()
        )
        flightdeck_sensor.init(server=INGESTION_URL, token=TOKEN)
        flightdeck_sensor.patch(quiet=True)
        asyncio.run(_open_and_leave())
        post_call = _teardown_and_expect_one(flavor, "post_call")
    streaming = post_call["payload"]["streaming"]
    assert streaming["chunk_count"] == 0
    assert streaming["final_outcome"] == "aborted"
    assert post_call["tokens_output"] == 0
    assert post_call["tokens_input"] > 0  # the pre-call estimate


# ----- litellm ---------------------------------------------------------------


@pytest.mark.parametrize("stream", [False, True], ids=["plain", "stream"])
def test_litellm_text_completion_through_the_openai_sdk_lands_one_post_call(
    sensor_reset: None, unique_flavor: str, stream: bool
) -> None:
    flavor = unique_flavor
    with respx.mock(assert_all_called=False, assert_all_mocked=True) as rmock:
        rmock.post("https://api.openai.com/v1/chat/completions").mock(
            return_value=_openai_chat_sse()
            if stream
            else httpx.Response(200, json=_chat_completion("Hi there"))
        )
        flightdeck_sensor.init(server=INGESTION_URL, token=TOKEN)
        flightdeck_sensor.patch(quiet=True)  # litellm and the OpenAI SDK, both live
        result = litellm.text_completion(
            model="gpt-4o", prompt="Hello", stream=stream, api_key="test-key"
        )
        if stream:
            text = "".join(c.choices[0].text or "" for c in result)
        else:
            text = result.choices[0].text
        assert text == "Hi there"
        post_call = _teardown_and_expect_one(flavor, "post_call")
    expected = (9, 4) if stream else (12, 5)
    assert (post_call["tokens_input"], post_call["tokens_output"]) == expected
    if stream:
        assert post_call["payload"]["streaming"]["final_outcome"] == "completed"


@pytest.mark.parametrize("stream", [False, True], ids=["plain", "stream"])
def test_litellm_responses_native_route_lands_one_post_call(
    sensor_reset: None, unique_flavor: str, stream: bool
) -> None:
    flavor = unique_flavor
    with respx.mock(assert_all_called=False, assert_all_mocked=True) as rmock:
        rmock.post("https://api.openai.com/v1/responses").mock(
            return_value=_openai_responses_sse()
            if stream
            else httpx.Response(200, json=_responses_body())
        )
        flightdeck_sensor.init(server=INGESTION_URL, token=TOKEN)
        flightdeck_sensor.patch(quiet=True)
        result = litellm.responses(
            model="gpt-4o", input="Hello", stream=stream, api_key="test-key"
        )
        if stream:
            assert [e.type for e in result][-1] == "response.completed"
        else:
            assert result.usage.output_tokens == 3
        post_call = _teardown_and_expect_one(flavor, "post_call")
    assert (post_call["tokens_input"], post_call["tokens_output"]) == (7, 3)
    if stream:
        assert post_call["payload"]["streaming"]["final_outcome"] == "completed"


def test_litellm_responses_bridged_through_completion_lands_one_post_call(
    sensor_reset: None, unique_flavor: str
) -> None:
    """Anthropic has no native Responses API: litellm bridges the call
    through ``litellm.completion``, which the patch also wraps."""
    flavor = unique_flavor
    with respx.mock(assert_all_called=False, assert_all_mocked=True) as rmock:
        rmock.post("https://api.anthropic.com/v1/messages").mock(
            return_value=_sse(_anthropic_events())
        )
        flightdeck_sensor.init(server=INGESTION_URL, token=TOKEN)
        flightdeck_sensor.patch(quiet=True)
        events = list(
            litellm.responses(
                model="anthropic/claude-sonnet-4-6",
                input="Hello",
                stream=True,
                api_key="test-key",
            )
        )
        assert any(getattr(e, "type", None) == "response.completed" for e in events)
        post_call = _teardown_and_expect_one(flavor, "post_call")
    assert post_call["payload"]["streaming"]["final_outcome"] == "completed"
    assert post_call["tokens_output"] > 0


@pytest.mark.parametrize("capture", [True, False], ids=["capture-on", "capture-off"])
def test_litellm_responses_content_round_trip_honours_capture(
    sensor_reset: None, unique_flavor: str, capture: bool
) -> None:
    flavor = unique_flavor
    with respx.mock(assert_all_called=False, assert_all_mocked=True) as rmock:
        rmock.post("https://api.openai.com/v1/responses").mock(
            return_value=httpx.Response(200, json=_responses_body())
        )
        flightdeck_sensor.init(
            server=INGESTION_URL, token=TOKEN, capture_prompts=capture
        )
        flightdeck_sensor.patch(quiet=True)
        litellm.responses(model="gpt-4o", input=PROMPT, api_key="test-key")
        post_call = _teardown_and_expect_one(flavor, "post_call")
    assert post_call["has_content"] is capture
    assert PROMPT not in json.dumps(post_call, default=str)

    status, body = _content_status(post_call["id"])
    if capture:
        assert status == 200
        assert PROMPT in body
        assert "Hi there" in body
    else:
        assert status == 404
