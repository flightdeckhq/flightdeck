"""The agent_handoff signal the sensor's framework wraps emit.

The Google ADK and OpenAI Agents SDK wraps report a hand-off through
``Session.emit_agent_handoff``. Until they land this script calls it
directly, as a wrap does, against the dev stack:

1. a hand-off on the sensor's own session (``triage_agent`` hands off to
   ``weather_agent``);
2. a child session opened as the framework wraps open one, then a
   hand-off on that child (``weather_agent`` hands off to
   ``billing_agent``), then the child's end.

Both must land as ``session_signal`` events with ``signal=agent_handoff``
and ``signal_data`` ``{from, to}``, no model and no content, and the
content endpoint must answer 404 for them although capture is on: the
agent names are metadata, and nothing handed over is captured. The
child's signal must carry the child's session id and its parent's.

Needs only the dev stack (no provider key). Prints the session ids, so
the run can be found on the dashboard and deleted by id.
"""

from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.request
import uuid
from typing import Any

from _helpers import (
    API_TOKEN,
    API_URL,
    fetch_events_for_session,
    init_sensor,
    print_result,
    wait_for_dev_stack,
)

import flightdeck_sensor
from flightdeck_sensor.core.session import SIGNAL_AGENT_HANDOFF

FLAVOR = "playground-agent-handoff"
CHILD_ROLE = "weather_agent"
# Time for the events to land: the hand-offs post synchronously, and the
# worker writes within a second or two on an idle stack.
EVENT_LANDED_S = 15.0
# One content fetch never blocks longer than this; a healthy API answers
# in milliseconds.
CONTENT_FETCH_TIMEOUT_S = 5.0
# What GET /v1/events/:id/content answers for an event with no stored
# content (rule 37): the resource does not exist.
CONTENT_ABSENT_STATUS = 404
# How much of the fetched events a failure message quotes: enough to see
# every event of this short run, short enough to read in a terminal.
FAILURE_DUMP_CHARS = 2000
MS_PER_S = 1000
SESSION_SIGNAL = "session_signal"


def _signals(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [e for e in events if e.get("event_type") == SESSION_SIGNAL]


def _content_status(event_id: str) -> int:
    req = urllib.request.Request(
        f"{API_URL}/v1/events/{event_id}/content",
        headers={"Authorization": f"Bearer {API_TOKEN}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=CONTENT_FETCH_TIMEOUT_S) as r:
            return int(r.status)
    except urllib.error.HTTPError as err:
        return int(err.code)


def _check(
    label: str,
    session_id: str,
    want_data: dict[str, str],
    want_parent: str | None,
    t0: float,
) -> None:
    events = fetch_events_for_session(
        session_id,
        timeout_s=EVENT_LANDED_S,
        expect_event_types=[SESSION_SIGNAL],
    )
    signals = _signals(events)
    if len(signals) != 1:
        raise AssertionError(
            f"{label}: want one {SESSION_SIGNAL}, got {json.dumps(events)[:FAILURE_DUMP_CHARS]}"
        )
    e = signals[0]
    payload = e.get("payload") or {}
    status = _content_status(e["id"])
    problems = []
    if payload.get("signal") != SIGNAL_AGENT_HANDOFF:
        problems.append(f"signal={payload.get('signal')!r}")
    if payload.get("signal_data") != want_data:
        problems.append(f"signal_data={payload.get('signal_data')!r}")
    if e.get("model") is not None:
        problems.append(f"model={e.get('model')!r}")
    if e.get("has_content"):
        problems.append("has_content=true")
    if status != CONTENT_ABSENT_STATUS:
        problems.append(f"content endpoint answered {status}")
    if want_parent is not None and payload.get("parent_session_id") != want_parent:
        problems.append(f"parent_session_id={payload.get('parent_session_id')!r}")
    print_result(
        label,
        not problems,
        int((time.monotonic() - t0) * MS_PER_S),
        f"event={e['id']} signal_data={payload.get('signal_data')} content={status}",
    )
    if problems:
        raise AssertionError(f"{label}: {', '.join(problems)}; payload={payload}")


def main() -> None:
    wait_for_dev_stack()
    root_id = str(uuid.uuid4())
    child_id = str(uuid.uuid4())
    print(f"[playground:37_agent_handoff] root session_id={root_id}")
    print(f"[playground:37_agent_handoff] child session_id={child_id}")
    t0 = time.monotonic()

    init_sensor(root_id, flavor=FLAVOR)
    session = flightdeck_sensor._session
    assert session is not None
    session.emit_agent_handoff(from_agent="triage_agent", to_agent=CHILD_ROLE)

    child = {
        "child_session_id": child_id,
        "child_agent_id": session.derive_subagent_id(CHILD_ROLE),
        "child_agent_name": f"{session.config.agent_name}/{CHILD_ROLE}",
        "agent_role": CHILD_ROLE,
    }
    session.emit_subagent_session_start(**child)
    session.emit_agent_handoff(from_agent=CHILD_ROLE, to_agent="billing_agent", **child)
    session.emit_subagent_session_end(**child)
    flightdeck_sensor.teardown()

    _check(
        "hand-off on the sensor's session",
        root_id,
        {"from": "triage_agent", "to": CHILD_ROLE},
        None,
        t0,
    )
    _check(
        "hand-off on a child session",
        child_id,
        {"from": CHILD_ROLE, "to": "billing_agent"},
        root_id,
        t0,
    )


if __name__ == "__main__":
    try:
        main()
    except AssertionError as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        sys.exit(1)
