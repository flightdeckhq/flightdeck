"""Phase 4 event-shape integration tests.

Wire-seeded (not sensor-driven): hand-crafts ``embeddings`` and
``llm_error`` event payloads, POSTs them through the real ingestion
API, and asserts they round-trip through NATS + worker + Postgres to
land on ``/v1/events`` with the correct structured fields.

Covers:

* ``event_type="embeddings"`` round-trips with tokens_input and
  tokens_output=0 preserved.
* ``event_type="llm_error"`` round-trips with the full error sub-object
  (error_type, provider, http_status, is_retryable, request_id).
* Streaming sub-object on ``post_call`` round-trips with TTFT + chunk
  count intact.
* ``/v1/sessions?error_type=X`` filters to sessions that emitted at
  least one matching ``llm_error`` event.

These tests are mock-free: the only thing they don't touch is the
provider SDKs themselves (those are the smoke-test's job). Everything
from the wire boundary inwards is real.
"""

from __future__ import annotations

import urllib.parse
import urllib.request
import uuid
from typing import Any

from .conftest import (
    API_URL,
    auth_headers,
    get_session_detail,
    get_session_event_count,
    make_event,
    post_event,
    session_exists_in_fleet,
    wait_until,
)


def _wait_for_event_count(session_id: str, want: int, timeout: float = 10.0) -> None:
    wait_until(
        lambda: get_session_event_count(session_id) >= want,
        timeout=timeout,
        msg=f"expected >= {want} events for session {session_id}",
    )


def _fetch_session_events(session_id: str) -> list[dict[str, Any]]:
    detail = get_session_detail(session_id)
    return detail.get("events", [])


def test_embeddings_event_roundtrips_with_input_only_tokens() -> None:
    sid = str(uuid.uuid4())
    flavor = f"test-phase4-embed-{uuid.uuid4().hex[:6]}"

    post_event(make_event(sid, flavor, "session_start"))
    wait_until(
        lambda: session_exists_in_fleet(sid), timeout=10,
        msg=f"session {sid} did not appear",
    )

    post_event(make_event(
        sid, flavor, "embeddings",
        model="text-embedding-3-small",
        tokens_input=42, tokens_output=0, tokens_total=42,
    ))
    _wait_for_event_count(sid, 2)
    events = _fetch_session_events(sid)
    embed = next((e for e in events if e["event_type"] == "embeddings"), None)
    assert embed is not None, f"no embeddings event in {events!r}"
    assert embed["tokens_input"] == 42
    assert embed["tokens_output"] == 0
    assert embed["model"] == "text-embedding-3-small"


def test_llm_error_event_roundtrips_with_structured_error() -> None:
    sid = str(uuid.uuid4())
    flavor = f"test-phase4-err-{uuid.uuid4().hex[:6]}"

    post_event(make_event(sid, flavor, "session_start"))
    wait_until(
        lambda: session_exists_in_fleet(sid), timeout=10,
        msg=f"session {sid} did not appear",
    )

    error_payload = {
        "error_type": "rate_limit",
        "provider": "anthropic",
        "http_status": 429,
        "provider_error_code": "rate_limit_exceeded",
        "error_message": "RateLimitError: slow down",
        "request_id": "req_abc123",
        "retry_after": 30,
        "is_retryable": True,
    }
    post_event(make_event(
        sid, flavor, "llm_error",
        model="claude-sonnet-4-6",
        latency_ms=120,
        error=error_payload,
    ))
    _wait_for_event_count(sid, 2)
    events = _fetch_session_events(sid)
    err_evt = next((e for e in events if e["event_type"] == "llm_error"), None)
    assert err_evt is not None, f"no llm_error event in {events!r}"
    payload_error = err_evt.get("payload", {}).get("error")
    assert payload_error is not None, f"no structured error in {err_evt!r}"
    assert payload_error["error_type"] == "rate_limit"
    assert payload_error["provider"] == "anthropic"
    assert payload_error["http_status"] == 429
    assert payload_error["is_retryable"] is True
    assert payload_error["request_id"] == "req_abc123"


