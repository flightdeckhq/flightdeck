"""OpenTelemetry GenAI framework exports through the live pipeline.

Every recorded agent-framework scenario (Pydantic AI, Strands Agents, the
OpenAI Agents SDK and Google ADK, ``tests/fixtures/otlp``) is replayed
into the ingestion API's OTLP receiver in the order it was recorded. Its
records are rewritten for the replay: moved to the moment of the replay,
under trace ids of their own, with a flavor of its own and
``flightdeck.agent_type=coding`` on the resource, as an operator sets
them with ``OTEL_RESOURCE_ATTRIBUTES``. The receiver stages them; the
assembler, once a trace is complete, publishes its sessions and events
through the receiver's own path, and the workers store them. The test
then reads what was stored: the sessions, their parents and roles, each
call's tokens, the tools and hand-off signals, the sessions' times (the
agent spans'), and that nothing of their content was stored with
capture off.

Two scenarios are also replayed in steps: the OpenAI Agents subagent
run, whose first export holds none of its agent spans (it is staged and
waits for its root), and a Google ADK run whose last log record arrives
after its root (the assembler waits for it rather than assembling the
trace without it).

Replayed with ``flightdeck.capture_prompts=true`` on the resource, the
runs' content is staged while their traces wait and reaches
``event_content`` once assembled, served by ``GET
/v1/events/{id}/content``: each call's messages, each tool's arguments
and result, a child agent's messages. With capture off nothing is
staged, nothing reaches ``event_content`` and the endpoint answers 404.
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
import uuid
from collections import Counter
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest

from ..otlp.fixture_checks import _fields
from ..otlp.replay import (
    genai_agent_spans,
    genai_record_times,
    genai_trace_ids,
    rewrite_genai,
)
from .conftest import (
    API_URL,
    DB_TIMESTAMP_RESOLUTION_US,
    INGESTION_URL,
    auth_headers,
    exec_sql,
    query_rows,
    wait_until,
)

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "otlp"
JSON = "application/json"
PROTOBUF = "application/x-protobuf"

# How long a replayed trace may take to be stored: the assembler takes a
# trace RootGrace (3 s) after its latest record and claims once a second,
# and the worker drains the bus in well under a second on an idle stack;
# the ceiling absorbs a loaded CI runner running the suite in parallel.
ASSEMBLE_TIMEOUT_SECS = 60.0

# How far before the moment of the replay its last record is dated:
# every record must be in the past when it is validated.
REPLAY_LEAD_NS = 1_000_000_000

# How close a session's started_at and ended_at must be to its agent
# span's start and end: Postgres stores microseconds, and rounds the
# nanosecond timestamps it is sent; SQLite stores milliseconds, cutting
# the rest off.
TIME_TOLERANCE_US = max(2, DB_TIMESTAMP_RESOLUTION_US)
# The origin stored timestamps are counted from, and the unit they are
# counted in.
EPOCH = datetime(1970, 1, 1, tzinfo=UTC)
US_PER_SECOND = 1_000_000


@dataclass
class Want:
    """What one scenario's sessions hold, by agent name below the flavor:
    a root agent's own name, a child's as ``root/role``."""

    sessions: dict[str, tuple[str | None, int]]  # name -> (parent name, how many)
    calls: dict[str, list[tuple[int, int]]] = field(default_factory=dict)
    tools: dict[str, list[str]] = field(default_factory=dict)
    llm_errors: dict[str, int] = field(default_factory=dict)
    signals: dict[str, int] = field(default_factory=dict)


def _one(name: str, calls: list[tuple[int, int]], tools: list[str]) -> Want:
    return Want(sessions={name: (None, 1)}, calls={name: calls}, tools={name: tools})


def _sub(parent_calls, parent_tools, child_calls, child_tools) -> Want:  # type: ignore[no-untyped-def]
    child = "assistant/weather_agent"
    return Want(
        sessions={"assistant": (None, 1), child: ("assistant", 1)},
        calls={"assistant": parent_calls, child: child_calls},
        tools={"assistant": parent_tools, child: child_tools},
    )


def _cache(calls: list[tuple[int, int]]) -> Want:
    return Want(sessions={"cached_agent": (None, 2)}, calls={"cached_agent": calls})


MODEL_ERROR = Want(
    sessions={"missing_model_agent": (None, 1)}, llm_errors={"missing_model_agent": 1}
)

PY, ST, OA, ADK = (
    "pydantic-ai-2.64.0",
    "strands-agents-1.63.0",
    "openai-agents-0.24.0",
    "google-adk-2.13.0",
)

# The expected values are the recorded spans' own (GENAI_COMPARISON.md),
# the ones the normalizer's fixture tests pin.
SCENARIOS: dict[tuple[str, str], Want] = {
    (PY, "tool-protobuf"): _one(
        "weather_agent", [(658, 54), (732, 18)], ["get_weather"]
    ),
    (PY, "tool-json"): _one("weather_agent", [(658, 54), (732, 18)], ["get_weather"]),
    (PY, "tool-no-content-protobuf"): _one(
        "weather_agent", [(658, 54), (732, 18)], ["get_weather"]
    ),
    (PY, "tool-error-protobuf"): _one("orders_agent", [(662, 56)], ["lookup_order"]),
    (PY, "subagent-protobuf"): _sub(
        [(666, 62), (764, 18)],
        ["ask_weather_agent"],
        [(647, 54), (721, 27)],
        ["get_weather"],
    ),
    (PY, "cache-no-content-protobuf"): _cache([(6682, 4), (6682, 5)]),
    (PY, "model-error-protobuf"): MODEL_ERROR,
    (PY, "model-error-json"): MODEL_ERROR,
    (ST, "tool-protobuf"): _one(
        "weather_agent", [(78, 14), (107, 15)], ["get_weather"]
    ),
    (ST, "tool-latest-json"): _one(
        "weather_agent", [(78, 14), (107, 15)], ["get_weather"]
    ),
    (ST, "tool-redacted-protobuf"): _one(
        "weather_agent", [(78, 14), (107, 15)], ["get_weather"]
    ),
    (ST, "tool-error-protobuf"): _one(
        "orders_agent", [(76, 15), (106, 8)], ["lookup_order"]
    ),
    (ST, "subagent-protobuf"): _sub(
        [(86, 22), (133, 17)],
        ["ask_weather_agent"],
        [(68, 14), (97, 17)],
        ["get_weather"],
    ),
    (ST, "cache-protobuf"): _cache([(1933, 3), (1933, 3)]),
    (ST, "model-error-protobuf"): MODEL_ERROR,
    (ST, "model-error-json"): MODEL_ERROR,
    (OA, "tool-protobuf"): _one(
        "weather_agent", [(77, 15), (107, 16)], ["get_weather"]
    ),
    (OA, "tool-json"): _one("weather_agent", [(77, 15), (107, 16)], ["get_weather"]),
    (OA, "tool-no-content-protobuf"): _one(
        "weather_agent", [(77, 15), (107, 16)], ["get_weather"]
    ),
    (OA, "tool-error-protobuf"): _one(
        "orders_agent", [(78, 16), (114, 26)], ["lookup_order"]
    ),
    (OA, "subagent-protobuf"): _sub(
        [(93, 22), (138, 16)],
        ["ask_weather_agent"],
        [(66, 15), (96, 16)],
        ["get_weather"],
    ),
    (OA, "handoff-protobuf"): Want(
        sessions={"triage_agent": (None, 1), "weather_agent": (None, 1)},
        calls={"triage_agent": [(69, 13)], "weather_agent": [(102, 15), (132, 16)]},
        tools={"weather_agent": ["get_weather"]},
        signals={"triage_agent": 1},
    ),
    (OA, "cache-no-content-protobuf"): _cache([(1921, 3), (1921, 3)]),
    (OA, "model-error-protobuf"): MODEL_ERROR,
    (OA, "model-error-json"): MODEL_ERROR,
    (ADK, "tool-protobuf"): _one(
        "weather_agent", [(103, 14), (137, 15)], ["get_weather"]
    ),
    (ADK, "tool-no-content-protobuf"): _one(
        "weather_agent", [(103, 14), (137, 15)], ["get_weather"]
    ),
    (ADK, "tool-error-protobuf"): _one("orders_agent", [(93, 15)], ["lookup_order"]),
    (ADK, "subagent-protobuf"): _sub(
        [(79, 17), (124, 16)], ["weather_agent"], [(89, 14), (123, 16)], ["get_weather"]
    ),
    (ADK, "handoff-protobuf"): Want(
        sessions={"triage_agent": (None, 1), "weather_agent": (None, 1)},
        calls={"triage_agent": [(244, 17)], "weather_agent": [(553, 14), (587, 16)]},
        tools={"triage_agent": ["transfer_to_agent"], "weather_agent": ["get_weather"]},
        signals={"triage_agent": 1},
    ),
    (ADK, "cache-no-content-protobuf"): _cache([(1934, 2), (1934, 2)]),
    (ADK, "model-error-protobuf"): MODEL_ERROR,
}


def test_every_recorded_genai_scenario_has_a_want() -> None:
    recorded = {
        (fw.name, sc.name)
        for fw in FIXTURES.iterdir()
        if fw.is_dir() and fw.name in (PY, ST, OA, ADK)
        for sc in fw.iterdir()
        if sc.is_dir()
    }
    assert recorded == set(SCENARIOS), recorded ^ set(SCENARIOS)


# ---------------------------------------------------------------------------
# Replay


class Replay:
    """One recorded scenario rewritten for a replay of its own."""

    def __init__(
        self, framework: str, scenario: str, flavor: str, capture: bool = False
    ) -> None:
        self.dir = FIXTURES / framework / scenario
        manifest = json.loads((self.dir / "manifest.json").read_text())
        self.requests: list[dict[str, Any]] = manifest["requests"]
        self.flavor = flavor
        self.capture = capture
        resource_attrs = {
            "flightdeck.flavor": flavor,
            "flightdeck.agent_type": "coding",
        }
        if capture:
            resource_attrs["flightdeck.capture_prompts"] = "true"
        raw = [(r, (self.dir / r["file"]).read_bytes()) for r in self.requests]
        latest = max(
            (
                t
                for r, body in raw
                for t in genai_record_times(r["path"], r["content_type"], body)
            ),
            default=0,
        )
        now_ns = time.time_ns()
        self.shift_ns = now_ns - REPLAY_LEAD_NS - latest
        self.trace_key = os.urandom(16)
        self.bodies = [
            rewrite_genai(
                r["path"],
                r["content_type"],
                body,
                trace_key=self.trace_key,
                shift_ns=self.shift_ns,
                resource_attrs=resource_attrs,
            )
            for r, body in raw
        ]

    def agent_spans(self) -> list[dict[str, Any]]:
        return [
            span
            for r, body in zip(self.requests, self.bodies, strict=True)
            if r["path"] == "/v1/traces"
            for span in genai_agent_spans(r["content_type"], body)
        ]

    def trace_ids(self) -> set[str]:
        return {
            tid
            for r, body in zip(self.requests, self.bodies, strict=True)
            if r["path"] != "/v1/metrics"
            for tid in genai_trace_ids(r["path"], r["content_type"], body)
        }

    def send(self, first: int = 0, last: int | None = None) -> None:
        """Post requests [first, last) in recorded order and check each
        answer: spans and log records all used, metrics all rejected."""
        for r, body in list(zip(self.requests, self.bodies, strict=True))[first:last]:
            status, rejected, message = post(r["path"], r["content_type"], body)
            assert status == 200, (r["file"], status, message)
            if r["path"] == "/v1/metrics":
                assert rejected > 0 and "metrics repeat span usage" in message, (
                    r["file"],
                    rejected,
                    message,
                )
            else:
                assert rejected == 0, (r["file"], rejected, message)


def post(path: str, content_type: str, body: bytes) -> tuple[int, int, str]:
    """POST one export; returns the status and the partial_success's
    rejected count and message."""
    req = urllib.request.Request(
        f"{INGESTION_URL}{path}",
        data=body,
        method="POST",
        headers={**auth_headers(), "Content-Type": content_type},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            status, raw = resp.status, resp.read()
    except urllib.error.HTTPError as err:
        return err.code, 0, err.read().decode(errors="replace")
    if content_type == JSON:
        partial = json.loads(raw or b"{}").get("partialSuccess", {})
        rejected = next(
            (int(v) for k, v in partial.items() if k.startswith("rejected")), 0
        )
        return status, rejected, partial.get("errorMessage", "")
    rejected, message = 0, ""
    for number, wire, value in _fields(raw):
        if number == 1 and wire == 2:
            for n, w, v in _fields(value):
                if n == 1 and w == 0:
                    rejected = v
                elif n == 2 and w == 2:
                    message = bytes(v).decode()
    return status, rejected, message


# ---------------------------------------------------------------------------
# Reading what was stored


def _epoch_us(stamp: str | None) -> int | None:
    """A stored timestamp as whole microseconds since the epoch."""
    if stamp is None:
        return None
    return (datetime.fromisoformat(stamp) - EPOCH) // timedelta(microseconds=1)


def stored_sessions(flavor: str) -> list[dict[str, Any]]:
    """The flavor's session rows, with their start and end also as
    microseconds since the epoch (``started_us``, ``ended_us``)."""
    rows = query_rows(
        "SELECT session_id, agent_name, agent_role, parent_session_id, state, client_type,"
        " framework, capture_prompts, context, started_at, ended_at"
        " FROM sessions WHERE flavor = :'flavor'",
        flavor=flavor,
    )
    for row in rows:
        row["started_us"] = _epoch_us(row["started_at"])
        row["ended_us"] = _epoch_us(row["ended_at"])
    return rows


def stored_events(flavor: str) -> list[dict[str, Any]]:
    return query_rows(
        "SELECT session_id, event_type, tokens_input, tokens_output, tool_name"
        " FROM events WHERE flavor = :'flavor' ORDER BY occurred_at, id",
        flavor=flavor,
    )


def content_rows(session_ids: list[str]) -> int:
    if not session_ids:
        return 0
    return int(
        exec_sql(
            "SELECT count(*) FROM event_content WHERE session_id = ANY(string_to_array(:'ids', ',')::uuid[])",
            sqlite="SELECT count(*) FROM event_content WHERE instr(:ids, session_id) > 0",
            ids=",".join(session_ids),
        )
    )


def stored_event_rows(flavor: str) -> list[dict[str, Any]]:
    return query_rows(
        "SELECT e.id, e.session_id, e.event_type, e.has_content, e.payload,"
        " s.parent_session_id"
        " FROM events e JOIN sessions s USING (session_id)"
        " WHERE e.flavor = :'flavor' ORDER BY e.occurred_at, e.id",
        flavor=flavor,
    )


def staged_rows(trace_hex: str) -> tuple[int, int]:
    """How many records and content rows a trace has staged."""
    out = exec_sql(
        "SELECT (SELECT count(*) FROM otlp_spans WHERE trace_id = decode(:'tid', 'hex'))"
        " || ',' || (SELECT count(*) FROM otlp_span_content WHERE trace_id = decode(:'tid', 'hex'))",
        sqlite=(
            "SELECT (SELECT count(*) FROM otlp_spans WHERE trace_id = unhex(:tid))"
            " || ',' || (SELECT count(*) FROM otlp_span_content WHERE trace_id = unhex(:tid))"
        ),
        tid=trace_hex,
    )
    spans, content = out.strip().split(",")
    return int(spans), int(content)


def fetch_content(event_id: str) -> tuple[int, dict[str, Any] | None]:
    """GET /v1/events/{id}/content: the status and the body on a 200."""
    req = urllib.request.Request(
        f"{API_URL}/v1/events/{event_id}/content", headers=auth_headers()
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as err:
        return err.code, None


def staged_trace(trace_hex: str) -> dict[str, Any] | None:
    """The staging row of a trace: whether its root was seen
    (``root_seen``), and how long from the database's clock
    (``due_in_secs``) and from the root's arrival
    (``due_after_root_secs``) its assembly is due."""
    rows = query_rows(
        "SELECT root_seen_at, resolve_at, now() AS db_now, pending, assembly_count,"
        " assembly_reason FROM otlp_traces WHERE trace_id = decode(:'tid', 'hex')",
        sqlite=(
            "SELECT root_seen_at, resolve_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS db_now,"
            " pending, assembly_count, assembly_reason"
            " FROM otlp_traces WHERE trace_id = unhex(:tid)"
        ),
        tid=trace_hex,
    )
    if not rows:
        return None
    row = rows[0]
    resolve_us = _epoch_us(row["resolve_at"])
    root_us = _epoch_us(row["root_seen_at"])
    assert resolve_us is not None, row
    now_us = _epoch_us(row["db_now"])
    assert now_us is not None, row
    row["root_seen"] = root_us is not None
    row["due_in_secs"] = (resolve_us - now_us) / US_PER_SECOND
    row["due_after_root_secs"] = (
        None if root_us is None else (resolve_us - root_us) / US_PER_SECOND
    )
    return row


def wait_assembled(
    flavor: str, want: Want
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Poll until every session the scenario wants is stored, closed, with
    its calls, tools, errors and signals, and return the rows."""
    n_sessions = sum(count for _, count in want.sessions.values())
    n_events = Counter(
        {
            "post_call": sum(len(c) for c in want.calls.values()),
            "tool_call": sum(len(t) for t in want.tools.values()),
            "llm_error": sum(want.llm_errors.values()),
            "session_signal": sum(want.signals.values()),
            "session_start": n_sessions,
            "session_end": n_sessions,
        }
    )
    seen: dict[str, Any] = {}

    def ready() -> bool:
        sessions = stored_sessions(flavor)
        events = stored_events(flavor)
        seen["sessions"], seen["events"] = sessions, events
        got = Counter(e["event_type"] for e in events)
        return (
            len(sessions) == n_sessions
            and all(s["ended_us"] for s in sessions)
            and all(got[t] >= n for t, n in n_events.items())
        )

    try:
        wait_until(
            ready,
            timeout=ASSEMBLE_TIMEOUT_SECS,
            interval=0.5,
            msg=f"{flavor} assembled",
        )
    except TimeoutError:
        got = Counter(e["event_type"] for e in seen.get("events", []))
        raise AssertionError(
            f"{flavor}: {len(seen.get('sessions', []))} of {n_sessions} sessions,"
            f" events {dict(got)} of {dict(n_events)}"
        ) from None
    return seen["sessions"], seen["events"]


