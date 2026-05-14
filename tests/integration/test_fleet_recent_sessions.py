"""Integration test: /v1/fleet embeds recent_sessions per agent.

The swimlane row reads its event circles from the agent's session
slice. Pre-extension, that slice came only from the paginated
``/v1/sessions`` page (LIMIT 100). A sub-agent whose session fell
outside that window — most commonly because the dashboard's 100-row
window was saturated by busier siblings — rendered with no event
circles, no spawn anchor for the connector overlay, and no SubAgent
linkage on the swimlane.

The fix attaches a per-agent ``recent_sessions`` rollup (cap = 5,
newest first by ``started_at``) directly on the
``/v1/fleet`` response so ``buildFlavors`` always has at least a
few sessions to populate the swimlane row from regardless of the
global page intersection.

This test pins the contract live against the seeded canonical
fixtures: every agent in the response carries a ``recent_sessions``
key, the slice is at most 5 long, and the agent of interest
(``e2e-test-fresh-subagent``) is the canonical exemplar — its
fresh session is in the rollup so the swimlane row is guaranteed
event circles.
"""

from __future__ import annotations

import json
import urllib.parse
import urllib.request
from typing import Any

from .conftest import API_URL, auth_headers

# Mirrors ``store.RecentSessionsPerAgent`` (api/internal/store/postgres.go).
# The Go side is the canonical source — bumping the cap there must be
# paired with bumping this constant. Lifted to module scope so the
# value is unmistakable when the test fails on length.
PER_AGENT_CAP = 5


def _list_fleet(params: dict[str, str]) -> dict[str, Any]:
    qs = urllib.parse.urlencode(params)
    req = urllib.request.Request(f"{API_URL}/v1/fleet?{qs}", headers=auth_headers())
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read())  # type: ignore[no-any-return]


def test_fleet_response_attaches_recent_sessions() -> None:
    """Every agent with ``total_sessions > 0`` carries a non-empty
    ``recent_sessions`` slice; agents with zero sessions may omit
    the key (``omitempty`` server-side). Slice length never exceeds
    ``PER_AGENT_CAP``; entries are descending by ``started_at`` with
    ``session_id`` ASC as a deterministic tie-breaker.
    """
    fleet = _list_fleet({"per_page": "200"})
    agents = fleet.get("agents", [])
    assert agents, "fleet roster must not be empty after seed"

    for a in agents:
        rs = a.get("recent_sessions")
        total = a.get("total_sessions", 0)
        if total > 0:
            # The rollup must be present AND non-empty when the agent
            # has at least one session. A null slice here means the
            # batched attach failed silently — the dashboard's
            # swimlane row would render zero event circles for this
            # agent. That's the bug the rollup exists to prevent.
            assert rs, (
                f"agent {a.get('agent_id')} has total_sessions={total} "
                f"but recent_sessions is empty/missing: {rs!r}"
            )
        elif rs is None:
            # Agents with no sessions legitimately omit the key
            # (``omitempty`` server-side). Move on.
            continue
        assert isinstance(rs, list), (
            f"recent_sessions must be a list, got {type(rs).__name__} "
            f"for agent_id={a.get('agent_id')}"
        )
        assert len(rs) <= PER_AGENT_CAP, (
            f"recent_sessions for agent {a.get('agent_id')} has "
            f"{len(rs)} entries, exceeding cap {PER_AGENT_CAP}"
        )
        for s in rs:
            for required in (
                "session_id",
                "flavor",
                "agent_type",
                "agent_id",
                "state",
                "started_at",
                "last_seen_at",
                "tokens_used",
            ):
                assert required in s, (
                    f"recent_sessions entry on {a.get('agent_id')} "
                    f"missing required field {required!r}: {s!r}"
                )
            # The slice is authoritative for ``this agent's
            # recent sessions``, so every embedded row must echo
            # the parent agent's agent_id back.
            assert s["agent_id"] == a["agent_id"], (
                "embedded session agent_id mismatch: row carries "
                f"{s['agent_id']} under agent {a['agent_id']}"
            )

    # Descending started_at across the slice — pins the SQL
    # ROW_NUMBER ordering contract that the swimlane relies on.
    for a in agents:
        rs = a.get("recent_sessions")
        if not rs or len(rs) < 2:
            continue
        for i in range(1, len(rs)):
            assert rs[i - 1]["started_at"] >= rs[i]["started_at"], (
                f"recent_sessions not descending by started_at on "
                f"agent {a['agent_id']}: position {i - 1} = "
                f"{rs[i - 1]['started_at']} < position {i} = "
                f"{rs[i]['started_at']}"
            )


def test_fresh_subagent_has_session_in_rollup() -> None:
    """The ``e2e-test-fresh-subagent`` canonical fixture's session
    must surface in the agent's ``recent_sessions`` slice — this is
    the regression guard for the empty-swimlane-row class of bug.
    """
    fleet = _list_fleet({"per_page": "200"})
    fresh = next(
        (
            a
            for a in fleet.get("agents", [])
            if a.get("agent_name") == "e2e-test-fresh-subagent"
        ),
        None,
    )
    assert fresh is not None, (
        "e2e-test-fresh-subagent must appear in the fleet roster after seed"
    )
    rs = fresh.get("recent_sessions") or []
    assert rs, (
        "e2e-test-fresh-subagent must carry at least one entry in "
        "recent_sessions — seed.py forwards-dates a fresh tool_call "
        "event so the session stays in the swimlane window. An "
        "empty slice here means the swimlane row renders with zero "
        "event circles."
    )
    # Sub-agent linkage flows through the rollup so the swimlane
    # row materialises with the correct topology.
    assert any(s.get("parent_session_id") for s in rs), (
        "fresh-subagent's rollup must carry at least one row with "
        "a non-null parent_session_id — without it the topology "
        "demotes to 'lone' and the connector overlay drops the "
        "relationship"
    )
