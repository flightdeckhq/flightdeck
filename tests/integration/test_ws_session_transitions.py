"""Session state changes the worker makes reach an open /api/v1/stream
WebSocket without any new event: the reconciler marking a run stale and
then lost, the orphan reaper closing a lost run, and a stale parent
revived by its sub-agent's event.

Each test creates its own agent and session through ingestion and moves
the session only by backdating its own row (or, for the parent, by
posting its child's event); the reconciler running in the dev stack's
worker does the rest on its next tick. The run is its agent's only one,
so every update must also carry the run's state as the agent's
rolled-up ``agent_state``. Each test removes what it wrote. Requires the
dev stack (``make dev``).

Each test opens the stream before it starts its run, and reads the run's
own session_start broadcast off it before it moves the session. The
worker commits the session row before it stores the start event and
announces it, so that broadcast can reach the stream after the API
already returns the row; read first, it can never be taken for one of
the state changes the test collects.
"""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from typing import TYPE_CHECKING, Any

import pytest
from websockets.asyncio.client import ClientConnection, connect

from .conftest import (
    BASE_URL,
    TOKEN,
    delete_flavor_data,
    exec_sql,
    make_event,
    post_event,
)
from .test_session_states import PROCESSING_SLACK_SECS, RECONCILER_POSITIVE_WAIT_SECS

if TYPE_CHECKING:
    from collections.abc import Callable

WS_URL = f"{BASE_URL.replace('http', 'ws', 1)}/api/v1/stream?token={TOKEN}"

# The tests listen on the stack-wide stream, which broadcasts everything
# the stack ingests; under the parallel phase's event rate the hub can
# drop a slow reader, so they run one at a time after it.
pytestmark = pytest.mark.exclusive

# How long a run's own session_start may take to reach the stream: the
# worker's processing of it, then as long again for the hub, which
# broadcasts in turn and may still be working through what the tests
# before this one sent. The wait ends as soon as the broadcast arrives.
START_BROADCAST_WAIT_SECS = 2 * PROCESSING_SLACK_SECS

Update = dict[str, Any]


async def _await_update(
    ws: ClientConnection,
    session_id: str,
    matches: Callable[[Update], bool],
    timeout: float,
    *,
    expected: str = "matching update",
) -> tuple[Update, list[Update]]:
    """Read broadcasts until one for ``session_id`` satisfies ``matches``.

    Returns that update and every update for the session received on the
    way, in arrival order (the matching one last). Fails the test, naming
    the ``expected`` update, when none arrives within ``timeout`` seconds.
    """
    seen: list[Update] = []
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while True:
        remaining = deadline - loop.time()
        if remaining <= 0:
            states = [u.get("session", {}).get("state") for u in seen]
            pytest.fail(
                f"no {expected} for {session_id} within {timeout}s; "
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


def _is_start(update: Update) -> bool:
    return update["type"] == "session_start"


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
            sqlite=(
                "UPDATE sessions SET last_seen_at = "
                "strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || :ago) "
                "WHERE session_id = :sid"
            ),
            ago=interval,
            sid=session_id,
        )
    else:
        exec_sql(
            "UPDATE sessions SET state = :'state', "
            "last_seen_at = NOW() - CAST(:'ago' AS interval) "
            "WHERE session_id = :'sid'::uuid",
            sqlite=(
                "UPDATE sessions SET state = :state, last_seen_at = "
                "strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || :ago) "
                "WHERE session_id = :sid"
            ),
            state=state,
            ago=interval,
            sid=session_id,
        )


def _new_run(flavor_prefix: str) -> tuple[str, str]:
    """A session id and a flavor of its own for a run the test starts."""
    return str(uuid.uuid4()), f"{flavor_prefix}-{uuid.uuid4().hex[:6]}"


