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

from flightdeck_sensor.core.agent_id import derive_agent_id

INGESTION_URL = "http://localhost:4000/ingest"
API_URL = "http://localhost:4000/api"
INGEST_HEALTH = f"{INGESTION_URL}/health"
API_HEALTH = f"{API_URL}/health"
TOKEN = "tok_dev"

# D115 identity defaults for the synthetic-emitter tier. The integration
# suite impersonates a sensor-like client (not the plugin), so client_type
# is pinned to "flightdeck_sensor" and agent_type defaults to the
# sensor's own "production" default. Individual tests can override via
# make_event(..., agent_type="coding") when needed.
DEFAULT_AGENT_TYPE = "production"
DEFAULT_CLIENT_TYPE = "flightdeck_sensor"
DEFAULT_USER = "integration"
DEFAULT_HOSTNAME = "integration-test-host"

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


def auth_headers(json_body: bool = False) -> dict[str, str]:
    """Return the standard headers for an authenticated API request.

    All ingestion and API /v1 endpoints require a bearer token (D095);
    every helper below composes its request headers through this
    function so the token is added in exactly one place. Pass
    ``json_body=True`` when the request carries a JSON body so the
    Content-Type header is also set.
    """
    headers = {"Authorization": f"Bearer {TOKEN}"}
    if json_body:
        headers["Content-Type"] = "application/json"
    return headers


def post_event(payload: dict[str, Any]) -> dict[str, Any]:
    """POST an event to the ingestion API and return the response."""
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        f"{INGESTION_URL}/v1/events",
        data=data,
        headers=auth_headers(json_body=True),
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
        headers=auth_headers(json_body=True),
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=5) as resp:
        return json.loads(resp.read())  # type: ignore[no-any-return]


def get_fleet() -> dict[str, Any]:
    """Return a sessions-flat view reconstructed from GET /v1/sessions.

    D115 retired the ``/v1/fleet`` flavor-grouped shape in favor of
    agent-keyed rollups that no longer nest sessions. Integration tests
    predate that change and scan for specific sessions by flavor, so
    this helper preserves the legacy iteration surface by fetching the
    most recent sessions via ``/v1/sessions`` and grouping them by
    flavor client-side. Returns ``{"flavors": [{"flavor": X,
    "sessions": [...]}...], "total_session_count": N}``.

    Single-page fetch (server caps at 100). Integration tests run
    serially and each creates 1--3 sessions; 100 recent sessions is
    comfortably above the working set per run.
    """
    url = f"{API_URL}/v1/sessions?limit=100"
    req = urllib.request.Request(url, headers=auth_headers())
    with urllib.request.urlopen(req, timeout=5) as resp:
        data = json.loads(resp.read())
    sessions = data.get("sessions", [])
    by_flavor: dict[str, dict[str, Any]] = {}
    flavor_order: list[str] = []
    for sess in sessions:
        name = sess.get("flavor", "")
        if name not in by_flavor:
            by_flavor[name] = {"flavor": name, "sessions": []}
            flavor_order.append(name)
        by_flavor[name]["sessions"].append(sess)
    return {
        "flavors": [by_flavor[name] for name in flavor_order],
        "total_session_count": len(sessions),
    }


def get_session(session_id: str) -> dict[str, Any]:
    """GET /v1/sessions/:id from the query API."""
    req = urllib.request.Request(
        f"{API_URL}/v1/sessions/{session_id}",
        headers=auth_headers(),
    )
    with urllib.request.urlopen(req, timeout=5) as resp:
        return json.loads(resp.read())  # type: ignore[no-any-return]


def wait_for_session_in_fleet(
    session_id: str, timeout: float = 5.0
) -> dict[str, Any] | None:
    """Poll GET /v1/sessions/:id until the worker persists the row or timeout.

    Under D115 the fleet endpoint no longer nests sessions under agents,
    so "did the session land?" is answered by hitting the single-session
    detail endpoint directly. Returns the ``session`` sub-dict on
    success or None on timeout.
    """
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            detail = get_session(session_id)
            return detail.get("session")  # type: ignore[no-any-return]
        except urllib.error.HTTPError as exc:
            if exc.code != 404:
                raise
        time.sleep(0.25)
    return None


def _identity_fields(
    *,
    agent_type: str = DEFAULT_AGENT_TYPE,
    client_type: str = DEFAULT_CLIENT_TYPE,
    user: str = DEFAULT_USER,
    hostname: str = DEFAULT_HOSTNAME,
    agent_name: str | None = None,
) -> dict[str, str]:
    """Return the D115 identity quintuple plus derived agent_id.

    Mirrors ``sensor/flightdeck_sensor/core/session.py::_build_payload``.
    The ingestion validator (D116) rejects any event lacking agent_id /
    a vocabulary-valid agent_type / a vocabulary-valid client_type, so
    every synthetic event must carry this block.
    """
    if agent_name is None:
        agent_name = f"{user}@{hostname}"
    agent_id = str(derive_agent_id(
        agent_type=agent_type,
        user=user,
        hostname=hostname,
        client_type=client_type,
        agent_name=agent_name,
    ))
    return {
        "agent_id": agent_id,
        "agent_type": agent_type,
        "agent_name": agent_name,
        "client_type": client_type,
        "user": user,
        "hostname": hostname,
    }


def make_event(
    session_id: str,
    flavor: str,
    event_type: str,
    *,
    agent_type: str = DEFAULT_AGENT_TYPE,
    client_type: str = DEFAULT_CLIENT_TYPE,
    user: str = DEFAULT_USER,
    hostname: str = DEFAULT_HOSTNAME,
    agent_name: str | None = None,
    **extra: Any,
) -> dict[str, Any]:
    """Build an event payload with D115 identity fields populated."""
    identity = _identity_fields(
        agent_type=agent_type,
        client_type=client_type,
        user=user,
        hostname=hostname,
        agent_name=agent_name,
    )
    payload: dict[str, Any] = {
        "session_id": session_id,
        "flavor": flavor,
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
    payload.update(identity)
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
        headers=auth_headers(json_body=True),
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=5) as resp:
        return json.loads(resp.read())  # type: ignore[no-any-return]


def delete_policy(policy_id: str) -> None:
    """Delete a token policy via DELETE /api/v1/policies/:id."""
    req = urllib.request.Request(
        f"{API_URL}/v1/policies/{policy_id}",
        headers=auth_headers(),
        method="DELETE",
    )
    try:
        with urllib.request.urlopen(req, timeout=5):
            pass
    except urllib.error.HTTPError:
        pass  # Already deleted or not found -- safe to ignore


def get_session_detail(session_id: str) -> dict[str, Any]:
    """GET /api/v1/sessions/:id -- returns session with events and policy fields."""
    req = urllib.request.Request(
        f"{API_URL}/v1/sessions/{session_id}",
        headers=auth_headers(),
    )
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
    """Return True once the worker has persisted the session row.

    Under D115 the legacy flavor-grouped fleet response is gone, so
    persistence is observed via ``GET /v1/sessions/:id`` returning 200.
    """
    try:
        get_session(session_id)
        return True
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return False
        raise


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
        headers=auth_headers(json_body=True),
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
                payload: dict[str, Any] = {
                    "session_id": sid,
                    "flavor": flavor,
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
                payload.update(_identity_fields())
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