def test_streaming_post_call_preserves_ttft_and_chunk_stats() -> None:
    sid = str(uuid.uuid4())
    flavor = f"test-phase4-stream-{uuid.uuid4().hex[:6]}"

    post_event(make_event(sid, flavor, "session_start"))
    wait_until(
        lambda: session_exists_in_fleet(sid), timeout=10,
        msg=f"session {sid} did not appear",
    )

    streaming = {
        "ttft_ms": 320,
        "chunk_count": 42,
        "inter_chunk_ms": {"p50": 25, "p95": 80, "max": 150},
        "final_outcome": "completed",
        "abort_reason": None,
    }
    post_event(make_event(
        sid, flavor, "post_call",
        model="claude-sonnet-4-6",
        tokens_input=100, tokens_output=200, tokens_total=300,
        latency_ms=1500,
        streaming=streaming,
    ))
    _wait_for_event_count(sid, 2)
    events = _fetch_session_events(sid)
    pc = next((e for e in events if e["event_type"] == "post_call"), None)
    assert pc is not None, f"no post_call in {events!r}"
    s = pc.get("payload", {}).get("streaming")
    assert s is not None, f"no streaming sub-object; event={pc!r}"
    assert s["ttft_ms"] == 320
    assert s["chunk_count"] == 42
    assert s["inter_chunk_ms"] == {"p50": 25, "p95": 80, "max": 150}
    assert s["final_outcome"] == "completed"


def test_sessions_error_type_filter_narrows_result() -> None:
    # Seed two sessions: one emits a rate_limit llm_error, the other
    # emits a timeout llm_error. /v1/sessions?error_type=rate_limit
    # returns only the first; error_type=timeout returns only the
    # second. Lightweight end-to-end validation of the Phase 4 API
    # filter landed in commit ``feat(api): Phase 4 /v1/sessions error_type filter``.
    sid_rl = str(uuid.uuid4())
    sid_to = str(uuid.uuid4())
    flavor_rl = f"test-phase4-filter-rl-{uuid.uuid4().hex[:6]}"
    flavor_to = f"test-phase4-filter-to-{uuid.uuid4().hex[:6]}"

    for sid, flavor in ((sid_rl, flavor_rl), (sid_to, flavor_to)):
        post_event(make_event(sid, flavor, "session_start"))
    wait_until(
        lambda: session_exists_in_fleet(sid_rl) and session_exists_in_fleet(sid_to),
        timeout=10,
        msg="sessions did not appear",
    )

    post_event(make_event(
        sid_rl, flavor_rl, "llm_error",
        error={
            "error_type": "rate_limit", "provider": "anthropic",
            "http_status": 429, "provider_error_code": None,
            "error_message": "x", "request_id": None,
            "retry_after": None, "is_retryable": True,
        },
    ))
    post_event(make_event(
        sid_to, flavor_to, "llm_error",
        error={
            "error_type": "timeout", "provider": "openai",
            "http_status": None, "provider_error_code": None,
            "error_message": "x", "request_id": None,
            "retry_after": None, "is_retryable": True,
        },
    ))
    _wait_for_event_count(sid_rl, 2)
    _wait_for_event_count(sid_to, 2)

    def _fetch(error_type: str) -> list[str]:
        qs = urllib.parse.urlencode({
            "error_type": error_type,
            "from": "2020-01-01T00:00:00Z",
            "limit": 100,
        })
        req = urllib.request.Request(
            f"{API_URL}/v1/sessions?{qs}", headers=auth_headers(),
        )
        import json as _json
        with urllib.request.urlopen(req, timeout=5) as resp:
            body = _json.loads(resp.read())
        return [s["session_id"] for s in body.get("sessions", [])]

    rl_ids = _fetch("rate_limit")
    to_ids = _fetch("timeout")
    assert sid_rl in rl_ids, f"rate_limit filter missing {sid_rl}: got {rl_ids}"
    assert sid_to not in rl_ids, f"rate_limit filter leaked {sid_to}: got {rl_ids}"
    assert sid_to in to_ids, f"timeout filter missing {sid_to}: got {to_ids}"
    assert sid_rl not in to_ids, f"timeout filter leaked {sid_rl}: got {to_ids}"


