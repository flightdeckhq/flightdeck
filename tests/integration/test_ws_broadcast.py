"""Integration tests for the /api/v1/stream WebSocket hub.

Regression coverage for the NOTIFY->SELECT race that caused the Fleet
Live Feed to drop post_call events when they were followed within
~200 ms by a tool_call (the new normal after b63ef8e). The hub now
carries the triggering event_id in the NOTIFY payload and fetches by
primary key, so tight paired events both reach the WebSocket.
"""

from __future__ import annotations

import asyncio
import json
import subprocess
import time
import uuid

from websockets.asyncio.client import connect

from .conftest import TOKEN, make_event, post_event

WS_URL = f"ws://localhost:4000/api/v1/stream?token={TOKEN}"


def _exec_sql(sql: str) -> str:
    result = subprocess.run(
        [
            "docker", "exec", "docker-postgres-1", "psql",
            "-U", "flightdeck", "-d", "flightdeck",
            "-t", "-A", "-c", sql,
        ],
        capture_output=True, text=True, timeout=10, check=True,
    )
    return result.stdout.strip()


def _get_event_ids(session_id: str, event_types: tuple[str, ...]) -> list[str]:
    """Return the event ids for the given session in occurred_at order,
    filtered to the given event_types. Used to pin down the DB-assigned
    UUIDs so the WebSocket assertions can compare by id."""
    type_list = ",".join(f"'{t}'" for t in event_types)
    raw = _exec_sql(
        f"SELECT id FROM events WHERE session_id = '{session_id}'::uuid "
        f"AND event_type IN ({type_list}) ORDER BY occurred_at ASC"
    )
    return [line.strip() for line in raw.splitlines() if line.strip()]


async def _collect_ws_last_events(
    session_id: str,
    event_types: tuple[str, ...],
    min_distinct: int,
    timeout: float,
) -> list[dict]:
    """Open a WebSocket, collect every fleetUpdate for session_id whose
    last_event.event_type is in event_types, return the list (in arrival
    order) once we have at least min_distinct distinct event ids or
    timeout fires. Filtering by event_type keeps the session_start
    broadcast from consuming one of the min_distinct slots -- we only
    care about the paired post_call / tool_call events for the race
    test.
    """
    collected: list[dict] = []
    seen_ids: set[str] = set()
    async with connect(WS_URL) as ws:
        deadline = asyncio.get_event_loop().time() + timeout
        while asyncio.get_event_loop().time() < deadline:
            remaining = deadline - asyncio.get_event_loop().time()
            if remaining <= 0:
                break
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=remaining)
            except asyncio.TimeoutError:
                break
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                continue
            sess = data.get("session") or {}
            if sess.get("session_id") != session_id:
                continue
            last = data.get("last_event")
            if not last:
                continue
            if last.get("event_type") not in event_types:
                continue
            eid = last.get("id")
            if not eid:
                continue
            if eid in seen_ids:
                continue
            seen_ids.add(eid)
            collected.append(last)
            if len(seen_ids) >= min_distinct:
                break
    return collected


def test_ws_broadcasts_tightly_paired_post_call_and_tool_call() -> None:
    """Pre-fix symptom: the hub's GetSessionEvents + tail race caused
    two NOTIFYs (post_call then tool_call, ~150 ms apart) to broadcast
    the same LastEvent (tool_call) twice. Post-fix, the NOTIFY payload
    carries event_id and the hub fetches that exact row, so both
    events reach the WebSocket in distinct broadcasts.

    The assertion is by event_id, not count. A pre-fix run would still
    see two broadcasts -- they would both carry the tool_call id, and
    the test would fail on the id comparison.
    """
    sid = str(uuid.uuid4())
    flavor = f"test-ws-race-{uuid.uuid4().hex[:6]}"

    # session_start first so the session row exists.
    post_event(make_event(sid, flavor, "session_start"))

    async def drive() -> list[dict]:
        # Start the WS listener BEFORE the paired posts so we don't
        # miss broadcasts between connect and send.
        task = asyncio.create_task(
            _collect_ws_last_events(
                sid,
                event_types=("post_call", "tool_call"),
                min_distinct=2,
                timeout=10.0,
            )
        )
        # Give the WS handshake a moment to land.
        await asyncio.sleep(0.2)
        # Queue the paired events close together to reproduce the
        # race window. POSTs are synchronous HTTP; ingestion publishes
        # to NATS and returns, so the worker-side commits will be
        # pipelined by the consumer pool.
        post_event(make_event(sid, flavor, "post_call", tokens_total=500))
        time.sleep(0.05)
        post_event(make_event(sid, flavor, "tool_call", tool_name="Glob"))
        return await task

    received = asyncio.run(drive())

    # Expected: the two DB-assigned event ids for post_call and
    # tool_call on this session, in occurred_at order.
    expected_ids = _get_event_ids(sid, ("post_call", "tool_call"))
    assert len(expected_ids) == 2, (
        f"expected two rows (post_call + tool_call) in DB for {sid}, "
        f"got {expected_ids}"
    )

    received_ids = [e["id"] for e in received]
    assert sorted(received_ids) == sorted(expected_ids), (
        "WebSocket broadcasts should carry both event ids (one per "
        "paired event). pre-fix: two broadcasts both carried the "
        "tool_call id because the hub re-queried GetSessionEvents "
        "and picked the tail. "
        f"expected_ids={expected_ids} received_ids={received_ids} "
        f"received_last_events={received}"
    )


def test_ws_broadcast_last_event_matches_notify_event() -> None:
    """Tighter variant: assert each broadcast's last_event.id matches
    the event that triggered its NOTIFY, in order. Pins down both the
    set of ids AND the order, which is what prevents the pre-fix
    test from accidentally passing even when ids happen to match by
    set but not by ordering.
    """
    sid = str(uuid.uuid4())
    flavor = f"test-ws-order-{uuid.uuid4().hex[:6]}"

    post_event(make_event(sid, flavor, "session_start"))

    async def drive() -> list[dict]:
        task = asyncio.create_task(
            _collect_ws_last_events(
                sid,
                event_types=("post_call", "tool_call"),
                min_distinct=2,
                timeout=10.0,
            )
        )
        await asyncio.sleep(0.2)
        post_event(make_event(sid, flavor, "post_call", tokens_total=750))
        time.sleep(0.05)
        post_event(make_event(sid, flavor, "tool_call", tool_name="Read"))
        return await task

    received = asyncio.run(drive())
    expected_ids = _get_event_ids(sid, ("post_call", "tool_call"))
    assert len(expected_ids) == 2, f"DB rows missing: {expected_ids}"

    # Index received broadcasts by id for per-id assertions.
    by_id = {e["id"]: e for e in received}
    # posted[0] is the post_call (earliest occurred_at), posted[1] is
    # the tool_call. The Supervisor's spec asserts each broadcast
    # carries the right event_id for its NOTIFY.
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
