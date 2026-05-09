"""Integration tests for the operator-actionable enrichment facet
filters on GET /v1/sessions.

Each test seeds two sessions where one matches the facet criterion
and one doesn't, then asserts the API filters to exactly the
matching session. The sixth test composes three filters in a single
request to exercise the AND-composition path (a two-filter pass can
mask a parenthesisation bug in the WHERE builder).

The five filters covered:
  - close_reason
  - estimated_via
  - terminal
  - matched_entry_id
  - originating_call_context
"""

from __future__ import annotations

import json
import time
import urllib.parse
import urllib.request
import uuid
from typing import Any

import pytest

from ..shared.fixtures import API_URL, auth_headers, make_event, post_event


def _fetch_sessions(**filters: Any) -> dict[str, Any]:
    qs = urllib.parse.urlencode(
        {"from": "2020-01-01T00:00:00Z", "limit": 100, **filters},
        doseq=True,
    )
    req = urllib.request.Request(
        f"{API_URL}/v1/sessions?{qs}", headers=auth_headers(),
    )
    with urllib.request.urlopen(req, timeout=5) as resp:
        return json.loads(resp.read())


def _poll_for_session(
    expect_sid: str, deadline_secs: float = 5.0, **filters: Any,
) -> dict[str, Any]:
    """Poll _fetch_sessions until expect_sid appears or the deadline
    expires. Required because the seed → ingestion → NATS → worker →
    Postgres pipeline is async; events take a few hundred ms to land."""
    end = time.monotonic() + deadline_secs
    last: dict[str, Any] = {}
    while time.monotonic() < end:
        last = _fetch_sessions(**filters)
        sids = {s["session_id"] for s in last["sessions"]}
        if expect_sid in sids:
            return last
        time.sleep(0.1)
    return last


def _seed_session(session_id: str, flavor: str) -> None:
    """Open + immediately close a session so the row materialises."""
    post_event(make_event(session_id, flavor, "session_start"))


def _seed_close_reason(session_id: str, flavor: str, close_reason: str) -> None:
    _seed_session(session_id, flavor)
    # Brief gap so the worker's session_start INSERT lands before the
    # session_end arrives — the worker drops orphan session_end events
    # that arrive before the session row materialises.
    time.sleep(0.2)
    post_event(
        make_event(
            session_id, flavor, "session_end",
            close_reason=close_reason,
        ),
    )


@pytest.mark.integration
def test_close_reason_filter_narrows_to_matching_session() -> None:
    flavor = f"facet-close-reason-{uuid.uuid4().hex[:6]}"
    match_sid = str(uuid.uuid4())
    skip_sid = str(uuid.uuid4())
    _seed_close_reason(match_sid, flavor, "directive_shutdown")
    _seed_close_reason(skip_sid, flavor, "normal_exit")

    resp = _poll_for_session(
        match_sid, flavor=flavor, close_reason="directive_shutdown",
    )
    sids = {s["session_id"] for s in resp["sessions"]}
    assert match_sid in sids, (
        f"directive_shutdown session missing from filtered result: {sids}"
    )
    assert skip_sid not in sids, (
        f"normal_exit session leaked into directive_shutdown result: {sids}"
    )


@pytest.mark.integration
def test_estimated_via_filter_narrows_to_matching_session() -> None:
    flavor = f"facet-estimated-via-{uuid.uuid4().hex[:6]}"
    match_sid = str(uuid.uuid4())
    skip_sid = str(uuid.uuid4())
    _seed_session(match_sid, flavor)
    post_event(
        make_event(match_sid, flavor, "post_call", estimated_via="heuristic"),
    )
    _seed_session(skip_sid, flavor)
    post_event(
        make_event(skip_sid, flavor, "post_call", estimated_via="tiktoken"),
    )

    resp = _poll_for_session(match_sid, flavor=flavor, estimated_via="heuristic")
    sids = {s["session_id"] for s in resp["sessions"]}
    assert match_sid in sids
    assert skip_sid not in sids


@pytest.mark.integration
def test_terminal_filter_narrows_to_terminal_sessions() -> None:
    flavor = f"facet-terminal-{uuid.uuid4().hex[:6]}"
    match_sid = str(uuid.uuid4())
    skip_sid = str(uuid.uuid4())
    _seed_session(match_sid, flavor)
    post_event(
        make_event(
            match_sid, flavor, "llm_error",
            error={"error_type": "authentication", "is_retryable": False},
            retry_attempt=1,
            terminal=True,
        ),
    )
    _seed_session(skip_sid, flavor)
    post_event(
        make_event(
            skip_sid, flavor, "llm_error",
            error={"error_type": "rate_limit", "is_retryable": True},
            retry_attempt=1,
            terminal=False,
        ),
    )

    resp = _poll_for_session(match_sid, flavor=flavor, terminal="true")
    sids = {s["session_id"] for s in resp["sessions"]}
    assert match_sid in sids
    assert skip_sid not in sids


