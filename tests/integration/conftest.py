"""Integration test fixtures.

The stack fixture verifies all services are healthy before any test runs.
Uses health check endpoints to wait for readiness.
"""

from __future__ import annotations

import time
from typing import Any, Callable

import pytest
import urllib.request
import urllib.error
import json

INGESTION_URL = "http://localhost:4000/ingest"
API_URL = "http://localhost:4000/api"
INGEST_HEALTH = f"{INGESTION_URL}/health"
API_HEALTH = f"{API_URL}/health"
TOKEN = "tok_dev"

MAX_WAIT_SECS = 60
POLL_INTERVAL = 2


def _check_health(url: str) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=3) as resp:
            body = json.loads(resp.read())
            return body.get("status") == "ok"
    except (urllib.error.URLError, OSError, json.JSONDecodeError):
        return False


def _wait_for_services() -> None:
    """Wait up to MAX_WAIT_SECS for all services to report healthy."""
    deadline = time.time() + MAX_WAIT_SECS
    services = {"ingestion": INGEST_HEALTH, "api": API_HEALTH}

    while time.time() < deadline:
        healthy = {name: _check_health(url) for name, url in services.items()}
        if all(healthy.values()):
            return
        time.sleep(POLL_INTERVAL)

    unhealthy = [name for name, ok in healthy.items() if not ok]
    pytest.fail(
        f"Services not healthy after {MAX_WAIT_SECS}s: {', '.join(unhealthy)}. "
        f"Run 'make dev' first."
    )


@pytest.fixture(scope="session", autouse=True)
def stack() -> None:
    """Verify all services are healthy before running integration tests."""
    _wait_for_services()


# ---------------------------------------------------------------------------
# Session lifecycle tracking
#
# Most integration tests POST synthetic events (they do not drive the real
# sensor), so without help every test session would stay in state=active
# forever and never accumulate runtime context. Two helpers here close
# both gaps:
#
#   * ``DEFAULT_TEST_CONTEXT`` -- a synthetic context dict auto-attached
#     to every ``session_start`` event built via ``make_event`` (unless
#     the caller passes ``context=...`` explicitly).
#   * ``_session_lifecycle`` autouse fixture -- POSTs a ``session_end``
#     event for every session_id seen in the test, except those that
#     already received one explicitly. This keeps dashboard data clean
#     across test runs and exercises the closed-state code path that
#     production sensors hit on teardown.
# ---------------------------------------------------------------------------

DEFAULT_TEST_CONTEXT: dict[str, Any] = {
    "os": "Linux",
    "arch": "x86_64",
    "hostname": "integration-test-host",
    "user": "integration",
    "python_version": "3.13.0",
    "pid": 12345,
    "process_name": "pytest",
    "git_branch": "integration-tests",
    "git_commit": "deadbee",
    "git_repo": "flightdeck",
    "orchestration": "docker-compose",
    "compose_project": "flightdeck-tests",
    "frameworks": ["integration-suite/1.0"],
}

# Session IDs created in the current test, mapped to their flavor, so the
# cleanup fixture can POST session_end. Reset before each test by the
# autouse fixture below.
_session_tracker: dict[str, str] = {}
_ended_sessions: set[str] = set()


def post_event(payload: dict[str, Any]) -> dict[str, Any]:
    """POST an event to the ingestion API and return the response."""
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        f"{INGESTION_URL}/v1/events",
        data=data,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {TOKEN}",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=5) as resp:
        body = json.loads(resp.read())
    if payload.get("event_type") == "session_end":
        sid = payload.get("session_id")
        if isinstance(sid, str):
            _ended_sessions.add(sid)
    return body  # type: ignore[no-any-return]


