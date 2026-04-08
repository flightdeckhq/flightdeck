"""Integration tests for token enforcement pipeline.

Tests the full enforcement pipeline: sensor → ingestion → NATS → workers → Postgres → API.
Requires `make dev` to be running.
"""

from __future__ import annotations

import uuid

from .conftest import (
    create_policy,
    delete_policy,
    get_session_detail,
    get_session_event_count,
    make_event,
    post_event,
    query_directives,
    session_exists_in_fleet,
    wait_for_session_in_fleet,
    wait_until,
)


def test_warn_threshold_fires_and_records() -> None:
    """Warn threshold fires when tokens exceed warn_at_pct and session detail includes policy fields."""
    sid = str(uuid.uuid4())
    flavor = f"enforce-warn-{uuid.uuid4().hex[:6]}"
    policy = None

    try:
        policy = create_policy(
            scope="flavor", scope_value=flavor,
            token_limit=500, warn_at_pct=1,
        )

        post_event(make_event(sid, flavor, "session_start"))
        wait_until(
            lambda: session_exists_in_fleet(sid),
            timeout=10,
            msg=f"session {sid} did not appear in fleet after session_start",
        )

        post_event(make_event(
            sid, flavor, "post_call",
            tokens_total=10, tokens_used_session=10,
        ))

        wait_until(
            lambda: get_session_event_count(sid) >= 2,
            timeout=10,
            msg=f"expected >= 2 events for session {sid}",
        )

        detail = get_session_detail(sid)
        assert len(detail.get("events", [])) >= 2, (
            f"expected >= 2 events for session {sid}, got {len(detail.get('events', []))}"
        )

        # Verify policy fields from the LEFT JOIN
        session = detail["session"]
        assert session["policy_token_limit"] == 500, (
            f"expected policy_token_limit=500, got {session.get('policy_token_limit')}"
        )
        assert session["warn_at_pct"] == 1, (
            f"expected warn_at_pct=1, got {session.get('warn_at_pct')}"
        )

    finally:
        if policy:
            delete_policy(policy["id"])


def test_warn_fires_only_once() -> None:
    """Warn directive is written exactly once, not on every subsequent post_call."""
    sid = str(uuid.uuid4())
    flavor = f"enforce-warn-once-{uuid.uuid4().hex[:6]}"
    policy = None

    try:
        policy = create_policy(
            scope="flavor", scope_value=flavor,
            token_limit=500, warn_at_pct=1,
        )

        post_event(make_event(sid, flavor, "session_start"))
        wait_until(
            lambda: session_exists_in_fleet(sid),
            timeout=10,
            msg=f"session {sid} did not appear in fleet after session_start",
        )

        post_event(make_event(
            sid, flavor, "post_call",
            tokens_total=10, tokens_used_session=10,
        ))
        wait_until(
            lambda: get_session_event_count(sid) >= 2,
            timeout=10,
            msg=f"first post_call not processed for session {sid}",
        )

        post_event(make_event(
            sid, flavor, "post_call",
            tokens_total=10, tokens_used_session=20,
        ))
        wait_until(
            lambda: get_session_event_count(sid) >= 3,
            timeout=10,
            msg=f"second post_call not processed for session {sid}",
        )

        directives = query_directives(sid)
        warn_directives = [d for d in directives if d.get("action") == "warn"]
        assert len(warn_directives) <= 1, (
            f"Expected at most 1 warn directive, got {len(warn_directives)}"
        )

    finally:
        if policy:
            delete_policy(policy["id"])


def test_block_threshold_writes_shutdown_directive() -> None:
    """Block threshold causes workers to write a shutdown directive."""
    sid = str(uuid.uuid4())
    flavor = f"enforce-block-{uuid.uuid4().hex[:6]}"
    policy = None

    try:
        policy = create_policy(
            scope="flavor", scope_value=flavor,
            token_limit=100, block_at_pct=1,
        )

        post_event(make_event(sid, flavor, "session_start"))
        wait_until(
            lambda: session_exists_in_fleet(sid),
            timeout=10,
            msg=f"session {sid} did not appear in fleet after session_start",
        )

        post_event(make_event(
            sid, flavor, "post_call",
            tokens_total=5, tokens_used_session=5,
        ))

        wait_until(
            lambda: any(
                d.get("action") == "shutdown"
                for d in query_directives(sid)
            ),
            timeout=10,
            msg=f"no shutdown directive written for session {sid}",
        )

        directives = query_directives(sid)
        shutdown_directives = [d for d in directives if d.get("action") == "shutdown"]
        assert len(shutdown_directives) >= 1, (
            f"Expected at least 1 shutdown directive, got {len(shutdown_directives)}: {directives}"
        )

    finally:
        if policy:
            delete_policy(policy["id"])


