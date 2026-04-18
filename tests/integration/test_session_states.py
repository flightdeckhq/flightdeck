"""Integration tests for session state transitions.

Tests the five-state lifecycle: active → idle → stale → closed/lost,
and the D105 revival path that flips stale/lost back to active on any
non-session_start event. Requires `make dev` to be running.
"""

from __future__ import annotations

import subprocess
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


def _exec_sql(sql: str) -> str:
    """Execute a SQL statement against the dev Postgres container.

    Used by the revival tests to force a session into a specific state
    without waiting for the background reconciler. Returns the trimmed
    psql output.
    """
    result = subprocess.run(
        [
            "docker", "exec", "docker-postgres-1", "psql",
            "-U", "flightdeck", "-d", "flightdeck",
            "-t", "-A", "-c", sql,
        ],
        capture_output=True,
        text=True,
        timeout=10,
        check=True,
    )
    return result.stdout.strip()


def _force_state(session_id: str, state: str) -> None:
    """Force a session into a given state via direct UPDATE.

    Avoids waiting 2–30 minutes for the reconciler to organically move a
    session through the lifecycle. Used only by tests that exercise the
    revival path.
    """
    _exec_sql(
        f"UPDATE sessions SET state = '{state}' "
        f"WHERE session_id = '{session_id}'::uuid"
    )


def _read_session_row(session_id: str) -> dict[str, str]:
    """Read state / last_seen_at / tokens_used straight from Postgres."""
    raw = _exec_sql(
        "SELECT state, last_seen_at, tokens_used FROM sessions "
        f"WHERE session_id = '{session_id}'::uuid"
    )
    parts = raw.split("|")
    if len(parts) != 3:
        raise AssertionError(f"unexpected session row for {session_id}: {raw!r}")
    return {"state": parts[0], "last_seen_at": parts[1], "tokens_used": parts[2]}


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


# ---------------------------------------------------------------------------
# D105 -- revive stale/lost sessions on any event; closed stays closed.
# ---------------------------------------------------------------------------


def test_lost_session_revives_on_post_call() -> None:
    """Session in state=lost receiving a post_call flips back to active,
    advances last_seen_at, and increments tokens_used (D105)."""
    sid = str(uuid.uuid4())
    flavor = f"test-revive-lost-{uuid.uuid4().hex[:6]}"

    post_event(make_event(sid, flavor, "session_start"))
    wait_for_session_in_fleet(sid, timeout=5.0)

    _force_state(sid, "lost")
    before = _read_session_row(sid)
    assert before["state"] == "lost"

    post_event(make_event(sid, flavor, "post_call", tokens_total=500))

    # Revival is synchronous in the worker but the POST is async via
    # NATS, so poll until the state flips back.
    detail = wait_for_state(sid, "active", timeout=10)
    assert detail["session"]["state"] == "active"

    after = _read_session_row(sid)
    assert after["last_seen_at"] != before["last_seen_at"], (
        f"last_seen_at should advance after revive; before={before['last_seen_at']} "
        f"after={after['last_seen_at']}"
    )
    assert int(after["tokens_used"]) == int(before["tokens_used"]) + 500, (
        f"tokens_used should increment by 500 after revive; "
        f"before={before['tokens_used']} after={after['tokens_used']}"
    )


def test_stale_session_revives_on_tool_call() -> None:
    """Session in state=stale receiving a tool_call flips back to active
    and advances last_seen_at (D105)."""
    sid = str(uuid.uuid4())
    flavor = f"test-revive-stale-{uuid.uuid4().hex[:6]}"

    post_event(make_event(sid, flavor, "session_start"))
    wait_for_session_in_fleet(sid, timeout=5.0)

    _force_state(sid, "stale")
    before = _read_session_row(sid)
    assert before["state"] == "stale"

    post_event(make_event(sid, flavor, "tool_call", tool_name="Glob"))

    detail = wait_for_state(sid, "active", timeout=10)
    assert detail["session"]["state"] == "active"

    after = _read_session_row(sid)
    assert after["last_seen_at"] != before["last_seen_at"], (
        "last_seen_at should advance when reviving a stale session"
    )


def test_closed_session_stays_closed_on_post_call() -> None:
    """Session in state=closed stays closed when any non-session_start
    event arrives; last_seen_at and tokens_used are NOT advanced.

    Closed is an explicit user exit (session_end), not a timeout-driven
    terminal. Revival would contradict the explicit exit. (D105)
    """
    sid = str(uuid.uuid4())
    flavor = f"test-closed-stays-{uuid.uuid4().hex[:6]}"

    post_event(make_event(sid, flavor, "session_start"))
    wait_for_session_in_fleet(sid, timeout=5.0)
    post_event(make_event(sid, flavor, "session_end"))
    wait_for_state(sid, "closed", timeout=10)

    before = _read_session_row(sid)
    assert before["state"] == "closed"

    post_event(make_event(sid, flavor, "post_call", tokens_total=999))

    # Poll for any state drift. If the worker skipped the event correctly
    # the row should be unchanged after one reconciler tick window.
    def _still_closed_and_unchanged() -> bool:
        row = _read_session_row(sid)
        return (
            row["state"] == "closed"
            and row["last_seen_at"] == before["last_seen_at"]
            and row["tokens_used"] == before["tokens_used"]
        )

    wait_until(
        _still_closed_and_unchanged,
        timeout=5,
        msg=(
            f"closed session {sid} should not be revived by post_call; "
            "expected state=closed with last_seen_at and tokens_used frozen"
        ),
    )


def test_lost_session_closes_on_session_end() -> None:
    """Session in state=lost receiving session_end transitions to
    closed (not active). CloseSession runs unconditionally; revival
    is skipped to avoid flickering through active (D105)."""
    sid = str(uuid.uuid4())
    flavor = f"test-lost-then-close-{uuid.uuid4().hex[:6]}"

    post_event(make_event(sid, flavor, "session_start"))
    wait_for_session_in_fleet(sid, timeout=5.0)

    _force_state(sid, "lost")

    post_event(make_event(sid, flavor, "session_end"))

    detail = wait_for_state(sid, "closed", timeout=10)
    assert detail["session"]["state"] == "closed"
    assert detail["session"]["ended_at"] is not None, (
        f"expected ended_at to be set after session_end on lost session {sid}"
    )


def test_reconciler_lost_threshold_is_30_min() -> None:
    """Reconciler transitions a session to lost only after 30 min of
    silence (D105 secondary change: raised from 10 min).

    Backdates last_seen_at by 31 minutes on a fresh active session, then
    waits for the background reconciler tick (every 60s) to flip it
    through stale and into lost in a single pass.
    """
    sid = str(uuid.uuid4())
    flavor = f"test-30min-lost-{uuid.uuid4().hex[:6]}"

    post_event(make_event(sid, flavor, "session_start"))
    wait_for_session_in_fleet(sid, timeout=5.0)

    _exec_sql(
        "UPDATE sessions SET last_seen_at = NOW() - INTERVAL '31 minutes' "
        f"WHERE session_id = '{sid}'::uuid"
    )

    # Reconciler runs every 60s. Wait up to ~90s for the next tick to
    # sweep the backdated row through active -> stale -> lost (both
    # transitions fire in the same ReconcileStaleSessions call).
    detail = wait_for_state(sid, "lost", timeout=90)
    assert detail["session"]["state"] == "lost"
