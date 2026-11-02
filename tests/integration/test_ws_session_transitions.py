"""Session state changes the worker makes reach an open /api/v1/stream
WebSocket without any new event: the reconciler marking a run stale and
then lost, the orphan reaper closing a lost run, and a stale parent
revived by its sub-agent's event.

Each test creates its own session through ingestion and moves it only by
backdating its own row (or, for the parent, by posting its child's event);
the reconciler running in the dev stack's worker does the rest on its
next tick. Requires the dev stack (``make dev``).
"""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from typing import TYPE_CHECKING, Any

import pytest
from websockets.asyncio.client import ClientConnection, connect

from .conftest import TOKEN, exec_sql, make_event, post_event, wait_for_session_in_fleet
from .test_session_states import PROCESSING_SLACK_SECS, RECONCILER_POSITIVE_WAIT_SECS

if TYPE_CHECKING:
    from collections.abc import Callable

WS_URL = f"ws://localhost:4000/api/v1/stream?token={TOKEN}"

# The tests listen on the stack-wide stream, which broadcasts everything
# the stack ingests; under the parallel phase's event rate the hub can
# drop a slow reader, so they run one at a time after it.
pytestmark = pytest.mark.exclusive

Update = dict[str, Any]


async def _await_update(
    ws: ClientConnection,
    session_id: str,
    matches: Callable[[Update], bool],
    timeout: float,
) -> tuple[Update, list[Update]]:
    """Read broadcasts until one for ``session_id`` satisfies ``matches``.

    Returns that update and every update for the session received on the
    way, in arrival order (the matching one last). Fails the test when
    none arrives within ``timeout`` seconds.
    """
    seen: list[Update] = []
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while True:
        remaining = deadline - loop.time()
        if remaining <= 0:
            states = [u.get("session", {}).get("state") for u in seen]
            pytest.fail(
                f"no matching update for {session_id} within {timeout}s; "
                f"saw {len(seen)} update(s) for it with states {states}"
            )
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=remaining)
        except TimeoutError:
            continue
        try:
            update = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if (update.get("session") or {}).get("session_id") != session_id:
            continue
        seen.append(update)
        if matches(update):
            return update, seen


def _in_state(state: str) -> Callable[[Update], bool]:
    return lambda u: u["session"]["state"] == state


def _event_count(session_id: str) -> int:
    return int(
        exec_sql(
            "SELECT COUNT(*) FROM events WHERE session_id = :'sid'::uuid",
            sid=session_id,
        )
    )


def _backdate(session_id: str, interval: str, *, state: str | None = None) -> None:
    """Move this test's own session's last signal into the past (and, for
    the reaper case, put it in ``state``) so the next reconciler tick acts
    on it."""
    if state is None:
        exec_sql(
            "UPDATE sessions SET last_seen_at = NOW() - CAST(:'ago' AS interval) "
            "WHERE session_id = :'sid'::uuid",
            ago=interval,
            sid=session_id,
        )
    else:
        exec_sql(
            "UPDATE sessions SET state = :'state', "
            "last_seen_at = NOW() - CAST(:'ago' AS interval) "
            "WHERE session_id = :'sid'::uuid",
            state=state,
            ago=interval,
            sid=session_id,
        )


def _started_session(flavor_prefix: str) -> str:
    sid = str(uuid.uuid4())
    post_event(make_event(sid, f"{flavor_prefix}-{uuid.uuid4().hex[:6]}", "session_start"))
    assert wait_for_session_in_fleet(sid, timeout=PROCESSING_SLACK_SECS), (
        f"session {sid} never landed"
    )
    return sid


