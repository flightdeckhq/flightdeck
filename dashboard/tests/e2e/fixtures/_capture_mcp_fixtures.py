"""Phase 5 fixture-freeze script (addition D).

Captures one canonical event payload per MCP event type from a real
flightdeck-sensor run against the reference MCP server. Output frozen
to ``mcp-events.json`` in this same directory.

The dashboard's MCP unit tests + Playwright E2E spec replay these
fixtures rather than re-running the full sensor-and-server pipeline
on every CI invocation. The fixture is the **dashboard contract**:
any sensor or worker change that mutates an MCP event payload shape
must regenerate this file (and the dashboard team must agree).

Usage::

    sensor/.venv/bin/python -m dashboard.tests.e2e.fixtures._capture_mcp_fixtures

This is NOT a pytest. It runs once when an authoritative regeneration
is needed. Volatile fields (session_id, agent_id, timestamp,
duration_ms) are normalised to stable placeholder strings so the JSON
is deterministic and reviewable across runs.

Volatile-field normalisation rules:
* ``session_id``       -> ``"<session-id>"``
* ``agent_id``         -> ``"<agent-id>"``
* ``timestamp``        -> ``"<timestamp>"``
* ``duration_ms``      -> any non-negative int -> ``42`` (representative)
* ``host`` / ``hostname`` -> ``"<host>"``
* ``user``             -> ``"<user>"``
* ``mcp_servers[i].instructions`` -> kept as-is (deterministic)
* ``mcp_servers[i].version``      -> kept as-is (mcp package version is deterministic per CI lockfile)

Event types covered: SESSION_START (with mcp_servers), MCP_TOOL_LIST,
MCP_TOOL_CALL, MCP_RESOURCE_LIST, MCP_RESOURCE_READ, MCP_PROMPT_LIST,
MCP_PROMPT_GET. One canonical payload per type. capture_prompts=True
on this run so the dashboard sees the maximum-fidelity shape (the
capture-disabled shape is the same minus the gated fields, which is
covered by sensor unit tests, not this fixture).
"""

from __future__ import annotations

import asyncio
import copy
import json
import sys
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

# Make the sensor package importable when running from the repo root.
_REPO_ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(_REPO_ROOT / "sensor"))

import flightdeck_sensor
from flightdeck_sensor.core.session import Session
from flightdeck_sensor.core.types import EventType, SensorConfig
from flightdeck_sensor.interceptor.mcp import (
    patch_mcp_classes,
    unpatch_mcp_classes,
)
from flightdeck_sensor.transport.client import ControlPlaneClient

import mcp.client.stdio as _mcp_stdio
from mcp import StdioServerParameters
from mcp.client.session import ClientSession


_FIXTURE_PATH = Path(__file__).resolve().parent / "mcp-events.json"


# ---------------------------------------------------------------------
# Sensor-session boilerplate
# ---------------------------------------------------------------------


def _install_capturing_session() -> tuple[Session, list[dict[str, Any]]]:
    """Install a sensor session whose event_queue collects to a list.

    Bypasses the public init() / patch() flow because we don't need
    real network egress — the goal here is to capture exactly what the
    sensor would have shipped to ingestion. The MagicMock client
    accepts post_event() calls but never sends bytes.
    """
    captured: list[dict[str, Any]] = []
    config = SensorConfig(
        server="http://localhost:9999",
        token="tok-fixture",
        agent_flavor="phase5-fixture-freeze",
        agent_type="coding",
        capture_prompts=True,
        quiet=True,
    )
    client = MagicMock(spec=ControlPlaneClient)

    def _capturing_post_event(payload: dict[str, Any]) -> tuple[Any, bool]:
        # session._post_event() -- the synchronous emission path used
        # for SESSION_START / SESSION_END / DIRECTIVE_RESULT acks.
        captured.append(copy.deepcopy(payload))
        return (None, False)

    client.post_event.side_effect = _capturing_post_event
    session = Session(config=config, client=client)

    real_enqueue = session.event_queue.enqueue

    def _capturing_enqueue(payload: dict[str, Any]) -> None:
        # session.event_queue.enqueue() -- the asynchronous emission path
        # used by every interceptor (the MCP wrapper enqueues here).
        captured.append(copy.deepcopy(payload))
        real_enqueue(payload)

    session.event_queue.enqueue = _capturing_enqueue  # type: ignore[method-assign]
    flightdeck_sensor._session = session
    return session, captured


def _release_session(session: Session) -> None:
    flightdeck_sensor._session = None
    try:
        session.event_queue.flush()
        session.event_queue.close()
    except Exception:
        pass


# ---------------------------------------------------------------------
# MCP exercise — drives every patched method against the reference server
# ---------------------------------------------------------------------


async def _exercise_reference_server() -> None:
    params = StdioServerParameters(
        command=sys.executable,
        args=["-m", "tests.smoke.fixtures.mcp_reference_server"],
    )
    # Attribute access (not local binding) so we get the post-patch
    # wrapped factory, which marks the streams with the transport label.
    async with _mcp_stdio.stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            await session.list_tools()
            await session.call_tool("echo", {"text": "fixture"})
            await session.list_resources()
            await session.read_resource("mem://demo")
            await session.list_prompts()
            await session.get_prompt("greet", {"name": "fixture"})


# ---------------------------------------------------------------------
# Volatile-field normalisation
# ---------------------------------------------------------------------


_VOLATILE_REPLACEMENTS = {
    "session_id": "<session-id>",
    "agent_id": "<agent-id>",
    "timestamp": "<timestamp>",
    "host": "<host>",
    "hostname": "<host>",
    "user": "<user>",
    "agent_name": "<agent-name>",
}