def post_heartbeat(session_id: str) -> dict[str, Any]:
    """POST a heartbeat to the ingestion API."""
    data = json.dumps({"session_id": session_id}).encode()
    req = urllib.request.Request(
        f"{INGESTION_URL}/v1/heartbeat",
        data=data,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {TOKEN}",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=5) as resp:
        return json.loads(resp.read())  # type: ignore[no-any-return]


def get_fleet() -> dict[str, Any]:
    """GET /v1/fleet from the query API.

    Pages through every flavor until the response is exhausted, then
    merges flavors that span page boundaries (the API groups sessions
    by flavor inside each page; the same flavor can appear on the
    next page with additional sessions). This is required so a
    session whose flavor sorts alphabetically past the first 50 in
    the fleet is still discoverable by callers like
    session_exists_in_fleet and wait_for_session_in_fleet.
    """
    limit = 100
    offset = 0
    merged: dict[str, dict[str, Any]] = {}
    flavor_order: list[str] = []
    total = 0
    while True:
        url = f"{API_URL}/v1/fleet?limit={limit}&offset={offset}"
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read())
        flavors = data.get("flavors", [])
        total = data.get("total_session_count", total)
        page_session_count = 0
        for flavor in flavors:
            page_session_count += len(flavor.get("sessions", []))
            name = flavor.get("flavor", "")
            if name not in merged:
                merged[name] = dict(flavor)
                flavor_order.append(name)
            else:
                # Same flavor straddled a page boundary -- append its
                # additional sessions onto the existing merged entry.
                merged[name].setdefault("sessions", []).extend(
                    flavor.get("sessions", [])
                )
                merged[name]["session_count"] = (
                    merged[name].get("session_count", 0)
                    + flavor.get("session_count", 0)
                )
                merged[name]["active_count"] = (
                    merged[name].get("active_count", 0)
                    + flavor.get("active_count", 0)
                )
                merged[name]["tokens_used_total"] = (
                    merged[name].get("tokens_used_total", 0)
                    + flavor.get("tokens_used_total", 0)
                )
        if offset + limit >= total or page_session_count < limit:
            break
        offset += limit

    return {
        "flavors": [merged[name] for name in flavor_order],
        "total_session_count": total,
    }


def get_session(session_id: str) -> dict[str, Any]:
    """GET /v1/sessions/:id from the query API."""
    req = urllib.request.Request(f"{API_URL}/v1/sessions/{session_id}")
    with urllib.request.urlopen(req, timeout=5) as resp:
        return json.loads(resp.read())  # type: ignore[no-any-return]


def _get_fleet_page(limit: int, offset: int) -> dict[str, Any]:
    """GET /v1/fleet?limit=&offset= -- single page."""
    url = f"{API_URL}/v1/fleet?limit={limit}&offset={offset}"
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=5) as resp:
        return json.loads(resp.read())  # type: ignore[no-any-return]


def wait_for_session_in_fleet(
    session_id: str, timeout: float = 5.0
) -> dict[str, Any] | None:
    """Poll GET /v1/fleet until the session appears or timeout.

    Pages through all sessions on each poll so a session does not get
    missed when accumulated test data pushes it past the default 50
    session limit. Without pagination, the helper used to silently
    return None for any session whose flavor sorted alphabetically
    after the first 50 in the fleet, producing intermittent failures
    in test_session_states.test_stale_after_no_signal that depended on
    test ordering.
    """
    deadline = time.time() + timeout
    limit = 50
    while time.time() < deadline:
        offset = 0
        while True:
            data = _get_fleet_page(limit, offset)
            flavors = data.get("flavors", [])
            for flavor in flavors:
                for sess in flavor.get("sessions", []):
                    if sess.get("session_id") == session_id:
                        return sess  # type: ignore[no-any-return]
            # If fewer sessions returned than limit, this was the last page.
            page_session_count = sum(
                len(f.get("sessions", [])) for f in flavors
            )
            total = data.get("total_session_count", page_session_count)
            if offset + limit >= total or page_session_count < limit:
                break
            offset += limit
        # Not found on this poll -- wait and retry.
        time.sleep(0.5)
    return None


