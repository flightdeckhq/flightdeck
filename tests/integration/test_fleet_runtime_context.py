"""Integration test: /v1/fleet projects D161 runtime-context fields.

The /agents page sidebar (D161) faceted nine runtime-context
dimensions: ``hostname``, ``user``, ``os``, ``arch``, ``git_branch``,
``git_repo``, ``orchestration``, ``python_version``, ``process_name``.
``hostname`` and ``user`` are sourced from agents-table columns; the
other seven come from a LATERAL JOIN against the agent's MOST RECENT
session's ``context`` JSONB.

This test pins the contract end-to-end against the live dev stack:

1. Seed an agent with TWO sessions where the LATER session carries a
   different ``os`` / ``git_branch`` than the earlier one.
2. Wait for both sessions to land + the worker to project the agent
   row.
3. Fetch /v1/fleet and verify the response carries the LATER
   session's context values (NOT the earlier one).
4. Verify a second agent seeded WITHOUT context returns nulls on
   every D161 field (so the consumer can collapse to "no value for
   this agent" without crashing).

The fields land on ``AgentSummary`` with ``omitempty`` JSON tags,
so absent keys may be missing entirely OR present-and-null — both
shapes mean "no value".
"""

from __future__ import annotations

import json
import time
import urllib.parse
import urllib.request
import uuid
from typing import Any

from .conftest import API_URL, auth_headers, make_event, post_event, wait_until


def _list_v1_fleet(params: dict[str, str]) -> dict[str, Any]:
    qs = urllib.parse.urlencode(params)
    req = urllib.request.Request(
        f"{API_URL}/v1/fleet?{qs}", headers=auth_headers()
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read())  # type: ignore[no-any-return]


def _wait_for_agent(
    agent_name: str,
    *,
    expect: dict[str, Any] | None = None,
    timeout: float = 15.0,
) -> dict[str, Any]:
    """Poll /v1/fleet until the named agent surfaces, then return it.

    The agent row appears in the fleet response as soon as the worker
    upserts the agent — but the LATERAL context projection runs at
    query time AND the worker may briefly be mid-flight on the most
    recent session_start. Callers that need specific D161 field
    values pass an ``expect`` dict (e.g. ``{"os": "Linux"}``) so the
    poll keeps retrying until every expected key matches; on timeout
    the assertion that follows prints the last-observed shape so the
    failure is debuggable.
    """
    matched: dict[str, dict[str, Any]] = {}

    def _check() -> bool:
        for page in ("1", "2"):
            fleet = _list_v1_fleet({"per_page": "300", "page": page})
            for a in fleet.get("agents", []):
                if a.get("agent_name") != agent_name:
                    continue
                matched["agent"] = a
                if expect is None:
                    return True
                return all(a.get(k) == v for k, v in expect.items())
        return False

    wait_until(_check, timeout=timeout, msg=f"agent {agent_name} in fleet")
    return matched["agent"]


def _seed_session_with_context(
    *,
    flavor: str,
    agent_name: str,
    context: dict[str, Any] | None,
) -> None:
    """POST a session_start (and a session_end one second later so the
    LATERAL ordering by started_at DESC is unambiguous) for the given
    agent, optionally with explicit context JSONB.
    """
    session_id = str(uuid.uuid4())
    start_kwargs: dict[str, Any] = {}
    if context is not None:
        start_kwargs["context"] = context
    post_event(
        make_event(
            session_id,
            flavor,
            "session_start",
            agent_name=agent_name,
            **start_kwargs,
        )
    )
    # Close it so the lifecycle fixture's teardown can find it; the
    # state is irrelevant — what matters is the context lands.
    post_event(
        make_event(
            session_id,
            flavor,
            "session_end",
            agent_name=agent_name,
        )
    )


