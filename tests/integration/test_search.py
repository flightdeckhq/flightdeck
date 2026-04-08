"""Integration tests for cross-entity search.

Tests GET /v1/search across agents, sessions, and events.
Requires `make dev` to be running.
"""

from __future__ import annotations

import json
import urllib.request
import uuid

from .conftest import (
    API_URL,
    get_session_event_count,
    make_event,
    post_event,
    session_exists_in_fleet,
    wait_until,
)


def _search(query: str) -> dict:
    """GET /api/v1/search?q=query."""
    url = f"{API_URL}/v1/search?q={urllib.parse.quote(query)}"
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=5) as resp:
        return json.loads(resp.read())


import urllib.parse


def _setup_searchable(flavor: str, host: str, tool_name: str) -> str:
    """Create a session and post a tool_call event with known searchable fields."""
    sid = str(uuid.uuid4())
    post_event(make_event(sid, flavor, "session_start", host=host))
    wait_until(
        lambda: session_exists_in_fleet(sid),
        timeout=10,
        msg=f"session {sid} did not appear in fleet",
    )
    post_event(make_event(
        sid, flavor, "post_call",
        tokens_total=100,
        tool_name=tool_name,
        model="claude-sonnet-4-6",
    ))
    wait_until(
        lambda: get_session_event_count(sid) >= 2,
        timeout=10,
        msg=f"post_call event not processed for session {sid}",
    )
    return sid


def test_search_finds_agent_by_flavor() -> None:
    """Search for a flavor name finds the agent."""
    flavor = f"search-test-agent-{uuid.uuid4().hex[:6]}"
    _setup_searchable(flavor, "host-a", "tool-a")

    results = _search(flavor)
    agent_flavors = [a["flavor"] for a in results.get("agents", [])]
    assert flavor in agent_flavors, (
        f"expected {flavor} in agents, got {agent_flavors}"
    )


def test_search_finds_session_by_host() -> None:
    """Search for a host name finds the session."""
    flavor = f"search-host-{uuid.uuid4().hex[:6]}"
    host = f"search-test-host-{uuid.uuid4().hex[:6]}"
    sid = _setup_searchable(flavor, host, "tool-b")

    results = _search(host)
    session_hosts = [s["host"] for s in results.get("sessions", [])]
    assert host in session_hosts, (
        f"expected {host} in session hosts, got {session_hosts}"
    )


def test_search_finds_event_by_tool() -> None:
    """Search for a tool name finds the event."""
    flavor = f"search-tool-{uuid.uuid4().hex[:6]}"
    tool = f"search-test-tool-{uuid.uuid4().hex[:6]}"
    _setup_searchable(flavor, "host-c", tool)

    results = _search(tool)
    event_tools = [e["tool_name"] for e in results.get("events", [])]
    assert tool in event_tools, (
        f"expected {tool} in event tool_names, got {event_tools}"
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
    flavor = f"{prefix}-agent"
    host = f"{prefix}-host"
    tool = f"{prefix}-tool"
    _setup_searchable(flavor, host, tool)

    results = _search(prefix)
    total = (
        len(results.get("agents", []))
        + len(results.get("sessions", []))
        + len(results.get("events", []))
    )
    assert total > 0, (
        f"expected at least one result for partial match '{prefix}', got 0"
    )
