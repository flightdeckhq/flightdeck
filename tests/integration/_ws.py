"""Helpers for the integration tests that read the /api/v1/stream WebSocket.

The stream broadcasts everything the stack ingests, so a test reads it
for its own session only. A test opens the socket and then starts its
run through ``start_run`` before it does what it is there to check.
``start_run`` first proves with one ping round trip that the hub has
registered the socket, so nothing broadcast afterwards can miss it. It
then posts the start and reads the start's own broadcast, which proves
the start is stored, so the start can never be taken for a later update.
Neither the open socket nor the session row proves either: the API
answers the upgrade before it registers the socket, and the worker
commits the row before it stores the start event and announces it.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from typing import TYPE_CHECKING, Any

import pytest

from .conftest import BASE_URL, TOKEN, make_event, post_event
from .test_session_states import PROCESSING_SLACK_SECS

if TYPE_CHECKING:
    from collections.abc import AsyncIterator, Callable

    from websockets.asyncio.client import ClientConnection

WS_URL = f"{BASE_URL.replace('http', 'ws', 1)}/api/v1/stream?token={TOKEN}"

# How long the API may take to answer a ping on a new socket. It answers
# once its handler has registered the socket with the hub and reached
# its read loop; the hub takes a registration between broadcasts, each a
# non-blocking hand-off to every client, so this is milliseconds even
# behind a backlog. The bound turns a stalled API into a clear failure
# and absorbs a slow CI runner the way the state waits do.
REGISTRATION_WAIT_SECS = PROCESSING_SLACK_SECS

# How long a run's own session_start may take to reach the stream: the
# worker's processing of it, then as long again for the hub, which
# broadcasts in turn and may still be working through what the tests
# before this one sent. The wait ends as soon as the broadcast arrives.
START_BROADCAST_WAIT_SECS = 2 * PROCESSING_SLACK_SECS

Update = dict[str, Any]


async def session_updates(
    ws: ClientConnection, session_id: str, timeout: float
) -> AsyncIterator[Update]:
    """Yield the broadcasts for ``session_id`` read off ``ws``, in arrival
    order, until ``timeout`` seconds have passed."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while (remaining := deadline - loop.time()) > 0:
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=remaining)
        except TimeoutError:
            return
        try:
            update = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if (update.get("session") or {}).get("session_id") == session_id:
            yield update


async def await_update(
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
    async for update in session_updates(ws, session_id, timeout):
        seen.append(update)
        if matches(update):
            return update, seen
    states = [u.get("session", {}).get("state") for u in seen]
    pytest.fail(
        f"no {expected} for {session_id} within {timeout}s; "
        f"saw {len(seen)} update(s) for it with states {states}"
    )


async def start_run(
    ws: ClientConnection, session_id: str, flavor: str, **fields: Any
) -> None:
    """Prove the hub has registered ``ws``, post the run's session_start,
    and read ``ws`` until the start's own broadcast has arrived.

    The pong proves the registration. The API writes the upgrade's
    response before its handler calls ``Hub.Register``, and the handler
    answers a ping only from its read loop: gorilla's default ping
    handler runs inside ``ReadMessage``, the API sets none of its own,
    and the handler enters that loop only once ``Register`` has returned.
    ``Register`` returns when the hub's loop has taken the client, and the
    loop adds it to its clients before it handles another broadcast; the
    start's POST goes out after the pong, so its broadcast, and every
    later one, reaches ``ws``.

    The start's broadcast proves the start is stored: the worker announces
    it only after storing the event, and the hub fetches that event to
    send it. The start carries an id of the test's own, which the
    broadcast is matched by, and which makes the worker drop a redelivered
    copy as a duplicate instead of storing and broadcasting it again.
    """
    pong = await ws.ping()
    try:
        await asyncio.wait_for(pong, timeout=REGISTRATION_WAIT_SECS)
    except TimeoutError:
        pytest.fail(
            f"the stream did not answer a ping within {REGISTRATION_WAIT_SECS}s, "
            "so the hub never registered the socket"
        )
    start_id = str(uuid.uuid4())
    start = make_event(session_id, flavor, "session_start", id=start_id, **fields)
    await asyncio.to_thread(post_event, start)
    await await_update(
        ws,
        session_id,
        lambda u: (
            u["type"] == "session_start"
            and (u.get("last_event") or {}).get("id") == start_id
        ),
        START_BROADCAST_WAIT_SECS,
        expected=f"session_start broadcast carrying event {start_id}",
    )
