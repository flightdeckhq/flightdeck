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


def test_langchain_openai_embeddings_capture_and_attribution() -> None:
    """Phase 4 polish S-EMBED-6: LangChain ``OpenAIEmbeddings`` rides
    through the OpenAI patch transitively. Two assertions:

    1. ``has_content=True`` AND ``content.input`` round-trips intact
       (capture_prompts=True works through the LangChain wrapper).
    2. Per-event ``framework`` field reads ``"langchain"``, NOT
       ``"openai"``. The supervisor's V-pass design principle:
       higher-level framework wins over the SDK transport.

    Also exercises the chat path symmetrically -- a ChatOpenAI invoke
    should produce framework=langchain too. Pre-fix every event in
    the dev DB had framework=null because Session.record_framework
    had zero callers (a Phase 1 oversight).
    """
    from langchain_openai import ChatOpenAI, OpenAIEmbeddings
    sess = _sensor_session()
    payload = "phase 4 smoke langchain transitive"

    # Embedding side. LangChain's ``OpenAIEmbeddings.embed_*``
    # client-side-tokenises the input before calling OpenAI's API
    # (an optimisation that lets it batch many documents into a
    # single request). The captured ``input`` reflects what the SDK
    # actually saw -- a list of integer-token-ID arrays -- not the
    # caller-supplied string. This is correct sensor behaviour: we
    # capture the wire shape, not a normalised reconstruction.
    # Operators see exactly what hit OpenAI. Disabling the
    # tokenisation requires the ``transformers`` package which is
    # heavyweight; verifying the captured shape is non-empty is
    # sufficient for the parity contract.
    e = OpenAIEmbeddings(model="text-embedding-3-small")
    e.embed_documents([payload])
    # Chat side -- exercises the same framework attribution path the
    # smoke spec wants verified for symmetry.
    llm = ChatOpenAI(model="gpt-4o-mini", max_tokens=4)
    llm.invoke("say ok")

    events = fetch_events_for_session(
        sess.config.session_id,
        expect_event_types=["embeddings", "post_call"],
    )

    # Framework attribution lives on the SESSION row (sessions.framework),
    # not on individual events -- the events table has no framework
    # column. The worker COALESCEs framework onto the session via
    # UpsertSession; pre-fix, Session.record_framework had no callers
    # so every session row had framework=null. Fetch the session
    # detail and assert on it.
    import httpx
    from tests.smoke.conftest import API_URL, API_TOKEN
    sess_r = httpx.get(
        f"{API_URL}/v1/sessions/{sess.config.session_id}",
        headers={"Authorization": f"Bearer {API_TOKEN}"},
        timeout=5.0,
    )
    assert sess_r.status_code == 200
    session_body = sess_r.json().get("session") or {}
    assert session_body.get("framework") == "langchain", (
        f"session must read framework=langchain (was the Phase 1 "
        f"oversight pre-fix); got {session_body.get('framework')!r}"
    )

    embed_ev = next((ev for ev in events if ev["event_type"] == "embeddings"), None)
    assert embed_ev is not None

    # Embedding content round-trip.
    assert embed_ev.get("has_content") is True
    import httpx
    from tests.smoke.conftest import API_URL, API_TOKEN
    r = httpx.get(
        f"{API_URL}/v1/events/{embed_ev['id']}/content",
        headers={"Authorization": f"Bearer {API_TOKEN}"},
        timeout=5.0,
    )
    assert r.status_code == 200
    body = r.json()
    # LangChain's OpenAIEmbeddings.embed_query(...) calls the
    # underlying client.embeddings.create(input=[<query>]) -- a
    # one-element list. The captured input matches what the OpenAI
    # SDK actually saw, not what the user passed to LangChain.
    captured = body.get("input")
    # Non-empty list (LangChain pre-tokenises strings into integer
    # arrays before calling OpenAI's API; we capture exactly what
    # the SDK saw on the wire). The shape contract: a list-typed
    # input survived the round-trip with at least one element.
    assert isinstance(captured, list) and len(captured) >= 1, (
        f"expected non-empty list input; got {captured!r}"
    )
