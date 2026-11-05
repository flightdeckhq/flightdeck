"""Seed the E2E fixtures of agent-framework runs reported over OTLP GenAI.

These runs go in the way an OpenTelemetry GenAI exporter sends them:
OTLP/HTTP trace (and, for Google ADK, log) exports to the ingestion
API's ``/v1/traces`` and ``/v1/logs``, which stage the records; the
assembler then publishes each run's sessions and events once its trace
is complete, and the workers store them. The dashboard specs therefore
render exactly what ingestion stores for a real export.

* Recorded runs (``tests/fixtures/otlp``), replayed with
  ``flightdeck.capture_prompts=true`` through ``tests/otlp/replay.py``:
  a Pydantic AI tool run and a Strands one (older-conventions content
  blocks), an OpenAI Agents hand-off (two root agents and an
  ``agent_handoff`` signal), a Google ADK tool run (content from its
  log records; its tool call stores none) and a Pydantic AI model call
  that failed (an ``llm_error``).
* One synthetic Pydantic AI run no recording has: an agent that runs a
  sub-agent that runs a sub-agent (depth 2), and, in a trace of its
  own, a model call no named agent made (the trace's unattributed
  session).

Every seed replays each run under a trace id of its own, dated now, so
the runs are fresh in Fleet's time window; the flavors are fixed, so
the agents stay the same rows across seeds. A spec finds a run by its
flavor and takes the newest one (dashboard/tests/e2e/_fixtures.ts
GENAI_FLAVORS mirrors them).
"""

from __future__ import annotations

import json
import os
import time
import urllib.parse
import urllib.request
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from tests.otlp.replay import genai_record_times, genai_trace_ids, rewrite_genai

FIXTURES = Path(__file__).resolve().parent.parent / "fixtures" / "otlp"

# How far before the seed its runs' last records are dated: every
# record must be in the past when ingestion validates it.
REPLAY_LEAD_NS = 1_000_000_000

# How long the seed waits for every run to be assembled and stored. The
# assembler takes a trace 3 s after its latest record (Google ADK's once
# its log records are in too) and claims once a second; the worker
# drains the bus in well under a second. The ceiling absorbs a loaded
# CI runner.
GENAI_LAND_TIMEOUT_SEC = 90

# How often the seed polls for the stored runs.
GENAI_POLL_INTERVAL_SEC = 0.5

# How far back the poll reads the sessions list: the runs are dated
# within a minute of the seed.
LIST_WINDOW = timedelta(hours=1)

# The recorded runs: (flavor, framework directory, scenario, how many
# sessions the run stores).
RECORDED: tuple[tuple[str, str, str, int], ...] = (
    ("e2e-genai-pydantic-ai", "pydantic-ai-2.64.0", "tool-json", 1),
    ("e2e-genai-strands", "strands-agents-1.63.0", "tool-protobuf", 1),
    ("e2e-genai-openai-handoff", "openai-agents-0.24.0", "handoff-protobuf", 2),
    ("e2e-genai-google-adk", "google-adk-2.13.0", "tool-protobuf", 1),
    ("e2e-genai-model-error", "pydantic-ai-2.64.0", "model-error-json", 1),
)

# The synthetic depth-2 run, and the unattributed call in a trace of
# its own: three agent sessions, and one unattributed session.
DEPTH2_FLAVOR = "e2e-genai-depth2"
DEPTH2_SESSIONS = 4

RESOURCE_BASE = {
    "flightdeck.agent_type": "coding",
    "flightdeck.capture_prompts": "true",
}


def _replay_recorded(
    ingestion_url: str, headers: dict[str, str], flavor: str, framework: str, scenario: str
) -> set[str]:
    """Post one recorded run in its recorded order; return its trace ids."""
    folder = FIXTURES / framework / scenario
    manifest = json.loads((folder / "manifest.json").read_text())
    requests = [
        (r, (folder / r["file"]).read_bytes())
        for r in manifest["requests"]
        if r["path"] != "/v1/metrics"
    ]
    latest = max(
        t for r, body in requests for t in genai_record_times(r["path"], r["content_type"], body)
    )
    shift_ns = time.time_ns() - REPLAY_LEAD_NS - latest
    trace_key = os.urandom(16)
    traces: set[str] = set()
    for r, body in requests:
        rewritten = rewrite_genai(
            r["path"],
            r["content_type"],
            body,
            trace_key=trace_key,
            shift_ns=shift_ns,
            resource_attrs={**RESOURCE_BASE, "flightdeck.flavor": flavor},
        )
        _post(ingestion_url, headers, r["path"], r["content_type"], rewritten)
        traces |= genai_trace_ids(r["path"], r["content_type"], rewritten)
    return traces


def _kv(key: str, value: Any) -> dict[str, Any]:
    if isinstance(value, int):
        return {"key": key, "value": {"intValue": str(value)}}
    if not isinstance(value, str):
        value = json.dumps(value)
    return {"key": key, "value": {"stringValue": value}}


def _text(role: str, text: str) -> dict[str, Any]:
    return {"role": role, "parts": [{"type": "text", "content": text}]}