def test_sessions_listing_exposes_error_types_per_session() -> None:
    # Phase 4 polish: the /v1/sessions listing carries a per-row
    # ``error_types: []string`` aggregate of every distinct
    # ``payload->'error'->>'error_type'`` observed across the
    # session's llm_error events. Powers the dashboard's ERROR TYPE
    # facet and the row-level red error indicator without a
    # per-session follow-up fetch. Three shapes covered here:
    #   - clean session (no errors): error_types is the empty list
    #   - one error: error_types contains exactly that taxonomy value
    #   - multiple distinct errors: error_types contains every value
    #     once, no duplicates
    sid_clean = str(uuid.uuid4())
    sid_one = str(uuid.uuid4())
    sid_many = str(uuid.uuid4())
    flavor = f"test-phase4-error-types-{uuid.uuid4().hex[:6]}"

    for sid in (sid_clean, sid_one, sid_many):
        post_event(make_event(sid, flavor, "session_start"))
    wait_until(
        lambda: all(
            session_exists_in_fleet(s) for s in (sid_clean, sid_one, sid_many)
        ),
        timeout=10,
        msg="sessions did not appear",
    )

    post_event(make_event(
        sid_one, flavor, "llm_error",
        error={
            "error_type": "rate_limit", "provider": "anthropic",
            "http_status": 429, "provider_error_code": None,
            "error_message": "x", "request_id": None,
            "retry_after": 30, "is_retryable": True,
        },
    ))
    # Two distinct error_types on sid_many, plus a duplicate of one
    # of them so the DISTINCT in the aggregate has something to
    # collapse.
    for et in ("authentication", "context_overflow", "authentication"):
        post_event(make_event(
            sid_many, flavor, "llm_error",
            error={
                "error_type": et, "provider": "openai",
                "http_status": 400, "provider_error_code": None,
                "error_message": "x", "request_id": None,
                "retry_after": None, "is_retryable": False,
            },
        ))
    _wait_for_event_count(sid_one, 2)
    _wait_for_event_count(sid_many, 4)

    qs = urllib.parse.urlencode({
        "flavor": flavor,
        "from": "2020-01-01T00:00:00Z",
        "limit": 100,
    })
    req = urllib.request.Request(
        f"{API_URL}/v1/sessions?{qs}", headers=auth_headers(),
    )
    import json as _json
    with urllib.request.urlopen(req, timeout=5) as resp:
        body = _json.loads(resp.read())

    by_id: dict[str, list[str]] = {
        s["session_id"]: s.get("error_types") or [] for s in body.get("sessions", [])
    }
    assert sid_clean in by_id, f"clean session missing from listing: {by_id!r}"
    assert by_id[sid_clean] == [], (
        f"clean session should have empty error_types, got {by_id[sid_clean]!r}"
    )
    assert by_id[sid_one] == ["rate_limit"], (
        f"single-error session should carry exactly its error_type, got {by_id[sid_one]!r}"
    )
    # Set comparison -- the aggregate's order is unspecified by the
    # SQL DISTINCT clause; we only require value presence + dedupe.
    assert set(by_id[sid_many]) == {"authentication", "context_overflow"}, (
        f"multi-error session lost a distinct value or kept a dupe: {by_id[sid_many]!r}"
    )
    assert len(by_id[sid_many]) == 2, (
        f"multi-error session should dedupe duplicates: got {by_id[sid_many]!r}"
    )