async def _start_run(
    ws: ClientConnection, session_id: str, flavor: str, **fields: Any
) -> None:
    """Post the run's session_start and read ``ws`` until the start's own
    broadcast has arrived.

    ``ws`` must be open before the start is posted, so the broadcast
    cannot slip past it. Once it has arrived the start is stored: the
    worker announces it only after storing the event, and the hub fetches
    that event to send it. The hub broadcasts in the order changes are
    announced, so everything the test reads for the session from here on
    is a later change.
    """
    post_event(make_event(session_id, flavor, "session_start", **fields))
    await _await_update(
        ws,
        session_id,
        _is_start,
        START_BROADCAST_WAIT_SECS,
        expected="session_start broadcast",
    )


def test_reconciler_stale_then_lost_reach_the_stream_without_an_event() -> None:
    """A run that goes silent shows stale, then lost, on an open stream:
    each a session_update carrying the session and no event, with the
    agent's rolled-up state."""
    sid, flavor = _new_run("test-ws-transition")
    try:
        _assert_stale_then_lost(sid, flavor)
    finally:
        delete_flavor_data(flavor)


def _assert_stale_then_lost(sid: str, flavor: str) -> None:
    async def drive() -> tuple[Update, Update, list[Update]]:
        async with connect(WS_URL) as ws:
            # The flavor names the agent too, so the run is the agent's
            # only one.
            await _start_run(ws, sid, flavor, agent_name=flavor)
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
        # The run is its agent's only one: the agent is where it is.
        assert update.get("agent_state") == update["session"]["state"], update
    for update in seen:
        assert "last_event" not in update, (
            f"a state change for {sid} must carry no event; got {update['last_event']}"
        )
    assert [u["session"]["state"] for u in seen] == ["stale", "lost"], (
        "expected exactly one update per transition, stale then lost; got "
        f"{[u['session']['state'] for u in seen]}"
    )
    # The start, stored before its broadcast arrived, is the run's one
    # event; the transitions add none.
    assert _event_count(sid) == 1, "the transitions must not write events"


def test_reaper_close_reaches_the_stream_as_a_session_end() -> None:
    """A lost run past FLIGHTDECK_ORPHAN_TIMEOUT_HOURS (24 h by default)
    closes on an open stream as a session_end carrying the reaper's
    synthetic event, like any other close."""
    sid, flavor = _new_run("test-ws-reap")
    try:
        _assert_reaped(sid, flavor)
    finally:
        delete_flavor_data(flavor)


def _assert_reaped(sid: str, flavor: str) -> None:
    async def drive() -> Update:
        async with connect(WS_URL) as ws:
            await _start_run(ws, sid, flavor, agent_name=flavor)
            _backdate(sid, "25 hours", state="lost")
            closed, _ = await _await_update(
                ws, sid, _in_state("closed"), RECONCILER_POSITIVE_WAIT_SECS
            )
            return closed

    closed = asyncio.run(drive())

    assert closed["type"] == "session_end", closed
    assert closed["session"].get("ended_at"), f"closed session {sid} has no ended_at"
    assert closed.get("agent_state") == "closed", closed
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
    parent_sid, parent_flavor = _new_run("test-ws-revive-parent")
    child_sid, child_flavor = _new_run("test-ws-revive-child")
    try:
        _assert_parent_revived(parent_sid, parent_flavor, child_sid, child_flavor)
    finally:
        delete_flavor_data(child_flavor)
        delete_flavor_data(parent_flavor)


def _assert_parent_revived(
    parent_sid: str, parent_flavor: str, child_sid: str, child_flavor: str
) -> None:
    async def drive() -> list[Update]:
        async with connect(WS_URL) as ws:
            await _start_run(ws, parent_sid, parent_flavor, agent_name=parent_flavor)
            await _start_run(
                ws,
                child_sid,
                child_flavor,
                parent_session_id=parent_sid,
                agent_role="worker",
            )
            # Put the parent where the reconciler would have: stale. Done
            # directly so the test does not wait out the 2-minute threshold.
            _backdate(parent_sid, "3 minutes", state="stale")
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
    assert revived.get("agent_state") == "active", revived