def _depth2_export(now_ns: int) -> tuple[bytes, set[str]]:
    """A Pydantic AI-shaped trace export: coordinator -> researcher ->
    fact_checker, each agent run through its parent's tool, each with
    one model call; and a model call with no agent in a second trace."""
    trace = os.urandom(16).hex()
    loose_trace = os.urandom(16).hex()
    sec = 1_000_000_000
    start = now_ns - 20 * sec
    spans: list[dict[str, Any]] = []

    def span(
        name: str,
        parent: str | None,
        begin: int,
        end: int,
        attrs: dict[str, Any],
        trace_id: str = trace,
    ) -> str:
        span_id = os.urandom(8).hex()
        rec: dict[str, Any] = {
            "traceId": trace_id,
            "spanId": span_id,
            "name": name,
            "kind": 1,
            "startTimeUnixNano": str(start + begin * sec // 10),
            "endTimeUnixNano": str(start + end * sec // 10),
            "attributes": [_kv(k, v) for k, v in attrs.items()],
            "status": {},
        }
        if parent:
            rec["parentSpanId"] = parent
        spans.append(rec)
        return span_id

    def agent(name: str, parent: str | None, begin: int, end: int) -> str:
        return span(
            f"invoke_agent {name}",
            parent,
            begin,
            end,
            {"gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": name},
        )

    def chat(
        parent: str | None, begin: int, end: int, question: str, answer: str, trace_id: str = trace
    ) -> None:
        span(
            "chat claude-haiku-4-5",
            parent,
            begin,
            end,
            {
                "gen_ai.operation.name": "chat",
                "gen_ai.provider.name": "anthropic",
                "gen_ai.request.model": "claude-haiku-4-5",
                "gen_ai.response.model": "claude-haiku-4-5",
                "gen_ai.usage.input_tokens": 120,
                "gen_ai.usage.output_tokens": 30,
                "gen_ai.input.messages": [_text("user", question)],
                "gen_ai.output.messages": [_text("assistant", answer)],
            },
            trace_id,
        )

    def tool(
        name: str, parent: str, begin: int, end: int, args: dict[str, Any], result: str
    ) -> str:
        return span(
            f"execute_tool {name}",
            parent,
            begin,
            end,
            {
                "gen_ai.operation.name": "execute_tool",
                "gen_ai.tool.name": name,
                "gen_ai.tool.call.id": f"toolu_{os.urandom(6).hex()}",
                "gen_ai.tool.call.arguments": args,
                "gen_ai.tool.call.result": result,
            },
        )

    coordinator = agent("coordinator", None, 0, 100)
    chat(coordinator, 2, 10, "Is it true that Paris is sunny today?", "I will ask the researcher.")
    ask_researcher = tool(
        "ask_researcher",
        coordinator,
        12,
        80,
        {"question": "Paris weather today"},
        "Sunny, checked.",
    )
    researcher = agent("researcher", ask_researcher, 13, 79)
    chat(researcher, 14, 20, "Paris weather today", "Sunny; I will have it checked.")
    ask_checker = tool(
        "ask_fact_checker", researcher, 22, 70, {"claim": "Paris is sunny"}, "Confirmed."
    )
    checker = agent("fact_checker", ask_checker, 23, 69)
    chat(checker, 24, 60, "Check: Paris is sunny", "Confirmed.")
    chat(coordinator, 85, 95, "Is it true that Paris is sunny today?", "Yes, Paris is sunny today.")
    # A model call with no agent above it, alone in a trace of its own:
    # it is the trace's root, and its session the unattributed one.
    chat(None, 90, 99, "A call outside any agent", "Answered.", loose_trace)

    doc = {
        "resourceSpans": [
            {
                "resource": {
                    "attributes": [
                        _kv(k, v)
                        for k, v in {**RESOURCE_BASE, "flightdeck.flavor": DEPTH2_FLAVOR}.items()
                    ]
                },
                "scopeSpans": [
                    {"scope": {"name": "pydantic-ai", "version": "2.64.0"}, "spans": spans}
                ],
            }
        ]
    }
    return json.dumps(doc).encode(), {trace, loose_trace}


def _post(
    ingestion_url: str, headers: dict[str, str], path: str, content_type: str, body: bytes
) -> None:
    req = urllib.request.Request(
        f"{ingestion_url}{path}",
        data=body,
        method="POST",
        headers={**headers, "Content-Type": content_type},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        resp.read()


def _stored(api_url: str, headers: dict[str, str], flavor: str, traces: set[str]) -> int:
    """How many closed sessions of these traces the flavor holds."""
    since = (datetime.now(UTC) - LIST_WINDOW).strftime("%Y-%m-%dT%H:%M:%SZ")
    query = urllib.parse.urlencode({"flavor": flavor, "from": since, "limit": 100})
    req = urllib.request.Request(f"{api_url}/v1/sessions?{query}", headers=headers)
    with urllib.request.urlopen(req, timeout=10) as resp:
        sessions = json.loads(resp.read()).get("sessions") or []
    return sum(
        1
        for s in sessions
        if (s.get("context") or {}).get("otel_trace_id") in traces and s.get("state") == "closed"
    )


def seed_genai_fixtures(ingestion_url: str, api_url: str, headers: dict[str, str]) -> None:
    """Replay every GenAI run, then wait until each is stored."""
    pending: list[tuple[str, set[str], int]] = []
    for flavor, framework, scenario, n_sessions in RECORDED:
        traces = _replay_recorded(ingestion_url, headers, flavor, framework, scenario)
        pending.append((flavor, traces, n_sessions))
    body, traces = _depth2_export(time.time_ns() - REPLAY_LEAD_NS)
    _post(ingestion_url, headers, "/v1/traces", "application/json", body)
    pending.append((DEPTH2_FLAVOR, traces, DEPTH2_SESSIONS))

    deadline = time.monotonic() + GENAI_LAND_TIMEOUT_SEC
    while pending:
        pending = [p for p in pending if _stored(api_url, headers, p[0], p[1]) < p[2]]
        if not pending:
            break
        if time.monotonic() > deadline:
            raise RuntimeError(f"genai fixtures not assembled: {[p[0] for p in pending]}")
        time.sleep(GENAI_POLL_INTERVAL_SEC)
    print(f"  seeded {len(RECORDED) + 1} OTLP GenAI runs")
