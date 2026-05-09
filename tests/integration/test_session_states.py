"""Integration tests for session state transitions.

Tests the five-state lifecycle: active → idle → stale → closed/lost,
and the D105 revival path that flips stale/lost back to active on any
non-session_start event. Requires `make dev` to be running.
"""

from __future__ import annotations

import subprocess
import time
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


def test_orphan_timeout_reaper_closes_lost_session() -> None:
    """Lost sessions silent past FLIGHTDECK_ORPHAN_TIMEOUT_HOURS get
    reaped: state flips to closed, ended_at is stamped, and a synthetic
    session_end event with payload.close_reason='orphan_timeout' lands
    so the dashboard's CloseReason facet surfaces the reconciler's
    verdict alongside happy-path shutdowns.

    Default timeout is 24h. Backdates last_seen_at by 25 hours and
    forces state='lost' so the next reconciler tick (every 60s) reaps
    in a single pass, then asserts the row update + the synthetic event.
    """
    sid = str(uuid.uuid4())
    flavor = f"test-orphan-reap-{uuid.uuid4().hex[:6]}"

    post_event(make_event(sid, flavor, "session_start"))
    wait_for_session_in_fleet(sid, timeout=5.0)

    # Skip the organic stale → lost progression: backdate and force.
    # The reaper only cares that state='lost' and last_seen_at is past
    # the threshold; getting there via 31-minute waits would balloon
    # the test runtime without exercising the reaper code path.
    _exec_sql(
        "UPDATE sessions SET state = 'lost', "
        "last_seen_at = NOW() - INTERVAL '25 hours' "
        f"WHERE session_id = '{sid}'::uuid"
    )

    detail = wait_for_state(sid, "closed", timeout=90)
    assert detail["session"]["state"] == "closed"
    assert detail["session"]["ended_at"] is not None, (
        f"reaper should stamp ended_at on {sid}; got null"
    )

    raw = _exec_sql(
        "SELECT payload->>'close_reason' FROM events "
        f"WHERE session_id = '{sid}'::uuid AND event_type = 'session_end'"
    )
    reasons = [line.strip() for line in raw.splitlines() if line.strip()]
    assert "orphan_timeout" in reasons, (
        f"reaper should emit synthetic session_end with "
        f"close_reason='orphan_timeout' on {sid}; saw {reasons!r}"
    )


def test_orphan_timeout_reaper_does_not_close_recent_lost_session() -> None:
    """A session in state='lost' but with last_seen_at *inside* the
    timeout window must NOT be reaped. Guards against the reaper firing
    on every lost row regardless of age (which would defeat the
    purpose of the threshold and prematurely close legitimately-paused
    sessions).
    """
    sid = str(uuid.uuid4())
    flavor = f"test-orphan-noreap-{uuid.uuid4().hex[:6]}"

    post_event(make_event(sid, flavor, "session_start"))
    wait_for_session_in_fleet(sid, timeout=5.0)

    # last_seen_at is 1 hour ago — past the 30-min lost threshold so
    # state='lost' is plausible, but well inside the default 24h orphan
    # window so the reaper must skip it.
    _exec_sql(
        "UPDATE sessions SET state = 'lost', "
        "last_seen_at = NOW() - INTERVAL '1 hour' "
        f"WHERE session_id = '{sid}'::uuid"
    )

    # Wait long enough for at least one reconciler tick (60s) plus
    # padding. If the reaper is going to wrongly fire, it fires here.
    time.sleep(75)

    row = _read_session_row(sid)
    assert row["state"] == "lost", (
        f"reaper wrongly closed recent lost session {sid}: state={row['state']!r}"
    )

    raw = _exec_sql(
        "SELECT COUNT(*) FROM events "
        f"WHERE session_id = '{sid}'::uuid "
        "AND event_type = 'session_end' "
        "AND payload->>'close_reason' = 'orphan_timeout'"
    )
    assert raw == "0", (
        f"reaper wrongly emitted orphan_timeout session_end for {sid}; "
        f"expected 0 rows, got {raw}"
    )


