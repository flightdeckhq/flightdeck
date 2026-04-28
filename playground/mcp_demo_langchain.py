"""LangChain agent + MCP tools via langchain-mcp-adapters.

Spins up the in-tree reference MCP server over stdio, wraps its tools
as LangChain tools via ``MultiServerMCPClient.get_tools()``, and
invokes one. The sensor's MCP patch sees the call through the
adapter's ``ClientSession`` underneath, so every tool invocation
produces an ``mcp_tool_call`` event with the right
``server_name`` / ``tool_name`` / ``arguments`` attribution — no
LangChain-specific patching needed.

Run with ``make dev`` up. Requires ``langchain-mcp-adapters`` (and
its langchain-core dependency).
"""
from __future__ import annotations

import asyncio
import os
import sys
import time
import uuid
from pathlib import Path

try:
    from langchain_mcp_adapters.client import MultiServerMCPClient
except ImportError:
    print("SKIP: pip install langchain-mcp-adapters to run this example")
    sys.exit(2)

try:
    import mcp  # noqa: F401  -- import to confirm the SDK is present
except ImportError:
    print("SKIP: pip install mcp to run this example")
    sys.exit(2)

import flightdeck_sensor
from _helpers import assert_event_landed, init_sensor, print_result


REFERENCE_SERVER_MODULE = "tests.smoke.fixtures.mcp_reference_server"

# See mcp_demo_basic.py for cwd/PYTHONPATH rationale.
_PROJECT_ROOT = str(Path(__file__).resolve().parent.parent)


def main() -> None:
    session_id = str(uuid.uuid4())
    init_sensor(session_id, flavor="playground-mcp-langchain")
    flightdeck_sensor.patch(quiet=True)
    print(f"[playground:mcp_demo_langchain] session_id={session_id}")

    server_env = dict(os.environ)
    server_env["PYTHONPATH"] = (
        _PROJECT_ROOT + os.pathsep + server_env.get("PYTHONPATH", "")
    )

    async def run() -> None:
        client = MultiServerMCPClient(
            {
                "flightdeck-ref": {
                    "command": sys.executable,
                    "args": ["-m", REFERENCE_SERVER_MODULE],
                    "transport": "stdio",
                    "cwd": _PROJECT_ROOT,
                    "env": server_env,
                },
            },
        )

        t0 = time.monotonic()
        tools = await client.get_tools()
        print_result(
            "MultiServerMCPClient.get_tools", True,
            int((time.monotonic() - t0) * 1000),
            f"{len(tools)} tools exposed as LangChain tools",
        )

        echo = next((t for t in tools if t.name == "echo"), None)
        if echo is None:
            raise AssertionError(
                f"langchain-mcp-adapters did not expose 'echo'; "
                f"got {[t.name for t in tools]!r}",
            )

        t0 = time.monotonic()
        result = await echo.ainvoke({"text": "hello from langchain playground"})
        print_result(
            "echo.ainvoke", True, int((time.monotonic() - t0) * 1000),
            f"result={result!r}"[:80],
        )

    asyncio.run(run())

    assert_event_landed(session_id, "mcp_tool_list", timeout=8)
    assert_event_landed(session_id, "mcp_tool_call", timeout=8)

    flightdeck_sensor.teardown()


if __name__ == "__main__":
    main()
