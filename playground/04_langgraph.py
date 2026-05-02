"""LangGraph -- minimal StateGraph routing through ChatAnthropic, plus
an MCP tool call routed through ``ToolNode``.

Proves the sensor's class-level patch survives LangGraph's dependency
chain: the graph compiles, runs, and the LLM node's call emits post_call
events just like a bare `ChatAnthropic().invoke()` would. The MCP
section drives ``ToolNode`` against tools loaded via
``langchain-mcp-adapters``; the sensor sees the call through the
patched ``ClientSession`` regardless of the surrounding graph runtime.
"""
from __future__ import annotations

import asyncio
import sys
import time
import uuid

try:
    from langgraph.graph import END, START, StateGraph
    from langchain_anthropic import ChatAnthropic
    from typing_extensions import TypedDict
except ImportError:
    print("SKIP: pip install langgraph langchain-anthropic")
    sys.exit(2)

import flightdeck_sensor
from _helpers import (
    assert_event_landed,
    fetch_events_for_session,
    init_sensor,
    mcp_server_params,
    print_result,
)


class State(TypedDict):
    text: str


def _run_chat() -> None:
    llm = ChatAnthropic(model="claude-haiku-4-5-20251001", max_tokens=5)

    def call(state: State) -> State:
        llm.invoke(state["text"])
        return state

    graph = StateGraph(State)
    graph.add_node("call", call)
    graph.add_edge(START, "call")
    graph.add_edge("call", END)

    t0 = time.monotonic()
    graph.compile().invoke({"text": "hi"})
    print_result(
        "StateGraph.compile().invoke", True,
        int((time.monotonic() - t0) * 1000),
    )


def _run_mcp(session_id: str) -> None:
    """ToolNode driving an MCP-adapter tool. Skipped cleanly when
    ``langchain-mcp-adapters`` or ``mcp`` are missing."""
    try:
        from langchain_core.messages import AIMessage  # type: ignore[import-untyped]
        from langchain_mcp_adapters.client import MultiServerMCPClient  # type: ignore[import-untyped]
        from langgraph.prebuilt import ToolNode  # type: ignore[import-untyped]
        import mcp  # noqa: F401  -- presence check
    except ImportError:
        print("SKIP MCP section: pip install mcp langchain-mcp-adapters")
        return

    params = mcp_server_params("playground._mcp_reference_server")

    async def run() -> None:
        client = MultiServerMCPClient(
            {
                "flightdeck-ref": {
                    "command": params.command,
                    "args": list(params.args),
                    "transport": "stdio",
                    "cwd": params.cwd,
                    "env": dict(params.env or {}),
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
                    "args": {"text": "hello from langgraph playground"},
                },
            ],
        )
        t0 = time.monotonic()
        await node.ainvoke({"messages": [ai_msg]})
        print_result(
            "ToolNode.ainvoke(echo)", True,
            int((time.monotonic() - t0) * 1000),
        )

    asyncio.run(run())

    events = fetch_events_for_session(
        session_id,
        expect_event_types=["mcp_tool_call"],
        timeout_s=20.0,
    )
    tcs = [e for e in events if e["event_type"] == "mcp_tool_call"]
    if not tcs:
        raise AssertionError(f"no mcp_tool_call observed; events={events!r}")
    payload = tcs[-1].get("payload") or {}
    server_ok = payload.get("server_name") == "flightdeck-mcp-reference"
    args_ok = (payload.get("arguments") or {}).get("text") == "hello from langgraph playground"
    tool_ok = tcs[-1].get("tool_name") == "echo"
    print_result("mcp payload.server_name", server_ok, 0)
    print_result("mcp payload.arguments round-trip", args_ok, 0)
    print_result("mcp tool_name=echo", tool_ok, 0)
    if not (server_ok and args_ok and tool_ok):
        raise AssertionError(f"mcp_tool_call payload mismatch: {tcs[-1]!r}")


def main() -> None:
    session_id = str(uuid.uuid4())
    init_sensor(session_id, flavor="playground-langgraph")
    flightdeck_sensor.patch(quiet=True)
    print(f"[playground:04_langgraph] session_id={session_id}")

    _run_chat()
    assert_event_landed(session_id, "post_call", timeout=8)

    _run_mcp(session_id)

    flightdeck_sensor.teardown()


if __name__ == "__main__":
    main()
