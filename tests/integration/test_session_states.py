"""Integration tests for session state transitions.

Tests the five-state lifecycle: active → idle → stale → closed/lost,
and the D105 revival path that flips stale/lost back to active on any
non-session_start event. Requires `make dev` to be running.
"""

from __future__ import annotations

import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from .conftest import (
    agent_row_locked,
    exec_sql,
    get_session,
    get_session_detail,
    make_event,
    post_event,
    post_heartbeat,
    session_events,
    session_row_locked,
    wait_for_session_in_fleet,
    wait_for_state,
    wait_until,
    worker_log_lines,
    worker_paused,
)


def _force_state(session_id: str, state: str) -> None:
    """Force a session into a given state via direct UPDATE.

    Avoids waiting 2–30 minutes for the reconciler to organically move a
    session through the lifecycle. Used only by tests that exercise the
    revival path.
    """
    exec_sql(
        "UPDATE sessions SET state = :'state' WHERE session_id = :'sid'::uuid",
        state=state,
        sid=session_id,
    )


def _read_session_row(session_id: str) -> dict[str, str]:
    """Read state / last_seen_at / tokens_used straight from Postgres."""
    raw = exec_sql(
        "SELECT state, last_seen_at, tokens_used FROM sessions "
        "WHERE session_id = :'sid'::uuid",
        sid=session_id,
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
        lambda: len(session_events(get_session_detail(sid))) >= 1,
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
    advances last_seen_at, and increments tokens_used.

    The revival flip and the token bump land in two separate
    transactions inside the worker (handleSessionGuard's
    ReviveIfRevivable, then HandlePostCall's UpdateTokensUsed). On
    fast hardware they commit close enough together that polling for
    state=active and then reading tokens_used in one shot works; on
    slower CI runners the revive commit can land before the token
    commit, leaving a brief window where state=active but tokens_used
    is still pre-bump. Poll for the conjunction (state AND tokens) to
    close the race rather than reading once after a state-only wait.
    """
    sid = str(uuid.uuid4())
    flavor = f"test-revive-lost-{uuid.uuid4().hex[:6]}"

    post_event(make_event(sid, flavor, "session_start"))
    wait_for_session_in_fleet(sid, timeout=5.0)

    _force_state(sid, "lost")
    before = _read_session_row(sid)
    assert before["state"] == "lost"
    expected_tokens = int(before["tokens_used"]) + 500

    post_event(make_event(sid, flavor, "post_call", tokens_total=500))

    def _revived_with_tokens() -> bool:
        row = _read_session_row(sid)
        return row["state"] == "active" and int(row["tokens_used"]) == expected_tokens

    wait_until(
        _revived_with_tokens,
        timeout=10,
        interval=0.5,
        msg=(
            f"session {sid} should be revived to active with tokens_used="
            f"{expected_tokens}"
        ),
    )

    after = _read_session_row(sid)
    assert after["state"] == "active"
    assert after["last_seen_at"] != before["last_seen_at"], (
        f"last_seen_at should advance after revive; before={before['last_seen_at']} "
        f"after={after['last_seen_at']}"
    )
    assert int(after["tokens_used"]) == expected_tokens, (
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
    closed (not active): the end settles the row directly, and revival
    is skipped to avoid flickering through active."""
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

    exec_sql(
        "UPDATE sessions SET last_seen_at = NOW() - INTERVAL '31 minutes' "
        "WHERE session_id = :'sid'::uuid",
        sid=sid,
    )

    # Reconciler runs every 60s. Wait up to ~90s for the next tick to
    # sweep the backdated row through active -> stale -> lost (both
    # transitions fire in the same ReconcileStaleSessions call).
    detail = wait_for_state(sid, "lost", timeout=90)
    assert detail["session"]["state"] == "lost"


def test_orphan_timeout_reaper_closes_lost_session() -> None:
    """Lost sessions silent past the configured orphan timeout
    (env ``FLIGHTDECK_ORPHAN_TIMEOUT_HOURS``, default 24h) get reaped:
    state flips to closed, ended_at is stamped, and a synthetic
    session_end event with payload.close_reason='orphan_timeout' lands
    so the dashboard's CloseReason facet surfaces the reconciler's
    verdict alongside happy-path shutdowns.

    Backdates last_seen_at by 25 hours (past the default 24h timeout)
    and forces state='lost' so the next reconciler tick reaps in a
    single pass, then asserts the row update + the synthetic event.
    """
    sid = str(uuid.uuid4())
    flavor = f"test-orphan-reap-{uuid.uuid4().hex[:6]}"

    post_event(make_event(sid, flavor, "session_start"))
    wait_for_session_in_fleet(sid, timeout=5.0)

    # Skip the organic stale → lost progression: backdate and force.
    # The reaper only cares that state='lost' and last_seen_at is past
    # the threshold; getting there via 31-minute waits would balloon
    # the test runtime without exercising the reaper code path.
    exec_sql(
        "UPDATE sessions SET state = 'lost', "
        "last_seen_at = NOW() - INTERVAL '25 hours' "
        "WHERE session_id = :'sid'::uuid",
        sid=sid,
    )

    detail = wait_for_state(sid, "closed", timeout=90)
    assert detail["session"]["state"] == "closed"
    assert detail["session"]["ended_at"] is not None, (
        f"reaper should stamp ended_at on {sid}; got null"
    )

    raw = exec_sql(
        "SELECT payload->>'close_reason' FROM events "
        "WHERE session_id = :'sid'::uuid AND event_type = 'session_end'",
        sid=sid,
    )
    reasons = [line.strip() for line in raw.splitlines() if line.strip()]
    # Tighter than `in`: the synthetic session_end should be the only
    # session_end on this row. A second one would indicate the reaper
    # double-fired or a duplicate path raced the reconciler.
    assert reasons == ["orphan_timeout"], (
        f"reaper should emit exactly one synthetic session_end with "
        f"close_reason='orphan_timeout' on {sid}; saw {reasons!r}"
    )


def test_orphan_timeout_reaper_does_not_close_recent_lost_session() -> None:
    """A session in state='lost' but with last_seen_at *inside* the
    ``FLIGHTDECK_ORPHAN_TIMEOUT_HOURS`` window (default 24h) must NOT
    be reaped. Guards against the reaper firing on every lost row
    regardless of age (which would defeat the purpose of the threshold
    and prematurely close legitimately-paused sessions).
    """
    sid = str(uuid.uuid4())
    flavor = f"test-orphan-noreap-{uuid.uuid4().hex[:6]}"

    post_event(make_event(sid, flavor, "session_start"))
    wait_for_session_in_fleet(sid, timeout=5.0)

    # last_seen_at is 1 hour ago — past the 30-min lost threshold so
    # state='lost' is plausible, but well inside the default 24h orphan
    # window so the reaper must skip it.
    exec_sql(
        "UPDATE sessions SET state = 'lost', "
        "last_seen_at = NOW() - INTERVAL '1 hour' "
        "WHERE session_id = :'sid'::uuid",
        sid=sid,
    )

    # Negative wait: poll for the wrong-firing condition (state flipped
    # to 'closed') with a 75s budget — long enough for at least one
    # reconciler tick (every 60s). If the reaper is going to wrongly
    # fire, it fires inside this window. Using wait_until rather than
    # bare time.sleep keeps the polling cadence visible and aligns
    # with the conftest convention (see tests/shared/fixtures.py).
    def _reaper_wrongly_fired() -> bool:
        return _read_session_row(sid)["state"] == "closed"

    try:
        wait_until(
            _reaper_wrongly_fired,
            timeout=75,
            interval=5,
            msg="reaper should NOT fire inside the timeout window",
        )
    except TimeoutError:
        # Expected: the reaper correctly stayed its hand.
        pass
    else:
        raise AssertionError(
            f"reaper wrongly closed recent lost session {sid} inside "
            f"the FLIGHTDECK_ORPHAN_TIMEOUT_HOURS window"
        )

    row = _read_session_row(sid)
    assert row["state"] == "lost", (
        f"reaper wrongly closed recent lost session {sid}: state={row['state']!r}"
    )

    raw = exec_sql(
        "SELECT COUNT(*) FROM events "
        "WHERE session_id = :'sid'::uuid "
        "AND event_type = 'session_end' "
        "AND payload->>'close_reason' = 'orphan_timeout'",
        sid=sid,
    )
    # psql -tA strips alignment but cast through int() so a future
    # whitespace change in psql output doesn't masquerade as a "0
    # rows" pass.
    assert int(raw.strip()) == 0, (
        f"reaper wrongly emitted orphan_timeout session_end for {sid}; "
        f"expected 0 rows, got {raw!r}"
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
    raw = exec_sql(
        "SELECT flavor, agent_type, "
        "COALESCE(context::text, 'NULL'), "
        "COALESCE(token_id::text, ''), "
        "COALESCE(token_name, '') "
        "FROM sessions "
        "WHERE session_id = :'sid'::uuid",
        sid=session_id,
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


# ---------------------------------------------------------------------------
# Event ordering across the worker pool. The pool processes one session's
# events concurrently, so a session_end can reach the database before
# its session_start, and a re-attaching session_start before the previous
# run's session_end. The worker orders a session's start and end by NATS
# stream sequence and gives a session_end whose row is missing two
# delayed redeliveries before it calls the event an orphan.
# ---------------------------------------------------------------------------

# The worker redelivers a session_end whose row is missing after one
# second and again after two before the orphan verdict; polls that may
# span that budget allow it plus the slack any other poll gets.
WORKER_RETRY_WINDOW_SECS = 3.0
# Room for the worker to process a handful of events on a loaded runner.
PROCESSING_SLACK_SECS = 10.0
STATE_TIMEOUT_SECS = PROCESSING_SLACK_SECS
RETRY_WINDOW_TIMEOUT_SECS = WORKER_RETRY_WINDOW_SECS + PROCESSING_SLACK_SECS
# Several times FLIGHTDECK_WORKER_POOL_SIZE (10), so many sessions are in
# flight across goroutines at once while the burst itself (three POSTs
# per session) still takes about two seconds.
BURST_SESSIONS = 50
BURST_TIMEOUT_SECS = 30.0
# Sessions per shape in the paused-worker backlog test: enough that the
# ten goroutines draining the backlog overlap on every shape many times.
BACKLOG_SESSIONS = 30
# Concurrent clients and total starts aimed at one session id in the
# hot-session test: enough for requests to overlap on the row.
HOT_SESSION_CLIENTS = 8
HOT_SESSION_STARTS = 40
# How long a re-attaching session_start may take while its row is held
# by another writer: the stamp skips the row and retries after pauses
# that add up to 75 ms, so well under a second; a stamp that waited for
# the lock would hang for the length of the block instead.
HELD_ROW_RESPONSE_BOUND_SECS = 2.0
# What the worker logs when it schedules a redelivery, on the orphan
# path, on a session_end that predates the session's current run, and on
# any failed attempt.
REDELIVERY_NOTICE = "event redelivery scheduled"
ORPHAN_WARNING = "dropped orphan session_end"
SUPERSEDED_WARNING = "session_end predates the session's current run"
PROCESS_ERROR_MARKER = "process error"
# Redeliveries the worker grants a session_end whose row is missing
# before the orphan verdict (the three-delivery budget minus the first).
ORPHAN_REDELIVERIES = 2
# The agent identity the lock-held test locks: its own, so the lock never
# blocks the sessions the other tests run under the default identity.
HELD_AGENT_NAME = "ordering-held-agent"
# Token counts and latency the probe post_call carries; the session row
# must show the total.
PROBE_INPUT_TOKENS = 5
PROBE_OUTPUT_TOKENS = 3
PROBE_CALL_TOKENS = PROBE_INPUT_TOKENS + PROBE_OUTPUT_TOKENS
PROBE_LATENCY_MS = 10


def _probe_call(sid: str, flavor: str) -> dict[str, Any]:
    return make_event(
        sid,
        flavor,
        "post_call",
        model="gpt-4o",
        tokens_input=PROBE_INPUT_TOKENS,
        tokens_output=PROBE_OUTPUT_TOKENS,
        tokens_total=PROBE_CALL_TOKENS,
        latency_ms=PROBE_LATENCY_MS,
    )


def _start_seq(sid: str) -> int:
    """The stream sequence recorded for the session's current run."""
    return int(
        exec_sql(
            "SELECT start_seq FROM sessions WHERE session_id = :'sid'::uuid", sid=sid
        )
    )


def _count_rows(flavor: str, event_type: str) -> int:
    return int(
        exec_sql(
            "SELECT COUNT(*) FROM events "
            "WHERE flavor = :'flavor' AND event_type = :'event_type'",
            flavor=flavor,
            event_type=event_type,
        )
    )


def _count_sessions(flavor: str, state: str) -> int:
    return int(
        exec_sql(
            "SELECT COUNT(*) FROM sessions WHERE flavor = :'flavor' AND state = :'state'",
            flavor=flavor,
            state=state,
        )
    )


def _wait_for_rows(flavor: str, event_type: str, expected: int, timeout: float) -> None:
    """Poll until exactly ``expected`` rows of ``event_type`` exist.

    The worker inserts an event row after the session side effects, so
    once the rows are there the state they imply is already committed.
    """
    seen = -1

    def _landed() -> bool:
        nonlocal seen
        seen = _count_rows(flavor, event_type)
        return seen == expected

    try:
        wait_until(_landed, timeout=timeout, msg=f"{flavor}: {event_type} rows")
    except TimeoutError as exc:
        raise TimeoutError(f"{exc}: saw {seen} of {expected}") from exc


def test_session_end_published_before_its_session_start_does_not_close_it() -> None:
    """A session_end that precedes the session_start in the stream is
    not this run's end: the worker retries it while the row is missing,
    and once the start has created the row, records the end as an event
    without closing the session, because publication order says the run
    began after it. (The ordering the pool can introduce on its own,
    an end published after its start but processed first, is exercised
    by the burst test below.)
    """
    sid = str(uuid.uuid4())
    flavor = f"test-end-first-{uuid.uuid4().hex[:6]}"

    post_event(make_event(sid, flavor, "session_end"))
    post_event(make_event(sid, flavor, "session_start"))

    _wait_for_rows(flavor, "session_end", 1, RETRY_WINDOW_TIMEOUT_SECS)
    assert get_session_detail(sid)["session"]["state"] == "active"
    wait_until(
        lambda: bool(worker_log_lines(SUPERSEDED_WARNING, f"session_id={sid}")),
        timeout=STATE_TIMEOUT_SECS,
        msg="worker did not report the superseded session_end",
    )

    # The session is still live and a later end closes it as usual.
    post_event(make_event(sid, flavor, "session_end"))
    wait_for_state(sid, "closed", timeout=STATE_TIMEOUT_SECS)


def test_short_lived_sessions_published_back_to_back_all_close() -> None:
    """Sessions that each start, make one call and end within a few
    milliseconds are the real-world shape of the race (one-shot scripts,
    test runs). Every one must end up closed with its session_end row.
    """
    flavor = f"test-burst-{uuid.uuid4().hex[:6]}"
    sids = [str(uuid.uuid4()) for _ in range(BURST_SESSIONS)]

    for sid in sids:
        post_event(make_event(sid, flavor, "session_start"))
        post_event(_probe_call(sid, flavor))
        post_event(make_event(sid, flavor, "session_end"))

    _wait_for_rows(flavor, "session_end", len(sids), BURST_TIMEOUT_SECS)
    closed = _count_sessions(flavor, "closed")
    assert closed == len(sids), f"{closed} of {len(sids)} {flavor} sessions closed"


def test_orphan_session_end_is_dropped_once_after_the_retry_budget() -> None:
    """A session_end whose session never appears is an orphan. The worker
    must not lazy-create a closed row for it (a teardown signal for a
    session the server never saw), must spend its retry budget on it in
    case the session_start is merely late (two delayed redeliveries),
    and must then acknowledge it once: one warning, no failed attempt,
    no event row.
    """
    sid = str(uuid.uuid4())
    flavor = f"test-orphan-end-{uuid.uuid4().hex[:6]}"
    sid_needle = f"session_id={sid}"
    errors_before = set(
        worker_log_lines(PROCESS_ERROR_MARKER, "event_type=session_end")
    )

    post_event(make_event(sid, flavor, "session_end"))

    wait_until(
        lambda: bool(worker_log_lines(ORPHAN_WARNING, sid_needle)),
        timeout=RETRY_WINDOW_TIMEOUT_SECS,
        msg=f"worker never logged the orphan drop for {sid}",
    )

    redeliveries = worker_log_lines(REDELIVERY_NOTICE, sid_needle)
    assert len(redeliveries) == ORPHAN_REDELIVERIES, redeliveries
    warnings = worker_log_lines(ORPHAN_WARNING, sid_needle)
    assert len(warnings) == 1, warnings
    new_errors = (
        set(worker_log_lines(PROCESS_ERROR_MARKER, "event_type=session_end"))
        - errors_before
    )
    assert not new_errors, new_errors
    rows = exec_sql(
        "SELECT COUNT(*) FROM sessions WHERE session_id = :'sid'::uuid",
        sid=sid,
    )
    assert rows == "0", f"orphan session_end must not create a row; found {rows}"
    assert _count_rows(flavor, "session_end") == 0


def test_reattach_published_right_after_session_end_keeps_the_session_open() -> None:
    """A session_start right after the previous run's session_end is a
    re-attachment: however the two are processed, the session must be
    open once both have landed. A call made then rolls its tokens into
    the open session, and the new run can still be ended. (The orderings
    the pool can introduce are forced by the backlog test below.)
    """
    sid = str(uuid.uuid4())
    flavor = f"test-reattach-{uuid.uuid4().hex[:6]}"
    post_event(make_event(sid, flavor, "session_start"))
    wait_for_state(sid, "active", timeout=STATE_TIMEOUT_SECS)

    post_event(make_event(sid, flavor, "session_end"))
    post_event(make_event(sid, flavor, "session_start"))
    _wait_for_rows(flavor, "session_start", 2, RETRY_WINDOW_TIMEOUT_SECS)
    _wait_for_rows(flavor, "session_end", 1, RETRY_WINDOW_TIMEOUT_SECS)

    post_event(_probe_call(sid, flavor))
    _wait_for_rows(flavor, "post_call", 1, STATE_TIMEOUT_SECS)
    session = get_session_detail(sid)["session"]
    assert session["state"] == "active", session
    assert session["tokens_used"] == PROBE_CALL_TOKENS, session
    assert session.get("ended_at") is None, session

    post_event(make_event(sid, flavor, "session_end"))
    wait_for_state(sid, "closed", timeout=STATE_TIMEOUT_SECS)


def test_reattachment_with_the_previous_end_queued_keeps_its_first_calls() -> None:
    """A call made right after the re-attaching session_start must roll
    its tokens into the session whatever the previous run's session_end
    does in the meantime: the ingestion API stamps the start's stream
    sequence on the row as it accepts the start and revives the row if
    that end closed it first.
    """
    sid = str(uuid.uuid4())
    flavor = f"test-reattach-call-{uuid.uuid4().hex[:6]}"
    post_event(make_event(sid, flavor, "session_start"))
    wait_for_state(sid, "active", timeout=STATE_TIMEOUT_SECS)

    post_event(make_event(sid, flavor, "session_end"))
    post_event(make_event(sid, flavor, "session_start"))
    post_event(_probe_call(sid, flavor))
    _wait_for_rows(flavor, "session_start", 2, RETRY_WINDOW_TIMEOUT_SECS)
    _wait_for_rows(flavor, "session_end", 1, RETRY_WINDOW_TIMEOUT_SECS)
    _wait_for_rows(flavor, "post_call", 1, RETRY_WINDOW_TIMEOUT_SECS)

    session = get_session_detail(sid)["session"]
    assert session["state"] == "active", session
    assert session["tokens_used"] == PROBE_CALL_TOKENS, session

    post_event(make_event(sid, flavor, "session_end"))
    wait_for_state(sid, "closed", timeout=STATE_TIMEOUT_SECS)


def test_reattachment_processed_after_both_runs_ended_stays_closed() -> None:
    """Force the worst order: the previous run's end and the new run's
    end are both processed while the re-attaching session_start is held
    back (the agents row it must upsert first is locked). The later end
    must leave its mark on the closed row, so the start, once released,
    cannot revive a session whose new run has already ended.
    """
    sid = str(uuid.uuid4())
    flavor = f"test-reattach-held-{uuid.uuid4().hex[:6]}"
    post_event(make_event(sid, flavor, "session_start", agent_name=HELD_AGENT_NAME))
    wait_for_state(sid, "active", timeout=STATE_TIMEOUT_SECS)
    agent_id = exec_sql(
        "SELECT agent_id FROM sessions WHERE session_id = :'sid'::uuid", sid=sid
    )

    with agent_row_locked(agent_id):
        post_event(make_event(sid, flavor, "session_end", agent_name=HELD_AGENT_NAME))
        post_event(make_event(sid, flavor, "session_start", agent_name=HELD_AGENT_NAME))
        post_event(make_event(sid, flavor, "session_end", agent_name=HELD_AGENT_NAME))
        _wait_for_rows(flavor, "session_end", 2, RETRY_WINDOW_TIMEOUT_SECS)
        assert _count_rows(flavor, "session_start") == 1, "the start was not held back"
        assert get_session_detail(sid)["session"]["state"] == "closed"

    _wait_for_rows(flavor, "session_start", 2, RETRY_WINDOW_TIMEOUT_SECS)
    assert get_session_detail(sid)["session"]["state"] == "closed"


def test_reattachment_that_ends_at_once_with_the_previous_end_queued_closes() -> None:
    """The previous run's end, the re-attaching start and the new run's end
    are all queued together. Whichever order the pool processes them in,
    the session must end closed: in particular, when both ends are
    processed before the start, the later end must leave its mark so the
    start cannot revive a session whose new run has already ended.
    """
    sid = str(uuid.uuid4())
    flavor = f"test-reattach-both-{uuid.uuid4().hex[:6]}"
    post_event(make_event(sid, flavor, "session_start"))
    wait_for_state(sid, "active", timeout=STATE_TIMEOUT_SECS)

    post_event(make_event(sid, flavor, "session_end"))
    post_event(make_event(sid, flavor, "session_start"))
    post_event(make_event(sid, flavor, "session_end"))
    _wait_for_rows(flavor, "session_start", 2, RETRY_WINDOW_TIMEOUT_SECS)
    _wait_for_rows(flavor, "session_end", 2, RETRY_WINDOW_TIMEOUT_SECS)
    assert get_session_detail(sid)["session"]["state"] == "closed"


def test_backlog_of_reattachments_drains_to_the_right_states() -> None:
    """Queue every re-attachment shape behind a paused worker, then let
    the pool drain the backlog concurrently. Whatever order the
    goroutines pick, a session whose latest event is a session_end must
    end closed and one whose latest event is a session_start must end
    active with its call's tokens.
    """
    flavor = f"test-backlog-{uuid.uuid4().hex[:6]}"
    ending = [str(uuid.uuid4()) for _ in range(BACKLOG_SESSIONS)]
    resuming = [str(uuid.uuid4()) for _ in range(BACKLOG_SESSIONS)]
    for sid in ending + resuming:
        post_event(make_event(sid, flavor, "session_start"))
    _wait_for_rows(
        flavor, "session_start", len(ending) + len(resuming), BURST_TIMEOUT_SECS
    )

    with worker_paused():
        for sid in ending:
            post_event(make_event(sid, flavor, "session_end"))
            post_event(make_event(sid, flavor, "session_start"))
            post_event(make_event(sid, flavor, "session_end"))
        for sid in resuming:
            post_event(make_event(sid, flavor, "session_end"))
            post_event(make_event(sid, flavor, "session_start"))
            post_event(_probe_call(sid, flavor))

    _wait_for_rows(
        flavor, "session_start", 2 * (len(ending) + len(resuming)), BURST_TIMEOUT_SECS
    )
    _wait_for_rows(
        flavor, "session_end", 2 * len(ending) + len(resuming), BURST_TIMEOUT_SECS
    )
    _wait_for_rows(flavor, "post_call", len(resuming), BURST_TIMEOUT_SECS)

    closed = exec_sql(
        "SELECT COUNT(*) FROM sessions WHERE session_id = ANY(:'ids'::uuid[]) AND state = 'closed'",
        ids="{" + ",".join(ending) + "}",
    )
    assert closed == str(len(ending)), (
        f"{closed} of {len(ending)} ended sessions closed"
    )
    live = exec_sql(
        "SELECT COUNT(*) FROM sessions WHERE session_id = ANY(:'ids'::uuid[]) "
        "AND state = 'active' AND tokens_used = :tokens",
        ids="{" + ",".join(resuming) + "}",
        tokens=PROBE_CALL_TOKENS,
    )
    assert live == str(len(resuming)), (
        f"{live} of {len(resuming)} resumed sessions active with their call's tokens"
    )
    for sid in resuming:
        post_event(make_event(sid, flavor, "session_end"))
    _wait_for_rows(
        flavor, "session_end", 2 * (len(ending) + len(resuming)), BURST_TIMEOUT_SECS
    )


def test_a_later_session_end_on_a_closed_row_advances_its_close_sequence() -> None:
    """When the re-attachment stamp is missed, a run's end can reach a row
    the previous run's end already closed. The later end must leave its
    sequence on the row, so a session_start published between the two
    ends still reads the row as closed by a newer end. Reproduced here
    with two ends on a closed row: the second must raise closed_seq.
    """
    sid = str(uuid.uuid4())
    flavor = f"test-later-end-{uuid.uuid4().hex[:6]}"
    post_event(make_event(sid, flavor, "session_start"))
    post_event(make_event(sid, flavor, "session_end"))
    wait_for_state(sid, "closed", timeout=STATE_TIMEOUT_SECS)
    first = int(
        exec_sql(
            "SELECT closed_seq FROM sessions WHERE session_id = :'sid'::uuid", sid=sid
        )
    )

    post_event(make_event(sid, flavor, "session_end"))
    _wait_for_rows(flavor, "session_end", 2, RETRY_WINDOW_TIMEOUT_SECS)
    second = int(
        exec_sql(
            "SELECT closed_seq FROM sessions WHERE session_id = :'sid'::uuid", sid=sid
        )
    )
    assert second > first, f"closed_seq did not advance: {first} -> {second}"
    assert get_session_detail(sid)["session"]["state"] == "closed"


def test_many_concurrent_session_starts_on_one_session_id_stay_consistent() -> None:
    """Several clients re-attaching the same session id at once must all be
    accepted and leave the session open: the ingestion stamp skips a row
    another request holds rather than queue every request on its lock.
    """
    sid = str(uuid.uuid4())
    flavor = f"test-hot-start-{uuid.uuid4().hex[:6]}"
    post_event(make_event(sid, flavor, "session_start"))
    wait_for_state(sid, "active", timeout=STATE_TIMEOUT_SECS)

    payloads = [
        make_event(sid, flavor, "session_start") for _ in range(HOT_SESSION_STARTS)
    ]
    with ThreadPoolExecutor(max_workers=HOT_SESSION_CLIENTS) as pool:
        replies = list(pool.map(post_event, payloads))
    assert all(r.get("status") == "ok" for r in replies), replies
    _wait_for_rows(flavor, "session_start", 1 + HOT_SESSION_STARTS, BURST_TIMEOUT_SECS)
    assert get_session_detail(sid)["session"]["state"] == "active"

    post_event(make_event(sid, flavor, "session_end"))
    wait_for_state(sid, "closed", timeout=STATE_TIMEOUT_SECS)


def test_reattaching_start_is_accepted_while_its_session_row_is_held() -> None:
    """The re-attachment stamp must not wait for a session row another
    writer holds: with the row locked for the whole request, the
    session_start is still accepted at once (the stamp skips the row,
    retries a few times and gives up), and the session stays usable.
    """
    sid = str(uuid.uuid4())
    flavor = f"test-held-row-{uuid.uuid4().hex[:6]}"
    post_event(make_event(sid, flavor, "session_start"))
    wait_for_state(sid, "active", timeout=STATE_TIMEOUT_SECS)

    with session_row_locked(sid):
        started = time.monotonic()
        reply = post_event(make_event(sid, flavor, "session_start"))
        elapsed = time.monotonic() - started
    assert reply.get("status") == "ok", reply
    assert elapsed < HELD_ROW_RESPONSE_BOUND_SECS, f"re-attachment took {elapsed:.2f}s"

    post_event(make_event(sid, flavor, "session_end"))
    wait_for_state(sid, "closed", timeout=STATE_TIMEOUT_SECS)


def test_reattaching_start_is_stamped_while_an_event_insert_shares_its_row() -> None:
    """The stamp must pass the KEY SHARE lock an in-flight event insert
    holds on the session row through the foreign key, since a busy
    session's row is shared that way for nearly every call: the stamp
    locks the row FOR NO KEY UPDATE, which KEY SHARE does not conflict
    with, where a plain FOR UPDATE would make it skip. The agents row is
    held so the worker's own handling of the re-attaching start blocks
    before it reaches the session row; the only writer that can move
    start_seq during the hold is the ingestion stamp.
    """
    sid = str(uuid.uuid4())
    flavor = f"test-shared-row-{uuid.uuid4().hex[:6]}"
    post_event(make_event(sid, flavor, "session_start", agent_name=HELD_AGENT_NAME))
    wait_for_state(sid, "active", timeout=STATE_TIMEOUT_SECS)
    agent_id = exec_sql(
        "SELECT agent_id FROM sessions WHERE session_id = :'sid'::uuid", sid=sid
    )

    with agent_row_locked(agent_id):
        before = _start_seq(sid)
        with session_row_locked(sid, mode="KEY SHARE"):
            reply = post_event(
                make_event(sid, flavor, "session_start", agent_name=HELD_AGENT_NAME)
            )
        assert reply.get("status") == "ok", reply
        after = _start_seq(sid)
    assert after > before, (
        f"the stamp skipped a shared row: start_seq {before} -> {after}"
    )

    post_event(make_event(sid, flavor, "session_end", agent_name=HELD_AGENT_NAME))
    wait_for_state(sid, "closed", timeout=STATE_TIMEOUT_SECS)


def test_reattached_run_that_ends_at_once_closes() -> None:
    """The mirror of the previous test: a re-attachment whose own
    session_end follows at once must end closed, whichever of the two
    the worker processes first.
    """
    sid = str(uuid.uuid4())
    flavor = f"test-reattach-end-{uuid.uuid4().hex[:6]}"
    post_event(make_event(sid, flavor, "session_start"))
    post_event(make_event(sid, flavor, "session_end"))
    wait_for_state(sid, "closed", timeout=STATE_TIMEOUT_SECS)

    post_event(make_event(sid, flavor, "session_start"))
    post_event(make_event(sid, flavor, "session_end"))
    _wait_for_rows(flavor, "session_end", 2, RETRY_WINDOW_TIMEOUT_SECS)
    assert get_session_detail(sid)["session"]["state"] == "closed"


# ---------------------------------------------------------------------------
# Parent-bump propagation: child events advance the parent session's
# last_seen_at and revive the parent from stale/lost back to active.
# A session with active descendants is logically active. Without this
# propagation a parent that handed off all real work to sub-agents
# would age to stale → lost → orphan_timeout closure while children
# clearly streamed events. Closed parents stay closed (terminal).
# ---------------------------------------------------------------------------


def _read_parent_last_seen(parent_session_id: str) -> str:
    """Read just last_seen_at from a session row, as ISO timestamp text."""
    return exec_sql(
        "SELECT last_seen_at FROM sessions WHERE session_id = :'sid'::uuid",
        sid=parent_session_id,
    )


def _seed_parent_with_child(
    parent_flavor_prefix: str,
    child_flavor_prefix: str,
) -> tuple[str, str]:
    """Seed a parent session and a child whose parent_session_id points
    at the parent's session_id. Returns (parent_sid, child_sid).
    """
    parent_sid = str(uuid.uuid4())
    child_sid = str(uuid.uuid4())
    parent_flavor = f"{parent_flavor_prefix}-{uuid.uuid4().hex[:6]}"
    child_flavor = f"{child_flavor_prefix}-{uuid.uuid4().hex[:6]}"

    post_event(make_event(parent_sid, parent_flavor, "session_start"))
    wait_for_session_in_fleet(parent_sid, timeout=5.0)

    post_event(
        make_event(
            child_sid,
            child_flavor,
            "session_start",
            parent_session_id=parent_sid,
            agent_role="worker",
        )
    )
    wait_for_session_in_fleet(child_sid, timeout=5.0)

    return parent_sid, child_sid


def test_child_event_bumps_active_parent_last_seen() -> None:
    """Happy-path bump: parent is active; a child post_call advances
    the parent's last_seen_at without changing state.
    """
    parent_sid, child_sid = _seed_parent_with_child(
        "test-bump-active-parent", "test-bump-active-child"
    )

    # Capture parent's current last_seen_at (post-session_start), then
    # backdate it 5 seconds so the child event's bump is observable as
    # a strictly-later timestamp.
    exec_sql(
        "UPDATE sessions SET last_seen_at = NOW() - INTERVAL '5 seconds' "
        "WHERE session_id = :'sid'::uuid",
        sid=parent_sid,
    )
    pre_bump = _read_parent_last_seen(parent_sid)

    post_event(
        make_event(
            child_sid,
            f"test-bump-active-child-{uuid.uuid4().hex[:6]}",
            "post_call",
            parent_session_id=parent_sid,
            tokens_total=42,
        )
    )

    def _parent_advanced() -> bool:
        return _read_parent_last_seen(parent_sid) > pre_bump

    wait_until(
        _parent_advanced,
        timeout=10,
        interval=0.5,
        msg=f"parent {parent_sid} last_seen_at did not advance on child event",
    )
    # State stays active throughout — bump without revival.
    assert _read_session_row(parent_sid)["state"] == "active"


def test_child_event_revives_stale_parent() -> None:
    """Parent forced to state='stale'; child event fires; parent
    transitions back to active and last_seen_at advances.
    """
    parent_sid, child_sid = _seed_parent_with_child(
        "test-revive-stale-parent", "test-revive-stale-child"
    )
    _force_state(parent_sid, "stale")
    assert _read_session_row(parent_sid)["state"] == "stale"

    post_event(
        make_event(
            child_sid,
            f"test-revive-stale-child-{uuid.uuid4().hex[:6]}",
            "post_call",
            parent_session_id=parent_sid,
            tokens_total=10,
        )
    )

    wait_until(
        lambda: _read_session_row(parent_sid)["state"] == "active",
        timeout=10,
        interval=0.5,
        msg=f"parent {parent_sid} should have been revived stale → active",
    )


def test_child_event_revives_lost_parent() -> None:
    """Parent forced to state='lost'; child event fires; parent
    transitions back to active. Mirrors the stale revival test for the
    second revivable state.
    """
    parent_sid, child_sid = _seed_parent_with_child(
        "test-revive-lost-parent", "test-revive-lost-child"
    )
    _force_state(parent_sid, "lost")
    assert _read_session_row(parent_sid)["state"] == "lost"

    post_event(
        make_event(
            child_sid,
            f"test-revive-lost-child-{uuid.uuid4().hex[:6]}",
            "post_call",
            parent_session_id=parent_sid,
            tokens_total=10,
        )
    )

    wait_until(
        lambda: _read_session_row(parent_sid)["state"] == "active",
        timeout=10,
        interval=0.5,
        msg=f"parent {parent_sid} should have been revived lost → active",
    )


def test_child_event_does_not_revive_closed_parent() -> None:
    """Parent forced to state='closed' (terminal); child event fires;
    parent stays closed. Reviving a closed session would contradict
    the user's explicit end-of-session signal.
    """
    parent_sid, child_sid = _seed_parent_with_child(
        "test-noop-closed-parent", "test-noop-closed-child"
    )
    _force_state(parent_sid, "closed")
    pre_state_row = _read_session_row(parent_sid)
    assert pre_state_row["state"] == "closed"

    post_event(
        make_event(
            child_sid,
            f"test-noop-closed-child-{uuid.uuid4().hex[:6]}",
            "post_call",
            parent_session_id=parent_sid,
            tokens_total=10,
        )
    )

    # Negative wait: poll for the wrong-flip condition (state changed
    # away from 'closed') with a 15s budget. If the bump is going to
    # incorrectly revive the closed parent, it does so inside this
    # window. Using wait_until rather than bare time.sleep keeps the
    # polling cadence visible.
    def _parent_wrongly_revived() -> bool:
        return _read_session_row(parent_sid)["state"] != "closed"

    try:
        wait_until(
            _parent_wrongly_revived,
            timeout=15,
            interval=1,
            msg=f"closed parent {parent_sid} must not revive on child event",
        )
    except TimeoutError:
        # Expected: parent correctly stayed closed.
        pass
    else:
        raise AssertionError(
            f"closed parent {parent_sid} was incorrectly revived to "
            f"{_read_session_row(parent_sid)['state']!r} by a child event"
        )


def test_orphan_reaper_does_not_fire_on_active_parent_with_child_traffic() -> None:
    """Reaper interaction: a parent that's been backdated (would be
    reaped) gets bumped back into a fresh window by child traffic,
    so the next reconciler tick does NOT close the parent. Guards
    against the parent-bump propagation accidentally landing in a
    state where children stream but the reaper still wins the race.

    Backdate parent past 24h orphan timeout AND force lost. Without
    the bump the next reconciler tick reaps. With the bump, the child
    event flips it back to active well before the tick fires.
    """
    parent_sid, child_sid = _seed_parent_with_child(
        "test-reaper-noop-parent", "test-reaper-noop-child"
    )
    exec_sql(
        "UPDATE sessions SET state = 'lost', "
        "last_seen_at = NOW() - INTERVAL '25 hours' "
        "WHERE session_id = :'sid'::uuid",
        sid=parent_sid,
    )

    # Child event fires immediately — the bump should flip parent to
    # active and update last_seen_at to NOW(), well before any
    # reconciler tick can pick the row up as a reaper candidate.
    post_event(
        make_event(
            child_sid,
            f"test-reaper-noop-child-{uuid.uuid4().hex[:6]}",
            "post_call",
            parent_session_id=parent_sid,
            tokens_total=10,
        )
    )

    wait_until(
        lambda: _read_session_row(parent_sid)["state"] == "active",
        timeout=10,
        interval=0.5,
        msg=f"parent {parent_sid} should be revived to active before reaper fires",
    )

    # Wait through one full reconciler tick window (60s + 30s padding)
    # to confirm the reaper does NOT subsequently close the parent.
    # State must stay active and ended_at must remain null. If the
    # bump's last_seen_at update raced and the reaper picked up a
    # stale value, this assertion catches it.
    def _parent_wrongly_closed() -> bool:
        return _read_session_row(parent_sid)["state"] == "closed"

    try:
        wait_until(
            _parent_wrongly_closed,
            timeout=90,
            interval=10,
            msg=f"reaper must not close parent {parent_sid} that has live child traffic",
        )
    except TimeoutError:
        # Expected: parent stayed active for the full reconciler window.
        pass
    else:
        raise AssertionError(
            f"reaper incorrectly closed parent {parent_sid} despite live child traffic"
        )