@pytest.mark.integration
def test_matched_entry_id_filter_narrows_to_matching_session() -> None:
    flavor = f"facet-matched-{uuid.uuid4().hex[:6]}"
    match_sid = str(uuid.uuid4())
    skip_sid = str(uuid.uuid4())
    target_entry = str(uuid.uuid4())
    other_entry = str(uuid.uuid4())
    _seed_session(match_sid, flavor)
    post_event(
        make_event(
            match_sid, flavor, "policy_mcp_block",
            server_url="stdio:///fake/server",
            server_name="fake-server",
            fingerprint="aaaaaaaaaaaaaaaa",
            policy_id=str(uuid.uuid4()),
            decision_path="flavor_entry",
            policy_decision={
                "policy_id": str(uuid.uuid4()),
                "scope": f"flavor:{flavor}",
                "decision": "block",
                "reason": "test",
                "decision_path": "flavor_entry",
                "matched_entry_id": target_entry,
                "matched_entry_label": "fake-server",
            },
        ),
    )
    _seed_session(skip_sid, flavor)
    post_event(
        make_event(
            skip_sid, flavor, "policy_mcp_block",
            server_url="stdio:///fake/other",
            server_name="other-server",
            fingerprint="bbbbbbbbbbbbbbbb",
            policy_id=str(uuid.uuid4()),
            decision_path="flavor_entry",
            policy_decision={
                "policy_id": str(uuid.uuid4()),
                "scope": f"flavor:{flavor}",
                "decision": "block",
                "reason": "test",
                "decision_path": "flavor_entry",
                "matched_entry_id": other_entry,
                "matched_entry_label": "other-server",
            },
        ),
    )

    resp = _poll_for_session(match_sid, flavor=flavor, matched_entry_id=target_entry)
    sids = {s["session_id"] for s in resp["sessions"]}
    assert match_sid in sids
    assert skip_sid not in sids


@pytest.mark.integration
def test_originating_call_context_filter_narrows() -> None:
    flavor = f"facet-origin-{uuid.uuid4().hex[:6]}"
    match_sid = str(uuid.uuid4())
    skip_sid = str(uuid.uuid4())
    _seed_session(match_sid, flavor)
    post_event(
        make_event(
            match_sid, flavor, "mcp_tool_call",
            server_name="fake", transport="stdio",
            originating_call_context="call_tool",
        ),
    )
    _seed_session(skip_sid, flavor)
    post_event(
        make_event(
            skip_sid, flavor, "mcp_resource_read",
            server_name="fake", transport="stdio",
            originating_call_context="read_resource",
            resource_uri="fake://x", content_bytes=10,
        ),
    )

    resp = _poll_for_session(
        match_sid, flavor=flavor, originating_call_context="call_tool",
    )
    sids = {s["session_id"] for s in resp["sessions"]}
    assert match_sid in sids
    assert skip_sid not in sids


@pytest.mark.integration
def test_three_filter_and_composition() -> None:
    """AND-composition guard: a parenthesisation bug in the WHERE
    builder can pass a two-filter test while breaking on three. Seed
    one session that matches all three filters and three sessions
    that each fail exactly one — verify only the all-matching one
    surfaces."""
    flavor = f"facet-three-{uuid.uuid4().hex[:6]}"

    # Match: terminal=true + close_reason=normal_exit + estimated_via=tiktoken.
    match_sid = str(uuid.uuid4())
    _seed_session(match_sid, flavor)
    post_event(
        make_event(match_sid, flavor, "post_call", estimated_via="tiktoken"),
    )
    post_event(
        make_event(
            match_sid, flavor, "llm_error",
            error={"error_type": "authentication", "is_retryable": False},
            retry_attempt=1, terminal=True,
        ),
    )
    post_event(
        make_event(match_sid, flavor, "session_end", close_reason="normal_exit"),
    )

    # Miss A: same close_reason + estimated_via, but terminal=false.
    miss_a = str(uuid.uuid4())
    _seed_session(miss_a, flavor)
    post_event(
        make_event(miss_a, flavor, "post_call", estimated_via="tiktoken"),
    )
    post_event(
        make_event(
            miss_a, flavor, "llm_error",
            error={"error_type": "rate_limit", "is_retryable": True},
            retry_attempt=1, terminal=False,
        ),
    )
    post_event(
        make_event(miss_a, flavor, "session_end", close_reason="normal_exit"),
    )

    # Miss B: terminal + close_reason match, but estimated_via=heuristic.
    miss_b = str(uuid.uuid4())
    _seed_session(miss_b, flavor)
    post_event(
        make_event(miss_b, flavor, "post_call", estimated_via="heuristic"),
    )
    post_event(
        make_event(
            miss_b, flavor, "llm_error",
            error={"error_type": "authentication", "is_retryable": False},
            retry_attempt=1, terminal=True,
        ),
    )
    post_event(
        make_event(miss_b, flavor, "session_end", close_reason="normal_exit"),
    )

    # Miss C: terminal + estimated_via match, but close_reason=directive_shutdown.
    miss_c = str(uuid.uuid4())
    _seed_session(miss_c, flavor)
    post_event(
        make_event(miss_c, flavor, "post_call", estimated_via="tiktoken"),
    )
    post_event(
        make_event(
            miss_c, flavor, "llm_error",
            error={"error_type": "authentication", "is_retryable": False},
            retry_attempt=1, terminal=True,
        ),
    )
    post_event(
        make_event(miss_c, flavor, "session_end", close_reason="directive_shutdown"),
    )

    resp = _poll_for_session(
        match_sid,
        flavor=flavor,
        terminal="true",
        close_reason="normal_exit",
        estimated_via="tiktoken",
    )
    sids = {s["session_id"] for s in resp["sessions"]}
    assert match_sid in sids, (
        f"all-match session missing under three-filter AND: {sids}"
    )
    assert miss_a not in sids, "session missing terminal=true leaked"
    assert miss_b not in sids, "session with estimated_via=heuristic leaked"
    assert miss_c not in sids, (
        "session with close_reason=directive_shutdown leaked"
    )
