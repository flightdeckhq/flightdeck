"""A litellm streamed call through the REAL sensor lands as one ``post_call``
carrying the token counts litellm reports in its trailing usage chunk, with
both the litellm patch and the OpenAI SDK patch active -- litellm serves
this route through the OpenAI SDK, so a double count would show here.

Provider HTTP is mocked at the network boundary with respx serving the
server-sent events api.openai.com sends; litellm, the OpenAI SDK, the
sensor guard and everything from the sensor to Postgres run for real
against the dev stack. Parallel-safe: a unique flavor per test and no
worker pause.
"""

from __future__ import annotations

import os
import uuid
from collections.abc import Iterator

import litellm
import pytest
import respx

import flightdeck_sensor

from .conftest import INGESTION_URL, TOKEN, delete_flavor_data
from .test_sensor_e2e import _force_reset_sensor
from .test_sensor_streaming import _openai_chat_sse, _teardown_and_expect_one

litellm.suppress_debug_info = True


@pytest.fixture
def sensor_reset() -> Iterator[None]:
    """Clean sensor state before and after each test; the module-level
    patches are removed too so later modules see the raw SDKs."""
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


def test_litellm_stream_through_the_openai_sdk_lands_one_post_call_with_trailing_usage(
    sensor_reset: None,
    unique_flavor: str,
) -> None:
    flavor = unique_flavor
    with respx.mock(assert_all_called=False, assert_all_mocked=True) as rmock:
        route = rmock.post("https://api.openai.com/v1/chat/completions").mock(
            return_value=_openai_chat_sse()
        )
        flightdeck_sensor.init(server=INGESTION_URL, token=TOKEN)
        flightdeck_sensor.patch(quiet=True)  # litellm and the OpenAI SDK, both live

        pieces = []
        for chunk in litellm.completion(
            model="gpt-4o",
            messages=[{"role": "user", "content": "Hello"}],
            stream=True,
            api_key="test-key",
        ):
            assert getattr(chunk, "usage", None) is None, "the usage chunk must stay hidden"
            if chunk.choices and chunk.choices[0].delta.content:
                pieces.append(chunk.choices[0].delta.content)
        assert "".join(pieces) == "Hi there"
        assert route.call_count == 1
        assert '"include_usage"' in route.calls.last.request.read().decode()

        # Exactly one post_call: the litellm wrapper's. The OpenAI SDK
        # descriptor passed the marked call through.
        post_call = _teardown_and_expect_one(flavor, "post_call")
        assert post_call["tokens_input"] == 9
        assert post_call["tokens_output"] == 4
        streaming = post_call["payload"]["streaming"]
        assert streaming["final_outcome"] == "completed"
        assert streaming["chunk_count"] == 3  # the usage chunk is absorbed
        assert streaming["ttft_ms"] is not None
