"""LangGraph graphs land as child sessions per node of a hand-built graph.

The real sensor (``flightdeck_sensor.init`` + ``patch``) wraps real
LangGraph graphs whose model calls go through LangChain's ``ChatOpenAI``,
with the OpenAI API mocked at the network boundary (respx), against the
stack under test. The tests read the stored ``sessions`` and ``events``
rows:

* a hand-built tool loop (a model node, a ``ToolNode`` and a
  ``RunnableLambda`` node): one closed child per node run under the
  sensor's session, carrying only its start and end; the model calls and
  tool calls on the sensor's session;
* a top-level ``create_agent`` doing the same work: no child sessions,
  its calls on the sensor's session;
* a graph invoked from inside a node (async): its node's child nests
  under the enclosing node's child;
* an interrupted node: its child closes normally, and the resumed run
  opens a second child.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import uuid
from typing import TYPE_CHECKING, Any

import httpx
import pytest
import respx

import flightdeck_sensor

from .conftest import (
    INGESTION_URL,
    TOKEN,
    delete_flavor_data,
    query_rows,
    wait_until,
)
from .test_sensor_e2e import _force_reset_sensor

if TYPE_CHECKING:
    from collections.abc import Iterator

OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions"
MODEL = "gpt-4o-mini"
# Time for the worker to write the sensor's events.
STORED_TIMEOUT_SECS = 20.0


def _sessions(flavor: str) -> list[dict[str, Any]]:
    return query_rows(
        "SELECT session_id::text, parent_session_id::text, agent_role, state,"
        " ended_at IS NOT NULL AS ended FROM sessions WHERE flavor = :'flavor'",
        flavor=flavor,
    )


def _events(flavor: str) -> list[dict[str, Any]]:
    return query_rows(
        "SELECT id::text, session_id::text, event_type, tool_name, payload"
        " FROM events WHERE flavor = :'flavor' ORDER BY occurred_at",
        flavor=flavor,
    )


def _ended(flavor: str, count: int) -> list[dict[str, Any]]:
    def done() -> bool:
        rows = _sessions(flavor)
        return len(rows) >= count and all(r["ended"] for r in rows)

    wait_until(done, timeout=STORED_TIMEOUT_SECS, msg=f"{flavor}: {count} sessions ended")
    return _sessions(flavor)


def _completion(
    *, content: str | None = None, tool_calls: list[dict[str, Any]] | None = None
) -> httpx.Response:
    message: dict[str, Any] = {"role": "assistant", "content": content}
    if tool_calls:
        message["tool_calls"] = tool_calls
    return httpx.Response(
        200,
        json={
            "id": "chatcmpl-it",
            "object": "chat.completion",
            "created": 1,
            "model": MODEL,
            "choices": [
                {
                    "index": 0,
                    "message": message,
                    "finish_reason": "tool_calls" if tool_calls else "stop",
                }
            ],
            "usage": {"prompt_tokens": 50, "completion_tokens": 10, "total_tokens": 60},
        },
    )


def _tool_call_then_answer() -> list[httpx.Response]:
    call = {
        "id": "call_1",
        "type": "function",
        "function": {"name": "multiply", "arguments": json.dumps({"a": 6, "b": 7})},
    }
    return [_completion(tool_calls=[call]), _completion(content="The answer is 42.")]


@pytest.fixture
def flavor() -> Iterator[str]:
    name = f"test-sensor-langgraph-{uuid.uuid4().hex[:10]}"
    _force_reset_sensor()
    os.environ["AGENT_FLAVOR"] = name
    try:
        yield name
    finally:
        os.environ.pop("AGENT_FLAVOR", None)
        with contextlib.suppress(Exception):
            flightdeck_sensor.teardown()
        _force_reset_sensor()
        delete_flavor_data(name)


@pytest.fixture
def lang() -> dict[str, Any]:
    """LangGraph and LangChain's pieces, imported by the test that needs
    them (a module-level import would put LangChain in every other test's
    process before its sensor classifies the frameworks)."""
    graph = pytest.importorskip("langgraph.graph")
    prebuilt = pytest.importorskip("langgraph.prebuilt")
    openai_chat = pytest.importorskip("langchain_openai")
    tools = pytest.importorskip("langchain_core.tools")
    runnables = pytest.importorskip("langchain_core.runnables")
    return {
        "StateGraph": graph.StateGraph,
        "MessagesState": graph.MessagesState,
        "START": graph.START,
        "END": graph.END,
        "ToolNode": prebuilt.ToolNode,
        "tools_condition": prebuilt.tools_condition,
        "ChatOpenAI": openai_chat.ChatOpenAI,
        "tool": tools.tool,
        "RunnableLambda": runnables.RunnableLambda,
    }


def _init(root: str) -> None:
    flightdeck_sensor.init(
        server=INGESTION_URL,
        token=TOKEN,
        session_id=root,
        agent_type="coding",
        capture_prompts=True,
        quiet=True,
    )
    flightdeck_sensor.patch(
        providers=[flightdeck_sensor.Provider.OPENAI, flightdeck_sensor.Provider.LANGGRAPH],
        quiet=True,
    )


def _multiply_tool(lang: dict[str, Any]) -> Any:
    def multiply(a: int, b: int) -> int:
        """Multiply two integers."""
        return a * b

    multiply.__annotations__ = {"a": int, "b": int, "return": int}
    return lang["tool"](multiply)


def _llm(lang: dict[str, Any]) -> Any:
    return lang["ChatOpenAI"](model=MODEL, api_key="test-key", max_retries=0)


def test_hand_built_graph_lands_a_child_per_node_run(flavor: str, lang: dict[str, Any]) -> None:
    root = str(uuid.uuid4())
    _init(root)
    multiply = _multiply_tool(lang)
    llm = _llm(lang).bind_tools([multiply])

    def call_model(state: dict[str, Any]) -> dict[str, Any]:
        return {"messages": [llm.invoke(state["messages"])]}

    graph = lang["StateGraph"](lang["MessagesState"])
    graph.add_node("model", call_model)
    graph.add_node("tools", lang["ToolNode"]([multiply]))
    graph.add_node("summarise", lang["RunnableLambda"](lambda state: {"messages": []}))
    graph.add_edge(lang["START"], "model")
    graph.add_conditional_edges(
        "model", lang["tools_condition"], {"tools": "tools", "__end__": "summarise"}
    )
    graph.add_edge("tools", "model")
    graph.add_edge("summarise", lang["END"])
    with respx.mock(assert_all_called=False) as router:
        router.post(OPENAI_CHAT_URL).mock(side_effect=_tool_call_then_answer())
        result = graph.compile().invoke({"messages": [("user", "What is 6 times 7?")]})
    assert result["messages"][-1].content == "The answer is 42."
    flightdeck_sensor.teardown()

    rows = _ended(flavor, 5)
    children = [r for r in rows if r["session_id"] != root]
    assert sorted(r["agent_role"] for r in children) == ["model", "model", "summarise", "tools"]
    assert {r["parent_session_id"] for r in children} == {root}
    assert {r["state"] for r in children} == {"closed"}

    def calls_stored() -> bool:
        return sum(1 for e in _events(flavor) if e["event_type"] == "post_call") == 2

    wait_until(calls_stored, timeout=STORED_TIMEOUT_SECS, msg="two post_calls stored")
    events = _events(flavor)
    # The children carry the structure only; the calls are the sensor's.
    for child in children:
        own = [e for e in events if e["session_id"] == child["session_id"]]
        assert {e["event_type"] for e in own} == {"session_start", "session_end"}, child
        (end,) = [e for e in own if e["event_type"] == "session_end"]
        assert "state" not in end["payload"], child
    calls = [e for e in events if e["event_type"] in ("post_call", "tool_call")]
    assert {e["session_id"] for e in calls} == {root}
    assert [e["tool_name"] for e in events if e["event_type"] == "tool_call"] == ["multiply"]


def test_create_agent_lands_no_child_sessions(flavor: str, lang: dict[str, Any]) -> None:
    """create_agent's model and tool nodes are the agent's own steps."""
    from langchain.agents import create_agent

    root = str(uuid.uuid4())
    _init(root)
    agent = create_agent(_llm(lang), [_multiply_tool(lang)])
    with respx.mock(assert_all_called=False) as router:
        router.post(OPENAI_CHAT_URL).mock(side_effect=_tool_call_then_answer())
        result = agent.invoke({"messages": [{"role": "user", "content": "What is 6 times 7?"}]})
    assert result["messages"][-1].content == "The answer is 42."
    flightdeck_sensor.teardown()

    (row,) = _ended(flavor, 1)
    assert row["session_id"] == root

    def calls_stored() -> bool:
        return sum(1 for e in _events(flavor) if e["event_type"] == "post_call") == 2

    wait_until(calls_stored, timeout=STORED_TIMEOUT_SECS, msg="two post_calls stored")
    assert {e["session_id"] for e in _events(flavor)} == {root}
    assert len(_sessions(flavor)) == 1


def test_graph_invoked_inside_a_node_nests_under_its_child(
    flavor: str, lang: dict[str, Any]
) -> None:
    root = str(uuid.uuid4())
    _init(root)
    state_graph, start, end = lang["StateGraph"], lang["START"], lang["END"]
    state = lang["MessagesState"]

    async def answer(s: dict[str, Any]) -> dict[str, Any]:
        return {"messages": [("assistant", "inner done")]}

    inner_graph = state_graph(state)
    inner_graph.add_node("inner", lang["RunnableLambda"](answer))
    inner_graph.add_edge(start, "inner")
    inner_graph.add_edge("inner", end)
    inner = inner_graph.compile()

    async def delegate(s: dict[str, Any]) -> dict[str, Any]:
        result: dict[str, Any] = await inner.ainvoke(s)
        return result

    outer_graph = state_graph(state)
    outer_graph.add_node("outer", delegate)
    outer_graph.add_edge(start, "outer")
    outer_graph.add_edge("outer", end)
    result = asyncio.run(outer_graph.compile().ainvoke({"messages": [("user", "go")]}))
    assert result["messages"][-1].content == "inner done"
    flightdeck_sensor.teardown()

    rows = _ended(flavor, 3)
    by_role = {r["agent_role"]: r for r in rows if r["agent_role"]}
    assert set(by_role) == {"outer", "inner"}
    assert by_role["outer"]["parent_session_id"] == root
    assert by_role["inner"]["parent_session_id"] == by_role["outer"]["session_id"]
    assert {r["state"] for r in by_role.values()} == {"closed"}


def test_interrupted_node_closes_its_child_and_resume_opens_another(
    flavor: str, lang: dict[str, Any]
) -> None:
    from langgraph.checkpoint.memory import InMemorySaver
    from langgraph.types import Command, interrupt

    root = str(uuid.uuid4())
    _init(root)

    def approve(s: dict[str, Any]) -> dict[str, Any]:
        return {"messages": [("assistant", interrupt("approve?"))]}

    graph = lang["StateGraph"](lang["MessagesState"])
    graph.add_node("approve", approve)
    graph.add_edge(lang["START"], "approve")
    graph.add_edge("approve", lang["END"])
    app = graph.compile(checkpointer=InMemorySaver())
    config = {"configurable": {"thread_id": f"thread-{root}"}}

    assert "__interrupt__" in app.invoke({"messages": [("user", "go")]}, config)
    assert app.invoke(Command(resume="approved"), config)["messages"][-1].content == "approved"
    flightdeck_sensor.teardown()

    rows = _ended(flavor, 3)
    children = [r for r in rows if r["session_id"] != root]
    assert [r["agent_role"] for r in children] == ["approve", "approve"]
    assert {r["parent_session_id"] for r in children} == {root}
    # The interrupt is LangGraph's control flow, not a failure: neither
    # child's session_end names an error state.
    child_ids = {r["session_id"] for r in children}
    ends = [
        e
        for e in _events(flavor)
        if e["event_type"] == "session_end" and e["session_id"] in child_ids
    ]
    assert len(ends) == 2
    assert all("state" not in e["payload"] and "error" not in e["payload"] for e in ends)
