"""Integration tests for MCP Protection Policy event pipeline (D131).

Exercises the full pipeline downstream of the sensor: POST event
to ingestion → NATS publish → worker consume → events table
INSERT. Each test posts a synthesized event payload (the same
shape the sensor would emit at call_tool time), polls the events
query API until the row lands, then asserts the payload
round-trips correctly.

This test deliberately bypasses the sensor's wrapper to isolate
pipeline correctness from sensor-side wrapper bugs. Sensor-side
behaviour (cache populate, evaluate, soft-launch downgrade,
call_tool hook) is unit-tested in
sensor/tests/unit/test_mcp_policy_enforcement.py.
"""

from __future__ import annotations

import datetime
import time
import uuid

import requests

from .conftest import API_URL, INGESTION_URL, TOKEN, auth_headers


def _now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _post_event(payload: dict) -> int:
    headers = {
        "Authorization": f"Bearer {TOKEN}",
        "Content-Type": "application/json",
    }
    r = requests.post(
        f"{INGESTION_URL}/v1/events",
        headers=headers, json=payload, timeout=5,
    )
    return r.status_code


def _wait_for_event(session_id: str, event_type: str, timeout: float = 5.0) -> dict | None:
    """Poll GET /v1/sessions/{id} until an event of the requested
    type appears, or return None on timeout."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        r = requests.get(
            f"{API_URL}/v1/sessions/{session_id}",
            headers=auth_headers(), timeout=3,
        )
        if r.status_code == 200:
            for event in r.json().get("events", []):
                if event.get("event_type") == event_type:
                    return event
        time.sleep(0.2)
    return None


def _baseline_session_start(session_id: str, flavor: str) -> dict:
    return {
        "session_id": session_id,
        "agent_id": str(uuid.uuid4()),
        "agent_type": "coding",
        "client_type": "flightdeck_sensor",
        "agent_name": "test-mcp-policy-pipeline",
        "user": "test",
        "hostname": "test-host",
        "flavor": flavor,
        "event_type": "session_start",
        "host": "test-host",
        "framework": None,
        "model": None,
        "timestamp": _now_iso(),
    }


def _policy_decision_event(
    session_id: str, flavor: str, event_type: str, *,
    decision_path: str = "flavor_entry",
    block_on_uncertainty: bool = False,
) -> dict:
    """Build a synthesized policy_mcp_warn / policy_mcp_block payload
    matching the sensor's wire shape."""
    payload = _baseline_session_start(session_id, flavor)
    payload["event_type"] = event_type
    payload.update({
        "server_url": "https://maps.example.com/sse",
        "server_name": "maps",
        "fingerprint": "abc123def4567890",
        "tool_name": "search",
        "policy_id": str(uuid.uuid4()),
        "scope": f"flavor:{flavor}",
        "decision_path": decision_path,
        "transport": "http",
    })
    if event_type == "policy_mcp_block":
        payload["block_on_uncertainty"] = block_on_uncertainty
    return payload


def _name_changed_event(session_id: str, flavor: str) -> dict:
    payload = _baseline_session_start(session_id, flavor)
    payload["event_type"] = "mcp_server_name_changed"
    payload.update({
        "server_url_canonical": "https://maps.example.com/sse",
        "fingerprint_old": "old0123456789abcd",
        "fingerprint_new": "new0123456789abcd",
        "name_old": "maps",
        "name_new": "maps-v2",
    })
    return payload


# ----- D131 — three new event types land end-to-end -----------------


def test_policy_mcp_warn_lands_with_payload() -> None:
    sid = str(uuid.uuid4())
    flavor = f"test-mcp-pipeline-{uuid.uuid4().hex[:6]}"

    assert _post_event(_baseline_session_start(sid, flavor)) == 200
    assert _post_event(_policy_decision_event(sid, flavor, "policy_mcp_warn")) == 200

    event = _wait_for_event(sid, "policy_mcp_warn", timeout=10.0)
    assert event is not None, "policy_mcp_warn did not land within 10s"
    assert event.get("event_type") == "policy_mcp_warn"
    payload = event.get("payload") or {}
    assert payload.get("server_name") == "maps"
    assert payload.get("decision_path") == "flavor_entry"
    assert payload.get("fingerprint") == "abc123def4567890"


