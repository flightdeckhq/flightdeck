"""Integration test: mcp-active fixture lands context.mcp_servers.

The seeded ``mcp-active`` role declares ``mcp_servers`` in
canonical.json; seed.py stamps that list onto the session_start
event's ``context.mcp_servers`` field. The worker persists it via
the write-once ``sessions.context`` JSONB column so the listing's
``mcp_server_names[]`` aggregation and the detail endpoint's
``context`` envelope both surface it.

Regression guard for the Chrome-verify Fold B finding: the
mcp-active session was landing with ``context = NULL`` on every
seed run, breaking the dashboard's MCP SERVERS panel. Root cause:
the idempotency check ``_session_is_complete`` counted events
alone, so when a previous dev-reset wiped the original
session_start but left keep-alive ``mcp_*`` extras behind, the
seeder treated the session as complete and never re-emitted the
authoritative session_start. The fix tightens
``_session_is_complete`` to require a ``session_start`` event in
the events list; this test pins the resulting contract.
"""

from __future__ import annotations

import json
import urllib.parse
import urllib.request
from typing import Any

from .conftest import API_URL, auth_headers


def _list_sessions(params: dict[str, str]) -> dict[str, Any]:
    qs = urllib.parse.urlencode(params)
    req = urllib.request.Request(f"{API_URL}/v1/sessions?{qs}", headers=auth_headers())
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read())  # type: ignore[no-any-return]


def _get_session(session_id: str) -> dict[str, Any]:
    req = urllib.request.Request(
        f"{API_URL}/v1/sessions/{session_id}", headers=auth_headers()
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read())  # type: ignore[no-any-return]


def test_mcp_active_session_has_mcp_servers_in_context() -> None:
    """The sensor-agent-prod / mcp-active session's
    ``context.mcp_servers`` must list both fixture servers
    (fixture-stdio-server + fixture-http-server) after seeding.
    """
    # Filter the listing by flavor so we don't depend on the agent
    # ordering in the response. ``e2e-research-agent`` is the
    # sensor-agent-prod flavor per canonical.json.
    listing = _list_sessions({"flavor": "e2e-research-agent", "limit": "20"})
    matching = [
        s
        for s in listing.get("sessions", [])
        if s.get("agent_name") == "e2e-test-sensor-agent-prod"
    ]
    assert matching, (
        "no sensor-agent-prod sessions returned — re-seed with make "
        "seed-e2e to populate the canonical fixture set"
    )

    # The session-list response carries the aggregated
    # ``mcp_server_names`` slice (derived from context.mcp_servers
    # via a correlated subquery). Both fixture server names must
    # appear on at least one session.
    seen_names: set[str] = set()
    for s in matching:
        for name in s.get("mcp_server_names") or []:
            seen_names.add(name)
    assert "fixture-stdio-server" in seen_names, (
        "fixture-stdio-server not in mcp_server_names for any "
        "sensor-agent-prod session — canonical.json declares it on "
        f"the mcp-active role. Seen: {sorted(seen_names)}"
    )
    assert "fixture-http-server" in seen_names, (
        "fixture-http-server not in mcp_server_names for any "
        "sensor-agent-prod session — canonical.json declares it on "
        f"the mcp-active role. Seen: {sorted(seen_names)}"
    )


def test_mcp_active_detail_envelope_carries_mcp_servers() -> None:
    """The session-detail endpoint's ``context`` envelope must echo
    the full mcp_servers fingerprint list (name + transport +
    capabilities + ...) so the drawer's MCP SERVERS panel can
    render the rich expansion.
    """
    listing = _list_sessions({"flavor": "e2e-research-agent", "limit": "20"})
    candidates = [
        s
        for s in listing.get("sessions", [])
        if s.get("agent_name") == "e2e-test-sensor-agent-prod"
        and (s.get("mcp_server_names") or [])
    ]
    assert candidates, (
        "no sensor-agent-prod session in the response carries a "
        "non-empty mcp_server_names list — the mcp-active fixture "
        "is missing its context payload"
    )

    detail = _get_session(candidates[0]["session_id"])
    ctx = (detail.get("session") or {}).get("context") or {}
    servers = ctx.get("mcp_servers") or []
    assert isinstance(servers, list) and servers, (
        f"session {candidates[0]['session_id']} context.mcp_servers "
        f"is empty: {servers!r}"
    )
    # Each fingerprint must carry the operator-facing fields used by
    # MCPServersPanel in the drawer.
    for srv in servers:
        for required in ("name", "transport"):
            assert required in srv, f"mcp_servers entry missing {required!r}: {srv!r}"
