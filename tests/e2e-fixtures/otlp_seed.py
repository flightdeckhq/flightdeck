"""Seed the E2E fixture of a Claude Code session reported over OTLP.

Unlike the canonical fixtures, which post Flightdeck events to
``POST /v1/events``, this one goes in the way an OpenTelemetry exporter
sends it: one OTLP/HTTP JSON log export to ``POST /v1/logs``, in the
record shape Claude Code 2.1.316 emits (tests/fixtures/otlp). Ingestion's
Claude Code dialect then creates the sessions, so the dashboard specs
render exactly what a real export stores:

* a root session (``context.telemetry=otlp``, observe only) with a
  prompt that names no model, an ``api_request`` carrying Claude Code's
  own cost and TTFT, a denied tool (``session_signal permission_denied``)
  and an MCP tool call;
* a ``general-purpose`` sub-agent child that ends with
  ``subagent_completed``.

Session ids derive from the fixed Claude Code ``session.id`` below, as
ingestion derives them, so every run addresses the same rows. A run
skips the export when the root already holds its events; either way it
pins the root ``active`` (only these fixture rows), because an OTLP
session has no end event and would age to ``stale`` during the suite.
"""

from __future__ import annotations

import json
import subprocess
import sys
import time
import urllib.error
import urllib.request
from typing import Any
from uuid import UUID, uuid5

NAMESPACE_FLIGHTDECK = UUID("ee22ab58-26fc-54ef-91b4-b5c0a97f9b61")

# The Claude Code session.id of the fixture; the Flightdeck ids follow
# from it (dashboard/tests/e2e/_fixtures.ts OTLP_AGENT mirrors them).
OTLP_CC_SESSION_ID = "e2e-otlp-observer"
OTLP_SUBAGENT_ID = "e2eotlpchild01"
OTLP_USER = "e2e-test-otlp"
OTLP_HOST = "e2e-otlp-host"
OTLP_FLAVOR = "e2e-otlp-claude-code"
OTLP_SERVICE_VERSION = "2.1.316"

# Mapped records the export carries, each one event, plus the synthetic
# session_start of the root and of the child: the root holds the
# prompt, the call, the denial, the MCP call and the Agent tool's
# result, so it is complete at 6 events.
OTLP_ROOT_MIN_EVENTS = 6

# How long to wait for the worker to store the root's events after the
# export is answered; the bus drains in well under a second on an idle
# stack.
OTLP_LAND_TIMEOUT_SEC = 30

# Per-call timeout for the docker exec psql pin, the canonical seed's
# own bound (seed.py PSQL_EXEC_TIMEOUT_SEC).
PSQL_EXEC_TIMEOUT_SEC = 10


def _session_id(cc_session_id: str, agent_id: str = "") -> str:
    name = f"flightdeck://otlp/claude-code/session/{cc_session_id}"
    if agent_id:
        name += f"/{agent_id}"
    return str(uuid5(NAMESPACE_FLIGHTDECK, name))


OTLP_ROOT_SESSION_ID = _session_id(OTLP_CC_SESSION_ID)
OTLP_CHILD_SESSION_ID = _session_id(OTLP_CC_SESSION_ID, OTLP_SUBAGENT_ID)


def _value(v: Any) -> dict[str, Any]:
    # Claude Code sends counts as strings or ints and flags as strings;
    # the dialect reads either. Strings keep the fixture close to the
    # recorded exports.
    if isinstance(v, bool):
        return {"boolValue": v}
    if isinstance(v, int):
        return {"intValue": str(v)}
    if isinstance(v, float):
        return {"doubleValue": v}
    return {"stringValue": str(v)}


def _attrs(d: dict[str, Any]) -> list[dict[str, Any]]:
    return [{"key": k, "value": _value(v)} for k, v in d.items()]