# ---------------------------------------------------------------------------
# D106: lazy session creation on events with unknown session_id.
#
# The plugin's fire-and-forget hook model means a non-session_start event
# can reach Flightdeck before session_start ever does -- server down at
# plugin startup, plugin enabled mid-session, future out-of-order
# delivery paths. Pre-D106 these events FK-violated at worker.InsertEvent
# and bounced in the NATS queue. D106 has non-session_start handlers
# lazy-create the session row so the event lands, with "unknown"
# sentinels on flavor/agent_type and NULL context/token columns that a
# later authoritative session_start enriches via UpsertSession's
# COALESCE + CASE branches.
# ---------------------------------------------------------------------------


def _read_session_identity(session_id: str) -> dict[str, str]:
    """Read flavor / agent_type / context / token columns from the DB.

    Returns "" for NULL columns so callers can assert on sentinel
    values without juggling None. context is returned as the raw
    JSONB text ("{}" or "null" -- psql -A renders JSONB verbatim).
    """
    raw = _exec_sql(
        "SELECT flavor, agent_type, "
        "COALESCE(context::text, 'NULL'), "
        "COALESCE(token_id::text, ''), "
        "COALESCE(token_name, '') "
        "FROM sessions "
        f"WHERE session_id = '{session_id}'::uuid"
    )
    parts = raw.split("|")
    if len(parts) != 5:
        raise AssertionError(f"unexpected session identity row: {raw!r}")
    return {
        "flavor": parts[0],
        "agent_type": parts[1],
        "context": parts[2],
        "token_id": parts[3],
        "token_name": parts[4],
    }


def _first_event_payload(
    session_id: str, flavor: str, event_type: str, **extra: object,
) -> dict[str, object]:
    """Build an event payload for a session_id that Flightdeck has
    never seen. Differs from make_event() only in that no session_start
    has preceded it -- the payload itself is identical so the server
    cannot distinguish "legitimate first event" from "session_start
    got lost"; D106 handles both identically.
    """
    return make_event(session_id, flavor, event_type, **extra)


def test_unknown_session_id_lazy_creates_on_post_call() -> None:
    """A post_call for a session_id Flightdeck has never seen creates
    the session row with state=active, started_at=event.occurred_at,
    best-effort flavor/host, and the tokens are counted correctly.

    Pre-D106 this event FK-violated at worker.InsertEvent and was
    dropped. After D106, the row manifests and the event lands.
    """
    sid = str(uuid.uuid4())
    flavor = f"test-d106-postcall-{uuid.uuid4().hex[:6]}"

    # Skip the session_start. Go directly to a post_call.
    post_event(_first_event_payload(sid, flavor, "post_call", tokens_total=250))
    wait_for_session_in_fleet(sid, timeout=10.0)

    row = _read_session_row(sid)
    assert row["state"] == "active", (
        f"lazy-created session {sid} should be state=active, got {row['state']}"
    )
    assert row["tokens_used"] == "250", (
        f"expected tokens_used=250 on lazy-created session, got {row['tokens_used']}"
    )

    identity = _read_session_identity(sid)
    # Plugin-style best-effort identity: the event's flavor is carried
    # through even though no session_start ever arrived. Under D115 the
    # agent_type "unknown" sentinel path is unreachable from the wire
    # (D116 rejects any agent_type outside {coding, production} at
    # ingestion); the flavor sentinel is still meaningful because flavor
    # is an informational field the validator does not constrain.
    assert identity["flavor"] == flavor, (
        f"expected flavor from event payload, got {identity['flavor']!r}"
    )
    # context is NULL -- the enrichable sentinel. An empty JSONB dict
    # would look identical to a session_start that collected nothing,
    # so D106 distinguishes them with true NULL.
    assert identity["context"] == "NULL", (
        f"expected context=NULL on lazy-created session, got {identity['context']!r}"
    )


