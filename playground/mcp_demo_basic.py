"""Direct mcp SDK -- list/call_tool, list/read_resource, list/get_prompt.

A developer using the raw ``mcp`` package copies this file, points
``StdioServerParameters`` at their own MCP server, and gets Flightdeck
telemetry on every operation. The sensor's ``patch()`` wraps
``mcp.client.session.ClientSession`` at the class level so every
``async with ClientSession(...) as session`` block emits the six MCP
event types automatically — no per-call instrumentation, no decorator,
no agent framework required.

Run with ``make dev`` up. Open the dashboard and watch the session
appear with six MCP rows on the timeline.
"""
from __future__ import annotations

import asyncio
import os
import sys
import time
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

# Project root resolution. The reference server lives at
# ``tests.smoke.fixtures.mcp_reference_server`` — that import path
# only resolves when the project root is on ``PYTHONPATH``. Running
# the playground from ``playground/`` (the canonical place) loses
# that path, so the spawned server's ``python -m`` lookup fails with
# "Connection closed". Pinning ``cwd`` + ``PYTHONPATH`` on the
# StdioServerParameters fixes it without forcing the operator to run
# the playground from the project root.
_PROJECT_ROOT = str(Path(__file__).resolve().parent.parent)


def main() -> None:
    session_id = str(uuid.uuid4())
    init_sensor(session_id, flavor="playground-mcp-basic")
    flightdeck_sensor.patch(quiet=True)
    print(f"[playground:mcp_demo_basic] session_id={session_id}")

    server_env = dict(os.environ)
    server_env["PYTHONPATH"] = (
        _PROJECT_ROOT + os.pathsep + server_env.get("PYTHONPATH", "")
    )
    params = StdioServerParameters(
        command=sys.executable,
        args=["-m", REFERENCE_SERVER_MODULE],
        cwd=_PROJECT_ROOT,
        env=server_env,
    )

    async def run() -> None:
        async with stdio_client(params) as (read, write):
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

    asyncio.run(run())

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

    flightdeck_sensor.teardown()


if __name__ == "__main__":
    main()
