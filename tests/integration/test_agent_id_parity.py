"""Integration test: agent_id symmetry across rollup and projection.

The dashboard's fleet store joins ``/v1/fleet`` (agents rollup) to
``/v1/sessions`` (session projection) by exact agent_id string
equality. Any divergence in the UUID5 derivation between the two
endpoints would leave child sessions orphaned: the agent appears
in the fleet roster, but ``buildFlavors`` finds no sessions for
its agent_id, and the swimlane row renders without event circles
or connectors.

This test pins the byte-identical contract for both root and
sub-agent fixtures so a future drift in the 6-tuple identity
inputs (agent_type / client_type / user / hostname / agent_name /
agent_role) fails loudly here instead of silently breaking the
live page.

D126's identity model adds ``agent_role`` as the 6th input for
sub-agents (sessions with non-null parent_session_id). Root
sessions skip the agent_role slot. The seed must produce the same
UUID5 on both the rollup path (worker's UpsertAgent in
workers/internal/writer/postgres.go) and the projection path
(SessionListItem.agent_id in api/internal/store/sessions.go).
"""

from __future__ import annotations

import json
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from typing import Any

from .conftest import API_URL, auth_headers


def _list_sessions(params: dict[str, str]) -> dict[str, Any]:
    qs = urllib.parse.urlencode(params)
    req = urllib.request.Request(f"{API_URL}/v1/sessions?{qs}", headers=auth_headers())
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read())  # type: ignore[no-any-return]


def _list_fleet(params: dict[str, str]) -> dict[str, Any]:
    qs = urllib.parse.urlencode(params)
    req = urllib.request.Request(f"{API_URL}/v1/fleet?{qs}", headers=auth_headers())
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read())  # type: ignore[no-any-return]


def test_agent_id_symmetric_for_sub_agent_fixture() -> None:
    """The seeded ``e2e-test-fresh-subagent`` fixture is the
    canonical sub-agent anchor. Its agent_id from the fleet
    rollup MUST equal its agent_id from any session projection
    that returns its session.
    """
    fleet = _list_fleet({"per_page": "200"})
    fleet_agent = next(
        (
            a
            for a in fleet.get("agents", [])
            if a.get("agent_name") == "e2e-test-fresh-subagent"
        ),
        None,
    )
    assert fleet_agent is not None, (
        "e2e-test-fresh-subagent must appear in the fleet roster — "
        "seed.py declares it as a Phase 2 sub-agent anchor"
    )
    fleet_agent_id = fleet_agent["agent_id"]

    since = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    sessions = _list_sessions(
        {"from": since, "flavor": "e2e-fresh-subagent", "limit": "5"}
    )
    matching = [
        s
        for s in sessions.get("sessions", [])
        if s.get("agent_name") == "e2e-test-fresh-subagent"
    ]
    assert matching, (
        "session projection must return at least one fresh-subagent "
        "session within the 1-hour window — the keep-alive watchdog "
        "pins started_at to NOW - 30 s"
    )

    for s in matching:
        session_agent_id = s["agent_id"]
        assert session_agent_id == fleet_agent_id, (
            "agent_id mismatch — fleet rollup returned "
            f"{fleet_agent_id} but session projection returned "
            f"{session_agent_id} for the same agent_name. A drift "
            "in the UUID5 derivation between rollup and projection "
            "paths orphans every sub-agent session on the dashboard."
        )


def test_agent_id_symmetric_for_root_fixture() -> None:
    """The seeded ``e2e-test-coding-agent`` is a root agent (no
    parent_session_id on any of its sessions). Same byte-identical
    agent_id symmetry applies.
    """
    fleet = _list_fleet({"per_page": "200"})
    fleet_agent = next(
        (
            a
            for a in fleet.get("agents", [])
            if a.get("agent_name") == "e2e-test-coding-agent"
        ),
        None,
    )
    assert fleet_agent is not None
    fleet_agent_id = fleet_agent["agent_id"]

    since = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
    sessions = _list_sessions(
        {"from": since, "flavor": "e2e-claude-code", "limit": "10"}
    )
    matching = [
        s
        for s in sessions.get("sessions", [])
        if s.get("agent_name") == "e2e-test-coding-agent"
    ]
    assert matching, (
        "session projection must return at least one coding-agent "
        "session within 24 hours"
    )

    for s in matching:
        assert s["agent_id"] == fleet_agent_id, (
            "agent_id mismatch on root fixture — fleet rollup "
            f"returned {fleet_agent_id} but session projection "
            f"returned {s['agent_id']} for the same agent_name"
        )