def test_unknown_session_id_lazy_creates_on_tool_call() -> None:
    """tool_call on an unknown session_id follows the same path as
    post_call. Matches the Claude Code plugin case where the first
    post-outage hook the plugin fires is PostToolUse.
    """
    sid = str(uuid.uuid4())
    flavor = f"test-d106-toolcall-{uuid.uuid4().hex[:6]}"

    post_event(
        _first_event_payload(sid, flavor, "tool_call", tool_name="Bash")
    )
    wait_for_session_in_fleet(sid, timeout=10.0)

    row = _read_session_row(sid)
    assert row["state"] == "active"
    identity = _read_session_identity(sid)
    assert identity["flavor"] == flavor
    assert identity["context"] == "NULL"


def test_unknown_flavor_uses_sentinel_on_lazy_create() -> None:
    """When the event literally omits flavor, D106 writes the 'unknown'
    sentinel so a later session_start can upgrade it.

    D115 note: the parallel sentinel path for ``agent_type`` is no longer
    reachable from the wire. The D116 ingestion validator rejects any
    event whose ``agent_type`` is outside ``{coding, production}`` with
    400, so this test now exercises only the flavor-sentinel upgrade.
    agent_type stays at its ``make_event`` default ("production") across
    the lazy-create and the authoritative session_start -- it never
    transits through "unknown" because it cannot legitimately arrive empty.
    """
    sid = str(uuid.uuid4())

    payload = _first_event_payload(sid, "", "post_call", tokens_total=100)
    payload["flavor"] = ""  # explicit: no flavor on the wire
    post_event(payload)
    wait_for_session_in_fleet(sid, timeout=10.0)

    identity = _read_session_identity(sid)
    assert identity["flavor"] == "unknown", (
        f"expected flavor='unknown' sentinel, got {identity['flavor']!r}"
    )

    # Now send the authoritative session_start. UpsertSession's CASE
    # branch must upgrade the flavor sentinel and fill in context.
    real_flavor = f"test-d106-upgrade-{uuid.uuid4().hex[:6]}"
    post_event(make_event(sid, real_flavor, "session_start"))
    # Wait until the row picks up the real flavor.
    wait_until(
        lambda: _read_session_identity(sid)["flavor"] == real_flavor,
        timeout=10,
        msg=f"session_start did not upgrade unknown flavor for {sid}",
    )
    enriched = _read_session_identity(sid)
    assert enriched["flavor"] == real_flavor, (
        f"expected sentinel upgrade to {real_flavor}, got {enriched['flavor']!r}"
    )
    # Context is NULL on lazy-create; session_start carries
    # DEFAULT_TEST_CONTEXT and COALESCE should fill it in.
    assert enriched["context"] != "NULL", (
        "expected session_start to enrich NULL context via COALESCE"
    )
    assert "integration-test-host" in enriched["context"], (
        "expected DEFAULT_TEST_CONTEXT hostname to appear in enriched context"
    )


def test_real_flavor_not_overwritten_on_session_start_reattach() -> None:
    """D094 write-once: a row whose flavor is a real value (not the
    'unknown' sentinel) is preserved when session_start re-arrives
    with a different flavor. The CASE guard is specifically scoped to
    'unknown' so lazy-created sentinels can upgrade without opening
    a door for legitimate reattaches to overwrite identity.
    """
    sid = str(uuid.uuid4())
    real_flavor = f"test-d106-writeonce-{uuid.uuid4().hex[:6]}"

    # First event carries a real flavor (plugin-style: every hook has
    # "claude-code", not the "unknown" sentinel).
    post_event(_first_event_payload(sid, real_flavor, "post_call", tokens_total=50))
    wait_for_session_in_fleet(sid, timeout=10.0)
    first = _read_session_identity(sid)
    assert first["flavor"] == real_flavor

    # A malformed or confused session_start arrives with a DIFFERENT
    # flavor. The CASE guard must refuse to overwrite.
    different_flavor = f"test-d106-should-ignore-{uuid.uuid4().hex[:6]}"
    post_event(make_event(sid, different_flavor, "session_start"))
    # Give the worker a beat to process.
    wait_until(
        lambda: _read_session_identity(sid)["context"] != "NULL",
        timeout=10,
        msg=f"session_start did not process for {sid}",
    )
    after = _read_session_identity(sid)
    assert after["flavor"] == real_flavor, (
        f"expected write-once preservation of {real_flavor!r}, got {after['flavor']!r}"
    )


