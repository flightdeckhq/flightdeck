"""Connect to two MCP servers in one session and exercise each.

Demonstrates Phase 5's per-event ``server_name`` + ``transport``
attribution: the same Flightdeck session connects to two distinct
MCP servers (the in-tree reference server + a sibling secondary
server in this directory), invokes one tool on each, and asserts
both tool calls land with the expected attribution. Useful for
verifying the dashboard's MCP_SERVER facet and the
``session_start.context.mcp_servers`` list when the agent talks to
multiple servers concurrently.

Run with ``make dev`` up.
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
from _helpers import init_sensor, print_result


REFERENCE_SERVER_MODULE = "tests.smoke.fixtures.mcp_reference_server"
SECONDARY_SERVER_MODULE = "playground.mcp_demo_secondary_server"

# See mcp_demo_basic.py for the cwd/PYTHONPATH rationale — same
# constraint applies here so both spawned servers can resolve their
# module path regardless of the playground's invocation cwd.
_PROJECT_ROOT = str(Path(__file__).resolve().parent.parent)


async def call_one_tool(
    *, module: str, tool: str, args: dict, label: str,
) -> None:
    server_env = dict(os.environ)
    server_env["PYTHONPATH"] = (
        _PROJECT_ROOT + os.pathsep + server_env.get("PYTHONPATH", "")
    )
    params = StdioServerParameters(
        command=sys.executable,
        args=["-m", module],
        cwd=_PROJECT_ROOT,
        env=server_env,
    )
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            t0 = time.monotonic()
            await session.call_tool(tool, args)
            print_result(label, True, int((time.monotonic() - t0) * 1000))


def main() -> None:
    session_id = str(uuid.uuid4())
    init_sensor(session_id, flavor="playground-mcp-multi-server")
    flightdeck_sensor.patch(quiet=True)
    print(f"[playground:mcp_demo_multi_server] session_id={session_id}")

    async def run() -> None:
        # Each server gets its own ClientSession; the sensor's MCP
        # interceptor tags every emitted event with the server's name
        # via the ``_flightdeck_transport`` + initialize() fingerprint
        # pathway. Sequential rather than gathered to keep the
        # event ordering deterministic for live inspection.
        await call_one_tool(
            module=REFERENCE_SERVER_MODULE, tool="echo",
            args={"text": "hello from server A"},
            label="reference server: echo",
        )
        await call_one_tool(
            module=SECONDARY_SERVER_MODULE, tool="reverse",
            args={"text": "playground"},
            label="secondary server: reverse",
        )

    asyncio.run(run())

    # Inline assertion: poll /v1/sessions/{id} once and verify both
    # server names appear on at least one mcp_tool_call event each.
    # Avoids assert_event_landed's single-type focus — multi-server
    # is specifically about attribution diversity.
    api = os.environ.get("FLIGHTDECK_API_URL", "http://localhost:4000/api")
    tok = os.environ.get("FLIGHTDECK_TOKEN", "tok_dev")
    req = urllib.request.Request(
        f"{api}/v1/sessions/{session_id}",
        headers={"Authorization": f"Bearer {tok}"},
    )
    deadline = time.monotonic() + 8.0
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
        except Exception:
            pass
        time.sleep(0.3)

    expected = {"flightdeck-mcp-reference", "flightdeck-mcp-secondary"}
    missing = expected - seen
    if missing:
        raise AssertionError(
            f"multi-server attribution failed: missing server_name(s) {missing!r}; "
            f"observed {seen!r} on session {session_id}"
        )
    print_result(
        "multi-server attribution", True, 0,
        f"both server names landed on the wire: {sorted(seen)}",
    )

    flightdeck_sensor.teardown()


if __name__ == "__main__":
    main()
