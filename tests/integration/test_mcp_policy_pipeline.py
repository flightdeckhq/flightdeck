"""Integration tests for MCP Protection Policy event pipeline.

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
from collections.abc import Iterator

import pytest
import requests

from ..shared.fixtures import INTEGRATION_TEST_SENSOR_VERSION
from .conftest import API_URL, INGESTION_URL, TOKEN, auth_headers, delete_flavor_data


def _now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _post_event(tracked: set[str], payload: dict) -> int:
    """POST one event and return the status code; the payload's flavor
    joins ``tracked`` so the test's rows are deleted when it ends."""
    if "flavor" in payload:
        tracked.add(payload["flavor"])
    headers = {
        "Authorization": f"Bearer {TOKEN}",
        "Content-Type": "application/json",
    }
    r = requests.post(
        f"{INGESTION_URL}/v1/events",
        headers=headers,
        json=payload,
        timeout=5,
    )
    return r.status_code


def _wait_for_event(
    session_id: str, event_type: str, timeout: float = 10.0
) -> dict | None:
    """Poll GET /v1/sessions/{id} until an event of the requested
    type appears, or return None on timeout."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        r = requests.get(
            f"{API_URL}/v1/sessions/{session_id}",
            headers=auth_headers(),
            timeout=3,
        )
        if r.status_code == 200:
            # API serialises events: null on a freshly-created session
            # whose events haven't drained yet — guard against the
            # null vs missing distinction so the helper polls instead
            # of crashing on TypeError.
            for event in r.json().get("events") or []:
                if event.get("event_type") == event_type:
                    return event
        time.sleep(0.2)
    return None


def _agent_id_for(flavor: str) -> str:
    """One agent per test: every event of a flavor carries the same agent id.

    The sensor derives an agent id from its identity tuple, so a run's
    events all share one. A fresh uuid4 per event would create an agent
    row per event instead, and on a shared stack the leftover rows push
    the seeded agents off the fleet page over repeated runs.
    """
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"flightdeck-test-mcp-pipeline/{flavor}"))


@pytest.fixture
def pipeline_flavors() -> Iterator[set[str]]:
    """The flavors a test has posted events for; ``_post_event`` records
    them. Once the test ends every row they produced is deleted, the
    agents row included, so nothing accumulates on the stack. The tests
    post their events outside the ``make_event`` tracker, so this is
    also what closes their sessions."""
    flavors: set[str] = set()
    try:
        yield flavors
    finally:
        for flavor in flavors:
            delete_flavor_data(flavor)


def _baseline_session_start(session_id: str, flavor: str) -> dict:
    return {
        "session_id": session_id,
        "agent_id": _agent_id_for(flavor),
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
        "sensor_version": INTEGRATION_TEST_SENSOR_VERSION,
        "timestamp": _now_iso(),
    }


def _policy_decision_event(
    session_id: str,
    flavor: str,
    event_type: str,
    *,
    decision_path: str = "flavor_entry",
    block_on_uncertainty: bool = False,
    originating_event_id: str | None = None,
    originating_call_context: str | None = None,
) -> dict:
    """Build a synthesized policy_mcp_warn / policy_mcp_block payload
    matching the sensor's wire shape.

    ``originating_event_id`` / ``originating_call_context`` are the
    chain fields the sensor stamps when the event fires inside an
    LLM call window. Tests that exercise the chain pass them; the
    rest leave the defaults None so existing payload shapes stay
    unchanged.
    """
    payload = _baseline_session_start(session_id, flavor)
    payload["event_type"] = event_type
    policy_id = str(uuid.uuid4())
    payload.update(
        {
            "server_url": "https://maps.example.com/sse",
            "server_name": "maps",
            "fingerprint": "abc123def4567890",
            "tool_name": "search",
            "policy_id": policy_id,
            "scope": f"flavor:{flavor}",
            "decision_path": decision_path,
            "transport": "http",
            # Shared policy_decision block required by ingestion on every
            # policy event (the validator ensures the dashboard's row
            # renderer always finds the structured fields it reads).
            "policy_decision": {
                "policy_id": policy_id,
                "scope": f"flavor:{flavor}",
                "decision": "block" if event_type == "policy_mcp_block" else "warn",
                "reason": (
                    "Server maps blocked by flavor entry, enforcement="
                    + ("block" if event_type == "policy_mcp_block" else "warn")
                ),
                "decision_path": decision_path,
            },
        }
    )
    if event_type == "policy_mcp_block":
        payload["block_on_uncertainty"] = block_on_uncertainty
    if originating_event_id is not None:
        payload["originating_event_id"] = originating_event_id
    if originating_call_context is not None:
        payload["originating_call_context"] = originating_call_context
    return payload


def _name_changed_event(session_id: str, flavor: str) -> dict:
    payload = _baseline_session_start(session_id, flavor)
    payload["event_type"] = "mcp_server_name_changed"
    payload.update(
        {
            "server_url_canonical": "https://maps.example.com/sse",
            "fingerprint_old": "old0123456789abcd",
            "fingerprint_new": "new0123456789abcd",
            "name_old": "maps",
            "name_new": "maps-v2",
        }
    )
    return payload


# ----- Three MCP policy event types land end-to-end -----------------


def test_policy_mcp_warn_lands_with_payload(pipeline_flavors: set[str]) -> None:
    sid = str(uuid.uuid4())
    flavor = f"test-mcp-pipeline-{uuid.uuid4().hex[:6]}"

    assert _post_event(pipeline_flavors, _baseline_session_start(sid, flavor)) == 200
    assert (
        _post_event(
            pipeline_flavors, _policy_decision_event(sid, flavor, "policy_mcp_warn")
        )
        == 200
    )

    event = _wait_for_event(sid, "policy_mcp_warn", timeout=10.0)
    assert event is not None, "policy_mcp_warn did not land within 10s"
    assert event.get("event_type") == "policy_mcp_warn"
    payload = event.get("payload") or {}
    assert payload.get("server_name") == "maps"
    assert payload.get("decision_path") == "flavor_entry"
    assert payload.get("fingerprint") == "abc123def4567890"


def test_policy_mcp_block_lands_with_payload(pipeline_flavors: set[str]) -> None:
    sid = str(uuid.uuid4())
    flavor = f"test-mcp-pipeline-{uuid.uuid4().hex[:6]}"

    assert _post_event(pipeline_flavors, _baseline_session_start(sid, flavor)) == 200
    assert (
        _post_event(
            pipeline_flavors,
            _policy_decision_event(
                sid,
                flavor,
                "policy_mcp_block",
                block_on_uncertainty=True,
            ),
        )
        == 200
    )

    event = _wait_for_event(sid, "policy_mcp_block", timeout=10.0)
    assert event is not None, "policy_mcp_block did not land within 10s"
    payload = event.get("payload") or {}
    assert payload.get("block_on_uncertainty") is True
    assert payload.get("decision_path") == "flavor_entry"


def test_mcp_server_name_changed_lands_with_payload(pipeline_flavors: set[str]) -> None:
    sid = str(uuid.uuid4())
    flavor = f"test-mcp-pipeline-{uuid.uuid4().hex[:6]}"

    assert _post_event(pipeline_flavors, _baseline_session_start(sid, flavor)) == 200
    assert _post_event(pipeline_flavors, _name_changed_event(sid, flavor)) == 200

    event = _wait_for_event(sid, "mcp_server_name_changed", timeout=10.0)
    assert event is not None, "mcp_server_name_changed did not land within 10s"
    payload = event.get("payload") or {}
    assert payload.get("server_url_canonical") == "https://maps.example.com/sse"
    assert payload.get("name_old") == "maps"
    assert payload.get("name_new") == "maps-v2"


def test_originating_event_id_chain_persists_end_to_end(
    pipeline_flavors: set[str],
) -> None:
    """Sensor-minted UUIDs + ``originating_event_id`` chain.

    The sensor mints the UUID for an LLM-call event at emission time
    and stamps `originating_event_id` on follow-on events emitted
    inside the same call window. The chain must round-trip through
    ingestion → NATS → worker → events.payload jsonb so the dashboard
    can render the intra-session jump affordance from any chained
    event back to its origin.

    Sensor unit tests cover the minting / chain-management logic;
    this test guards the storage roundtrip the worker is responsible
    for. The worker only persists fields declared in EventPayload's
    typed shape, so the chain fields must be declared there
    explicitly.
    """
    sid = str(uuid.uuid4())
    flavor = f"test-d149-chain-{uuid.uuid4().hex[:6]}"
    origin_event_id = str(uuid.uuid4())
    call_context = "tool_call"

    assert _post_event(pipeline_flavors, _baseline_session_start(sid, flavor)) == 200
    assert (
        _post_event(
            pipeline_flavors,
            _policy_decision_event(
                sid,
                flavor,
                "policy_mcp_warn",
                originating_event_id=origin_event_id,
                originating_call_context=call_context,
            ),
        )
        == 200
    )

    event = _wait_for_event(sid, "policy_mcp_warn", timeout=10.0)
    assert event is not None, "policy_mcp_warn did not land within 10s"
    payload = event.get("payload") or {}
    assert payload.get("originating_event_id") == origin_event_id, (
        f"originating_event_id did not roundtrip; "
        f"want {origin_event_id}, got {payload.get('originating_event_id')!r}"
    )
    assert payload.get("originating_call_context") == call_context, (
        f"originating_call_context did not roundtrip; "
        f"want {call_context!r}, got {payload.get('originating_call_context')!r}"
    )


# ----- Ingestion validation rejects malformed payloads --------------


def test_policy_mcp_warn_missing_fingerprint_rejected(
    pipeline_flavors: set[str],
) -> None:
    sid = str(uuid.uuid4())
    flavor = f"test-mcp-pipeline-{uuid.uuid4().hex[:6]}"
    payload = _policy_decision_event(sid, flavor, "policy_mcp_warn")
    del payload["fingerprint"]
    assert _post_event(pipeline_flavors, payload) == 400


def test_policy_mcp_block_bad_decision_path_rejected(
    pipeline_flavors: set[str],
) -> None:
    sid = str(uuid.uuid4())
    flavor = f"test-mcp-pipeline-{uuid.uuid4().hex[:6]}"
    payload = _policy_decision_event(sid, flavor, "policy_mcp_block")
    payload["decision_path"] = "garbage"
    assert _post_event(pipeline_flavors, payload) == 400


def test_mcp_server_name_changed_missing_name_old_rejected(
    pipeline_flavors: set[str],
) -> None:
    sid = str(uuid.uuid4())
    flavor = f"test-mcp-pipeline-{uuid.uuid4().hex[:6]}"
    payload = _name_changed_event(sid, flavor)
    del payload["name_old"]
    assert _post_event(pipeline_flavors, payload) == 400


# ----- mcp_policy_user_remembered --------------------------------


def _user_remembered_event(session_id: str, flavor: str) -> dict:
    payload = _baseline_session_start(session_id, flavor)
    payload["event_type"] = "mcp_policy_user_remembered"
    payload.update(
        {
            "fingerprint": "abc1234567890abc",
            "server_url_canonical": "stdio://npx -y @scope/server-x",
            "server_name": "x",
            "decided_at": "2026-05-06T12:00:00Z",
        }
    )
    return payload


def test_mcp_policy_user_remembered_lands_with_payload(
    pipeline_flavors: set[str],
) -> None:
    sid = str(uuid.uuid4())
    flavor = f"test-mcp-pipeline-{uuid.uuid4().hex[:6]}"

    assert _post_event(pipeline_flavors, _baseline_session_start(sid, flavor)) == 200
    assert _post_event(pipeline_flavors, _user_remembered_event(sid, flavor)) == 200

    event = _wait_for_event(sid, "mcp_policy_user_remembered", timeout=10.0)
    assert event is not None, "mcp_policy_user_remembered did not land within 10s"
    payload = event.get("payload") or {}
    assert payload.get("server_name") == "x"
    assert payload.get("fingerprint") == "abc1234567890abc"
    assert payload.get("decided_at") == "2026-05-06T12:00:00Z"
    assert "permission_mode" not in payload


def test_mcp_policy_user_remembered_keeps_permission_mode(
    pipeline_flavors: set[str],
) -> None:
    sid = str(uuid.uuid4())
    flavor = f"test-mcp-pipeline-{uuid.uuid4().hex[:6]}"

    assert _post_event(pipeline_flavors, _baseline_session_start(sid, flavor)) == 200
    remembered = _user_remembered_event(sid, flavor)
    remembered["permission_mode"] = "bypassPermissions"
    assert _post_event(pipeline_flavors, remembered) == 200

    event = _wait_for_event(sid, "mcp_policy_user_remembered", timeout=10.0)
    assert event is not None, "mcp_policy_user_remembered did not land within 10s"
    assert (event.get("payload") or {}).get("permission_mode") == "bypassPermissions"


def test_mcp_policy_user_remembered_oversized_permission_mode_rejected(
    pipeline_flavors: set[str],
) -> None:
    sid = str(uuid.uuid4())
    flavor = f"test-mcp-pipeline-{uuid.uuid4().hex[:6]}"
    payload = _user_remembered_event(sid, flavor)
    payload["permission_mode"] = "m" * 65
    assert _post_event(pipeline_flavors, payload) == 400


def test_mcp_policy_user_remembered_missing_decided_at_rejected(
    pipeline_flavors: set[str],
) -> None:
    sid = str(uuid.uuid4())
    flavor = f"test-mcp-pipeline-{uuid.uuid4().hex[:6]}"
    payload = _user_remembered_event(sid, flavor)
    del payload["decided_at"]
    assert _post_event(pipeline_flavors, payload) == 400


# ----- mcp_server_attached live-context UPSERT ---------------------


def _attached_event(
    session_id: str,
    flavor: str,
    *,
    name: str = "maps",
    server_url_canonical: str = "https://maps.example.com/sse",
    fingerprint: str = "abcdef0123456789",
) -> dict:
    """Build a synthesised mcp_server_attached payload matching the
    sensor's wire shape."""
    payload = _baseline_session_start(session_id, flavor)
    payload["event_type"] = "mcp_server_attached"
    payload.update(
        {
            "fingerprint": fingerprint,
            "server_url_canonical": server_url_canonical,
            "server_name": name,
            "transport": "sse",
            "protocol_version": "2025-11-25",
            "version": "1.0.0",
            "capabilities": {"tools": {"listChanged": True}},
            "instructions": "Test server.",
            "attached_at": "2026-05-06T15:00:00+00:00",
        }
    )
    return payload


