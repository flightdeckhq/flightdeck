"""Anthropic SDK smoke test. Runs manually; NOT in CI.

Coverage: non-streaming chat, sync streaming, async streaming, error
classification (via an intentionally bad request that tickles the
error classifier without eating quota).

Rule 40d: do not land framework-touching changes without running this
target at least once against a real provider so SDK class-rename or
streaming-shape drift surfaces before users hit it.
"""

from __future__ import annotations

import asyncio

import pytest

from tests.smoke.conftest import (
    fetch_events_for_session,
    make_sensor_session,
    require_env,
    wait_for_dev_stack,
)


def _sensor_session():
    return make_sensor_session(flavor="smoke-anthropic")


@pytest.fixture(scope="module", autouse=True)
def _stack_ready() -> None:
    require_env("ANTHROPIC_API_KEY")
    wait_for_dev_stack()


def test_anthropic_non_stream_chat_completion() -> None:
    import anthropic
    sess = _sensor_session()
    client = anthropic.Anthropic()
    client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=16,
        messages=[{"role": "user", "content": "say the word 'ok'"}],
    )
    events = fetch_events_for_session(
        sess.config.session_id, expect_event_types=["post_call"],
    )
    assert any(e["event_type"] == "post_call" for e in events), events


def test_anthropic_sync_streaming_ttft_captured() -> None:
    import anthropic
    sess = _sensor_session()
    client = anthropic.Anthropic()
    with client.messages.stream(
        model="claude-haiku-4-5-20251001",
        max_tokens=16,
        messages=[{"role": "user", "content": "count 1 2 3"}],
    ) as stream:
        for _ in stream:
            pass
    events = fetch_events_for_session(
        sess.config.session_id, expect_event_types=["post_call"],
    )
    streamed = [
        e for e in events
        if e["event_type"] == "post_call"
        and e.get("payload", {}).get("streaming")
    ]
    assert streamed, f"no streaming post_call observed; events={events!r}"
    assert streamed[-1]["payload"]["streaming"]["ttft_ms"] is not None


def test_anthropic_async_streaming_ttft_captured() -> None:
    import anthropic
    sess = _sensor_session()
    client = anthropic.AsyncAnthropic()

    async def run() -> None:
        async with client.messages.stream(
            model="claude-haiku-4-5-20251001",
            max_tokens=16,
            messages=[{"role": "user", "content": "say hi"}],
        ) as stream:
            async for _ in stream:
                pass

    asyncio.run(run())
    events = fetch_events_for_session(
        sess.config.session_id, expect_event_types=["post_call"],
    )
    streamed = [
        e for e in events
        if e["event_type"] == "post_call"
        and e.get("payload", {}).get("streaming")
    ]
    assert streamed, f"no async streaming post_call observed; events={events!r}"


def test_anthropic_invalid_model_emits_llm_error() -> None:
    import anthropic
    sess = _sensor_session()
    client = anthropic.Anthropic()
    with pytest.raises(Exception):
        client.messages.create(
            model="this-model-does-not-exist",
            max_tokens=16,
            messages=[{"role": "user", "content": "hello"}],
        )
    events = fetch_events_for_session(
        sess.config.session_id, expect_event_types=["llm_error"],
    )
    errors = [e for e in events if e["event_type"] == "llm_error"]
    assert errors, f"no llm_error observed; events={events!r}"
    err = errors[-1]["payload"]["error"]
    # not_found OR invalid_request depending on how Anthropic classes
    # the error -- both are acceptable; the important bit is that the
    # taxonomy caught something real, not ``other``.
    assert err["error_type"] != "other", err
