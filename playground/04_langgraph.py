"""LangGraph -- minimal StateGraph routing through ChatAnthropic, plus
an MCP tool call routed through ``ToolNode``.

Proves the sensor's class-level patch survives LangGraph's dependency
chain: the graph compiles, runs, and the LLM node's call emits post_call
events just like a bare `ChatAnthropic().invoke()` would. The MCP
section drives ``ToolNode`` against tools loaded via
``langchain-mcp-adapters``; the sensor sees the call through the
patched ``ClientSession`` regardless of the surrounding graph runtime.

The Gemini section runs a tool loop built from a model node
(``ChatGoogleGenerativeAI`` on ``gemini-3.1-flash-lite`` with the tool
bound) and a ``ToolNode``, on a session of its own: one tool round, the
model asking for ``get_weather`` and then answering with its result. It
checks the model calls with ``assert_gemini_calls`` (one event pair per
billed request, ``provider=google``, the served model, each response's
tokens, the stored request and reply, a ``tool_call`` per function asked
for), the result passed back as a ``functionResponse``, and the graph:
one closed child session per node run, under the sensor's session,
carrying only its start and end. The counts are read from what the run
did. It skips without ``GEMINI_API_KEY`` (or ``GOOGLE_API_KEY``) and fails
when the key is set but ``langchain-google-genai`` is not installed.
"""

from __future__ import annotations

import asyncio
import os
import sys
import time
import uuid
from collections import Counter

try:
    from langchain_anthropic import ChatAnthropic
    from langgraph.graph import END, START, StateGraph
    from typing_extensions import TypedDict
except ImportError:
    print("SKIP: pip install langgraph langchain-anthropic")
    sys.exit(2)

import flightdeck_sensor

from _helpers import (
    MS_PER_S,
    assert_event_landed,
    assert_gemini_calls,
    child_sessions,
    fetch_events_for_session,
    init_sensor,
    mcp_server_params,
    print_result,
    stored_content_of,
)

# A current, cheap model the Gemini API serves to a new key.
GEMINI_MODEL = "gemini-3.1-flash-lite"
# Room for a tool call and a one-sentence answer.
GEMINI_MAX_TOKENS = 400
WEATHER_PROMPT = "What is the weather in Paris? Use the get_weather tool."
# The round's second request passes back the question, the model's call
# and the result: three contents.
TOOL_ROUND_CONTENTS = 3
# The graph's nodes, by name.
MODEL_NODE = "model"
TOOLS_NODE = "tools"


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
        "StateGraph.compile().invoke",
        True,
        int((time.monotonic() - t0) * 1000),
    )