# ---------------------------------------------------------------------------
# Cleanup, by the ids this test created


def delete_replay(flavor: str, trace_ids: set[str]) -> None:
    ids = [s["session_id"] for s in stored_sessions(flavor)]
    if ids:
        joined = ",".join(ids)
        # Each statement with its SQLite spelling. The last removes the
        # sessions and the agents they leave without one: SQLite has no
        # data-modifying CTE, so there the agents whose every session is
        # listed go first, in a transaction that checks its foreign keys
        # at commit, and the sessions after them.
        for sql, sqlite in (
            (
                "DELETE FROM event_content WHERE session_id = ANY(string_to_array(:'ids', ',')::uuid[])",
                "DELETE FROM event_content WHERE instr(:ids, session_id) > 0",
            ),
            (
                "DELETE FROM events WHERE session_id = ANY(string_to_array(:'ids', ',')::uuid[])",
                "DELETE FROM events WHERE instr(:ids, session_id) > 0",
            ),
            (
                (
                    "WITH gone AS (DELETE FROM sessions WHERE session_id = ANY(string_to_array(:'ids', ',')::uuid[])"
                    " RETURNING agent_id) DELETE FROM agents a USING (SELECT DISTINCT agent_id FROM gone) g"
                    " WHERE a.agent_id = g.agent_id AND NOT EXISTS (SELECT 1 FROM sessions o WHERE o.agent_id = a.agent_id)"
                ),
                (
                    "PRAGMA defer_foreign_keys = ON",
                    (
                        "DELETE FROM agents WHERE agent_id IN"
                        " (SELECT agent_id FROM sessions WHERE instr(:ids, session_id) > 0)"
                        " AND NOT EXISTS (SELECT 1 FROM sessions o WHERE o.agent_id = agents.agent_id"
                        " AND instr(:ids, o.session_id) = 0)"
                    ),
                    "DELETE FROM sessions WHERE instr(:ids, session_id) > 0",
                ),
            ),
        ):
            exec_sql(sql, sqlite=sqlite, ids=joined)
    for tid in trace_ids:
        exec_sql(
            "DELETE FROM otlp_traces WHERE trace_id = decode(:'tid', 'hex')",
            sqlite="DELETE FROM otlp_traces WHERE trace_id = unhex(:tid)",
            tid=tid,
        )


