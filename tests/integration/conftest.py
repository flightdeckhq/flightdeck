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
        return json.loads(resp.read())  # type: ignore[no-any-return]


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
    """GET /v1/fleet from the query API."""
    req = urllib.request.Request(f"{API_URL}/v1/fleet")
    with urllib.request.urlopen(req, timeout=5) as resp:
        return json.loads(resp.read())  # type: ignore[no-any-return]


def get_session(session_id: str) -> dict[str, Any]:
    """GET /v1/sessions/:id from the query API."""
    req = urllib.request.Request(f"{API_URL}/v1/sessions/{session_id}")
    with urllib.request.urlopen(req, timeout=5) as resp:
        return json.loads(resp.read())  # type: ignore[no-any-return]


def wait_for_session_in_fleet(
    session_id: str, timeout: float = 5.0
) -> dict[str, Any] | None:
    """Poll GET /v1/fleet until the session appears or timeout."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        fleet = get_fleet()
        for flavor in fleet.get("flavors", []):
            for sess in flavor.get("sessions", []):
                if sess.get("session_id") == session_id:
                    return sess  # type: ignore[no-any-return]
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


def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line(
        "markers",
        "slow: marks tests that require waiting for background reconciler (60s+)",
    )