def _run_mcp(session_id: str) -> None:
    """ToolNode driving an MCP-adapter tool. Skipped cleanly when
    ``langchain-mcp-adapters`` or ``mcp`` are missing."""
    try:
        import mcp  # noqa: F401  -- presence check
        from langchain_core.messages import AIMessage  # type: ignore[import-untyped]
        from langchain_mcp_adapters.client import MultiServerMCPClient  # type: ignore[import-untyped]
        from langgraph.graph import END, START, MessagesState, StateGraph  # type: ignore[import-untyped]
        from langgraph.prebuilt import ToolNode  # type: ignore[import-untyped]
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
        # LangGraph 1.x runs a ToolNode only inside a graph, which supplies
        # the runtime it needs; a one-node graph is the smallest such.
        graph = StateGraph(MessagesState)
        graph.add_node("tools", ToolNode(tools))
        graph.add_edge(START, "tools")
        graph.add_edge("tools", END)
        app = graph.compile()
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
        await app.ainvoke({"messages": [ai_msg]})
        print_result(
            "ToolNode in a graph: ainvoke(echo)",
            True,
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
    # MCP tool args are captured to event_content.tool_input (fetched via
    # /v1/events/:id/content), not inline in the event payload; the event
    # carries has_content=true to signal operators to fetch.
    args_ok = tcs[-1].get("has_content") is True and "arguments" not in payload
    tool_ok = tcs[-1].get("tool_name") == "echo"
    print_result("mcp payload.server_name", server_ok, 0)
    print_result("mcp args captured to event_content (not inline)", args_ok, 0)
    print_result("mcp tool_name=echo", tool_ok, 0)
    if not (server_ok and args_ok and tool_ok):
        raise AssertionError(f"mcp_tool_call payload mismatch: {tcs[-1]!r}")


def _check(label: str, ok: bool, detail: object = "") -> None:
    print_result(label, ok, 0, "" if ok else str(detail))
    if not ok:
        raise AssertionError(f"{label}: {detail}")


def _run_gemini() -> None:
    """A model node and a ``ToolNode`` on Gemini, one tool round, on a
    session of its own (see the module docstring)."""
    if not (os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")):
        print("  SKIP  Gemini section: GEMINI_API_KEY / GOOGLE_API_KEY is not set")
        return
    try:
        from langchain_core.tools import tool
        from langchain_google_genai import ChatGoogleGenerativeAI
        from langgraph.graph import MessagesState
        from langgraph.prebuilt import ToolNode, tools_condition
    except ImportError as exc:
        # With the key set, a missing package is a broken venv, not a
        # section to skip.
        raise AssertionError(
            f"GEMINI_API_KEY is set but the Gemini section cannot run: {exc}"
        ) from exc

    @tool
    def get_weather(city: str) -> str:
        """Returns the current weather in a city."""
        return f"sunny, 21 C in {city}"

    session_id = str(uuid.uuid4())
    init_sensor(session_id, flavor="playground-langgraph")
    flightdeck_sensor.patch(quiet=True)
    print(f"[playground:04_langgraph] gemini session_id={session_id}")
    llm = ChatGoogleGenerativeAI(model=GEMINI_MODEL, max_tokens=GEMINI_MAX_TOKENS)
    with_tools = llm.bind_tools([get_weather])

    def model(state: MessagesState) -> dict[str, list[object]]:
        return {"messages": [with_tools.invoke(state["messages"])]}

    graph = StateGraph(MessagesState)
    graph.add_node(MODEL_NODE, model)
    graph.add_node(TOOLS_NODE, ToolNode([get_weather]))
    graph.add_edge(START, MODEL_NODE)
    graph.add_conditional_edges(MODEL_NODE, tools_condition, {"tools": TOOLS_NODE, "__end__": END})
    graph.add_edge(TOOLS_NODE, MODEL_NODE)
    t0 = time.monotonic()
    try:
        result = graph.compile().invoke({"messages": [("user", WEATHER_PROMPT)]})
    finally:
        flightdeck_sensor.teardown()

    # One model request per AI message, one tool-node run per AI message
    # that asked for tools: the counts are what the run did.
    replies = [m for m in result["messages"] if m.type == "ai"]
    asked = [c["name"] for m in replies for c in m.tool_calls]
    tool_rounds = sum(bool(m.tool_calls) for m in replies)
    answered = "get_weather" in asked and bool(replies[-1].text)
    print_result(
        "a model node and a ToolNode on Gemini: one tool round",
        answered,
        int((time.monotonic() - t0) * MS_PER_S),
        f"{len(replies)} model calls, asked for {asked}",
    )
    if not answered:
        raise AssertionError(f"the graph did not ask for get_weather and answer: {result!r}")
    assert_gemini_calls(
        session_id,
        "LangGraph (Gemini)",
        requests=len(replies),
        replies={WEATHER_PROMPT: replies[0].text},
        asked=asked,
        thinking_calls=0,
        served_models={m.response_metadata.get("model_name") for m in replies},
    )
    stored_content_of(session_id, "functionResponse", "input", least=TOOL_ROUND_CONTENTS)
    print_result("the tool round's result is stored as a functionResponse", True, 0)

    # The graph: one closed child session per node run, under the
    # sensor's session, carrying only its start and end (the model calls
    # and the tool call stay on the sensor's session).
    runs = {MODEL_NODE: len(replies), TOOLS_NODE: tool_rounds}
    children = child_sessions(session_id, sum(runs.values()))
    _check(
        "one closed child session per node run, under the sensor's session",
        Counter(c.get("agent_role") for c in children) == Counter(runs)
        and all(c.get("ended_at") and c.get("parent_session_id") == session_id for c in children),
        [(c.get("agent_role"), c.get("ended_at")) for c in children],
    )
    kinds = [
        sorted(
            {
                e.get("event_type")
                for e in fetch_events_for_session(
                    c["session_id"], expect_event_types=["session_start", "session_end"]
                )
            }
        )
        for c in children
    ]
    _check(
        "each node's child carries its start and end only",
        all(k == ["session_end", "session_start"] for k in kinds),
        kinds,
    )


def main() -> None:
    session_id = str(uuid.uuid4())
    init_sensor(session_id, flavor="playground-langgraph")
    flightdeck_sensor.patch(quiet=True)
    print(f"[playground:04_langgraph] session_id={session_id}")

    _run_chat()
    assert_event_landed(session_id, "post_call", timeout=8)

    _run_mcp(session_id)

    flightdeck_sensor.teardown()

    _run_gemini()


if __name__ == "__main__":
    main()
