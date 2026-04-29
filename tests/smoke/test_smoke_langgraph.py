"""LangGraph smoke test. Runs manually; NOT in CI.

LangGraph reuses LangChain's provider integrations (``ChatAnthropic``
/ ``ChatOpenAI``) and ``langchain-mcp-adapters`` for MCP tool exposure.
The sensor's class-level patch survives LangGraph's dependency chain:
the graph compiles, runs, and the LLM node's call emits ``post_call``
events just like a bare ``ChatAnthropic().invoke()`` would. MCP tool
calls routed through ``ToolNode`` end up at the patched
``ClientSession`` regardless of the surrounding graph runtime.
"""

from __future__ import annotations

import asyncio

import pytest

from tests.smoke.conftest import (
    fetch_events_for_session,
    make_sensor_session,
    require_env,
    wait_for_dev_stack,
)


def _sensor_session():
    return make_sensor_session(flavor="smoke-langgraph")


@pytest.fixture(scope="module", autouse=True)
def _stack_ready() -> None:
    wait_for_dev_stack()


# ---------------------------------------------------------------------------
# Chat path: graph compiles, runs, LLM call emits a post_call event.
# Regression guard against an SDK version upgrade that changes
# LangGraph's internal call shape.
# ---------------------------------------------------------------------------


def test_langgraph_state_graph_invokes_chat_anthropic() -> None:
    require_env("ANTHROPIC_API_KEY")
    pytest.importorskip("langgraph")
    pytest.importorskip("langchain_anthropic")
    from langchain_anthropic import ChatAnthropic
    from langgraph.graph import END, START, StateGraph
    from typing_extensions import TypedDict

    class State(TypedDict):
        text: str

    sess = _sensor_session()
    llm = ChatAnthropic(model="claude-haiku-4-5-20251001", max_tokens=8)

    def call(state: State) -> State:
        llm.invoke(state["text"])
        return state

    graph = StateGraph(State)
    graph.add_node("call", call)
    graph.add_edge(START, "call")
    graph.add_edge("call", END)
    graph.compile().invoke({"text": "say ok"})

    events = fetch_events_for_session(
        sess.config.session_id, expect_event_types=["post_call"],
    )
    assert any(e["event_type"] == "post_call" for e in events), events


# ---------------------------------------------------------------------------
# MCP path: ToolNode driving an MCP-adapter tool routes through the
# patched ClientSession and emits an mcp_tool_call event with the
# right server attribution.
# ---------------------------------------------------------------------------


def test_langgraph_tool_node_invokes_mcp_tool_through_sensor() -> None:
    """A LangGraph ``ToolNode`` running an MCP-adapter tool produces an
    ``mcp_tool_call`` event. Constructs a minimal node-and-state to
    drive the tool call directly; skipped cleanly when the adapter
    isn't installed.
    """
    pytest.importorskip("mcp")
    pytest.importorskip("langgraph")
    pytest.importorskip("langchain_mcp_adapters")

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
