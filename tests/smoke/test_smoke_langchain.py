"""LangChain Phase 4 smoke test. Runs manually; NOT in CI.

LangChain is transitively covered by the Anthropic + OpenAI interceptors
(``langchain-anthropic`` calls ``client.messages.create()``;
``langchain-openai`` calls ``client.chat.completions.create()``). This
smoke test proves the wrapping still fires when the call arrives via
LangChain's abstraction -- regression guard against an SDK version
upgrade that changes the call shape.
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
    return make_sensor_session(flavor="smoke-langchain")


@pytest.fixture(scope="module", autouse=True)
def _stack_ready() -> None:
    require_env("ANTHROPIC_API_KEY", "OPENAI_API_KEY")
    wait_for_dev_stack()


def test_langchain_chat_anthropic_invoke() -> None:
    from langchain_anthropic import ChatAnthropic
    sess = _sensor_session()
    llm = ChatAnthropic(
        model="claude-haiku-4-5-20251001", max_tokens=16,
    )
    llm.invoke("say ok")
    events = fetch_events_for_session(
        sess.config.session_id, expect_event_types=["post_call"],
    )
    assert any(e["event_type"] == "post_call" for e in events), events


def test_langchain_chat_openai_invoke() -> None:
    from langchain_openai import ChatOpenAI
    sess = _sensor_session()
    llm = ChatOpenAI(model="gpt-4o-mini", max_tokens=16)
    llm.invoke("say ok")
    events = fetch_events_for_session(
        sess.config.session_id, expect_event_types=["post_call"],
    )
    assert any(e["event_type"] == "post_call" for e in events), events


def test_langchain_openai_embeddings_emits_embeddings_event() -> None:
    from langchain_openai import OpenAIEmbeddings
    sess = _sensor_session()
    e = OpenAIEmbeddings(model="text-embedding-3-small")
    e.embed_query("phase 4 smoke")
    events = fetch_events_for_session(
        sess.config.session_id, expect_event_types=["embeddings"],
    )
    embeds = [ev for ev in events if ev["event_type"] == "embeddings"]
    assert embeds, f"no embeddings event; events={events!r}"
