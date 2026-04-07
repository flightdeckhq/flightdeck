"""Integration test fixtures.

The stack fixture verifies all services are healthy before any test runs.
Uses health check endpoints to wait for readiness.
"""

from __future__ import annotations

import time
from typing import Any

import pytest
import urllib.request
import urllib.error
import json

INGESTION_URL = "http://localhost:8080"
API_URL = "http://localhost:8081"
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
