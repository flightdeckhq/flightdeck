"""OpenAI SDK Phase 4 smoke test. Runs manually; NOT in CI.

Coverage: non-stream chat, sync stream, async stream, embeddings
(event_type promotion), auth error (bad key).
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
    return make_sensor_session(flavor="smoke-openai")


@pytest.fixture(scope="module", autouse=True)
def _stack_ready() -> None:
    require_env("OPENAI_API_KEY")
    wait_for_dev_stack()


def test_openai_non_stream_chat() -> None:
    import openai
    sess = _sensor_session()
    client = openai.OpenAI()
    client.chat.completions.create(
        model="gpt-4o-mini",
        max_tokens=16,
        messages=[{"role": "user", "content": "say ok"}],
    )
    events = fetch_events_for_session(
        sess.config.session_id, expect_event_types=["post_call"],
    )
    assert any(e["event_type"] == "post_call" for e in events), events


def test_openai_embeddings_emits_embeddings_event() -> None:
    import openai
    sess = _sensor_session()
    client = openai.OpenAI()
    client.embeddings.create(
        model="text-embedding-3-small",
        input=["phase 4 smoke test"],
    )
    events = fetch_events_for_session(
        sess.config.session_id, expect_event_types=["embeddings"],
    )
    embeds = [e for e in events if e["event_type"] == "embeddings"]
    assert embeds, f"no embeddings event observed; events={events!r}"


def test_openai_sync_stream_carries_ttft() -> None:
    import openai
    sess = _sensor_session()
    client = openai.OpenAI()
    stream = client.chat.completions.create(
        model="gpt-4o-mini",
        max_tokens=16,
        messages=[{"role": "user", "content": "count 1 2 3"}],
        stream=True,
    )
    # openai's stream() returns a GuardedStream; iterate it.
    with stream as s:
        for _ in s:
            pass
    events = fetch_events_for_session(
        sess.config.session_id, expect_event_types=["post_call"],
    )
    streamed = [
        e for e in events
        if e["event_type"] == "post_call"
        and e.get("payload", {}).get("streaming")
    ]
    assert streamed, events


def test_openai_async_stream_carries_ttft() -> None:
    import openai
    sess = _sensor_session()
    client = openai.AsyncOpenAI()

    async def run() -> None:
        s = await client.chat.completions.create(
            model="gpt-4o-mini",
            max_tokens=16,
            messages=[{"role": "user", "content": "say hi"}],
            stream=True,
        )
        async with s:
            async for _ in s:
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
    assert streamed, events


def test_openai_auth_error_classifies_correctly() -> None:
    import openai
    sess = _sensor_session()
    # Deliberately bogus key; overrides the env-configured client for
    # this one request. Every other smoke test in this module uses
    # the real key via default client construction.
    client = openai.OpenAI(api_key="sk-definitely-not-a-real-key")
    with pytest.raises(Exception):
        client.chat.completions.create(
            model="gpt-4o-mini",
            max_tokens=4,
            messages=[{"role": "user", "content": "hi"}],
        )
    events = fetch_events_for_session(
        sess.config.session_id, expect_event_types=["llm_error"],
    )
    errors = [e for e in events if e["event_type"] == "llm_error"]
    assert errors, f"no llm_error observed; events={events!r}"
    assert errors[-1]["payload"]["error"]["error_type"] == "authentication"
