"""Seed canonical E2E fixtures into a running dev stack.

Runs as:

    python3 tests/e2e-fixtures/seed.py

Reads ``canonical.json`` (sibling file) and emits events to the
ingestion API with identity fields that match the D115 vocabulary.
Session IDs derive deterministically from ``uuid5(NAMESPACE,
'flightdeck-e2e/<agent_name>/<role>')`` so each seed run addresses
the same sessions and the operation is idempotent — a repeat run
against an already-seeded DB is a no-op per session.

Used by ``dashboard/tests/e2e/globalSetup.ts`` as the Playwright
globalSetup hook and exposed to developers via ``make seed-e2e``
for fixture iteration.

Three sessions per role follow the declarative timeline in
canonical.json. For ``aged-closed`` and ``stale`` the worker stamps
``last_seen_at = NOW()`` on write, so after the event sequence
lands we back-date the session row directly via ``docker exec
psql`` — the same pattern ``test_session_states.py:269`` uses to
simulate aged sessions.
"""

from __future__ import annotations

import json
import os
import pathlib
import subprocess
import sys
import time
import urllib.error
from typing import Any
from uuid import UUID, uuid5

# Make ``tests.shared.fixtures`` importable when the script runs
# standalone (not under pytest). Walks up two levels:
# tests/e2e-fixtures/seed.py -> tests/ -> repo root.
_REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from tests.shared.fixtures import (  # noqa: E402
    API_URL,
    INGESTION_URL,
    auth_headers,
    get_session,
    make_event,
    post_event,
    wait_for_services,
    wait_for_session_in_fleet,
)

# NAMESPACE_FLIGHTDECK mirrors sensor/flightdeck_sensor/core/agent_id.py.
# Imported verbatim here rather than re-importing the sensor module so
# seed.py stays runnable even in environments where the sensor isn't
# installed (though make_event itself pulls sensor in). Keeps the
# failure mode "import error on helper" rather than "silent fallback
# to a different namespace".
NAMESPACE_FLIGHTDECK = UUID("ee22ab58-26fc-54ef-91b4-b5c0a97f9b61")

CANONICAL_PATH = pathlib.Path(__file__).resolve().parent / "canonical.json"

# Minimum events per seeded session. Used by ``session_is_complete`` as
# the idempotency signal: a session with at least this many events is
# considered fully seeded. session_start + pre_call + post_call = 3 is
# the floor; closed sessions get +session_end (4), and every role
# emits a tool_call/tool_result pair on top so the real counts are
# 5-6.
MIN_EVENTS_FOR_COMPLETE = 3

# Seed cap: how long to wait for the worker to catch up once all
# events are posted before T_TEST starts reading the fleet.
SEED_READY_TIMEOUT_SEC = 30


def _derive_session_id(agent_name: str, role: str) -> str:
    return str(uuid5(NAMESPACE_FLIGHTDECK, f"flightdeck-e2e/{agent_name}/{role}"))


def _shift_timestamp(offset_sec: int) -> str:
    """Return an ISO-8601 UTC timestamp ``offset_sec`` from now.

    Negative offsets point to the past. The ingestion API accepts
    past-dated event timestamps but the worker ultimately stamps
    ``last_seen_at = NOW()`` on writes (see
    workers/internal/writer/postgres.go), so for aged-closed / stale
    roles the post-seed SQL backdate is the load-bearing adjustment,
    not this.
    """
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + offset_sec))