def _normalise(payload: dict[str, Any]) -> dict[str, Any]:
    out = copy.deepcopy(payload)
    for key, replacement in _VOLATILE_REPLACEMENTS.items():
        if key in out:
            out[key] = replacement
    if isinstance(out.get("duration_ms"), int):
        out["duration_ms"] = 42
    return out


def _select_canonical(captured: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Pick the first event of each MCP event type plus session_start."""
    wanted = {
        EventType.SESSION_START.value,
        EventType.MCP_TOOL_LIST.value,
        EventType.MCP_TOOL_CALL.value,
        EventType.MCP_RESOURCE_LIST.value,
        EventType.MCP_RESOURCE_READ.value,
        EventType.MCP_PROMPT_LIST.value,
        EventType.MCP_PROMPT_GET.value,
    }
    canonical: dict[str, dict[str, Any]] = {}
    for ev in captured:
        et = ev.get("event_type")
        if et in wanted and et not in canonical:
            canonical[et] = _normalise(ev)
    return canonical


# ---------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------


def main() -> int:
    session, captured = _install_capturing_session()
    patch_mcp_classes(quiet=True)
    try:
        # session.start() emits SESSION_START with context.mcp_servers AFTER
        # the MCP exercise records the fingerprint.
        asyncio.run(_exercise_reference_server())
        # Now emit session_start synthetically so it ships with the
        # fingerprint. Real sensor runs call init() -> session.start()
        # BEFORE the agent does any work, so the typical order is
        # session_start (no mcp_servers yet) ... initialize fingerprints
        # ... per-call events. The dashboard contract treats
        # context.mcp_servers as authoritative for "this session has
        # connected to these servers" -- regardless of arrival order.
        # For the fixture freeze we want session_start.context.mcp_servers
        # populated, so we emit session_start here, after initialize().
        session._post_event(EventType.SESSION_START)
    finally:
        unpatch_mcp_classes(quiet=True)
        _release_session(session)

    canonical = _select_canonical(captured)
    missing = sorted(
        {
            EventType.SESSION_START.value,
            EventType.MCP_TOOL_LIST.value,
            EventType.MCP_TOOL_CALL.value,
            EventType.MCP_RESOURCE_LIST.value,
            EventType.MCP_RESOURCE_READ.value,
            EventType.MCP_PROMPT_LIST.value,
            EventType.MCP_PROMPT_GET.value,
        }
        - canonical.keys()
    )
    if missing:
        print(f"FAIL — missing canonical events: {missing}", file=sys.stderr)
        return 1

    # API-shape fixtures (synthetic, not captured live).
    #
    # The Query API surfaces MCP server identity in two distinct ways:
    #
    # * ``GET /v1/sessions``        -> per-row ``mcp_server_names: string[]``
    #                                  (lean, just names; no fingerprint
    #                                  detail to keep the listing payload
    #                                  small).
    # * ``GET /v1/sessions/:id``    -> ``context.mcp_servers: object[]``
    #                                  (full fingerprint per server).
    #
    # Both shapes are part of the dashboard contract — frozen below so the
    # dashboard team builds against a known wire format BEFORE the worker
    # / Query API land. When Step 7 implements the API, the live response
    # MUST match these shapes byte-for-byte (modulo the volatile-field
    # placeholders).
    server_fingerprint_example = canonical[EventType.SESSION_START.value]["context"][
        "mcp_servers"
    ]
    session_listing_item = {
        "session_id": "<session-id>",
        "agent_id": "<agent-id>",
        "agent_name": "<agent-name>",
        "agent_type": "coding",
        "client_type": "flightdeck_sensor",
        "flavor": "phase5-fixture-freeze",
        "framework": None,
        "host": "<host>",
        "model": None,
        "state": "active",
        "tokens_used": 0,
        "tokens_input": 0,
        "tokens_output": 0,
        "tokens_cache_read": 0,
        "tokens_cache_creation": 0,
        "token_limit": None,
        "started_at": "<timestamp>",
        "ended_at": None,
        "last_seen_at": "<timestamp>",
        "last_attached_at": None,
        "error_types": [],
        "policy_event_types": [],
        # Phase 5 listing-shape commitment: names only, derived at query
        # time from session.context.mcp_servers, parallel to the existing
        # error_types[] / policy_event_types[] aggregation patterns.
        "mcp_server_names": [
            srv["name"] for srv in server_fingerprint_example
        ],
    }
    session_detail = {
        **session_listing_item,
        # Full per-server fingerprint, surfaced from sessions.context.
        # Detail responses keep the structure the sensor produced —
        # listing trades that detail for compactness.
        "context": {"mcp_servers": server_fingerprint_example},
        "attachments": [],
        "events": [],  # populated in real responses; left empty in fixture.
    }

    output = {
        "_meta": {
            "phase": "5",
            "source": "flightdeck-sensor against tests/smoke/fixtures/mcp_reference_server.py",
            "capture_prompts": True,
            "agent_type": "coding",
            "flavor": "phase5-fixture-freeze",
            "note": (
                "Volatile fields (session_id, agent_id, timestamp, host, "
                "user, agent_name, duration_ms) replaced with placeholder "
                "values so the JSON is deterministic. Regenerate by "
                "running this script when the sensor's MCP payload shape "
                "changes."
            ),
        },
        "events": canonical,
        "session_listing_item": session_listing_item,
        "session_detail": session_detail,
    }

    _FIXTURE_PATH.write_text(json.dumps(output, indent=2, sort_keys=True))
    print(f"wrote {_FIXTURE_PATH} ({len(canonical)} canonical events)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
