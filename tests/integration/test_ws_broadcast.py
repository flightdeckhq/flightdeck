"""Integration tests for the /api/v1/stream WebSocket hub.

Two events of one session committed close together, a post_call and
then a tool_call, must each reach the stream as a broadcast of its own,
carrying its own event. The worker's notification names the event it
announces, and the hub fetches that event by its id: a hub that read the
session's latest event instead would broadcast the tool_call for both,
which is how the Fleet Live Feed would lose a post_call followed closely
by a tool_call.

Each test opens the stream and starts its run through ``start_run``
before it posts the pair, so the socket is registered with the hub and
neither of the pair's broadcasts can go out before it is listening.
"""

from __future__ import annotations

import asyncio
import time
import uuid
from typing import TYPE_CHECKING

import pytest
from websockets.asyncio.client import connect

from ._ws import WS_URL, Update, session_updates, start_run
from .conftest import exec_sql, make_event, post_event
from .test_session_states import PROCESSING_SLACK_SECS

if TYPE_CHECKING:
    from websockets.asyncio.client import ClientConnection

# Both tests listen on the stack-wide ``/v1/stream`` hub, which
# broadcasts every event the stack ingests; the parallel phase's event
# rate would flood the feed these assertions read, so they run one at
# a time after it.
pytestmark = pytest.mark.exclusive

PAIR_TYPES = ("post_call", "tool_call")


def _get_event_ids(session_id: str, event_types: tuple[str, ...]) -> list[str]:
    """Return the event ids for the given session in occurred_at order,
    filtered to the given event_types. Used to pin down the stored ids so
    the WebSocket assertions can compare by id.

    The event_types tuple is rendered as a comma-separated string and
    expanded server-side via string_to_array so the bind-variable form
    works for the IN-list case without inlining the list into the SQL.
    """
    raw = exec_sql(
        "SELECT id FROM events WHERE session_id = :'sid'::uuid "
        "AND event_type = ANY(string_to_array(:'types', ',')) "
        "ORDER BY occurred_at ASC",
        sqlite=(
            "SELECT id FROM events WHERE session_id = :sid "
            "AND instr(',' || :types || ',', ',' || event_type || ',') > 0 "
            "ORDER BY occurred_at ASC"
        ),
        sid=session_id,
        types=",".join(event_types),
    )
    return [line.strip() for line in raw.splitlines() if line.strip()]


async def _collect_pair(ws: ClientConnection, session_id: str) -> list[Update]:
    """Read ``ws`` and return the broadcasts for ``session_id`` whose
    last_event is one of the pair's types, one per distinct event id, in
    arrival order: once both ids have arrived, or with what arrived after
    PROCESSING_SLACK_SECS, the worker's processing of a handful of events
    on a loaded runner."""
    collected: list[Update] = []
    seen_ids: set[str] = set()
    async for update in session_updates(ws, session_id, PROCESSING_SLACK_SECS):
        last = update.get("last_event") or {}
        eid = last.get("id")
        if last.get("event_type") not in PAIR_TYPES or not eid or eid in seen_ids:
            continue
        seen_ids.add(eid)
        collected.append(update)
        if len(seen_ids) == len(PAIR_TYPES):
            break
    return collected


def test_ws_broadcasts_tightly_paired_post_call_and_tool_call() -> None:
    """A post_call and a tool_call posted back to back reach the stream as
    two broadcasts carrying the two stored event ids.

    The assertion is by event id, not count: a hub that broadcast the
    session's latest event would still send two broadcasts, both carrying
    the tool_call's id, and fail the comparison.
    """
    sid = str(uuid.uuid4())
    flavor = f"test-ws-race-{uuid.uuid4().hex[:6]}"

    async def drive() -> list[Update]:
        async with connect(WS_URL) as ws:
            await start_run(ws, sid, flavor)
            # Back to back: the closer the tool_call's commit follows the
            # post_call's, the likelier a hub that read the session's
            # latest event would broadcast the tool_call for both. POSTs
            # are synchronous HTTP; ingestion publishes to NATS and
            # returns, so the worker-side commits will be pipelined by the
            # consumer pool.
            post_call = make_event(sid, flavor, "post_call", tokens_total=500)
            tool_call = make_event(sid, flavor, "tool_call", tool_name="Glob")
            await asyncio.to_thread(post_event, post_call)
            await asyncio.to_thread(post_event, tool_call)
            return await _collect_pair(ws, sid)

    received = [u["last_event"] for u in asyncio.run(drive())]

    # Expected: the two stored event ids for post_call and tool_call on
    # this session, in occurred_at order.
    expected_ids = _get_event_ids(sid, PAIR_TYPES)
    assert len(expected_ids) == 2, (
        f"expected two rows (post_call + tool_call) in DB for {sid}, got {expected_ids}"
    )

    received_ids = [e["id"] for e in received]
    assert sorted(received_ids) == sorted(expected_ids), (
        "WebSocket broadcasts should carry both event ids (one per paired "
        "event); a hub that broadcast the session's latest event would send "
        "the tool_call's id twice. "
        f"expected_ids={expected_ids} received_ids={received_ids} "
        f"received_last_events={received}"
    )


def test_ws_broadcast_last_event_matches_notify_event() -> None:
    """Each of the pair's broadcasts carries the event its notification
    named: the broadcast carrying the stored post_call's id says
    post_call, and the one carrying the stored tool_call's id says
    tool_call. The two are stamped a second apart so the stored order
    (by occurred_at) tells them apart; arrival order is not asserted.
    """
    sid = str(uuid.uuid4())
    flavor = f"test-ws-order-{uuid.uuid4().hex[:6]}"

    async def drive() -> list[Update]:
        async with connect(WS_URL) as ws:
            await start_run(ws, sid, flavor)
            # The fixture timestamps are whole seconds, so two events
            # posted back to back usually tie on occurred_at and the DB
            # order below would be arbitrary. Stamp them a second apart.
            now = time.time()
            post_call = make_event(
                sid,
                flavor,
                "post_call",
                tokens_total=750,
                timestamp=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)),
            )
            tool_call = make_event(
                sid,
                flavor,
                "tool_call",
                tool_name="Read",
                timestamp=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now + 1)),
            )
            await asyncio.to_thread(post_event, post_call)
            await asyncio.to_thread(post_event, tool_call)
            return await _collect_pair(ws, sid)

    received = [u["last_event"] for u in asyncio.run(drive())]
    expected_ids = _get_event_ids(sid, PAIR_TYPES)
    assert len(expected_ids) == 2, f"DB rows missing: {expected_ids}"

    # Index received broadcasts by id for per-id assertions.
    by_id = {e["id"]: e for e in received}
    # expected_ids is in occurred_at order: the post_call, then the
    # tool_call stamped a second later. Each must arrive, carrying its
    # own type.
    assert expected_ids[0] in by_id, (
        f"post_call id {expected_ids[0]} missing from WS broadcasts; "
        f"received_ids={list(by_id.keys())}"
    )
    assert expected_ids[1] in by_id, (
        f"tool_call id {expected_ids[1]} missing from WS broadcasts; "
        f"received_ids={list(by_id.keys())}"
    )
    assert by_id[expected_ids[0]]["event_type"] == "post_call"
    assert by_id[expected_ids[1]]["event_type"] == "tool_call"
