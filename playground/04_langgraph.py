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
import os
import sys
import time
import uuid
from pathlib import Path

try:
    from langgraph.graph import END, START, StateGraph
    from langchain_anthropic import ChatAnthropic
    from typing_extensions import TypedDict
except ImportError:
    print("SKIP: pip install langgraph langchain-anthropic")
    sys.exit(2)

import flightdeck_sensor
from _helpers import assert_event_landed, init_sensor, print_result

_PROJECT_ROOT = str(Path(__file__).resolve().parent.parent)


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

    # ``tests.smoke.fixtures.mcp_reference_server`` resolves only with the
    # project root on PYTHONPATH; running from ``playground/`` (the canonical
    # invocation, see run_all.py) loses it, so the spawned server's
    # ``python -m`` lookup fails with "Connection closed". Pin cwd + PYTHONPATH
    # the same way 13_mcp.py does.
    server_env = dict(os.environ)
    server_env["PYTHONPATH"] = (
        _PROJECT_ROOT + os.pathsep + server_env.get("PYTHONPATH", "")
    )

    async def run() -> None:
        client = MultiServerMCPClient(
            {
                "flightdeck-ref": {
                    "command": sys.executable,
                    "args": ["-m", "tests.smoke.fixtures.mcp_reference_server"],
                    "transport": "stdio",
                    "cwd": _PROJECT_ROOT,
                    "env": server_env,
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
    assert_event_landed(session_id, "mcp_tool_call", timeout=8)


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