def test_fleet_projects_d161_runtime_context_from_latest_session() -> None:
    """Seed one agent with two sessions where the LATER session carries
    a different context; the projection must return the LATER values.
    """
    suffix = uuid.uuid4().hex[:8]
    agent_name = f"test-d161-int-{suffix}"
    flavor = f"d161-int-{suffix}"

    # Earlier session — initial context.
    _seed_session_with_context(
        flavor=flavor,
        agent_name=agent_name,
        context={
            "os": "Darwin",
            "arch": "x86_64",
            "git_branch": "old-branch",
            "git_repo": "old-repo",
            "orchestration": "docker",
            "python_version": "3.10",
            "process_name": "old.py",
        },
    )
    # The LATERAL projection picks by ``started_at DESC LIMIT 1`` —
    # ``make_event`` stamps a 1-second-granularity timestamp, so wait
    # at least 1.1s before the second session_start to guarantee a
    # strict ordering on the wire.
    time.sleep(1.2)
    _seed_session_with_context(
        flavor=flavor,
        agent_name=agent_name,
        context={
            "os": "Linux",
            "arch": "arm64",
            "git_branch": "main",
            "git_repo": "flightdeck",
            "orchestration": "kubernetes",
            "python_version": "3.12",
            "process_name": "new.py",
        },
    )
    agent = _wait_for_agent(agent_name, expect={"os": "Linux"})

    # Every D161 field must come back with the LATER session's value.
    assert agent.get("os") == "Linux", agent
    assert agent.get("arch") == "arm64", agent
    assert agent.get("git_branch") == "main", agent
    assert agent.get("git_repo") == "flightdeck", agent
    assert agent.get("orchestration") == "kubernetes", agent
    assert agent.get("python_version") == "3.12", agent
    assert agent.get("process_name") == "new.py", agent


def test_fleet_d161_runtime_context_null_when_no_context() -> None:
    """An agent whose latest session was started WITHOUT a context
    JSONB (worker stamps NULL) must return null for every D161 field;
    fields are ``omitempty``, so the keys may be missing or null —
    both shapes mean "no value".

    Note: ``make_event`` injects ``DEFAULT_TEST_CONTEXT`` (carrying
    sensor identity fields like ``working_dir``) when a session_start
    doesn't already carry context, so we explicitly set an empty
    object here so the JSONB IS present but the seven D161 keys are
    all missing.
    """
    suffix = uuid.uuid4().hex[:8]
    agent_name = f"test-d161-empty-{suffix}"
    flavor = f"d161-empty-{suffix}"
    _seed_session_with_context(
        flavor=flavor,
        agent_name=agent_name,
        context={},  # explicit empty context — no D161 keys
    )
    agent = _wait_for_agent(agent_name)

    for field in (
        "os",
        "arch",
        "git_branch",
        "git_repo",
        "orchestration",
        "python_version",
        "process_name",
    ):
        # The field is either missing from the payload (``omitempty``)
        # OR present-and-null. Both shapes mean "no value for this
        # agent" — the consumer collapses both to the same chip
        # absence on the sidebar.
        assert agent.get(field) is None, (
            f"agent {agent_name}: expected D161 field {field!r} "
            f"to be null/absent on empty context, got {agent.get(field)!r}"
        )


def test_fleet_d161_runtime_context_hostname_user_from_agent_columns() -> None:
    """``hostname`` and ``user`` are sourced from the agents-table
    columns (single-valued per agent), NOT the JSONB lateral. Even
    when the latest session's context omits them, the projection
    surfaces the agent-row values.
    """
    suffix = uuid.uuid4().hex[:8]
    agent_name = f"test-d161-cols-{suffix}"
    flavor = f"d161-cols-{suffix}"
    # Seed via the shared make_event which derives the agent's
    # ``hostname`` + ``user`` columns from the named args.
    session_id = str(uuid.uuid4())
    post_event(
        make_event(
            session_id,
            flavor,
            "session_start",
            agent_name=agent_name,
            user="alice",
            hostname="agent-host-7",
            # Context with NO hostname / user keys to prove the
            # projection uses the agents-table columns, not the
            # JSONB.
            context={"os": "Linux"},
        )
    )
    post_event(
        make_event(
            session_id,
            flavor,
            "session_end",
            agent_name=agent_name,
            user="alice",
            hostname="agent-host-7",
        )
    )
    agent = _wait_for_agent(agent_name, expect={"os": "Linux"})

    assert agent.get("hostname") == "agent-host-7", agent
    assert agent.get("user") == "alice", agent
    assert agent.get("os") == "Linux", agent