def _wait_for_context_mcp_server(
    session_id: str,
    server_name: str,
    *,
    timeout: float = 10.0,
) -> dict | None:
    """Poll GET /v1/sessions/{id} until
    ``session.context.mcp_servers`` contains an element with the
    given ``name``, or return None on timeout. Used by the attach tests
    to assert the worker UPSERT landed on the live row within the
    expected window."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        r = requests.get(
            f"{API_URL}/v1/sessions/{session_id}",
            headers=auth_headers(),
            timeout=3,
        )
        if r.status_code == 200:
            session = r.json().get("session") or {}
            ctx = session.get("context") or {}
            for srv in ctx.get("mcp_servers") or []:
                if srv.get("name") == server_name:
                    return srv
        time.sleep(0.2)
    return None


def test_mcp_server_attached_populates_session_context(
    pipeline_flavors: set[str],
) -> None:
    """Emitting mcp_server_attached after session_start
    populates sessions.context.mcp_servers within the SLA window so
    the dashboard SessionDrawer panel renders live."""
    sid = str(uuid.uuid4())
    flavor = f"test-mcp-attach-{uuid.uuid4().hex[:6]}"

    assert _post_event(pipeline_flavors, _baseline_session_start(sid, flavor)) == 200
    # Wait for the session row to land so the post-attach poll
    # has something to read against. session_start emits no event-
    # type-keyed signal, so poll until GET /v1/sessions/<id>
    # returns 200.
    deadline = time.monotonic() + 10.0
    while time.monotonic() < deadline:
        r = requests.get(
            f"{API_URL}/v1/sessions/{sid}",
            headers=auth_headers(),
            timeout=3,
        )
        if r.status_code == 200:
            break
        time.sleep(0.2)
    assert r.status_code == 200, f"session row never landed: {r.status_code}"

    assert _post_event(pipeline_flavors, _attached_event(sid, flavor)) == 200

    server = _wait_for_context_mcp_server(sid, "maps", timeout=10.0)
    assert server is not None, (
        "mcp_server_attached did not populate context.mcp_servers within 10s"
    )
    assert server["name"] == "maps"
    assert server["server_url"] == "https://maps.example.com/sse"
    assert server["transport"] == "sse"
    assert server["version"] == "1.0.0"
    assert server["instructions"] == "Test server."
    assert server["capabilities"] == {"tools": {"listChanged": True}}
    # protocol_version round-trips as the wire-typed value (str here).
    assert server["protocol_version"] == "2025-11-25"


def test_mcp_server_attached_idempotent_replay(pipeline_flavors: set[str]) -> None:
    """Re-emitting the same mcp_server_attached payload must
    not create a duplicate entry in context.mcp_servers. Tuple dedup
    by (name, server_url) per the locked design."""
    sid = str(uuid.uuid4())
    flavor = f"test-mcp-attach-{uuid.uuid4().hex[:6]}"

    assert _post_event(pipeline_flavors, _baseline_session_start(sid, flavor)) == 200
    assert _post_event(pipeline_flavors, _attached_event(sid, flavor)) == 200
    server = _wait_for_context_mcp_server(sid, "maps", timeout=10.0)
    assert server is not None

    # Replay the exact same payload — should be a no-op at the SQL
    # layer.
    assert _post_event(pipeline_flavors, _attached_event(sid, flavor)) == 200
    time.sleep(1.0)  # Let the worker drain.

    r = requests.get(
        f"{API_URL}/v1/sessions/{sid}",
        headers=auth_headers(),
        timeout=3,
    )
    assert r.status_code == 200
    session_obj = r.json().get("session") or {}
    servers = (session_obj.get("context") or {}).get("mcp_servers") or []
    matching = [s for s in servers if s.get("name") == "maps"]
    assert len(matching) == 1, (
        f"expected exactly one 'maps' entry after replay, got {len(matching)}"
    )


def test_mcp_server_attached_distinct_tuples_both_land(
    pipeline_flavors: set[str],
) -> None:
    """Tuple dedup is by (name, server_url). Distinct tuples
    are independent attaches and must both land in
    context.mcp_servers."""
    sid = str(uuid.uuid4())
    flavor = f"test-mcp-attach-{uuid.uuid4().hex[:6]}"

    assert _post_event(pipeline_flavors, _baseline_session_start(sid, flavor)) == 200
    assert (
        _post_event(
            pipeline_flavors,
            _attached_event(
                sid,
                flavor,
                name="maps",
                server_url_canonical="https://maps.example.com/sse",
                fingerprint="aaaaaaaaaaaaaaaa",
            ),
        )
        == 200
    )
    assert (
        _post_event(
            pipeline_flavors,
            _attached_event(
                sid,
                flavor,
                name="search",
                server_url_canonical="https://search.example.com/sse",
                fingerprint="bbbbbbbbbbbbbbbb",
            ),
        )
        == 200
    )

    # Both should land.
    assert _wait_for_context_mcp_server(sid, "maps", timeout=10.0) is not None
    assert _wait_for_context_mcp_server(sid, "search", timeout=10.0) is not None

    r = requests.get(
        f"{API_URL}/v1/sessions/{sid}",
        headers=auth_headers(),
        timeout=3,
    )
    assert r.status_code == 200
    session_obj = r.json().get("session") or {}
    servers = (session_obj.get("context") or {}).get("mcp_servers") or []
    names = sorted(s.get("name") for s in servers)
    assert names == ["maps", "search"]


# ----- SQL aggregation includes MCP-policy event types -----
#
# Guarded regression: the API listing query's policy_event_types[] subquery only
# matched the three token-budget event types (policy_warn /
# policy_degrade / policy_block). Sessions that emitted MCP-policy
# events reported policy_event_types=[] on /v1/sessions, which made
# the dashboard's MCP POLICY facet count 0 → hidden by the
# .filter(g => g.values.length > 0). The fix extends the IN clause
# to the full seven-event vocabulary; this test locks the contract.


def _list_session(session_id: str, flavor: str) -> dict | None:
    """Fetch one session's row from the listing endpoint, the path the
    dashboard's Investigate page hits. The listing has no session_id
    filter, so the request narrows to the test's own flavor and the
    row is picked by id; taking the newest row instead would return
    whatever session another test created last."""
    r = requests.get(
        f"{API_URL}/v1/sessions",
        headers=auth_headers(),
        params={"flavor": flavor, "from": "1970-01-01T00:00:00Z"},
        timeout=5,
    )
    if r.status_code != 200:
        return None
    for row in r.json().get("sessions") or []:
        if row.get("session_id") == session_id:
            return row
    return None


def test_listing_aggregates_all_four_mcp_policy_event_types(
    pipeline_flavors: set[str],
) -> None:
    sid = str(uuid.uuid4())
    flavor = f"test-mcp-pipeline-{uuid.uuid4().hex[:6]}"

    assert _post_event(pipeline_flavors, _baseline_session_start(sid, flavor)) == 200
    assert (
        _post_event(
            pipeline_flavors, _policy_decision_event(sid, flavor, "policy_mcp_warn")
        )
        == 200
    )
    assert (
        _post_event(
            pipeline_flavors, _policy_decision_event(sid, flavor, "policy_mcp_block")
        )
        == 200
    )
    assert _post_event(pipeline_flavors, _name_changed_event(sid, flavor)) == 200
    assert _post_event(pipeline_flavors, _user_remembered_event(sid, flavor)) == 200

    # Wait for the worker to drain all four events into Postgres.
    for et in (
        "policy_mcp_warn",
        "policy_mcp_block",
        "mcp_server_name_changed",
        "mcp_policy_user_remembered",
    ):
        assert _wait_for_event(sid, et, timeout=10.0) is not None, (
            f"{et} did not land within 10s"
        )

    # The list endpoint's policy_event_types[] aggregation must
    # include all four MCP-policy types alongside any token-budget
    # types. In the guarded regression this array was empty for sessions that only
    # emitted MCP-policy events.
    deadline = time.monotonic() + 10.0
    row = None
    seen: list[str] = []
    while time.monotonic() < deadline:
        row = _list_session(sid, flavor)
        if row is not None:
            seen = sorted(row.get("policy_event_types") or [])
            if len(seen) == 4:
                break
        time.sleep(0.2)

    assert row is not None, f"session {sid} did not appear in listing"
    assert seen == sorted(
        [
            "mcp_policy_user_remembered",
            "mcp_server_name_changed",
            "policy_mcp_block",
            "policy_mcp_warn",
        ]
    ), f"policy_event_types missing MCP-policy entries; got {seen!r}"


def test_filter_accepts_mcp_policy_event_types_in_vocab() -> None:
    """Smoke test for the handler's vocabulary validation: the four
    MCP-policy event types must be accepted by the
    ?policy_event_type=... filter without 400ing.

    Pairs with the SQL fix above — together they verify both the
    aggregation (output) and the filter (input) sides of the
    listing endpoint accept the full seven-event vocabulary."""
    for event_type in (
        "policy_mcp_warn",
        "policy_mcp_block",
        "mcp_server_name_changed",
        "mcp_policy_user_remembered",
    ):
        r = requests.get(
            f"{API_URL}/v1/sessions",
            headers=auth_headers(),
            params={
                "policy_event_type": event_type,
                "from": "1970-01-01T00:00:00Z",
            },
            timeout=5,
        )
        assert r.status_code == 200, (
            f"{event_type}: expected 200, got {r.status_code} ({r.text[:200]})"
        )