def test_policy_mcp_block_lands_with_payload() -> None:
    sid = str(uuid.uuid4())
    flavor = f"test-mcp-pipeline-{uuid.uuid4().hex[:6]}"

    assert _post_event(_baseline_session_start(sid, flavor)) == 200
    assert _post_event(_policy_decision_event(
        sid, flavor, "policy_mcp_block",
        block_on_uncertainty=True,
    )) == 200

    event = _wait_for_event(sid, "policy_mcp_block", timeout=10.0)
    assert event is not None, "policy_mcp_block did not land within 10s"
    payload = event.get("payload") or {}
    assert payload.get("block_on_uncertainty") is True
    assert payload.get("decision_path") == "flavor_entry"


def test_mcp_server_name_changed_lands_with_payload() -> None:
    sid = str(uuid.uuid4())
    flavor = f"test-mcp-pipeline-{uuid.uuid4().hex[:6]}"

    assert _post_event(_baseline_session_start(sid, flavor)) == 200
    assert _post_event(_name_changed_event(sid, flavor)) == 200

    event = _wait_for_event(sid, "mcp_server_name_changed", timeout=10.0)
    assert event is not None, "mcp_server_name_changed did not land within 10s"
    payload = event.get("payload") or {}
    assert payload.get("server_url_canonical") == "https://maps.example.com/sse"
    assert payload.get("name_old") == "maps"
    assert payload.get("name_new") == "maps-v2"


# ----- D131 — ingestion validation rejects malformed payloads ------


def test_policy_mcp_warn_missing_fingerprint_rejected() -> None:
    sid = str(uuid.uuid4())
    flavor = f"test-mcp-pipeline-{uuid.uuid4().hex[:6]}"
    payload = _policy_decision_event(sid, flavor, "policy_mcp_warn")
    del payload["fingerprint"]
    assert _post_event(payload) == 400


def test_policy_mcp_block_bad_decision_path_rejected() -> None:
    sid = str(uuid.uuid4())
    flavor = f"test-mcp-pipeline-{uuid.uuid4().hex[:6]}"
    payload = _policy_decision_event(sid, flavor, "policy_mcp_block")
    payload["decision_path"] = "garbage"
    assert _post_event(payload) == 400


def test_mcp_server_name_changed_missing_name_old_rejected() -> None:
    sid = str(uuid.uuid4())
    flavor = f"test-mcp-pipeline-{uuid.uuid4().hex[:6]}"
    payload = _name_changed_event(sid, flavor)
    del payload["name_old"]
    assert _post_event(payload) == 400


# ----- D139 mcp_policy_user_remembered ---------------------------


def _user_remembered_event(session_id: str, flavor: str) -> dict:
    payload = _baseline_session_start(session_id, flavor)
    payload["event_type"] = "mcp_policy_user_remembered"
    payload.update({
        "fingerprint": "abc1234567890abc",
        "server_url_canonical": "stdio://npx -y @scope/server-x",
        "server_name": "x",
        "decided_at": "2026-05-06T12:00:00Z",
    })
    return payload


def test_mcp_policy_user_remembered_lands_with_payload() -> None:
    sid = str(uuid.uuid4())
    flavor = f"test-mcp-pipeline-{uuid.uuid4().hex[:6]}"

    assert _post_event(_baseline_session_start(sid, flavor)) == 200
    assert _post_event(_user_remembered_event(sid, flavor)) == 200

    event = _wait_for_event(sid, "mcp_policy_user_remembered", timeout=10.0)
    assert event is not None, "mcp_policy_user_remembered did not land within 10s"
    payload = event.get("payload") or {}
    assert payload.get("server_name") == "x"
    assert payload.get("fingerprint") == "abc1234567890abc"
    assert payload.get("decided_at") == "2026-05-06T12:00:00Z"


def test_mcp_policy_user_remembered_missing_decided_at_rejected() -> None:
    sid = str(uuid.uuid4())
    flavor = f"test-mcp-pipeline-{uuid.uuid4().hex[:6]}"
    payload = _user_remembered_event(sid, flavor)
    del payload["decided_at"]
    assert _post_event(payload) == 400
