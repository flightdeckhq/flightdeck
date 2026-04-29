"""Bare ``mcp`` SDK smoke test. Manual; NOT in CI.

Bootstraps the in-tree reference MCP server over stdio and drives
every operation the sensor's MCP interceptor patches (``initialize``,
``list_tools``, ``call_tool``, ``list_resources``, ``read_resource``,
``list_prompts``, ``get_prompt``), asserting the corresponding
``mcp_*`` event types land in ``/v1/events`` carrying the structured
fields the dashboard contract depends on.

Why a direct-SDK smoke even though every framework adapter ultimately
routes through ``ClientSession`` (which is what the sensor patches):
a real provider SDK release can change the ``InitializeResult`` shape,
the ``CallToolResult.content`` envelope, or surface new error classes.
Mocked unit tests pin those against fixtures and won't notice SDK
drift. Rule 40d's "real exercise the patch surface" bar is what this
file enforces.

Run via ``make smoke-mcp``.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
import urllib.request
import uuid

import pytest

from tests.smoke.conftest import (
    API_TOKEN,
    API_URL,
    fetch_events_for_session,
    make_sensor_session,
    mcp_reference_server_params,
    wait_for_dev_stack,
)


@pytest.fixture(scope="module", autouse=True)
def _stack_ready() -> None:
    pytest.importorskip("mcp")
    wait_for_dev_stack()


def _sensor_session():
    return make_sensor_session(flavor="smoke-mcp")


def _drive_reference_server() -> None:
    """Open a ClientSession against the reference server and exercise
    every patched op. Runs synchronously from the test's perspective
    via ``asyncio.run``; the sensor's interceptor patches async
    ``ClientSession`` methods directly so this is the natural call
    shape.
    """
    from mcp.client.session import ClientSession
    from mcp.client.stdio import stdio_client

    async def run() -> None:
        params = mcp_reference_server_params()
        async with stdio_client(params) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                await session.list_tools()
                await session.call_tool("echo", {"text": "hello smoke"})
                await session.list_resources()
                await session.read_resource("mem://demo")
                await session.list_prompts()
                await session.get_prompt("greet", {"name": "smoke"})

    asyncio.run(run())


def test_mcp_reference_server_emits_all_six_event_types() -> None:
    """Every op the sensor patches fires its corresponding event_type
    and reaches the wire."""
    sess = _sensor_session()
    _drive_reference_server()

    expected = [
        "mcp_tool_list",
        "mcp_tool_call",
        "mcp_resource_list",
        "mcp_resource_read",
        "mcp_prompt_list",
        "mcp_prompt_get",
    ]
    events = fetch_events_for_session(
        sess.config.session_id,
        expect_event_types=["session_start", *expected],
        timeout_s=20.0,
    )

    by_type: dict[str, list[dict]] = {}
    for e in events:
        by_type.setdefault(e["event_type"], []).append(e)

    for et in expected:
        assert by_type.get(et), f"missing {et} event; observed types={list(by_type)!r}"

    tc = by_type["mcp_tool_call"][-1]
    assert tc.get("tool_name") == "echo", f"tool_name mismatch: {tc!r}"
    payload = tc.get("payload") or {}
    assert payload.get("server_name") == "flightdeck-mcp-reference"
    assert payload.get("transport") == "stdio"
    assert (payload.get("arguments") or {}).get("text") == "hello smoke"

    rr = by_type["mcp_resource_read"][-1]
    rr_payload = rr.get("payload") or {}
    assert rr_payload.get("resource_uri") == "mem://demo"
    assert (rr_payload.get("content_bytes") or 0) > 0

    pg = by_type["mcp_prompt_get"][-1]
    pg_payload = pg.get("payload") or {}
    assert pg_payload.get("prompt_name") == "greet"
    assert (pg_payload.get("arguments") or {}).get("name") == "smoke"


def test_mcp_per_event_server_name_attribution_is_consistent() -> None:
    """Every MCP event the reference run produces carries the same
    ``server_name`` + ``transport`` attribution in its payload. The
    sensor's ``record_mcp_server`` only lands on
    ``session_start.context.mcp_servers`` when MCP init happens BEFORE
    ``flightdeck_sensor.init()`` (the worker's UpsertSession writes
    context once on conflict and never updates) — typical agent
    scripts init flightdeck first, so per-event attribution via
    ``server_name`` is the authoritative real-time signal. This test
    pins that signal.
    """
    sess = _sensor_session()
    _drive_reference_server()

    events = fetch_events_for_session(
        sess.config.session_id,
        expect_event_types=["session_start", "mcp_tool_list", "mcp_tool_call"],
        timeout_s=20.0,
    )
    mcp_events = [e for e in events if e["event_type"].startswith("mcp_")]
    assert mcp_events, f"no MCP events observed; events={events!r}"
    for e in mcp_events:
        payload = e.get("payload") or {}
        assert payload.get("server_name") == "flightdeck-mcp-reference", (
            f"server_name mismatch on {e['event_type']}: {payload!r}"
        )
        assert payload.get("transport") == "stdio", (
            f"transport mismatch on {e['event_type']}: {payload!r}"
        )


def test_mcp_multi_server_attribution_is_distinct_per_event() -> None:
    """Two MCP servers in one Flightdeck session each produce events
    carrying their own ``server_name`` -- a single event must NOT
    inherit the wrong server's attribution. Spawns the in-tree
    reference server plus a second tiny FastMCP server defined inline
    here, exercises one tool on each, and asserts both names appear.
    """
    sess = _sensor_session()

    secondary_module = "tests.smoke.fixtures.mcp_secondary_server"

    async def call_one(*, module: str, tool: str, args: dict) -> None:
        from mcp import StdioServerParameters
        from mcp.client.session import ClientSession
        from mcp.client.stdio import stdio_client

        params = StdioServerParameters(
            command=sys.executable,
            args=["-m", module],
        )
        async with stdio_client(params) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                await session.call_tool(tool, args)

    async def run() -> None:
        await call_one(
            module="tests.smoke.fixtures.mcp_reference_server",
            tool="echo",
            args={"text": "hello server A"},
        )
        await call_one(
            module=secondary_module,
            tool="reverse",
            args={"text": "playground"},
        )

    asyncio.run(run())

    api = os.environ.get("FLIGHTDECK_API_URL", API_URL)
    tok = os.environ.get("FLIGHTDECK_API_TOKEN", API_TOKEN)
    req = urllib.request.Request(
        f"{api}/v1/sessions/{sess.config.session_id}",
        headers={"Authorization": f"Bearer {tok}"},
    )
    deadline = time.monotonic() + 10.0
    seen: set[str] = set()
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(req, timeout=2) as r:
                events = json.loads(r.read()).get("events", [])
            seen = {
                (e.get("payload") or {}).get("server_name") or ""
                for e in events
                if e.get("event_type") == "mcp_tool_call"
            }
            if {"flightdeck-mcp-reference", "flightdeck-mcp-secondary"} <= seen:
                break
        except Exception:  # noqa: BLE001 -- transient ingest lag
            pass
        time.sleep(0.3)

    expected = {"flightdeck-mcp-reference", "flightdeck-mcp-secondary"}
    missing = expected - seen
    assert not missing, (
        f"multi-server attribution failed: missing {missing!r}; "
        f"observed {seen!r} on session {sess.config.session_id}"
    )
    # Silence unused-import vigilance on uuid (kept for parity with the
    # rest of the smoke files in this directory).
    _ = uuid.uuid4
