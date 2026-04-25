"""litellm Phase 4 smoke test. Runs manually; NOT in CI.

Coverage: multi-provider chat, embeddings (new module-level patch),
provider-specific error pass-through.

litellm streaming remains out of scope (KI26); we don't smoke-test a
path that's explicitly unsupported.
"""

from __future__ import annotations

import pytest

from tests.smoke.conftest import (
    fetch_events_for_session,
    make_sensor_session,
    require_env,
    wait_for_dev_stack,
)


def _sensor_session():
    return make_sensor_session(flavor="smoke-litellm")


@pytest.fixture(scope="module", autouse=True)
def _stack_ready() -> None:
    require_env("ANTHROPIC_API_KEY", "OPENAI_API_KEY")
    wait_for_dev_stack()


def test_litellm_openai_completion() -> None:
    import litellm
    sess = _sensor_session()
    litellm.completion(
        model="gpt-4o-mini",
        max_tokens=16,
        messages=[{"role": "user", "content": "say ok"}],
    )
    events = fetch_events_for_session(
        sess.config.session_id, expect_event_types=["post_call"],
    )
    assert any(e["event_type"] == "post_call" for e in events), events


def test_litellm_anthropic_completion() -> None:
    import litellm
    sess = _sensor_session()
    litellm.completion(
        model="claude-haiku-4-5-20251001",
        max_tokens=16,
        messages=[{"role": "user", "content": "say ok"}],
    )
    events = fetch_events_for_session(
        sess.config.session_id, expect_event_types=["post_call"],
    )
    assert any(e["event_type"] == "post_call" for e in events), events


def test_litellm_embedding_emits_embeddings_event() -> None:
    import litellm
    sess = _sensor_session()
    litellm.embedding(
        model="text-embedding-3-small",
        input=["phase 4 smoke test"],
    )
    events = fetch_events_for_session(
        sess.config.session_id, expect_event_types=["embeddings"],
    )
    embeds = [e for e in events if e["event_type"] == "embeddings"]
    assert embeds, f"no embeddings event; events={events!r}"


def test_litellm_embeddings_capture_routes_to_openai() -> None:
    """Phase 4 polish S-EMBED-6: litellm-routed embedding with
    capture_prompts=True. Routes to OpenAI's text-embedding-3-small;
    verifies has_content=True and the input round-trips intact."""
    import litellm
    sess = _sensor_session()
    payload = "phase 4 smoke litellm route to openai"
    litellm.embedding(
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


def test_litellm_invalid_model_emits_llm_error() -> None:
    import litellm
    sess = _sensor_session()
    with pytest.raises(Exception):
        litellm.completion(
            model="not-a-real-model",
            max_tokens=16,
            messages=[{"role": "user", "content": "hi"}],
        )
    events = fetch_events_for_session(
        sess.config.session_id, expect_event_types=["llm_error"],
    )
    errors = [e for e in events if e["event_type"] == "llm_error"]
    assert errors, f"no llm_error; events={events!r}"