@pytest.fixture
def replay_factory() -> Iterator[Any]:
    made: list[Replay] = []

    def make(framework: str, scenario: str, capture: bool = False) -> Replay:
        flavor = f"test-otlp-genai-{uuid.uuid4().hex[:10]}"
        replay = Replay(framework, scenario, flavor, capture)
        made.append(replay)
        return replay

    yield make
    for replay in made:
        delete_replay(replay.flavor, replay.trace_ids())


# ---------------------------------------------------------------------------
# The checks


def check_stored(
    replay: Replay,
    want: Want,
    sessions: list[dict[str, Any]],
    events: list[dict[str, Any]],
) -> None:
    prefix = replay.flavor + "/"
    by_id = {s["session_id"]: s for s in sessions}
    names = Counter(s["agent_name"].removeprefix(prefix) for s in sessions)
    assert names == Counter({n: c for n, (_, c) in want.sessions.items()}), names
    for s in sessions:
        name = s["agent_name"].removeprefix(prefix)
        parent_name, _ = want.sessions[name]
        assert s["client_type"] == "otlp", s
        assert s["capture_prompts"] is replay.capture, s
        ctx = s["context"] or {}
        assert (
            ctx.get("telemetry") == "otlp" and ctx.get("supports_directives") is False
        ), ctx
        assert ctx.get("otel_trace_id") in replay.trace_ids(), ctx
        assert ctx.get("otel_assembly") == "complete", ctx
        if parent_name is None:
            assert s["parent_session_id"] is None and s["agent_role"] is None, s
        else:
            parent = by_id[s["parent_session_id"]]
            assert parent["agent_name"] == prefix + parent_name, (s, parent)
            assert s["agent_role"] == name.rsplit("/", 1)[1], s

    def per_name(event_type: str, value: Any) -> dict[str, list[Any]]:
        out: dict[str, list[Any]] = {}
        for e in events:
            if e["event_type"] == event_type:
                name = by_id[e["session_id"]]["agent_name"].removeprefix(prefix)
                out.setdefault(name, []).append(value(e))
        return {k: sorted(v) for k, v in out.items()}

    want_calls = {k: sorted(v) for k, v in want.calls.items() if v}
    assert (
        per_name("post_call", lambda e: (e["tokens_input"], e["tokens_output"]))
        == want_calls
    )
    assert per_name("tool_call", lambda e: e["tool_name"]) == {
        k: sorted(v) for k, v in want.tools.items()
    }
    assert {
        k: len(v) for k, v in per_name("llm_error", lambda e: 1).items()
    } == want.llm_errors
    assert {
        k: len(v) for k, v in per_name("session_signal", lambda e: 1).items()
    } == want.signals

    # Each session spans its agent span: the run's own times, not the
    # moment it was assembled.
    for span in replay.agent_spans():
        match = [
            s
            for s in sessions
            if (s["context"] or {}).get("otel_span_id")
            and s["context"].get("otel_trace_id") == span["trace"]
            and s["agent_name"].endswith("/" + span["agent"])
        ]
        assert len(match) == 1, (span, [s["agent_name"] for s in sessions])
        s = match[0]
        assert abs(s["started_us"] - span["start"] // 1000) <= TIME_TOLERANCE_US, (
            s["started_us"],
            span,
        )
        assert abs(s["ended_us"] - span["end"] // 1000) <= TIME_TOLERANCE_US, (
            s["ended_us"],
            span,
        )

    if not replay.capture:
        # Capture is off: no content of any event was stored.
        assert content_rows(list(by_id)) == 0


