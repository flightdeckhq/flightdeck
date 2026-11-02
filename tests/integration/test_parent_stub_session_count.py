"""Integration test: a parent agent counts its session when a sub-agent's
session_start reaches the worker first.

A child's ``session_start`` whose parent session is not stored yet makes
the worker write the parent row as a stub that belongs to no agent, so
the child row can reference it. The parent's own events then claim the
stub, and the parent's agent must count that session once:
``GET /v1/fleet`` lists the agent with ``total_sessions`` 1. The Fleet
hides an agent whose ``total_sessions`` is 0, so a parent left at 0
vanished from the sidebar and the swimlane while its session ran. An
OTLP export carrying a root and its sub-agent, a plugin retrying a
failed root start and a framework spawning a sub-agent at once all
deliver the child's start first.

Each test orders the events explicitly: it posts the child's
``session_start``, waits until the worker has stored the child and the
ownerless parent stub, and only then posts the parent's event.
"""

from __future__ import annotations

import json
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass, field
from typing import Any

from .conftest import (
    API_URL,
    auth_headers,
    exec_sql,
    get_session_detail,
    get_session_event_count,
    make_event,
    post_event,
    wait_for_state,
    wait_until,
)

# Long enough for the worker to process an event and for the API to
# serve the result on a loaded laptop or CI runner; the happy path takes
# well under a second.
PROCESSING_TIMEOUT_SECS = 15.0

# The API's per_page cap on /v1/fleet. The fleet is ordered by
# last_seen_at, so an agent this test just touched is on the first page;
# FLEET_PAGES_SCANNED pages leave room for a busy shared stack.
FLEET_PER_PAGE = 200
FLEET_PAGES_SCANNED = 3


@dataclass
class _Family:
    """A parent session, its sub-agent's session, their agents, and how
    many events the test posted for each session."""

    flavor: str
    agent_name: str
    parent_sid: str
    child_sid: str
    parent_agent: str = ""
    child_agent: str = ""
    posted: dict[str, int] = field(default_factory=dict)

    @classmethod
    def new(cls) -> _Family:
        suffix = uuid.uuid4().hex[:8]
        f = cls(
            flavor=f"test-stub-count-{suffix}",
            agent_name=f"test-stub-count-{suffix}",
            parent_sid=str(uuid.uuid4()),
            child_sid=str(uuid.uuid4()),
        )
        # The agent ids the fixtures derive from each side's identity.
        f.parent_agent = str(f.parent_event("session_end")["agent_id"])
        f.child_agent = str(f.child_event("session_end")["agent_id"])
        return f

    def post(self, event: dict[str, Any]) -> None:
        """POST the event and count it toward its session."""
        post_event(event)
        sid = event["session_id"]
        self.posted[sid] = self.posted.get(sid, 0) + 1

    def wait_stored(self) -> None:
        """Wait until the worker has stored every event posted so far. The
        worker inserts an event's row after the session writes the event
        makes, so a stored count means those writes are done. Best effort:
        a timeout leaves the caller to proceed."""
        for sid, count in self.posted.items():
            try:
                wait_until(
                    lambda sid=sid, count=count: get_session_event_count(sid) >= count,
                    timeout=PROCESSING_TIMEOUT_SECS,
                    msg=f"{count} events of session {sid} stored",
                )
            except TimeoutError:
                pass

    def parent_event(self, event_type: str) -> dict[str, Any]:
        return make_event(
            self.parent_sid, self.flavor, event_type, agent_name=self.agent_name
        )

    def child_event(self, event_type: str) -> dict[str, Any]:
        return make_event(
            self.child_sid,
            self.flavor,
            event_type,
            agent_name=self.agent_name,
            agent_role="worker",
            parent_session_id=self.parent_sid,
        )


def _fleet_agent(agent_id: str) -> dict[str, Any] | None:
    """The /v1/fleet row of ``agent_id``, None while it is not listed."""
    for page in range(1, FLEET_PAGES_SCANNED + 1):
        qs = urllib.parse.urlencode(
            {"per_page": str(FLEET_PER_PAGE), "page": str(page)}
        )
        req = urllib.request.Request(f"{API_URL}/v1/fleet?{qs}", headers=auth_headers())
        with urllib.request.urlopen(req, timeout=10) as resp:
            agents = json.loads(resp.read()).get("agents") or []
        for agent in agents:
            if agent.get("agent_id") == agent_id:
                return agent  # type: ignore[no-any-return]
        if len(agents) < FLEET_PER_PAGE:
            return None
    return None


def _counted_agent(agent_id: str) -> dict[str, Any]:
    """The /v1/fleet row of ``agent_id`` once it counts a session, or the
    last row observed when it never does within the timeout."""
    observed: dict[str, Any] = {}

    def _counted() -> bool:
        row = _fleet_agent(agent_id)
        observed["row"] = row
        return row is not None and row.get("total_sessions", 0) >= 1

    try:
        wait_until(_counted, timeout=PROCESSING_TIMEOUT_SECS, msg="agent counted")
    except TimeoutError:
        pass
    row = observed.get("row")
    assert row is not None, f"/v1/fleet does not list the agent {agent_id}"
    return row  # type: ignore[no-any-return]