def make_event(
    session_id: str,
    flavor: str,
    event_type: str,
    **extra: Any,
) -> dict[str, Any]:
    """Build an event payload."""
    payload: dict[str, Any] = {
        "session_id": session_id,
        "flavor": flavor,
        "agent_type": "autonomous",
        "event_type": event_type,
        "host": "test-host",
        "framework": None,
        "model": None,
        "tokens_input": None,
        "tokens_output": None,
        "tokens_total": None,
        "tokens_used_session": 0,
        "token_limit_session": None,
        "latency_ms": None,
        "tool_name": None,
        "tool_input": None,
        "tool_result": None,
        "has_content": False,
        "content": None,
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    payload.update(extra)
    if event_type == "session_start" and "context" not in payload:
        payload["context"] = dict(DEFAULT_TEST_CONTEXT)
    _session_tracker[session_id] = flavor
    return payload


def create_policy(
    scope: str,
    scope_value: str,
    token_limit: int | None,
    warn_at_pct: int | None = None,
    degrade_at_pct: int | None = None,
    degrade_to: str | None = None,
    block_at_pct: int | None = None,
) -> dict[str, Any]:
    """Create a token policy via POST /api/v1/policies."""
    body: dict[str, Any] = {
        "scope": scope,
        "scope_value": scope_value,
        "token_limit": token_limit,
        "warn_at_pct": warn_at_pct,
        "degrade_at_pct": degrade_at_pct,
        "degrade_to": degrade_to,
        "block_at_pct": block_at_pct,
    }
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        f"{API_URL}/v1/policies",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=5) as resp:
        return json.loads(resp.read())  # type: ignore[no-any-return]


def delete_policy(policy_id: str) -> None:
    """Delete a token policy via DELETE /api/v1/policies/:id."""
    req = urllib.request.Request(
        f"{API_URL}/v1/policies/{policy_id}",
        method="DELETE",
    )
    try:
        with urllib.request.urlopen(req, timeout=5):
            pass
    except urllib.error.HTTPError:
        pass  # Already deleted or not found -- safe to ignore


def get_session_detail(session_id: str) -> dict[str, Any]:
    """GET /api/v1/sessions/:id -- returns session with events and policy fields."""
    req = urllib.request.Request(f"{API_URL}/v1/sessions/{session_id}")
    with urllib.request.urlopen(req, timeout=5) as resp:
        return json.loads(resp.read())  # type: ignore[no-any-return]


def query_directives(session_id: str) -> list[dict[str, Any]]:
    """Query directives table directly via docker exec psql."""
    import subprocess

    sql = (
        f"SELECT COALESCE(json_agg(row_to_json(d)), '[]'::json) "
        f"FROM directives d "
        f"WHERE d.session_id = '{session_id}'::uuid"
    )
    result = subprocess.run(
        ["docker", "exec", "docker-postgres-1", "psql", "-U", "flightdeck",
         "-d", "flightdeck", "-t", "-c", sql],
        capture_output=True, text=True, timeout=10,
    )
    raw = result.stdout.strip()
    if not raw or raw == "null":
        return []
    return json.loads(raw)  # type: ignore[no-any-return]


