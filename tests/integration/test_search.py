"""Integration tests for cross-entity search.

Tests GET /v1/search across agents, sessions, and events.
Requires `make dev` to be running.
"""

from __future__ import annotations

import json
import urllib.parse
import urllib.request
import uuid

import pytest

from .conftest import (
    API_URL,
    auth_headers,
    get_session_event_count,
    make_event,
    post_event,
    session_exists_in_fleet,
    wait_until,
)


def _search(query: str) -> dict:
    """GET /api/v1/search?q=query."""
    url = f"{API_URL}/v1/search?q={urllib.parse.quote(query)}"
    req = urllib.request.Request(url, headers=auth_headers())
    with urllib.request.urlopen(req, timeout=5) as resp:
        return json.loads(resp.read())


def _setup_searchable(agent_name: str, host: str, tool_name: str) -> str:
    """Create a session under an agent whose agent_name is the needle,
    then post a tool_call event with a unique host and tool_name.

    Passes ``agent_name=`` through to ``make_event`` so the event-level
    identity fields populate the agents table with the test-owned
    label. The flavor field carries the same string so flavor-scoped
    session queries (e.g. ``test_directives::test_directive_filter_by_flavor``)
    still see a recognizable value -- only agent-level search keys on
    ``agent_name`` under D115.
    """
    sid = str(uuid.uuid4())
    post_event(make_event(
        sid, agent_name, "session_start",
        host=host,
        agent_name=agent_name,
    ))
    wait_until(
        lambda: session_exists_in_fleet(sid),
        timeout=10,
        msg=f"session {sid} did not appear in fleet",
    )
    post_event(make_event(
        sid, agent_name, "post_call",
        tokens_total=100,
        tool_name=tool_name,
        model="claude-sonnet-4-6",
        agent_name=agent_name,
    ))
    wait_until(
        lambda: get_session_event_count(sid) >= 2,
        timeout=10,
        msg=f"post_call event not processed for session {sid}",
    )
    return sid


@pytest.fixture(scope="module")
def searchable_fixture() -> dict[str, str]:
    """Module-scoped fixture: create one session under an agent whose
    agent_name / host / tool name are all unique strings, then let
    every search-by-X test run against the same session.

    D115: the agent-level search dimension is ``agent_name`` (the
    flavor column was dropped from the agents table in migration
    000015). Integration tests drive a unique ``agent_name`` via the
    conftest ``agent_name=`` kwarg so the search query has a
    deterministic needle.
    """
    suffix = uuid.uuid4().hex[:6]
    agent_name = f"search-test-agent-{suffix}"
    host = f"search-test-host-{suffix}"
    tool = f"search-test-tool-{suffix}"
    _setup_searchable(agent_name, host, tool)
    return {"agent_name": agent_name, "host": host, "tool": tool}


@pytest.mark.parametrize(
    "field, group_key, item_key",
    [
        ("agent_name", "agents", "agent_name"),
        ("host", "sessions", "host"),
        ("tool", "events", "tool_name"),
    ],
    ids=["by_agent_name", "by_host", "by_tool"],
)
def test_search_finds_entity(
    searchable_fixture: dict[str, str],
    field: str,
    group_key: str,
    item_key: str,
) -> None:
    """Search for the unique value finds the matching row in the
    expected result group. Three cases that previously lived as three
    separate tests with three independent fixtures."""
    needle = searchable_fixture[field]
    results = _search(needle)
    values = [item[item_key] for item in results.get(group_key, [])]
    assert needle in values, (
        f"expected {needle} in {group_key}.{item_key}, got {values}"
    )


def test_search_empty_returns_empty_arrays() -> None:
    """Search for a non-existent term returns 200 with empty arrays."""
    results = _search("zzz-no-match-xyz-999")
    assert results.get("agents") == [], f"expected empty agents, got {results.get('agents')}"
    assert results.get("sessions") == [], f"expected empty sessions, got {results.get('sessions')}"
    assert results.get("events") == [], f"expected empty events, got {results.get('events')}"


def test_search_partial_match() -> None:
    """Partial match finds results across multiple groups."""
    prefix = f"search-partial-{uuid.uuid4().hex[:4]}"
    agent_name = f"{prefix}-agent"
    host = f"{prefix}-host"
    tool = f"{prefix}-tool"
    _setup_searchable(agent_name, host, tool)

    results = _search(prefix)
    total = (
        len(results.get("agents", []))
        + len(results.get("sessions", []))
        + len(results.get("events", []))
    )
    assert total > 0, (
        f"expected at least one result for partial match '{prefix}', got 0"
    )
