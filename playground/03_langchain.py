"""LangChain -- ChatAnthropic + ChatOpenAI, plus an MCP tool call via
``langchain-mcp-adapters``.

LangChain constructs Anthropic() / OpenAI() clients internally. Because
`flightdeck_sensor.patch()` mutates those classes at import time, every
LangChain `ChatAnthropic(...).invoke(...)` call emits pre/post events
with no framework-specific wiring.

The MCP section uses ``langchain-mcp-adapters``: the adapter wraps an
MCP ``ClientSession`` and exposes its tools as native LangChain tools.
The sensor patches ``ClientSession`` directly so every adapter-routed
tool invocation produces an ``mcp_tool_call`` event.
"""
from __future__ import annotations

import asyncio
import os
import sys
import time
import uuid
from pathlib import Path

try:
    from langchain_anthropic import ChatAnthropic
    from langchain_openai import ChatOpenAI
except ImportError:
    print("SKIP: pip install langchain-anthropic langchain-openai")
    sys.exit(2)

import flightdeck_sensor
from _helpers import assert_event_landed, init_sensor, print_result


REFERENCE_SERVER_MODULE = "tests.smoke.fixtures.mcp_reference_server"
_PROJECT_ROOT = str(Path(__file__).resolve().parent.parent)


def _run_chat() -> None:
    t0 = time.monotonic()
    ChatAnthropic(model="claude-haiku-4-5-20251001", max_tokens=5).invoke("hi")
    print_result("ChatAnthropic.invoke", True, int((time.monotonic() - t0) * 1000))

    t0 = time.monotonic()
    ChatOpenAI(model="gpt-4o-mini", max_tokens=5).invoke("hi")
    print_result("ChatOpenAI.invoke", True, int((time.monotonic() - t0) * 1000))


def _run_mcp(session_id: str) -> None:
    """Optional MCP demo using langchain-mcp-adapters. Skipped cleanly
    when the adapter (or the ``mcp`` SDK) isn't installed -- chat
    coverage above is the primary contract this script exercises."""
    try:
        from langchain_mcp_adapters.client import MultiServerMCPClient  # type: ignore[import-untyped]
        import mcp  # noqa: F401  -- presence check
    except ImportError:
        print("SKIP MCP section: pip install mcp langchain-mcp-adapters")
        return

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
        await echo.ainvoke({"text": "hello from langchain playground"})
        print_result(
            "echo.ainvoke", True, int((time.monotonic() - t0) * 1000),
        )

    asyncio.run(run())
    assert_event_landed(session_id, "mcp_tool_call", timeout=8)


def main() -> None:
    session_id = str(uuid.uuid4())
    init_sensor(session_id, flavor="playground-langchain")
    flightdeck_sensor.patch(quiet=True)
    print(f"[playground:03_langchain] session_id={session_id}")

    _run_chat()
    assert_event_landed(session_id, "post_call", timeout=8)

    _run_mcp(session_id)

    flightdeck_sensor.teardown()


if __name__ == "__main__":
    main()
