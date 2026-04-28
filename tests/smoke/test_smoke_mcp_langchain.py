"""Phase 5 MCP smoke test — LangChain via langchain-mcp-adapters.
Manual; NOT in CI.

LangChain's MCP integration (``langchain-mcp-adapters``) wraps an
MCP ``ClientSession`` and exposes its tools as LangChain tools. The
sensor's MCP interceptor patches ``ClientSession`` directly, so the
adapter glue is transparent — every tool invocation through a
LangChain agent still produces ``mcp_tool_call`` events.

This file exercises the path end-to-end: spawn the reference MCP
server over stdio, build a ``MultiServerMCPClient`` against it, ask
the client for its tools, and invoke one. Skipped cleanly when the
adapter isn't installed.

Run with ``make smoke-mcp-langchain``.
"""

from __future__ import annotations

import asyncio

import pytest

from tests.smoke.conftest import (
    fetch_events_for_session,
    make_sensor_session,
    wait_for_dev_stack,
)


@pytest.fixture(scope="module", autouse=True)
def _stack_ready() -> None:
    pytest.importorskip("mcp")
    pytest.importorskip("langchain_mcp_adapters")
    wait_for_dev_stack()


def _sensor_session():
    return make_sensor_session(flavor="smoke-mcp-langchain")


def test_langchain_mcp_adapter_routes_tool_calls_through_sensor() -> None:
    """A LangChain MCP-adapter tool invocation produces an
    ``mcp_tool_call`` event with the adapter's tool name + arguments.
    """
    import sys
    from langchain_mcp_adapters.client import MultiServerMCPClient  # type: ignore[import-untyped]

    sess = _sensor_session()

    async def run() -> None:
        client = MultiServerMCPClient(
            {
                "flightdeck-ref": {
                    "command": sys.executable,
                    "args": ["-m", "tests.smoke.fixtures.mcp_reference_server"],
                    "transport": "stdio",
                },
            },
        )
        tools = await client.get_tools()
        echo = next((t for t in tools if t.name == "echo"), None)
        assert echo is not None, (
            f"langchain-mcp-adapters did not expose 'echo'; got {[t.name for t in tools]!r}"
        )
        await echo.ainvoke({"text": "hello langchain smoke"})

    asyncio.run(run())

    events = fetch_events_for_session(
        sess.config.session_id,
        expect_event_types=["mcp_tool_list", "mcp_tool_call"],
        timeout_s=20.0,
    )
    tcs = [e for e in events if e["event_type"] == "mcp_tool_call"]
    assert tcs, f"no mcp_tool_call observed; events={events!r}"
    payload = tcs[-1].get("payload") or {}
    assert payload.get("server_name") == "flightdeck-mcp-reference"
    assert payload.get("transport") == "stdio"
    assert tcs[-1].get("tool_name") == "echo"
    assert (payload.get("arguments") or {}).get("text") == "hello langchain smoke"