def test_order_independence_pc_then_ss_matches_ss_then_pc() -> None:
    """Order independence: post_call -> session_start -> tool_call
    produces the same final session row as session_start -> post_call
    -> tool_call. Token totals, flavor, and context must match.
    """
    # Out-of-order pipeline.
    sid_a = str(uuid.uuid4())
    flavor_a = f"test-d106-order-a-{uuid.uuid4().hex[:6]}"
    post_event(_first_event_payload(sid_a, flavor_a, "post_call", tokens_total=200))
    wait_for_session_in_fleet(sid_a, timeout=10.0)
    post_event(make_event(sid_a, flavor_a, "session_start"))
    post_event(make_event(sid_a, flavor_a, "tool_call", tool_name="Bash"))
    wait_until(
        lambda: _read_session_identity(sid_a)["context"] != "NULL",
        timeout=10,
        msg="session_start did not enrich context on sid_a",
    )

    # In-order baseline.
    sid_b = str(uuid.uuid4())
    flavor_b = f"test-d106-order-b-{uuid.uuid4().hex[:6]}"
    post_event(make_event(sid_b, flavor_b, "session_start"))
    wait_for_session_in_fleet(sid_b, timeout=10.0)
    post_event(make_event(sid_b, flavor_b, "post_call", tokens_total=200))
    post_event(make_event(sid_b, flavor_b, "tool_call", tool_name="Bash"))

    wait_until(
        lambda: _read_session_row(sid_a)["tokens_used"] == "200",
        timeout=10,
        msg="tokens not counted on sid_a after enrichment",
    )
    wait_until(
        lambda: _read_session_row(sid_b)["tokens_used"] == "200",
        timeout=10,
        msg="tokens not counted on sid_b",
    )

    row_a = _read_session_row(sid_a)
    row_b = _read_session_row(sid_b)
    assert row_a["state"] == row_b["state"] == "active"
    assert row_a["tokens_used"] == row_b["tokens_used"] == "200", (
        f"order independence failure: sid_a tokens={row_a['tokens_used']}, "
        f"sid_b tokens={row_b['tokens_used']}"
    )

    id_a = _read_session_identity(sid_a)
    id_b = _read_session_identity(sid_b)
    # Flavors differ by design (a vs b random suffix), but the shape
    # of the identity (both real, both with context, both with
    # matching agent_type) must match.
    assert id_a["agent_type"] == id_b["agent_type"] == "production"
    assert id_a["context"] != "NULL" and id_b["context"] != "NULL", (
        "both sessions must carry enriched context after session_start"
    )


def test_session_end_on_unknown_session_id_does_not_lazy_create() -> None:
    """D106 deliberately excludes session_end from lazy-create. A
    teardown signal for a session we never saw should not
    retroactively manifest a closed row. This mirrors D105's
    rationale for excluding session_end from the revive path.
    """
    sid = str(uuid.uuid4())
    flavor = f"test-d106-end-{uuid.uuid4().hex[:6]}"

    # session_end on an unknown session_id. Pre-D106 and post-D106
    # both drop this at InsertEvent (FK) -- the only difference is
    # that post-D106 doesn't create a zombie closed row.
    post_event(make_event(sid, flavor, "session_end"))

    # The session row must not exist. Direct DB lookup rather than
    # wait_for -- there's nothing to wait for.
    import time as _time
    _time.sleep(1.0)  # brief pause for worker to (not) process
    raw = _exec_sql(
        f"SELECT COUNT(*) FROM sessions WHERE session_id = '{sid}'::uuid"
    )
    assert raw == "0", (
        f"session_end on unknown session_id should not lazy-create a row; "
        f"found {raw} row(s) for {sid}"
    )