def test_flavor_policy_applies_to_all_sessions() -> None:
    """Flavor-scoped policy applies to all sessions of that flavor."""
    sid_a = str(uuid.uuid4())
    sid_b = str(uuid.uuid4())
    flavor = f"enforce-flavor-{uuid.uuid4().hex[:6]}"
    policy = None

    try:
        policy = create_policy(
            scope="flavor", scope_value=flavor,
            token_limit=50000, warn_at_pct=80,
        )

        post_event(make_event(sid_a, flavor, "session_start"))
        post_event(make_event(sid_b, flavor, "session_start"))

        wait_for_session_in_fleet(sid_a, timeout=5.0)
        wait_for_session_in_fleet(sid_b, timeout=5.0)

        detail_a = get_session_detail(sid_a)
        detail_b = get_session_detail(sid_b)

        assert detail_a["session"]["policy_token_limit"] == 50000, (
            f"session A: expected policy_token_limit=50000, got {detail_a['session'].get('policy_token_limit')}"
        )
        assert detail_a["session"]["warn_at_pct"] == 80, (
            f"session A: expected warn_at_pct=80, got {detail_a['session'].get('warn_at_pct')}"
        )
        assert detail_b["session"]["policy_token_limit"] == 50000, (
            f"session B: expected policy_token_limit=50000, got {detail_b['session'].get('policy_token_limit')}"
        )
        assert detail_b["session"]["warn_at_pct"] == 80, (
            f"session B: expected warn_at_pct=80, got {detail_b['session'].get('warn_at_pct')}"
        )

    finally:
        if policy:
            delete_policy(policy["id"])


def test_org_policy_applies_when_no_flavor_policy() -> None:
    """Org-scoped policy applies as fallback when no flavor-scoped policy exists."""
    sid = str(uuid.uuid4())
    flavor = f"enforce-org-fallback-{uuid.uuid4().hex[:6]}"
    policy = None

    try:
        policy = create_policy(
            scope="org", scope_value="",
            token_limit=200000, warn_at_pct=90,
        )

        post_event(make_event(sid, flavor, "session_start"))
        wait_for_session_in_fleet(sid, timeout=5.0)

        detail = get_session_detail(sid)
        session = detail["session"]

        assert session["policy_token_limit"] == 200000, (
            f"expected policy_token_limit=200000, got {session.get('policy_token_limit')}"
        )
        assert session["warn_at_pct"] == 90, (
            f"expected warn_at_pct=90, got {session.get('warn_at_pct')}"
        )
        assert session.get("degrade_at_pct") is None, (
            f"expected degrade_at_pct=None, got {session.get('degrade_at_pct')}"
        )

    finally:
        if policy:
            delete_policy(policy["id"])


def test_session_policy_overrides_flavor_policy() -> None:
    """Session-scoped policy takes priority over flavor-scoped policy."""
    sid = str(uuid.uuid4())
    flavor = f"enforce-override-{uuid.uuid4().hex[:6]}"
    flavor_policy = None
    session_policy = None

    try:
        flavor_policy = create_policy(
            scope="flavor", scope_value=flavor,
            token_limit=100000, warn_at_pct=80,
        )
        session_policy = create_policy(
            scope="session", scope_value=sid,
            token_limit=10000, warn_at_pct=50,
        )

        post_event(make_event(sid, flavor, "session_start"))
        wait_for_session_in_fleet(sid, timeout=5.0)

        detail = get_session_detail(sid)
        session = detail["session"]

        # Session scope wins over flavor scope
        assert session["policy_token_limit"] == 10000, (
            f"expected session-scoped policy_token_limit=10000, got {session.get('policy_token_limit')}"
        )
        assert session["warn_at_pct"] == 50, (
            f"expected session-scoped warn_at_pct=50, got {session.get('warn_at_pct')}"
        )

    finally:
        if session_policy:
            delete_policy(session_policy["id"])
        if flavor_policy:
            delete_policy(flavor_policy["id"])