@pytest.mark.parametrize(
    ("framework", "scenario"),
    list(SCENARIOS),
    ids=[f"{fw}/{sc}" for fw, sc in SCENARIOS],
)
def test_recorded_genai_scenario_is_assembled(
    framework: str, scenario: str, replay_factory: Any
) -> None:
    want = SCENARIOS[(framework, scenario)]
    replay = replay_factory(framework, scenario)
    replay.send()
    sessions, events = wait_assembled(replay.flavor, want)
    check_stored(replay, want, sessions, events)


def test_split_export_waits_for_its_root(replay_factory: Any) -> None:
    """The OpenAI Agents subagent run arrived in two exports, the root and
    both agent spans in the second. The first is staged and waits, with
    nothing published; the second completes the trace."""
    replay = replay_factory(OA, "subagent-protobuf")
    files = [r["file"] for r in replay.requests]
    split = files.index("002-traces.pb")
    replay.send(0, split)
    (trace,) = replay.trace_ids()
    staged = staged_trace(trace)
    assert staged is not None and not staged["root_seen"] and staged["pending"], staged
    # Without its root the trace is due only after the quiet timeout.
    assert staged["due_in_secs"] > 25 * 60, staged
    assert stored_sessions(replay.flavor) == []

    replay.send(split)
    want = SCENARIOS[(OA, "subagent-protobuf")]
    sessions, events = wait_assembled(replay.flavor, want)
    check_stored(replay, want, sessions, events)