def _records(now_ns: int) -> list[dict[str, Any]]:
    """The export's log records, oldest first, the last one at now."""
    child = {"agent_id": OTLP_SUBAGENT_ID}
    child_named = {**child, "agent.name": "general-purpose"}
    specs: list[tuple[str, dict[str, Any]]] = [
        (
            "user_prompt",
            {"prompt": "E2E OTLP prompt: list the repo files.", "prompt_length": "37"},
        ),
        (
            "api_request",
            {
                "model": "claude-haiku-4-5-20251001",
                "input_tokens": 10,
                "output_tokens": 178,
                "cache_read_tokens": 14595,
                "cache_creation_tokens": 7483,
                "cache_creation_1h_tokens": 7483,
                "cost_usd": 0.0173255,
                "duration_ms": 2194,
                "ttft_ms": 935,
                "request_id": "req_e2e_otlp_root_1",
                "query_source": "repl_main_thread",
            },
        ),
        (
            "tool_decision",
            {
                "decision": "reject",
                "source": "config",
                "tool_name": "Bash",
                "tool_use_id": "toolu_e2e_otlp_denied",
            },
        ),
        (
            "tool_result",
            {
                "tool_name": "mcp_tool",
                "tool_use_id": "toolu_e2e_otlp_mcp",
                "success": "true",
                "duration_ms": "7",
                "tool_parameters": json.dumps(
                    {"mcp_server_name": "e2e-otlp-mcp", "mcp_tool_name": "echo"}
                ),
                "tool_input": json.dumps({"text": "hi"}),
            },
        ),
        (
            "api_request",
            {
                **child_named,
                "model": "claude-haiku-4-5-20251001",
                "input_tokens": 10,
                "output_tokens": 124,
                "cache_creation_tokens": 13974,
                "cost_usd": 0.0180975,
                "duration_ms": 1968,
                "ttft_ms": 1272,
                "request_id": "req_e2e_otlp_child_1",
                "query_source": "agent:builtin:general-purpose",
            },
        ),
        (
            "tool_result",
            {
                **child,
                "tool_name": "Bash",
                "tool_use_id": "toolu_e2e_otlp_child_bash",
                "success": "true",
                "duration_ms": "392",
            },
        ),
        ("subagent_completed", {**child, "agent_type": "general-purpose"}),
        (
            "tool_result",
            {
                "tool_name": "Agent",
                "tool_use_id": "toolu_e2e_otlp_agent",
                "success": "true",
                "duration_ms": "4100",
            },
        ),
    ]
    step_ns = 1_000_000_000  # one second between records
    first_ns = now_ns - step_ns * len(specs)
    records = []
    for i, (name, extra) in enumerate(specs):
        ts = first_ns + step_ns * (i + 1)
        attrs = {
            "session.id": OTLP_CC_SESSION_ID,
            "user.email": OTLP_USER,
            "terminal.type": "e2e",
            "event.name": name,
            "event.sequence": i + 1,
            **extra,
        }
        records.append(
            {
                "timeUnixNano": str(ts),
                "observedTimeUnixNano": str(ts),
                "body": {"stringValue": f"claude_code.{name}"},
                "attributes": _attrs(attrs),
            }
        )
    return records


def _export(now_ns: int) -> dict[str, Any]:
    resource = {
        "service.name": "claude-code",
        "service.version": OTLP_SERVICE_VERSION,
        "host.name": OTLP_HOST,
        "os.type": "linux",
        "host.arch": "amd64",
        "flightdeck.flavor": OTLP_FLAVOR,
        "flightdeck.capture_prompts": "true",
    }
    return {
        "resourceLogs": [
            {
                "resource": {"attributes": _attrs(resource)},
                "scopeLogs": [
                    {
                        "scope": {
                            "name": "com.anthropic.claude_code.events",
                            "version": OTLP_SERVICE_VERSION,
                        },
                        "logRecords": _records(now_ns),
                    }
                ],
            }
        ]
    }


def _root_event_count(api_url: str, headers: dict[str, str]) -> int:
    req = urllib.request.Request(
        f"{api_url}/v1/sessions/{OTLP_ROOT_SESSION_ID}", headers=headers
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return len(json.loads(resp.read()).get("events") or [])
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return 0
        raise


def _pin_root_active() -> None:
    # Only the fixture's own root row and its agent; the ids are uuid5
    # literals derived above, never input.
    sql = (
        "UPDATE sessions SET state='active', last_seen_at=NOW() "
        f"WHERE session_id='{OTLP_ROOT_SESSION_ID}'::uuid; "
        "UPDATE agents SET last_seen_at=NOW() WHERE agent_id = "
        f"(SELECT agent_id FROM sessions WHERE session_id='{OTLP_ROOT_SESSION_ID}'::uuid)"
    )
    result = subprocess.run(
        [
            "docker",
            "exec",
            "docker-postgres-1",
            "psql",
            "-U",
            "flightdeck",
            "-d",
            "flightdeck",
            "-c",
            sql,
        ],
        capture_output=True,
        text=True,
        timeout=PSQL_EXEC_TIMEOUT_SEC,
        check=False,
    )
    if result.returncode != 0:
        print(
            f"[seed] otlp: active pin failed: {result.stderr.strip()}", file=sys.stderr
        )


def seed_otlp_fixture(
    ingestion_url: str, api_url: str, headers: dict[str, str], mode: str = "full"
) -> None:
    """Send the OTLP export when the root is not seeded yet (full mode
    only), then pin the root active."""
    if mode == "full" and _root_event_count(api_url, headers) < OTLP_ROOT_MIN_EVENTS:
        body = json.dumps(_export(time.time_ns())).encode()
        req = urllib.request.Request(
            f"{ingestion_url}/v1/logs",
            data=body,
            headers={**headers, "Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            answer = json.loads(resp.read() or b"{}")
        rejected = int(answer.get("partialSuccess", {}).get("rejectedLogRecords", 0))
        if rejected:
            raise RuntimeError(
                f"otlp export: {rejected} records not used: "
                f"{answer['partialSuccess'].get('errorMessage')}"
            )
        deadline = time.monotonic() + OTLP_LAND_TIMEOUT_SEC
        while _root_event_count(api_url, headers) < OTLP_ROOT_MIN_EVENTS:
            if time.monotonic() > deadline:
                raise RuntimeError("otlp fixture: root events did not land")
            time.sleep(0.5)
        print(f"  seeded otlp/{OTLP_CC_SESSION_ID} ({OTLP_ROOT_SESSION_ID[:8]})")
    _pin_root_active()