def test_reconciler_stale_then_lost_reach_the_stream_without_an_event() -> None:
    """A run that goes silent shows stale, then lost, on an open stream:
    each a session_update carrying the session and no event."""
    sid = _started_session("test-ws-transition")
    events_before = _event_count(sid)

    async def drive() -> tuple[Update, Update, list[Update]]:
        async with connect(WS_URL) as ws:
            # Past the 2-minute stale threshold, short of the 30-minute
            # lost threshold.
            _backdate(sid, "3 minutes")
            stale, seen_stale = await _await_update(
                ws, sid, _in_state("stale"), RECONCILER_POSITIVE_WAIT_SECS
            )
            _backdate(sid, "31 minutes")
            lost, seen_lost = await _await_update(
                ws, sid, _in_state("lost"), RECONCILER_POSITIVE_WAIT_SECS
            )
            return stale, lost, seen_stale + seen_lost

    stale, lost, seen = asyncio.run(drive())

    for update in (stale, lost):
        assert update["type"] == "session_update", update
    for update in seen:
        assert "last_event" not in update, (
            f"a state change for {sid} must carry no event; got {update['last_event']}"
        )
    assert [u["session"]["state"] for u in seen] == ["stale", "lost"], (
        "expected exactly one update per transition, stale then lost; got "
        f"{[u['session']['state'] for u in seen]}"
    )
    assert _event_count(sid) == events_before, "the transitions must not write events"


def test_reaper_close_reaches_the_stream_as_a_session_end() -> None:
    """A lost run past FLIGHTDECK_ORPHAN_TIMEOUT_HOURS (24 h by default)
    closes on an open stream as a session_end carrying the reaper's
    synthetic event, like any other close."""
    sid = _started_session("test-ws-reap")

    async def drive() -> Update:
        async with connect(WS_URL) as ws:
            _backdate(sid, "25 hours", state="lost")
            closed, _ = await _await_update(
                ws, sid, _in_state("closed"), RECONCILER_POSITIVE_WAIT_SECS
            )
            return closed

    closed = asyncio.run(drive())

    assert closed["type"] == "session_end", closed
    assert closed["session"].get("ended_at"), f"closed session {sid} has no ended_at"
    last_event = closed.get("last_event")
    assert last_event, f"the reaper's close for {sid} must carry its session_end"
    assert last_event["event_type"] == "session_end"
    assert (last_event.get("payload") or {}).get("close_reason") == "orphan_timeout"
    stored = exec_sql(
        "SELECT id FROM events WHERE session_id = :'sid'::uuid AND event_type = 'session_end'",
        sid=sid,
    )
    assert last_event["id"] == stored.strip(), (
        f"broadcast event {last_event['id']} is not the stored session_end {stored!r}"
    )


def test_parent_revived_by_its_child_reaches_the_stream() -> None:
    """A stale parent that its sub-agent's event revives shows active again
    on an open stream: the child's own broadcast names only the child."""
    parent_sid = _started_session("test-ws-revive-parent")
    child_sid = str(uuid.uuid4())
    child_flavor = f"test-ws-revive-child-{uuid.uuid4().hex[:6]}"
    post_event(
        make_event(
            child_sid,
            child_flavor,
            "session_start",
            parent_session_id=parent_sid,
            agent_role="worker",
        )
    )
    assert wait_for_session_in_fleet(child_sid, timeout=PROCESSING_SLACK_SECS)
    # Put the parent where the reconciler would have: stale. Done directly
    # so the test does not wait out the 2-minute threshold.
    _backdate(parent_sid, "3 minutes", state="stale")

    async def drive() -> list[Update]:
        async with connect(WS_URL) as ws:
            post_event(
                make_event(
                    child_sid,
                    child_flavor,
                    "tool_call",
                    parent_session_id=parent_sid,
                    agent_role="worker",
                    tool_name="Read",
                    timestamp=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                )
            )
            _, seen = await _await_update(
                ws, parent_sid, _in_state("active"), PROCESSING_SLACK_SECS
            )
            return seen

    seen = asyncio.run(drive())
    revived = seen[-1]
    assert revived["type"] == "session_update", revived
    assert "last_event" not in revived, (
        f"the parent's revival is a state change, not an event; got {revived['last_event']}"
    )