def test_adk_log_record_after_the_root_is_waited_for(replay_factory: Any) -> None:
    """A Google ADK run whose last log record arrives after its root: the
    assembler finds the trace incomplete and waits for the record, up to
    30 seconds after the root, then assembles it complete once it comes."""
    replay = replay_factory(ADK, "tool-protobuf")
    files = [r["file"] for r in replay.requests]
    traces_at = files.index("002-traces.pb")
    replay.send(0, traces_at + 1)
    (trace,) = replay.trace_ids()

    def deferred() -> bool:
        staged = staged_trace(trace)
        return bool(
            staged
            and staged["root_seen"]
            and abs(staged["due_after_root_secs"] - 30) < 0.5
        )

    wait_until(
        deferred,
        timeout=ASSEMBLE_TIMEOUT_SECS,
        interval=0.25,
        msg="the assembler deferring the ADK trace for its log record",
    )
    assert stored_sessions(replay.flavor) == []

    replay.send(traces_at + 1)
    want = SCENARIOS[(ADK, "tool-protobuf")]
    sessions, events = wait_assembled(replay.flavor, want)
    check_stored(replay, want, sessions, events)
    staged = staged_trace(trace)
    assert staged is not None and staged["assembly_reason"] == "complete", staged


# ---------------------------------------------------------------------------
# Content under the capture gate


