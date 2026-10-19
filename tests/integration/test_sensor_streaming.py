"""Streamed calls through the REAL sensor land with the token counts the
provider sent inside the stream.

Provider HTTP is mocked at the network boundary with respx serving
server-sent events exactly as api.anthropic.com and api.openai.com do;
the SDK parses them, the sensor guard meters them, and everything from
the sensor to Postgres runs for real against the dev stack.
"""

from __future__ import annotations

import anthropic
import httpx
import openai
import respx

import flightdeck_sensor

from .conftest import INGESTION_URL, TOKEN
from .test_sensor_e2e import (  # noqa: F401  (fixtures)
    _wait_for_event_type,
    sensor_reset,
    unique_flavor,
)

ANTHROPIC_SSE = "".join(
    f"event: {name}\ndata: {data}\n\n"
    for name, data in [
        (
            "message_start",
            '{"type":"message_start","message":{"id":"msg_s1","type":"message","role":"assistant",'
            '"model":"claude-sonnet-4-6","content":[],"stop_reason":null,"stop_sequence":null,'
            '"usage":{"input_tokens":11,"output_tokens":1,"cache_read_input_tokens":0,'
            '"cache_creation_input_tokens":0}}}',
        ),
        ("content_block_start", '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}'),
        ("content_block_delta", '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}'),
        ("content_block_delta", '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" there"}}'),
        ("content_block_stop", '{"type":"content_block_stop","index":0}'),
        ("message_delta", '{"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":5}}'),
        ("message_stop", '{"type":"message_stop"}'),
    ]
)

OPENAI_SSE = "".join(
    f"data: {data}\n\n"
    for data in [
        '{"id":"chatcmpl-s1","object":"chat.completion.chunk","created":1,"model":"gpt-4o",'
        '"choices":[{"index":0,"delta":{"role":"assistant","content":"Hi"},"finish_reason":null}]}',
        '{"id":"chatcmpl-s1","object":"chat.completion.chunk","created":1,"model":"gpt-4o",'
        '"choices":[{"index":0,"delta":{"content":" there"},"finish_reason":null}]}',
        '{"id":"chatcmpl-s1","object":"chat.completion.chunk","created":1,"model":"gpt-4o",'
        '"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
        '{"id":"chatcmpl-s1","object":"chat.completion.chunk","created":1,"model":"gpt-4o",'
        '"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":4,"total_tokens":13}}',
        "[DONE]",
    ]
)


def _sse(body: str) -> httpx.Response:
    return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=body.encode())


def test_anthropic_raw_stream_plain_iteration_lands_real_usage(
    sensor_reset: None, unique_flavor: str,
) -> None:
    flavor = unique_flavor
    with respx.mock(assert_all_called=False) as rmock:
        rmock.post("https://api.anthropic.com/v1/messages").mock(return_value=_sse(ANTHROPIC_SSE))
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

        post_call = _wait_for_event_type(flavor, "post_call", timeout=15)
        assert post_call["tokens_input"] == 11
        assert post_call["tokens_output"] == 5
        assert post_call["tokens_total"] == 16
        assert post_call["payload"]["streaming"]["chunk_count"] == 7
        assert post_call["payload"]["streaming"]["final_outcome"] == "completed"


def test_anthropic_helper_stream_with_block_lands_real_usage(
    sensor_reset: None, unique_flavor: str,
) -> None:
    flavor = unique_flavor
    with respx.mock(assert_all_called=False) as rmock:
        rmock.post("https://api.anthropic.com/v1/messages").mock(return_value=_sse(ANTHROPIC_SSE))
        flightdeck_sensor.init(server=INGESTION_URL, token=TOKEN)
        client = flightdeck_sensor.wrap(anthropic.Anthropic(api_key="test-key"))

        with client.messages.stream(
            model="claude-sonnet-4-6",
            messages=[{"role": "user", "content": "Hello"}],
            max_tokens=50,
        ) as stream:
            text = "".join(stream.text_stream)
        assert text == "Hello there"

        post_call = _wait_for_event_type(flavor, "post_call", timeout=15)
        assert post_call["tokens_input"] == 11
        assert post_call["tokens_output"] == 5


def test_openai_chat_stream_lands_usage_from_final_chunk(
    sensor_reset: None, unique_flavor: str,
) -> None:
    flavor = unique_flavor
    with respx.mock(assert_all_called=False) as rmock:
        route = rmock.post("https://api.openai.com/v1/chat/completions").mock(return_value=_sse(OPENAI_SSE))
        flightdeck_sensor.init(server=INGESTION_URL, token=TOKEN)
        client = flightdeck_sensor.wrap(openai.OpenAI(api_key="test-key"))

        pieces = []
        with client.chat.completions.create(
            model="gpt-4o",
            messages=[{"role": "user", "content": "Hello"}],
            stream=True,
        ) as stream:
            for chunk in stream:
                if chunk.choices and chunk.choices[0].delta.content:
                    pieces.append(chunk.choices[0].delta.content)
        assert "".join(pieces) == "Hi there"
        # The sensor asked for the usage chunk.
        sent = route.calls.last.request.read().decode()
        assert '"include_usage"' in sent

        post_call = _wait_for_event_type(flavor, "post_call", timeout=15)
        assert post_call["tokens_input"] == 9
        assert post_call["tokens_output"] == 4
        assert post_call["payload"]["streaming"]["chunk_count"] == 4
