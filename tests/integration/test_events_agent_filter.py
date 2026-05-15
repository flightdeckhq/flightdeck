"""Integration test: GET /v1/events agent_id filter + the
SessionListItem.attachment_count column (D157 Phase 4).

The agent drawer's Events tab lists every event across all of one
agent's runs. The events table has no agent_id column, so the
filter resolves through a sessions subquery. This test pins the
contract live against the seeded canonical fixtures: the agent_id
filter returns only that agent's events, a malformed agent_id is
rejected with 400, and the /v1/sessions listing carries an
attachment_count per row.
"""

from __future__ import annotations

import datetime
import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from .conftest import API_URL, auth_headers


def _get(path: str, params: dict[str, str]) -> dict[str, Any]:
    qs = urllib.parse.urlencode(params)
    req = urllib.request.Request(f"{API_URL}{path}?{qs}", headers=auth_headers())
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read())  # type: ignore[no-any-return]


def _status(path: str, params: dict[str, str]) -> int:
    qs = urllib.parse.urlencode(params)
    req = urllib.request.Request(f"{API_URL}{path}?{qs}", headers=auth_headers())
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status
    except urllib.error.HTTPError as exc:
        return exc.code


# 30 days back comfortably covers the canonical seed's backdated
# events; both the events and the sessions query use it so a session
# and its events fall inside the same window.
def _wide_from() -> str:
    return (
        datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=30)
    ).isoformat()


def _pick_agent_with_sessions() -> str:
    fleet = _get("/v1/fleet", {"per_page": "200"})
    for a in fleet.get("agents", []):
        if a.get("total_sessions", 0) > 0 and a.get("agent_id"):
            return str(a["agent_id"])
    raise AssertionError("no agent with sessions in the seeded fleet")


def test_events_agent_id_filter_scopes_to_one_agent() -> None:
    """Every event returned for ``?agent_id=A`` belongs to one of
    agent A's sessions — the sessions subquery must not leak."""
    agent_id = _pick_agent_with_sessions()

    sessions = _get(
        "/v1/sessions",
        {"agent_id": agent_id, "from": _wide_from(), "limit": "100"},
    )
    session_ids = {s["session_id"] for s in sessions.get("sessions", [])}
    assert session_ids, f"agent {agent_id} has no sessions in /v1/sessions"

    events = _get(
        "/v1/events",
        {"agent_id": agent_id, "from": _wide_from(), "limit": "2000"},
    )
    assert isinstance(events.get("events"), list)
    assert events["total"] >= 1, (
        f"agent {agent_id} has sessions but /v1/events?agent_id= returned no events"
    )
    for ev in events["events"]:
        assert ev["session_id"] in session_ids, (
            f"event {ev['id']} from session {ev['session_id']} is not "
            f"one of agent {agent_id}'s sessions — the agent_id "
            "subquery leaked"
        )


def test_events_agent_id_malformed_returns_400() -> None:
    """A non-UUID agent_id is rejected at the handler boundary."""
    assert (
        _status("/v1/events", {"agent_id": "not-a-uuid", "from": _wide_from()}) == 400
    )


def test_sessions_listing_carries_attachment_count() -> None:
    """Every /v1/sessions row exposes an integer attachment_count
    (the agent drawer Runs-tab attached pill reads it)."""
    agent_id = _pick_agent_with_sessions()
    sessions = _get(
        "/v1/sessions",
        {"agent_id": agent_id, "from": _wide_from(), "limit": "100"},
    )
    rows = sessions.get("sessions", [])
    assert rows, f"agent {agent_id} has no sessions"
    for s in rows:
        assert "attachment_count" in s, (
            f"session {s.get('session_id')} missing attachment_count"
        )
        assert isinstance(s["attachment_count"], int)
        assert s["attachment_count"] >= 0