def test_capture_off_stages_and_stores_no_content(replay_factory: Any) -> None:
    """With capture off a waiting trace stages its records and no content,
    the assembled events store none, and the content endpoint answers
    404 for every event (rule 37)."""
    replay = replay_factory(OA, "subagent-protobuf")
    files = [r["file"] for r in replay.requests]
    split = files.index("002-traces.pb")
    replay.send(0, split)
    (trace,) = replay.trace_ids()
    spans, content = staged_rows(trace)
    assert spans > 0 and content == 0, (spans, content)

    replay.send(split)
    want = SCENARIOS[(OA, "subagent-protobuf")]
    sessions, events = wait_assembled(replay.flavor, want)
    check_stored(replay, want, sessions, events)
    rows = stored_event_rows(replay.flavor)
    assert rows and not any(r["has_content"] for r in rows), rows
    for r in rows:
        payload = r["payload"] or {}
        assert (
            "incoming_message" not in payload and "outgoing_message" not in payload
        ), r
        if r["event_type"] in ("post_call", "tool_call"):
            assert fetch_content(r["id"])[0] == 404, r


# The recordings whose runs captured content, and what each stores: a
# fragment of the first call's input messages, and the first tool's
# arguments and result (None where the framework records none on the
# tool span: Google ADK keeps them inside the next call's messages).
CONTENT_SCENARIOS: dict[tuple[str, str], tuple[str, Any, Any]] = {
    (PY, "tool-protobuf"): (
        "What is the weather in Paris?",
        {"city": "Paris"},
        "Paris: sunny, 21 C",
    ),
    (ST, "tool-protobuf"): (
        "What is the weather in Paris?",
        {"city": "Paris"},
        [{"text": "Paris: sunny, 21 C"}],
    ),
    (ST, "tool-latest-json"): (
        "What is the weather in Paris?",
        {"city": "Paris"},
        [{"text": "Paris: sunny, 21 C"}],
    ),
    (OA, "tool-json"): (
        "What is the weather in Paris?",
        {"city": "Paris"},
        "Paris: sunny, 21 C",
    ),
    (ADK, "tool-protobuf"): ("What is the weather in Paris?", None, None),
}