def _post_session_events(
    *,
    agent_cfg: dict[str, Any],
    session_id: str,
    role_cfg: dict[str, Any],
) -> int:
    """Emit the declarative event timeline for a single session role.

    Posts session_start first and waits for the worker to persist the
    sessions row before posting followups -- out-of-order processing
    under NATS's worker pool can land a session_end before its
    session_start, which trips the events FK constraint. The wait is
    cheap (typically <200 ms) and converts a race into a serialized
    write path.

    Each role lands session_start, a pre_call/post_call pair with
    token usage (exercises the dashboard's token columns), and a
    tool_call event carrying both tool_name/tool_input AND tool_result
    on the single payload (the system has no separate tool_result
    event type — workers/internal/processor/event.go recognises only
    session_start / session_end / heartbeat / directive_result and
    lazy-creates on pre_call/post_call/tool_call). Closed roles add
    session_end at ``ended_offset_sec``.

    Returns the count of events successfully posted.
    """
    started = int(role_cfg["started_offset_sec"])
    ended = role_cfg["ended_offset_sec"]

    identity = {
        "agent_type": agent_cfg["agent_type"],
        "client_type": agent_cfg["client_type"],
        "user": agent_cfg["user"],
        "hostname": agent_cfg["hostname"],
        "agent_name": agent_cfg["agent_name"],
    }
    common = {
        "host": agent_cfg["host"],
        "framework": agent_cfg["framework"],
        "model": agent_cfg["model"],
    }

    # 1. session_start, then wait for persistence.
    post_event(make_event(
        session_id, agent_cfg["flavor"], "session_start",
        timestamp=_shift_timestamp(started),
        **identity,
        **common,
    ))
    if wait_for_session_in_fleet(session_id, timeout=5.0) is None:
        print(
            f"  warn: {session_id[:8]} session_start did not surface in 5s; "
            f"subsequent event inserts may FK-violate",
            file=sys.stderr,
        )

    posted = 1

    # 2. pre_call / post_call pair (tokens on post).
    post_event(make_event(
        session_id, agent_cfg["flavor"], "pre_call",
        timestamp=_shift_timestamp(started + 5),
        tokens_input=240,
        tokens_used_session=240,
        **identity,
        **common,
    ))
    post_event(make_event(
        session_id, agent_cfg["flavor"], "post_call",
        timestamp=_shift_timestamp(started + 8),
        tokens_input=240,
        tokens_output=80,
        tokens_total=320,
        tokens_used_session=320,
        latency_ms=3100,
        **identity,
        **common,
    ))
    posted += 2

    # 3. tool_call carrying both input and result on one payload.
    post_event(make_event(
        session_id, agent_cfg["flavor"], "tool_call",
        timestamp=_shift_timestamp(started + 10),
        tool_name="read_file",
        tool_input={"path": "/tmp/e2e.txt"},
        tool_result={"ok": True, "bytes": 42},
        **identity,
        **common,
    ))
    posted += 1

    # 4. session_end for closed roles.
    if ended is not None:
        post_event(make_event(
            session_id, agent_cfg["flavor"], "session_end",
            timestamp=_shift_timestamp(int(ended)),
            **identity,
            **common,
        ))
        posted += 1

    return posted


def _session_is_complete(session_id: str) -> bool:
    """Return True if the session already has >= MIN_EVENTS_FOR_COMPLETE
    events in the DB. Used for idempotent seeding: a session that
    cleared the bar is left alone on subsequent seed runs.
    """
    try:
        detail = get_session(session_id)
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return False
        raise
    events = detail.get("events") or []
    return len(events) >= MIN_EVENTS_FOR_COMPLETE


def _backdate_session(
    session_id: str,
    started_offset_sec: int,
    ended_offset_sec: int | None,
    force_state: str | None = None,
) -> None:
    """Force started_at / last_seen_at / ended_at to the declared offsets
    via ``docker exec psql``. The worker stamps NOW() for these columns
    on every event write, so the only way to land an "aged" or "stale"
    fixture deterministically is to UPDATE directly after the events
    land.

    Mirrors test_session_states.py:269's pattern. Best-effort — if
    psql isn't reachable or the row isn't there yet, the function logs
    and continues; the test that relies on the backdate will surface
    the gap clearly.

    ``force_state`` overrides the state column explicitly — used for
    aged-closed so a session_end event that raced or missed the FK
    window does not leave the fixture in state='active'. For stale we
    leave the state alone and let the reconciler classify naturally
    based on last_seen_at.
    """
    started_expr = f"NOW() - INTERVAL '{abs(started_offset_sec)} seconds'"
    parts = [
        f"started_at = {started_expr}",
        f"last_seen_at = {started_expr}" if ended_offset_sec is None
        else f"last_seen_at = NOW() - INTERVAL '{abs(ended_offset_sec)} seconds'",
    ]
    if ended_offset_sec is not None:
        parts.append(
            f"ended_at = NOW() - INTERVAL '{abs(ended_offset_sec)} seconds'"
        )
    if force_state is not None:
        parts.append(f"state = '{force_state}'")
    set_clause = ", ".join(parts)
    sql = (
        f"UPDATE sessions SET {set_clause} "
        f"WHERE session_id = '{session_id}'::uuid"
    )
    try:
        result = subprocess.run(
            ["docker", "exec", "docker-postgres-1", "psql", "-U", "flightdeck",
             "-d", "flightdeck", "-c", sql],
            capture_output=True, text=True, timeout=10, check=False,
        )
        if result.returncode != 0:
            print(
                f"  warn: psql backdate for {session_id} returned "
                f"{result.returncode}: {result.stderr.strip()}",
                file=sys.stderr,
            )
    except (subprocess.TimeoutExpired, FileNotFoundError) as exc:
        print(
            f"  warn: psql backdate for {session_id} failed: {exc}",
            file=sys.stderr,
        )


