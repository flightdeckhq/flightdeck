"""Phase 5 MCP smoke test — LangGraph via langchain-mcp-adapters.
Manual; NOT in CI.

LangGraph reuses ``langchain-mcp-adapters`` for MCP tool exposure
(via ``MultiServerMCPClient``) — the difference from a plain
LangChain run is the surrounding graph runtime, not the MCP path.
This smoke pins that the graph-mediated tool invocation still
routes through the patched ``ClientSession`` and emits an
``mcp_tool_call`` event with the right attribution.

Run with ``make smoke-mcp-langgraph``.
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
    pytest.importorskip("langgraph")
    pytest.importorskip("langchain_mcp_adapters")
    wait_for_dev_stack()


def _sensor_session():
    return make_sensor_session(flavor="smoke-mcp-langgraph")


def test_langgraph_tool_node_invokes_mcp_tool_through_sensor() -> None:
    """A LangGraph ``ToolNode`` running an MCP-adapter tool produces
    an ``mcp_tool_call`` event. Constructs a minimal graph with the
    tool node + a fixture state to drive the tool call directly.
    """
    import sys
    from langchain_core.messages import AIMessage  # type: ignore[import-untyped]
    from langchain_mcp_adapters.client import MultiServerMCPClient  # type: ignore[import-untyped]
    from langgraph.prebuilt import ToolNode  # type: ignore[import-untyped]

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
        node = ToolNode(tools)
        ai_msg = AIMessage(
            content="",
            tool_calls=[
                {
                    "id": "call-1",
                    "name": "echo",
                    "args": {"text": "hello langgraph smoke"},
                },
            ],
        )
        await node.ainvoke({"messages": [ai_msg]})

    asyncio.run(run())

    events = fetch_events_for_session(
        sess.config.session_id,
        expect_event_types=["mcp_tool_call"],
        timeout_s=20.0,
    )
    tcs = [e for e in events if e["event_type"] == "mcp_tool_call"]
    assert tcs, f"no mcp_tool_call observed; events={events!r}"
    payload = tcs[-1].get("payload") or {}
    assert tcs[-1].get("tool_name") == "echo"
    assert payload.get("server_name") == "flightdeck-mcp-reference"
    assert (payload.get("arguments") or {}).get("text") == "hello langgraph smoke"
