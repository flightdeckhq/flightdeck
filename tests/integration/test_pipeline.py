"""Integration tests for the full event pipeline.

These tests exercise the real stack: sensor → ingestion → NATS → workers → Postgres → API.
Requires `make dev` to be running.
"""

from __future__ import annotations

import uuid

from .conftest import (
    get_fleet,
    get_session,
    get_session_event_count,
    make_event,
    post_event,
    post_heartbeat,
    session_exists_in_fleet,
    wait_for_session_in_fleet,
    wait_until,
)


def test_post_event_session_appears_in_fleet() -> None:
    """POST event → session appears in GET /v1/fleet within 3 seconds."""
    sid = str(uuid.uuid4())
    flavor = f"test-pipeline-{uuid.uuid4().hex[:6]}"

    post_event(make_event(sid, flavor, "session_start"))
    sess = wait_for_session_in_fleet(sid, timeout=5.0)
    assert sess is not None, (
        f"session {sid} did not appear in fleet after session_start"
    )
    assert sess["flavor"] == flavor, (
        f"expected flavor={flavor}, got {sess.get('flavor')}"
    )
    assert sess["state"] == "active", (
        f"expected state=active for new session {sid}, got {sess.get('state')}"
    )


def test_multiple_events_returned_in_order() -> None:
    """POST multiple events → GET /v1/sessions/:id returns them in chronological order."""
    sid = str(uuid.uuid4())
    flavor = f"test-order-{uuid.uuid4().hex[:6]}"

    post_event(make_event(sid, flavor, "session_start"))
    wait_until(
        lambda: session_exists_in_fleet(sid),
        timeout=10,
        msg=f"session {sid} did not appear after session_start",
    )

    post_event(make_event(sid, flavor, "post_call", tokens_total=100))
    wait_until(
        lambda: get_session_event_count(sid) >= 2,
        timeout=10,
        msg=f"second event not processed for session {sid}",
    )

    post_event(make_event(sid, flavor, "post_call", tokens_total=200))
    wait_until(
        lambda: get_session_event_count(sid) >= 3,
        timeout=10,
        msg=f"third event not processed for session {sid}",
    )

    detail = get_session(sid)
    events = detail.get("events", [])
    assert len(events) >= 3, (
        f"expected >= 3 events for session {sid}, got {len(events)}"
    )

    # Events should be in chronological order
    timestamps = [e["occurred_at"] for e in events]
    assert timestamps == sorted(timestamps), (
        f"events not in chronological order: {timestamps}"
    )


def test_heartbeat_updates_last_seen() -> None:
    """POST heartbeat → last_seen_at updates in fleet response."""
    sid = str(uuid.uuid4())
    flavor = f"test-heartbeat-{uuid.uuid4().hex[:6]}"

    post_event(make_event(sid, flavor, "session_start"))
    wait_for_session_in_fleet(sid, timeout=5.0)

    # Get initial last_seen_at
    fleet1 = get_fleet()
    initial_last_seen = None
    for f in fleet1.get("flavors", []):
        for s in f.get("sessions", []):
            if s["session_id"] == sid:
                initial_last_seen = s["last_seen_at"]
                break

    assert initial_last_seen is not None, (
        f"session {sid} has no last_seen_at after session_start"
    )

    post_heartbeat(sid)

    def _last_seen_updated() -> bool:
        fleet = get_fleet()
        for flav in fleet.get("flavors", []):
            for s in flav.get("sessions", []):
                if s["session_id"] == sid:
                    return s["last_seen_at"] > initial_last_seen
        return False

    wait_until(
        _last_seen_updated,
        timeout=10,
        msg=f"last_seen_at did not update for session {sid} after heartbeat",
    )

    fleet2 = get_fleet()
    updated_last_seen = None
    for f in fleet2.get("flavors", []):
        for s in f.get("sessions", []):
            if s["session_id"] == sid:
                updated_last_seen = s["last_seen_at"]
                break

    assert updated_last_seen is not None, (
        f"session {sid} not found in fleet after heartbeat"
    )
    assert updated_last_seen >= initial_last_seen, (
        f"expected last_seen_at to increase after heartbeat, "
        f"initial={initial_last_seen}, updated={updated_last_seen}"
    )


# test_session_end_sets_closed -- removed in Phase 4.5 audit Task 1.
# Exact duplicate of test_session_states.py::test_session_transitions_to_closed
# which already verifies session_end → state=closed AND ended_at is set.
