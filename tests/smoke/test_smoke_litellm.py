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
