"""A litellm streamed call through the REAL sensor lands as one ``post_call``
carrying the token counts litellm reports in its trailing usage chunk, with
both the litellm patch and the OpenAI SDK patch active -- litellm serves
this route through the OpenAI SDK, so a double count would show here. An
OpenAI SDK call a litellm callback makes while the litellm call is in
flight lands as a call of its own beside it.

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
from typing import Any

import litellm
import pytest
import respx
from litellm.integrations.custom_logger import CustomLogger

import flightdeck_sensor

from .conftest import INGESTION_URL, TOKEN, delete_flavor_data, wait_until
from .test_sensor_e2e import _force_reset_sensor
from .test_sensor_streaming import (
    _openai_chat_sse,
    _query_events_for_flavor,
    _teardown_and_expect_one,
)

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
        chunks = list(
            litellm.completion(
                model="gpt-4o",
                messages=[{"role": "user", "content": "Hello"}],
                stream=True,
                api_key="test-key",
            )
        )
        for chunk in chunks:
            if chunk.choices and chunk.choices[0].delta.content:
                pieces.append(chunk.choices[0].delta.content)
        assert "".join(pieces) == "Hi there"
        # On OpenAI's own base litellm asks for usage itself, so its
        # trailing usage chunk is the caller's, as without the sensor.
        assert [getattr(c, "usage", None) is not None for c in chunks] == [False] * (
            len(chunks) - 1
        ) + [True]
        assert route.call_count == 1
        assert '"include_usage"' in route.calls.last.request.read().decode()

        # Exactly one post_call: the litellm wrapper's. The OpenAI SDK
        # descriptor passed the marked call through.
        post_call = _teardown_and_expect_one(flavor, "post_call")
        assert post_call["tokens_input"] == 9
        assert post_call["tokens_output"] == 4
        streaming = post_call["payload"]["streaming"]
        assert streaming["final_outcome"] == "completed"
        assert streaming["chunk_count"] == len(chunks)  # litellm's usage chunk included
        assert streaming["ttft_ms"] is not None


def test_an_sdk_call_a_litellm_callback_makes_lands_as_a_call_of_its_own(
    sensor_reset: None,
    unique_flavor: str,
) -> None:
    """litellm runs ``log_pre_api_call`` inside the call, before its
    request; the OpenAI SDK call the callback makes is not litellm's own
    request, so it lands as its own ``post_call``, and litellm's request,
    which goes through the OpenAI SDK too, lands once."""
    import openai

    flavor = unique_flavor
    with respx.mock(assert_all_called=False, assert_all_mocked=True) as rmock:
        route = rmock.post("https://api.openai.com/v1/chat/completions").mock(
            return_value=_openai_chat_sse()
        )
        flightdeck_sensor.init(server=INGESTION_URL, token=TOKEN)
        flightdeck_sensor.patch(quiet=True)
        asked: list[Any] = []

        class _AsksItsOwnQuestion(CustomLogger):  # type: ignore[misc]
            def log_pre_api_call(self, model: Any, messages: Any, kwargs: Any) -> None:
                client = openai.OpenAI(api_key="test-key")
                asked.append(
                    list(
                        client.chat.completions.create(
                            model="gpt-4.1-nano",
                            messages=[{"role": "user", "content": "the callback's question"}],
                            stream=True,
                        )
                    )
                )

        lists = {
            name: list(value)
            for name, value in vars(litellm).items()
            if name.endswith(("callback", "callbacks")) and isinstance(value, list)
        }
        litellm.callbacks = [_AsksItsOwnQuestion()]
        try:
            list(
                litellm.completion(
                    model="gpt-4o",
                    messages=[{"role": "user", "content": "Hello"}],
                    stream=True,
                    api_key="test-key",
                )
            )
        finally:
            for name, value in lists.items():
                getattr(litellm, name)[:] = value
        assert len(asked) == 1
        assert route.call_count == 2

        flightdeck_sensor.teardown()
        rows = []

        def _landed() -> bool:
            rows[:] = _query_events_for_flavor(flavor)
            types = [e["event_type"] for e in rows]
            return "session_end" in types and types.count("post_call") >= 2

        wait_until(_landed, timeout=15, msg=f"no session_end and two post_calls for {flavor}")
        post_calls = [e for e in rows if e["event_type"] == "post_call"]
        assert sorted(e["model_requested"] for e in post_calls) == ["gpt-4.1-nano", "gpt-4o"]
        assert [e["event_type"] for e in rows].count("pre_call") == 2
        assert all((e["tokens_input"], e["tokens_output"]) == (9, 4) for e in post_calls)
