"""Integration tests for session state transitions.

Tests the five-state lifecycle: active → idle → stale → closed/lost,
and the D105 revival path that flips stale/lost back to active on any
non-session_start event. Requires `make dev` to be running.
"""

from __future__ import annotations

import uuid

from .conftest import (
    exec_sql,
    get_session,
    get_session_detail,
    make_event,
    post_event,
    post_heartbeat,
    wait_for_session_in_fleet,
    wait_for_state,
    wait_until,
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
    raw = exec_sql(
        "SELECT COUNT(*) FROM sessions WHERE session_id = :'sid'::uuid",
        sid=sid,
    )
    assert raw == "0", (
        f"session_end on unknown session_id should not lazy-create a row; "
        f"found {raw} row(s) for {sid}"
    )


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