def _session_owner(session_id: str) -> str | None:
    """The stored row's agent_id: None while the row is missing, "" while
    it belongs to no agent."""
    raw = exec_sql(
        "SELECT COALESCE((SELECT COALESCE(agent_id::text, 'no-agent') FROM sessions "
        "WHERE session_id = :'sid'::uuid), 'no-row')",
        sid=session_id,
    )
    if raw == "no-row":
        return None
    return "" if raw == "no-agent" else raw


def _session_state(session_id: str) -> str | None:
    """The stored row's state, None while the row is missing."""
    raw = exec_sql(
        "SELECT COALESCE((SELECT state FROM sessions "
        "WHERE session_id = :'sid'::uuid), 'no-row')",
        sid=session_id,
    )
    return None if raw == "no-row" else raw


def _start_child_first(f: _Family) -> None:
    """Post the child's session_start and wait until the worker has
    stored it. The worker writes the parent stub before the child row, so
    a stored child means the stub exists, still without an owner."""
    assert f.parent_agent != f.child_agent, (
        "the role must give the sub-agent its own agent"
    )
    f.post(f.child_event("session_start"))
    wait_until(
        lambda: _session_owner(f.child_sid) is not None,
        timeout=PROCESSING_TIMEOUT_SECS,
        msg=f"child session {f.child_sid} stored",
    )
    assert _session_owner(f.parent_sid) == "", (
        "the child's session_start must leave the parent as a stub that "
        "belongs to no agent"
    )


def _end_and_delete(f: _Family) -> None:
    """End the runs still open, then remove the rows by explicit id.

    The worker stores an event's row only after the session writes the
    event makes, and a closed row says nothing about an end still in
    flight, so the cleanup waits until every event the test posted is
    stored, before and after posting the closing ends; no event row can
    then land while the rows are being deleted. A run that is already
    closed (or never stored) gets no further end. The deletes go children
    first: content and events reference sessions, a child references its
    parent session, and sessions reference agents."""
    f.wait_stored()
    for sid, event_for in (
        (f.child_sid, f.child_event),
        (f.parent_sid, f.parent_event),
    ):
        if _session_state(sid) not in (None, "closed"):
            f.post(event_for("session_end"))
    f.wait_stored()
    for sid in (f.child_sid, f.parent_sid):
        for sql in (
            "DELETE FROM event_content WHERE session_id = :'id'::uuid",
            "DELETE FROM events WHERE session_id = :'id'::uuid",
            "DELETE FROM sessions WHERE session_id = :'id'::uuid",
        ):
            exec_sql(sql, id=sid)
    for agent_id in (f.child_agent, f.parent_agent):
        exec_sql("DELETE FROM agents WHERE agent_id = :'id'::uuid", id=agent_id)


def test_parent_started_after_its_sub_agent_counts_its_session_once() -> None:
    f = _Family.new()
    try:
        _start_child_first(f)

        f.post(f.parent_event("session_start"))
        wait_until(
            lambda: _session_owner(f.parent_sid) == f.parent_agent,
            timeout=PROCESSING_TIMEOUT_SECS,
            msg=f"parent session {f.parent_sid} attributed to {f.parent_agent}",
        )
        row = _counted_agent(f.parent_agent)
        assert row["total_sessions"] == 1, (
            f"parent agent total_sessions = {row['total_sessions']}, want 1: "
            "the parent's session_start filled the stub without counting it"
        )
        child_row = _fleet_agent(f.child_agent)
        assert child_row is not None and child_row["total_sessions"] == 1, child_row

        # A second session_start of the parent (a re-attachment, or a
        # client retrying the start) finds the row owned and does not
        # count it again.
        f.post(f.parent_event("session_start"))
        wait_until(
            lambda: get_session_event_count(f.parent_sid) >= 2,
            timeout=PROCESSING_TIMEOUT_SECS,
            msg="second parent session_start stored",
        )
        row = _counted_agent(f.parent_agent)
        assert row["total_sessions"] == 1, row
    finally:
        _end_and_delete(f)


def test_parent_whose_only_event_is_its_end_counts_its_session_once() -> None:
    """The parent's session_start never reaches the server (a root start
    the client gave up on) and its session_end is the only event of it
    that does: the end closes the stub and claims it for the parent's
    agent, and a duplicate end does not count it again."""
    f = _Family.new()
    try:
        _start_child_first(f)

        f.post(f.parent_event("session_end"))
        wait_for_state(f.parent_sid, "closed", timeout=PROCESSING_TIMEOUT_SECS)
        wait_until(
            lambda: _session_owner(f.parent_sid) == f.parent_agent,
            timeout=PROCESSING_TIMEOUT_SECS,
            msg=f"parent session {f.parent_sid} attributed to {f.parent_agent}",
        )
        row = _counted_agent(f.parent_agent)
        assert row["total_sessions"] == 1, (
            f"parent agent total_sessions = {row['total_sessions']}, want 1: "
            "the parent's session_end left the stub uncounted"
        )

        f.post(f.parent_event("session_end"))
        wait_until(
            lambda: get_session_event_count(f.parent_sid) >= 2,
            timeout=PROCESSING_TIMEOUT_SECS,
            msg="duplicate parent session_end stored",
        )
        row = _counted_agent(f.parent_agent)
        assert row["total_sessions"] == 1, row
        assert get_session_detail(f.parent_sid)["session"]["state"] == "closed"
    finally:
        _end_and_delete(f)
