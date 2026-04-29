"""Direct mcp SDK -- list/call_tool, list/read_resource, list/get_prompt,
plus a multi-server attribution scenario.

A developer using the raw ``mcp`` package copies this file, points
``StdioServerParameters`` at their own MCP server, and gets Flightdeck
telemetry on every operation. The sensor's ``patch()`` wraps
``mcp.client.session.ClientSession`` at the class level so every
``async with ClientSession(...) as session`` block emits the six MCP
event types automatically -- no per-call instrumentation, no decorator,
no agent framework required.

The second half exercises a second MCP server in the same Flightdeck
session so the per-event ``server_name`` + ``transport`` attribution
the dashboard's MCP_SERVER facet relies on can be observed end-to-end.

Run with ``make dev`` up. Open the dashboard and watch the session
appear with eight MCP rows on the timeline (six from the reference
server, two from the secondary server).
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import time
import urllib.request
import uuid
from pathlib import Path

try:
    from mcp import StdioServerParameters
    from mcp.client.session import ClientSession
    from mcp.client.stdio import stdio_client
except ImportError:
    print("SKIP: pip install mcp to run this example")
    sys.exit(2)

import flightdeck_sensor
from _helpers import assert_event_landed, init_sensor, print_result


REFERENCE_SERVER_MODULE = "tests.smoke.fixtures.mcp_reference_server"
SECONDARY_SERVER_MODULE = "playground._secondary_mcp_server"

# Project root resolution. The reference server lives at
# ``tests.smoke.fixtures.mcp_reference_server`` -- that import path
# only resolves when the project root is on ``PYTHONPATH``. Running
# the playground from ``playground/`` (the canonical place) loses
# that path, so the spawned server's ``python -m`` lookup fails with
# "Connection closed". Pinning ``cwd`` + ``PYTHONPATH`` on the
# StdioServerParameters fixes it without forcing the operator to run
# the playground from the project root. Same constraint applies to
# the secondary server module.
_PROJECT_ROOT = str(Path(__file__).resolve().parent.parent)


def _params_for(module: str) -> StdioServerParameters:
    server_env = dict(os.environ)
    server_env["PYTHONPATH"] = (
        _PROJECT_ROOT + os.pathsep + server_env.get("PYTHONPATH", "")
    )
    return StdioServerParameters(
        command=sys.executable,
        args=["-m", module],
        cwd=_PROJECT_ROOT,
        env=server_env,
    )


async def _exercise_reference_server() -> None:
    """Open a session against the reference server and exercise every
    op the sensor patches so the six MCP event types all land."""
    async with stdio_client(_params_for(REFERENCE_SERVER_MODULE)) as (read, write):
        async with ClientSession(read, write) as session:
            t0 = time.monotonic()
            await session.initialize()
            print_result(
                "ClientSession.initialize",
                True,
                int((time.monotonic() - t0) * 1000),
                "fingerprint stamped on session",
            )

            t0 = time.monotonic()
            tools = await session.list_tools()
            print_result(
                "session.list_tools", True,
                int((time.monotonic() - t0) * 1000),
                f"{len(tools.tools)} tools",
            )

            t0 = time.monotonic()
            await session.call_tool("echo", {"text": "hello mcp"})
            print_result(
                "session.call_tool(echo)", True,
                int((time.monotonic() - t0) * 1000),
            )

            t0 = time.monotonic()
            resources = await session.list_resources()
            print_result(
                "session.list_resources", True,
                int((time.monotonic() - t0) * 1000),
                f"{len(resources.resources)} resources",
            )

            t0 = time.monotonic()
            await session.read_resource("mem://demo")
            print_result(
                "session.read_resource(mem://demo)", True,
                int((time.monotonic() - t0) * 1000),
            )

            t0 = time.monotonic()
            prompts = await session.list_prompts()
            print_result(
                "session.list_prompts", True,
                int((time.monotonic() - t0) * 1000),
                f"{len(prompts.prompts)} prompts",
            )

            t0 = time.monotonic()
            await session.get_prompt("greet", {"name": "playground"})
            print_result(
                "session.get_prompt(greet)", True,
                int((time.monotonic() - t0) * 1000),
            )


async def _exercise_secondary_server() -> None:
    """Sequential, not gathered: deterministic event ordering for live
    inspection in the dashboard."""
    async with stdio_client(_params_for(SECONDARY_SERVER_MODULE)) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            t0 = time.monotonic()
            await session.call_tool("reverse", {"text": "playground"})
            print_result(
                "secondary server: reverse",
                True,
                int((time.monotonic() - t0) * 1000),
            )


def _assert_multi_server_attribution(session_id: str) -> None:
    """Poll /v1/sessions/{id} until every mcp_tool_call event carries a
    server_name and the union of those names covers both fixture
    servers."""
    api = os.environ.get("FLIGHTDECK_API_URL", "http://localhost:4000/api")
    tok = os.environ.get("FLIGHTDECK_TOKEN", "tok_dev")
    req = urllib.request.Request(
        f"{api}/v1/sessions/{session_id}",
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
    if missing:
        raise AssertionError(
            f"multi-server attribution failed: missing {missing!r}; "
            f"observed {seen!r} on session {session_id}"
        )
    print_result(
        "multi-server attribution", True, 0,
        f"both server names landed on the wire: {sorted(seen)}",
    )


def main() -> None:
    session_id = str(uuid.uuid4())
    init_sensor(session_id, flavor="playground-mcp")
    flightdeck_sensor.patch(quiet=True)
    print(f"[playground:13_mcp] session_id={session_id}")

    asyncio.run(_exercise_reference_server())
    asyncio.run(_exercise_secondary_server())

    # Wait for each event_type the demo produced to surface in the
    # query API. Six independent assertions because the sensor flushes
    # the MCP event queue asynchronously and we want a clear failure
    # message if any one type fails to land.
    for et in (
        "mcp_tool_list",
        "mcp_tool_call",
        "mcp_resource_list",
        "mcp_resource_read",
        "mcp_prompt_list",
        "mcp_prompt_get",
    ):
        assert_event_landed(session_id, et, timeout=8)

    _assert_multi_server_attribution(session_id)

    flightdeck_sensor.teardown()


if __name__ == "__main__":
    main()