@pytest.mark.parametrize(
    ("framework", "scenario"),
    list(CONTENT_SCENARIOS),
    ids=[f"{fw}/{sc}" for fw, sc in CONTENT_SCENARIOS],
)
def test_captured_content_is_served(
    framework: str, scenario: str, replay_factory: Any
) -> None:
    """With capture declared, every call's content (Google ADK's from its
    log records, one of which arrives before its span and one after)
    and every tool's arguments and result reach event_content under the
    GenAI provider, and the content endpoint serves them (200); the
    staged content is deleted once the trace is assembled."""
    question, tool_input, tool_output = CONTENT_SCENARIOS[(framework, scenario)]
    want = SCENARIOS[(framework, scenario)]
    replay = replay_factory(framework, scenario, capture=True)
    replay.send()
    sessions, events = wait_assembled(replay.flavor, want)
    check_stored(replay, want, sessions, events)

    rows = stored_event_rows(replay.flavor)
    calls = [r for r in rows if r["event_type"] == "post_call"]
    assert calls and all(r["has_content"] for r in calls), calls
    for r in calls:
        status, body = fetch_content(r["id"])
        assert status == 200 and body is not None, (r, status)
        assert body["provider"] == "otel_genai", body
        assert body["messages"] and question in json.dumps(body["messages"]), body
    tools = [r for r in rows if r["event_type"] == "tool_call"]
    for r in tools:
        status, body = fetch_content(r["id"])
        if tool_input is None:
            assert not r["has_content"] and status == 404, (r, status)
            continue
        assert r["has_content"] and status == 200 and body is not None, (r, status)
        assert (
            body["tool_input"] == tool_input and body["tool_output"] == tool_output
        ), body
    for tid in replay.trace_ids():
        assert staged_rows(tid)[1] == 0, tid


