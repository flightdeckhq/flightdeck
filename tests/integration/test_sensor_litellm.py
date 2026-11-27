"""A litellm streamed call through the REAL sensor lands as one ``post_call``
carrying the token counts litellm reports in its trailing usage chunk, with
both the litellm patch and the OpenAI SDK patch active -- litellm serves
this route through the OpenAI SDK, so a double count would show here. A
litellm ``Router``'s streamed call that its fallback answers lands each
of its two requests: the refused attempt's ``llm_error`` and the answer's
``post_call``.

Provider HTTP is mocked at the network boundary with respx serving the
server-sent events api.openai.com sends; litellm, the OpenAI SDK, the
sensor guard and everything from the sensor to Postgres run for real
against the dev stack. Parallel-safe: a unique flavor per test and no
worker pause.
"""

from __future__ import annotations

import asyncio
import os
import uuid
from collections.abc import Iterator
from typing import Any

import httpx
import litellm
import pytest
import respx
from litellm.litellm_core_utils.streaming_handler import CustomStreamWrapper

import flightdeck_sensor

from .conftest import INGESTION_URL, TOKEN, delete_flavor_data
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


# The two deployments of the Router test: hosts under .invalid, which no
# resolver answers, mocked by respx.
PRIMARY_BASE = "https://primary.invalid/v1"
BACKUP_BASE = "https://backup.invalid/v1"


@pytest.mark.parametrize("is_async", [False, True], ids=["sync", "async"])
def test_a_router_stream_its_fallback_answers_lands_the_refused_attempt_and_the_answer(
    sensor_reset: None,
    unique_flavor: str,
    monkeypatch: pytest.MonkeyPatch,
    is_async: bool,
) -> None:
    """The first deployment refuses the request (HTTP 503) and the Router
    answers with its fallback deployment's stream. The caller gets the
    Router's own stream wrapper, a ``CustomStreamWrapper``, as without the
    sensor, and the two requests land as two calls: the refused attempt's
    ``llm_error`` and the answer's ``post_call`` with the provider's
    counts."""
    flavor = unique_flavor
    # litellm's async OpenAI client otherwise sends through aiohttp, which
    # respx does not see.
    monkeypatch.setattr(litellm, "disable_aiohttp_transport", True)
    with respx.mock(assert_all_called=False, assert_all_mocked=True) as rmock:
        refused = rmock.post(f"{PRIMARY_BASE}/chat/completions").mock(
            return_value=httpx.Response(
                503, json={"error": {"message": "overloaded", "type": "server_error"}}
            )
        )
        answered = rmock.post(f"{BACKUP_BASE}/chat/completions").mock(
            return_value=_openai_chat_sse()
        )
        flightdeck_sensor.init(server=INGESTION_URL, token=TOKEN)
        flightdeck_sensor.patch(quiet=True)
        router = litellm.Router(
            model_list=[
                {
                    "model_name": name,
                    "litellm_params": {"model": "openai/gpt-4o", "api_base": base, "api_key": "k"},
                }
                for name, base in (("primary", PRIMARY_BASE), ("backup", BACKUP_BASE))
            ],
            fallbacks=[{"primary": ["backup"]}],
            num_retries=0,
        )
        messages = [{"role": "user", "content": "Hello"}]
        if is_async:

            async def _read() -> tuple[Any, list[Any]]:
                stream = await router.acompletion(model="primary", messages=messages, stream=True)
                return stream, [chunk async for chunk in stream]

            stream, chunks = asyncio.run(_read())
        else:
            stream = router.completion(model="primary", messages=messages, stream=True)
            chunks = list(stream)
        assert isinstance(stream, CustomStreamWrapper)
        assert type(stream).__name__.endswith("FallbackStreamWrapper")
        assert "".join(c.choices[0].delta.content or "" for c in chunks if c.choices) == "Hi there"
        assert (refused.call_count, answered.call_count) == (1, 1)
        del stream, chunks

        post_call = _teardown_and_expect_one(flavor, "post_call")
        assert (post_call["tokens_input"], post_call["tokens_output"]) == (9, 4)
        assert post_call["payload"]["streaming"]["final_outcome"] == "completed"
        types = [e["event_type"] for e in _query_events_for_flavor(flavor)]
        assert types.count("pre_call") == 2
        assert types.count("llm_error") == 1