def wait_until(
    condition_fn: Callable[[], bool],
    timeout: float = 10.0,
    interval: float = 0.25,
    msg: str = "condition not met",
) -> None:
    """Poll condition_fn until it returns True or timeout is reached.

    Never use time.sleep() as a fixed wait -- use this instead.
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if condition_fn():
            return
        time.sleep(interval)
    raise TimeoutError(f"Timed out after {timeout}s: {msg}")


def session_exists_in_fleet(session_id: str) -> bool:
    """Check if a session appears in the fleet endpoint."""
    fleet = get_fleet()
    for flavor in fleet.get("flavors", []):
        for s in flavor.get("sessions", []):
            if s.get("session_id") == session_id:
                return True
    return False


def get_session_event_count(session_id: str) -> int:
    """Return the number of events for a session."""
    try:
        detail = get_session_detail(session_id)
        return len(detail.get("events", []))
    except Exception:
        return 0


def wait_for_state(
    session_id: str, expected_state: str, timeout: float = 10.0,
) -> dict[str, Any]:
    """Poll until session reaches expected_state or timeout."""
    detail: dict[str, Any] = {}

    def _check() -> bool:
        nonlocal detail
        try:
            detail = get_session_detail(session_id)
            return detail["session"]["state"] == expected_state
        except Exception:
            return False

    wait_until(
        _check,
        timeout=timeout,
        msg=f"session {session_id} did not reach state={expected_state}",
    )
    return detail


def post_directive(
    action: str,
    session_id: str | None = None,
    flavor: str | None = None,
    reason: str | None = None,
    grace_period_ms: int = 5000,
) -> dict[str, Any]:
    """POST /api/v1/directives and return response JSON."""
    body: dict[str, Any] = {
        "action": action,
        "grace_period_ms": grace_period_ms,
    }
    if session_id is not None:
        body["session_id"] = session_id
    if flavor is not None:
        body["flavor"] = flavor
    if reason is not None:
        body["reason"] = reason
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        f"{API_URL}/v1/directives",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=5) as resp:
        return json.loads(resp.read())  # type: ignore[no-any-return]


def directive_has_delivered_at(directive_id: str) -> bool:
    """Check if a directive has been marked delivered via direct DB query."""
    import subprocess

    sql = (
        f"SELECT delivered_at IS NOT NULL "
        f"FROM directives "
        f"WHERE id = '{directive_id}'::uuid"
    )
    result = subprocess.run(
        ["docker", "exec", "docker-postgres-1", "psql", "-U", "flightdeck",
         "-d", "flightdeck", "-t", "-c", sql],
        capture_output=True, text=True, timeout=10,
    )
    return result.stdout.strip() == "t"


@pytest.fixture(autouse=True)
def _session_lifecycle() -> Any:
    """Track sessions created during a test and POST session_end on teardown.

    Production sensors close their session on teardown via ``Session.end()``
    which posts ``session_end``. Integration tests bypass the sensor and
    POST synthetic events directly, so without this fixture every test
    session would remain in state=active forever and accumulate stale
    rows in the dashboard. The fixture clears the per-test tracker, runs
    the test, then POSTs ``session_end`` for every session_id observed
    that has not already been ended explicitly.

    Failures during cleanup are swallowed -- a teardown error must not
    mask the actual test result. The cleanup pass is best-effort.
    """
    _session_tracker.clear()
    _ended_sessions.clear()
    try:
        yield
    finally:
        for sid, flavor in list(_session_tracker.items()):
            if sid in _ended_sessions:
                continue
            try:
                # Build the payload directly -- calling make_event() here
                # would re-register the session_id in the tracker (already
                # being drained) and pull in DEFAULT_TEST_CONTEXT, which
                # only belongs on session_start.
                payload = {
                    "session_id": sid,
                    "flavor": flavor,
                    "agent_type": "autonomous",
                    "event_type": "session_end",
                    "host": "test-host",
                    "framework": None,
                    "model": None,
                    "tokens_input": None,
                    "tokens_output": None,
                    "tokens_total": None,
                    "tokens_used_session": 0,
                    "token_limit_session": None,
                    "latency_ms": None,
                    "tool_name": None,
                    "tool_input": None,
                    "tool_result": None,
                    "has_content": False,
                    "content": None,
                    "timestamp": time.strftime(
                        "%Y-%m-%dT%H:%M:%SZ", time.gmtime()
                    ),
                }
                post_event(payload)
            except Exception:
                pass


def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line(
        "markers",
        "slow: marks tests that require waiting for background reconciler (60s+)",
    )
    config.addinivalue_line(
        "markers",
        "manual: marks tests that are NOT part of CI -- run manually only "
        "(e.g. test_ui_demo.py is a dashboard data-population tool, not a "
        "regression test). Excluded by `make test-integration` and CI via "
        "`-m 'not manual'`. Phase 4.5 audit Task 1.",
    )
