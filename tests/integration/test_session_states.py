"""Integration tests for session state transitions.

Tests the five-state lifecycle: active → idle → stale → closed/lost.
Requires `make dev` to be running.
"""

from __future__ import annotations

import uuid

from .conftest import (
    get_session,
    get_session_detail,
    make_event,
    post_event,
    post_heartbeat,
    wait_for_session_in_fleet,
    wait_for_state,
    wait_until,
)


# Removed in Phase 4.5 audit Task 1:
#   - test_new_session_starts_active: same assertion as
#     test_pipeline.py::test_post_event_session_appears_in_fleet
#     (both verify state=active after session_start).
#   - test_stale_after_no_signal: was a no-op test that only verified
#     state=active immediately after creation. The actual stale
#     transition requires waiting 2 minutes for the background
#     reconciler and is unit-tested in
#     workers/tests/processor_test.go::TestReconciler_SetsStaleAfter2Min
#     and ::TestReconciler_SetsLostAfter10Min.


def test_session_with_heartbeats_only_stays_active() -> None:
    """Session with heartbeats but no LLM calls remains active (not idle).

    Note: the idle transition requires the background reconciler which runs
    every 60s. In Phase 1, sessions receiving heartbeats stay active.
    """
    sid = str(uuid.uuid4())
    flavor = f"test-hb-{uuid.uuid4().hex[:6]}"

    post_event(make_event(sid, flavor, "session_start"))
    wait_for_session_in_fleet(sid, timeout=5.0)

    # Send a heartbeat
    post_heartbeat(sid)

    # Wait until heartbeat is processed (event count increases)
    wait_until(
        lambda: len(get_session_detail(sid).get("events", [])) >= 1,
        timeout=10,
        msg=f"heartbeat not processed for session {sid}",
    )

    detail = get_session(sid)
    # Should still be active (heartbeat keeps it alive)
    assert detail["session"]["state"] == "active", (
        f"expected session {sid} to stay active after heartbeat, "
        f"got state={detail['session'].get('state')}"
    )


def test_session_transitions_to_closed() -> None:
    """Session receiving session_end transitions to closed."""
    sid = str(uuid.uuid4())
    flavor = f"test-closed-{uuid.uuid4().hex[:6]}"

    post_event(make_event(sid, flavor, "session_start"))
    wait_for_session_in_fleet(sid, timeout=5.0)

    post_event(make_event(sid, flavor, "session_end"))

    detail = wait_for_state(sid, "closed", timeout=10)
    assert detail["session"]["state"] == "closed", (
        f"expected session {sid} state=closed after session_end, "
        f"got state={detail['session'].get('state')}"
    )
    assert detail["session"]["ended_at"] is not None, (
        f"expected ended_at to be set for closed session {sid}"
    )
