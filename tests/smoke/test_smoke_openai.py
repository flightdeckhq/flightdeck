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


def test_openai_embeddings_capture_single_string() -> None:
    """Phase 4 polish S-EMBED-6: capture_prompts=True with a
    single-string input must populate ``has_content=true`` AND the
    fetched ``content.input`` round-trips intact."""
    import openai
    sess = _sensor_session()  # make_sensor_session defaults capture_prompts=True
    client = openai.OpenAI()
    payload = "phase 4 smoke single-string capture"
    client.embeddings.create(
        model="text-embedding-3-small",
        input=payload,
    )
    events = fetch_events_for_session(
        sess.config.session_id, expect_event_types=["embeddings"],
    )
    embed = next(
        (e for e in events if e["event_type"] == "embeddings"), None,
    )
    assert embed is not None, f"no embedding event; events={events!r}"
    assert embed.get("has_content") is True, (
        f"expected has_content=True with capture_prompts=True; got {embed!r}"
    )
    # Pull /v1/events/{id}/content; assert input round-trips.
    import httpx
    from tests.smoke.conftest import API_URL, API_TOKEN
    r = httpx.get(
        f"{API_URL}/v1/events/{embed['id']}/content",
        headers={"Authorization": f"Bearer {API_TOKEN}"},
        timeout=5.0,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get("input") == payload, (
        f"input did not round-trip: got {body.get('input')!r}"
    )


def test_openai_embeddings_capture_list_of_strings() -> None:
    """Phase 4 polish S-EMBED-6: list-of-strings input round-trips
    too. Distinct test so a single failure narrows the regression
    to one input shape."""
    import openai
    sess = _sensor_session()
    client = openai.OpenAI()
    payload = ["item one", "item two", "item three"]
    client.embeddings.create(
        model="text-embedding-3-small",
        input=payload,
    )
    events = fetch_events_for_session(
        sess.config.session_id, expect_event_types=["embeddings"],
    )
    embed = next(
        (e for e in events if e["event_type"] == "embeddings"), None,
    )
    assert embed is not None
    assert embed.get("has_content") is True
    import httpx
    from tests.smoke.conftest import API_URL, API_TOKEN
    r = httpx.get(
        f"{API_URL}/v1/events/{embed['id']}/content",
        headers={"Authorization": f"Bearer {API_TOKEN}"},
        timeout=5.0,
    )
    assert r.status_code == 200
    body = r.json()
    assert body.get("input") == payload, body


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