def test_captured_content_waits_staged_until_assembly(replay_factory: Any) -> None:
    """A captured trace waiting for its root holds its content in the
    staging table only; once assembled the content is in event_content,
    a child agent's session carries the message its parent sent it and
    its answer, and the staging table holds none."""
    replay = replay_factory(OA, "subagent-protobuf", capture=True)
    files = [r["file"] for r in replay.requests]
    split = files.index("002-traces.pb")
    replay.send(0, split)
    (trace,) = replay.trace_ids()
    spans, content = staged_rows(trace)
    assert spans > 0 and content > 0, (spans, content)
    assert stored_sessions(replay.flavor) == []

    replay.send(split)
    want = SCENARIOS[(OA, "subagent-protobuf")]
    sessions, events = wait_assembled(replay.flavor, want)
    check_stored(replay, want, sessions, events)
    assert staged_rows(trace)[1] == 0

    rows = stored_event_rows(replay.flavor)
    child_start = [
        r
        for r in rows
        if r["event_type"] == "session_start" and r["parent_session_id"] is not None
    ]
    child_end = [
        r
        for r in rows
        if r["event_type"] == "session_end" and r["parent_session_id"] is not None
    ]
    assert len(child_start) == 1 and len(child_end) == 1, rows
    incoming = (child_start[0]["payload"] or {}).get("incoming_message") or {}
    outgoing = (child_end[0]["payload"] or {}).get("outgoing_message") or {}
    assert "weather like in Paris" in json.dumps(incoming.get("body")), incoming
    assert "sunny" in json.dumps(outgoing.get("body")), outgoing
    roots = {s["session_id"] for s in sessions if s["parent_session_id"] is None}
    for r in rows:
        if r["session_id"] in roots and r["event_type"].startswith("session_"):
            payload = r["payload"] or {}
            assert "incoming_message" not in payload, r
    calls = [r for r in rows if r["event_type"] == "post_call"]
    assert len(calls) == 4 and all(fetch_content(r["id"])[0] == 200 for r in calls)


@pytest.mark.parametrize(
    ("framework", "scenario"),
    [
        (PY, "tool-no-content-protobuf"),
        (ST, "tool-redacted-protobuf"),
        (OA, "tool-no-content-protobuf"),
        (ADK, "tool-no-content-protobuf"),
    ],
    ids=["E5", "E8", "E12", "E17"],
)
def test_framework_without_content_stores_none_under_capture(
    framework: str, scenario: str, replay_factory: Any
) -> None:
    """A run whose framework recorded no content (its own switch off, or
    Strands' [REDACTED]) stores none even with capture declared: the
    sessions are capture-on, and every content request is a 404."""
    want = SCENARIOS[(framework, scenario)]
    replay = replay_factory(framework, scenario, capture=True)
    replay.send()
    sessions, events = wait_assembled(replay.flavor, want)
    check_stored(replay, want, sessions, events)
    assert content_rows([s["session_id"] for s in sessions]) == 0
    for r in stored_event_rows(replay.flavor):
        assert not r["has_content"], r
        if r["event_type"] in ("post_call", "tool_call"):
            assert fetch_content(r["id"])[0] == 404, r
