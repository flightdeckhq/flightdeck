"""The sensor's agent_handoff signal lands as the OTLP receiver's does.

The real sensor (``flightdeck_sensor.init``) reports a hand-off through
``Session.emit_agent_handoff``, the call the framework wraps make, on its
own session and on a child session. The OpenAI Agents hand-off recording
(``tests/fixtures/otlp``) is replayed into the OTLP receiver beside it.
Both run with capture on. The test reads the stored ``events`` rows and
requires them to match column for column, ``payload`` included, apart
from the ids, the flavor and the time, and requires that no hand-off
wrote ``event_content``: the worker and the dashboard see one shape whichever
source reported the hand-off.
"""

from __future__ import annotations

import contextlib
import json
import os
import uuid
from typing import TYPE_CHECKING, Any

import pytest

import flightdeck_sensor

from .conftest import (
    INGESTION_URL,
    TOKEN,
    delete_flavor_data,
    exec_sql,
    wait_until,
)
from .test_otlp_genai import OA, SCENARIOS, Replay, delete_replay, wait_assembled

if TYPE_CHECKING:
    from collections.abc import Iterator

# The columns two hand-offs differ in whoever reported them.
PER_EVENT = ("id", "session_id", "flavor", "occurred_at")
# Time for the sensor's synchronous posts to be written by the worker.
STORED_TIMEOUT_SECS = 15.0


def _rows(sql: str, **bindings: Any) -> list[dict[str, Any]]:
    out = exec_sql(f"SELECT coalesce(json_agg(r), '[]'::json) FROM ({sql}) r", **bindings)
    return json.loads(out or "[]")  # type: ignore[no-any-return]


def _signals(flavor: str) -> list[dict[str, Any]]:
    return _rows(
        "SELECT e.* FROM events e WHERE e.flavor = :'flavor'"
        " AND e.event_type = 'session_signal' ORDER BY e.occurred_at",
        flavor=flavor,
    )


def _content_rows(event_ids: list[str]) -> int:
    return int(
        exec_sql(
            "SELECT count(*) FROM event_content"
            " WHERE event_id = ANY(string_to_array(:'ids', ',')::uuid[])",
            ids=",".join(event_ids),
        )
    )


def _shape(row: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in row.items() if k not in PER_EVENT}


@pytest.fixture
def sensor_flavor() -> Iterator[str]:
    flavor = f"test-sensor-handoff-{uuid.uuid4().hex[:10]}"
    os.environ["AGENT_FLAVOR"] = flavor
    try:
        yield flavor
    finally:
        os.environ.pop("AGENT_FLAVOR", None)
        with contextlib.suppress(Exception):
            flightdeck_sensor.teardown()
        delete_flavor_data(flavor)


@pytest.fixture
def otlp_handoff() -> Iterator[Replay]:
    replay = Replay(
        OA, "handoff-protobuf", f"test-otlp-handoff-{uuid.uuid4().hex[:10]}", capture=True
    )
    try:
        yield replay
    finally:
        delete_replay(replay.flavor, replay.trace_ids())


def test_sensor_handoff_is_stored_as_the_receivers(
    sensor_flavor: str, otlp_handoff: Replay
) -> None:
    otlp_handoff.send()

    root_id = str(uuid.uuid4())
    child_id = str(uuid.uuid4())
    flightdeck_sensor.init(
        server=INGESTION_URL,
        token=TOKEN,
        session_id=root_id,
        agent_type="coding",
        capture_prompts=True,
        quiet=True,
    )
    session = flightdeck_sensor._session
    assert session is not None
    session.emit_agent_handoff(from_agent="triage_agent", to_agent="weather_agent")
    child = {
        "child_session_id": child_id,
        "child_agent_id": session.derive_subagent_id("weather_agent"),
        "child_agent_name": f"{session.config.agent_name}/weather_agent",
        "agent_role": "weather_agent",
    }
    session.emit_subagent_session_start(**child)
    session.emit_agent_handoff(from_agent="weather_agent", to_agent="billing_agent", **child)
    session.emit_subagent_session_end(**child)
    flightdeck_sensor.teardown()

    wait_assembled(otlp_handoff.flavor, SCENARIOS[(OA, "handoff-protobuf")])
    (otlp,) = _signals(otlp_handoff.flavor)
    wait_until(
        lambda: len(_signals(sensor_flavor)) == 2,
        timeout=STORED_TIMEOUT_SECS,
        msg=f"{sensor_flavor}: two hand-off signals stored",
    )
    by_session = {r["session_id"]: r for r in _signals(sensor_flavor)}
    root, on_child = by_session[root_id], by_session[child_id]

    # The receiver's hand-off, column for column.
    assert otlp["payload"] == {
        "signal": "agent_handoff",
        "signal_data": {"from": "triage_agent", "to": "weather_agent"},
    }
    assert _shape(root) == _shape(otlp)

    # On a child, the same row with the child's linkage, as every event
    # of a child session carries it.
    assert on_child["payload"] == {
        "signal": "agent_handoff",
        "signal_data": {"from": "weather_agent", "to": "billing_agent"},
        "parent_session_id": root_id,
        "agent_role": "weather_agent",
    }
    assert {k: v for k, v in _shape(on_child).items() if k != "payload"} == {
        k: v for k, v in _shape(otlp).items() if k != "payload"
    }

    # Capture is on for both (the replay's model calls store theirs), and
    # no hand-off stored any content.
    assert root["has_content"] is False and on_child["has_content"] is False
    assert _content_rows([otlp["id"], root["id"], on_child["id"]]) == 0