def test_embeddings_content_input_roundtrips() -> None:
    """Phase 4 polish S-EMBED-4: ``content.input`` round-trips
    ingestion → worker → event_content table → ``GET
    /v1/events/{id}/content``. Asserts both the single-string and
    list-of-strings shapes survive intact (no normalisation /
    re-shaping at any layer)."""
    sid = str(uuid.uuid4())
    flavor = f"test-phase4-embed-content-{uuid.uuid4().hex[:6]}"

    post_event(make_event(sid, flavor, "session_start"))
    wait_until(
        lambda: session_exists_in_fleet(sid), timeout=10,
        msg=f"session {sid} did not appear",
    )

    # Single-string input
    post_event(make_event(
        sid, flavor, "embeddings",
        model="text-embedding-3-small",
        tokens_input=24,
        has_content=True,
        content={
            "provider": "openai",
            "model": "text-embedding-3-small",
            "system": None,
            "messages": [],
            "tools": None,
            "response": {},
            "input": "phase 4 e2e single-string capture",
            "session_id": sid,
            "event_id": "",
            "captured_at": "2026-04-25T00:00:00Z",
        },
    ))

    # List-of-strings input
    post_event(make_event(
        sid, flavor, "embeddings",
        model="text-embedding-3-small",
        tokens_input=42,
        has_content=True,
        content={
            "provider": "openai",
            "model": "text-embedding-3-small",
            "system": None,
            "messages": [],
            "tools": None,
            "response": {},
            "input": ["item one", "item two", "item three"],
            "session_id": sid,
            "event_id": "",
            "captured_at": "2026-04-25T00:00:00Z",
        },
    ))

    _wait_for_event_count(sid, 3)

    # Fetch via the per-event content endpoint and assert the input
    # field round-trips intact for both shapes.
    events = _fetch_session_events(sid)
    embed_events = [e for e in events if e["event_type"] == "embeddings"]
    assert len(embed_events) == 2

    import json as _json
    found_string = False
    found_list = False
    for e in embed_events:
        req = urllib.request.Request(
            f"{API_URL}/v1/events/{e['id']}/content",
            headers=auth_headers(),
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            body = _json.loads(resp.read())
        captured_input = body.get("input")
        if captured_input == "phase 4 e2e single-string capture":
            found_string = True
        elif captured_input == ["item one", "item two", "item three"]:
            found_list = True
    assert found_string, "single-string embedding input did not round-trip"
    assert found_list, "list embedding input did not round-trip"


def test_session_framework_filter_matches_attributed_sessions() -> None:
    """Phase 4 polish: the per-event ``framework`` field is now
    actively populated (pre-fix it was always null because
    ``Session.record_framework`` had no callers). ``/v1/sessions
    ?framework=langchain`` must return sessions whose events emit
    ``framework=langchain``.

    Seeds a session whose events explicitly carry ``framework="
    langchain"`` and one carrying ``framework="openai"``, then
    asserts the filter matches only the langchain session.
    """
    sid_lc = str(uuid.uuid4())
    sid_oa = str(uuid.uuid4())
    flavor_lc = f"test-fw-lc-{uuid.uuid4().hex[:6]}"
    flavor_oa = f"test-fw-oa-{uuid.uuid4().hex[:6]}"

    for sid, flavor, framework in (
        (sid_lc, flavor_lc, "langchain"),
        (sid_oa, flavor_oa, "openai"),
    ):
        post_event(make_event(
            sid, flavor, "session_start", framework=framework,
        ))
    wait_until(
        lambda: session_exists_in_fleet(sid_lc) and session_exists_in_fleet(sid_oa),
        timeout=10,
        msg="sessions did not appear",
    )

    # Filter the listing on framework=langchain. The langchain session
    # must surface; the openai session must not.
    qs = urllib.parse.urlencode({
        "framework": "langchain",
        "from": "2020-01-01T00:00:00Z",
        "limit": 100,
    })
    req = urllib.request.Request(
        f"{API_URL}/v1/sessions?{qs}", headers=auth_headers(),
    )
    import json as _json
    with urllib.request.urlopen(req, timeout=5) as resp:
        body = _json.loads(resp.read())
    matched = [s["session_id"] for s in body.get("sessions", [])]
    assert sid_lc in matched, (
        f"framework=langchain filter must include the langchain session: "
        f"got {matched}"
    )
    assert sid_oa not in matched, (
        f"framework=langchain filter must NOT include the openai session: "
        f"got {matched}"
    )