def _wait_for_fleet_visibility(expected_agent_names: list[str], timeout: float) -> None:
    """Poll GET /v1/fleet until every expected agent_name is present.

    The fleet endpoint is what Playwright tests land on, so this is the
    correct success signal — not the per-session detail endpoint.
    """
    import urllib.request

    deadline = time.time() + timeout
    missing: list[str] = list(expected_agent_names)
    while time.time() < deadline:
        req = urllib.request.Request(
            f"{API_URL}/v1/fleet?per_page=100",
            headers=auth_headers(),
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            payload = json.loads(resp.read())
        live_names = {a.get("agent_name", "") for a in (payload.get("agents") or [])}
        missing = [n for n in expected_agent_names if n not in live_names]
        if not missing:
            return
        time.sleep(1.0)
    raise TimeoutError(
        f"Fleet did not surface all E2E fixtures after {timeout}s. "
        f"Missing: {missing}. Check workers logs."
    )


def seed() -> None:
    print(f"[seed] waiting for services at {INGESTION_URL} / {API_URL} ...")
    wait_for_services(timeout=30)

    with CANONICAL_PATH.open() as fh:
        cfg = json.load(fh)

    roles_cfg: dict[str, dict[str, Any]] = cfg["session_roles"]
    agents_cfg: list[dict[str, Any]] = cfg["agents"]

    total_sessions = sum(len(a["session_roles"]) for a in agents_cfg)
    print(f"[seed] canonical dataset: {len(agents_cfg)} agents, {total_sessions} sessions")

    seeded: int = 0
    skipped: int = 0
    backdated: int = 0

    for agent_cfg in agents_cfg:
        for role in agent_cfg["session_roles"]:
            role_cfg = roles_cfg[role]
            session_id = _derive_session_id(agent_cfg["agent_name"], role)

            if _session_is_complete(session_id):
                print(f"  skip {agent_cfg['agent_name']}/{role} ({session_id[:8]}) — already has events")
                skipped += 1
                continue

            posted = _post_session_events(
                agent_cfg=agent_cfg,
                session_id=session_id,
                role_cfg=role_cfg,
            )
            seeded += 1
            print(f"  seeded {agent_cfg['agent_name']}/{role} ({session_id[:8]}) — {posted} events")

    expected_agent_names = [a["agent_name"] for a in agents_cfg]
    print(f"[seed] waiting for worker to persist {len(expected_agent_names)} agents ...")
    _wait_for_fleet_visibility(expected_agent_names, timeout=SEED_READY_TIMEOUT_SEC)

    # Backdate aged-closed / stale sessions so their visible timestamps
    # match the declared offsets. Done AFTER the fleet-visibility wait
    # so the worker has finished stamping NOW() on every column before
    # we move them. aged-closed also gets an explicit state='closed'
    # override because a session_end that races the session_start
    # insert leaves the row in state='active'; the UI renders state by
    # the enum, not by presence of ended_at.
    #
    # fresh-active is *forward-dated* on every seed run (not skipped by
    # idempotency) because wall-clock time between seed and
    # Playwright run drifts last_seen_at into the reconciler's 2-min
    # stale window. The session_id is stable (uuid5-derived) so
    # re-stamping last_seen_at = NOW() and pinning state='active'
    # keeps the fixture semantics consistent without re-emitting
    # events. Matches the aged-closed/stale pattern: the UI reads
    # state enum + last_seen_at, not the event stream's recency.
    for agent_cfg in agents_cfg:
        for role in agent_cfg["session_roles"]:
            role_cfg = roles_cfg[role]
            session_id = _derive_session_id(agent_cfg["agent_name"], role)
            if role == "fresh-active":
                # Pin state='active' and last_seen_at to NOW. Runs on
                # every seed invocation so the session stays fresh
                # relative to the Playwright run even if the previous
                # seed landed 10 min ago.
                #
                # ALSO emit a fresh tool_call event (timestamp=NOW-5s)
                # on every seed run. Without this, the event stream's
                # newest timestamp stays frozen at original-seed-time;
                # the Fleet swimlane defaults to a 1-minute domain,
                # so events older than 60s are filtered out at render
                # time (timeline/SwimLane.tsx AggregatedSessionEvents
                # line 655). The refresh keeps a visible circle in the
                # swimlane regardless of how much wall-clock time
                # passed between seeds.
                sql = (
                    f"UPDATE sessions SET "
                    f"state='active', "
                    f"last_seen_at=NOW(), "
                    f"started_at=NOW() - INTERVAL '30 seconds' "
                    f"WHERE session_id='{session_id}'::uuid"
                )
                try:
                    subprocess.run(
                        ["docker", "exec", "docker-postgres-1", "psql",
                         "-U", "flightdeck", "-d", "flightdeck", "-c", sql],
                        capture_output=True, text=True, timeout=10, check=False,
                    )
                    # Emit a fresh tool_call so the session has an
                    # in-window event for the default 1m swimlane
                    # domain.
                    identity = {
                        "agent_type": agent_cfg["agent_type"],
                        "client_type": agent_cfg["client_type"],
                        "user": agent_cfg["user"],
                        "hostname": agent_cfg["hostname"],
                        "agent_name": agent_cfg["agent_name"],
                    }
                    post_event(make_event(
                        session_id, agent_cfg["flavor"], "tool_call",
                        timestamp=_shift_timestamp(-5),
                        tool_name="e2e_refresh",
                        tool_input={"reason": "seed keeps fresh-active in 1m swimlane window"},
                        tool_result={"ok": True},
                        framework=agent_cfg["framework"],
                        model=agent_cfg["model"],
                        host=agent_cfg["host"],
                        **identity,
                    ))
                    backdated += 1
                except (subprocess.TimeoutExpired, FileNotFoundError) as exc:
                    print(f"  warn: fresh-active refresh for {session_id} failed: {exc}", file=sys.stderr)
                continue
            if role not in ("aged-closed", "stale"):
                continue
            # Force state for deterministic E2E assertions. Letting the
            # reconciler reclassify naturally would flake: the
            # reconciler runs on a timer (see workers postgres.go:543),
            # so test runs that start right after seed may catch
            # aged-closed/stale in state='active' briefly. Tests assert
            # on the UI behaviour per state, so pinning the enum is
            # fine and matches how test_session_states.py:54 handles
            # the same class of fixture.
            if role == "aged-closed":
                forced_state = "closed"
            elif role == "stale":
                # 3h past last_seen_at is well beyond the 10-min lost
                # threshold. 'lost' is what the reconciler would set on
                # its next pass anyway; pinning it up-front makes the
                # fixture test-stable on a freshly-seeded stack.
                forced_state = "lost"
            else:
                forced_state = None
            _backdate_session(
                session_id=session_id,
                started_offset_sec=int(role_cfg["started_offset_sec"]),
                ended_offset_sec=role_cfg["ended_offset_sec"],
                force_state=forced_state,
            )
            backdated += 1

    print(f"[seed] done — seeded={seeded} skipped={skipped} backdated={backdated}")


if __name__ == "__main__":
    try:
        seed()
    except Exception as exc:
        print(f"[seed] FAILED: {exc}", file=sys.stderr)
        sys.exit(1)
