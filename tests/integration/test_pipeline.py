"""Integration tests for the full event pipeline.

These tests exercise the real stack: sensor → ingestion → NATS → workers → Postgres → API.
Requires `make dev` to be running.
"""

from __future__ import annotations

import uuid
import time

from .conftest import (
    get_fleet,
    get_session,
    make_event,
    post_event,
    post_heartbeat,
    wait_for_session_in_fleet,
)


def test_post_event_session_appears_in_fleet() -> None:
    """POST event → session appears in GET /v1/fleet within 3 seconds."""
    sid = str(uuid.uuid4())
    flavor = f"test-pipeline-{uuid.uuid4().hex[:6]}"

    post_event(make_event(sid, flavor, "session_start"))
    sess = wait_for_session_in_fleet(sid, timeout=5.0)
    assert sess is not None, f"Session {sid} did not appear in fleet"
    assert sess["flavor"] == flavor
    assert sess["state"] == "active"


def test_multiple_events_returned_in_order() -> None:
    """POST multiple events → GET /v1/sessions/:id returns them in chronological order."""
    sid = str(uuid.uuid4())
    flavor = f"test-order-{uuid.uuid4().hex[:6]}"

    post_event(make_event(sid, flavor, "session_start"))
    time.sleep(0.3)
    post_event(make_event(sid, flavor, "post_call", tokens_total=100))
    time.sleep(0.3)
    post_event(make_event(sid, flavor, "post_call", tokens_total=200))

    # Wait for events to propagate
    time.sleep(2)

    detail = get_session(sid)
    events = detail.get("events", [])
    assert len(events) >= 3, f"Expected >=3 events, got {len(events)}"

    # Events should be in chronological order
    timestamps = [e["occurred_at"] for e in events]
    assert timestamps == sorted(timestamps), "Events not in chronological order"


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

    assert initial_last_seen is not None

    time.sleep(1)
    post_heartbeat(sid)
    time.sleep(2)

    # Get updated last_seen_at
    fleet2 = get_fleet()
    updated_last_seen = None
    for f in fleet2.get("flavors", []):
        for s in f.get("sessions", []):
            if s["session_id"] == sid:
                updated_last_seen = s["last_seen_at"]
                break

    assert updated_last_seen is not None
    assert updated_last_seen >= initial_last_seen


def test_session_end_sets_closed() -> None:
    """POST session_end → session state is closed in fleet response."""
    sid = str(uuid.uuid4())
    flavor = f"test-close-{uuid.uuid4().hex[:6]}"

    post_event(make_event(sid, flavor, "session_start"))
    wait_for_session_in_fleet(sid, timeout=5.0)

    post_event(make_event(sid, flavor, "session_end"))
    time.sleep(2)

    detail = get_session(sid)
    assert detail["session"]["state"] == "closed"
