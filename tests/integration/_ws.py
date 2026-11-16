"""Helpers for the integration tests that read the /api/v1/stream WebSocket.

The stream broadcasts everything the stack ingests, so a test reads it
for its own session only. A test opens the socket before it starts its
run, and reads the run's own session_start broadcast off it
(``start_run``) before it does what it is there to check. That broadcast
proves two things. The hub has registered the socket, so nothing the
test does afterwards can be broadcast before the socket is listening.
And the start is stored, so it can never be taken for a later update.
Waiting for the session row instead proves neither: the worker commits
the row before it stores the start event and announces it, and the API
answers the upgrade before the hub registers the socket.
"""

from __future__ import annotations

import asyncio
import json
from typing import TYPE_CHECKING, Any

import pytest

from .conftest import BASE_URL, TOKEN, make_event, post_event
from .test_session_states import PROCESSING_SLACK_SECS

if TYPE_CHECKING:
    from collections.abc import Callable

    from websockets.asyncio.client import ClientConnection

WS_URL = f"{BASE_URL.replace('http', 'ws', 1)}/api/v1/stream?token={TOKEN}"

# How long a run's own session_start may take to reach the stream: the
# worker's processing of it, then as long again for the hub, which
# broadcasts in turn and may still be working through what the tests
# before this one sent. The wait ends as soon as the broadcast arrives.
START_BROADCAST_WAIT_SECS = 2 * PROCESSING_SLACK_SECS

Update = dict[str, Any]


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


def _is_start(update: Update) -> bool:
    return update["type"] == "session_start"


async def start_run(
    ws: ClientConnection, session_id: str, flavor: str, **fields: Any
) -> None:
    """Post the run's session_start and read ``ws`` until the start's own
    broadcast has arrived.

    ``ws`` must be open before the start is posted, so the broadcast
    cannot slip past it. Once it has arrived the hub has registered the
    socket, and the start is stored: the worker announces it only after
    storing the event, and the hub fetches that event to send it. The hub
    broadcasts in the order changes are announced, so everything the test
    reads for the session from here on is a later change.
    """
    post_event(make_event(session_id, flavor, "session_start", **fields))
    await await_update(
        ws,
        session_id,
        _is_start,
        START_BROADCAST_WAIT_SECS,
        expected="session_start broadcast",
    )
