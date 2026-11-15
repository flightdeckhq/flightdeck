"""LangGraph Runnable nodes: child sessions per node of a hand-built graph.

Drives real LangGraph graphs on ``claude-haiku-4-5`` through the sensor's
LangGraph wrap, three runs:

1. **A hand-built tool loop** (sync): a ``RunnableLambda`` model node, a
   ``ToolNode`` and a ``RunnableLambda`` summarise node. Each node run
   lands as a closed child session of the sensor's session, role the
   node name, carrying only its start and end; the model calls and the
   ``multiply`` tool call stay on the sensor's session.
2. **A graph invoked inside a node** (async): an async ``delegate`` node
   awaits an inner graph whose ``inner_model`` node is a natively async
   ``RunnableCallable``; the inner node's child nests under the
   delegate's child.
3. **``create_agent``** doing run 1's work, under a second sensor
   session: its model and tool nodes are the agent's own steps, so no
   child session lands.

Self-skips (exit 2) without ``ANTHROPIC_API_KEY`` or without
``langgraph`` / ``langchain-anthropic``.
"""

from __future__ import annotations

import asyncio
import json
import sys
import time
import urllib.error
import urllib.request
import uuid
from typing import Any

from _helpers import (
    API_TOKEN,
    API_URL,
    fetch_events_for_session,
    init_sensor,
    print_result,
    require_env,
    wait_for_dev_stack,
)

FLAVOR = "playground-langgraph-runnable-nodes"
MODEL = "claude-haiku-4-5-20251001"
# Short answers keep the run cheap; the tool call needs a few tokens.
MAX_TOKENS = 200
# How long to wait for the worker to write the child sessions: the
# sensor posts them synchronously, the worker writes them in batches.
CHILDREN_DEADLINE_S = 25.0
CHILDREN_POLL_S = 0.4
# One sessions request never blocks longer than this, so the deadline
# above stays the only bound on the wait; a healthy API answers in ms.
SESSIONS_FETCH_TIMEOUT_S = 5.0
# A page of child sessions: the largest run here opens six children.
SESSIONS_PAGE_LIMIT = 50


def _children(parent_id: str, want: int) -> list[dict[str, Any]]:
    """The sessions whose parent is ``parent_id``, once ``want`` have
    landed (or what landed by the deadline)."""
    deadline = time.monotonic() + CHILDREN_DEADLINE_S
    rows: list[dict[str, Any]] = []
    while time.monotonic() < deadline:
        req = urllib.request.Request(
            f"{API_URL}/v1/sessions?parent_session_id={parent_id}&limit={SESSIONS_PAGE_LIMIT}",
            headers={"Authorization": f"Bearer {API_TOKEN}"},
        )
        try:
            with urllib.request.urlopen(req, timeout=SESSIONS_FETCH_TIMEOUT_S) as r:
                rows = json.loads(r.read()).get("sessions", [])
        except (urllib.error.URLError, OSError, ValueError):
            # Not answering yet, or not JSON yet: poll again until the
            # deadline, which reports what did land.
            rows = []
        if len(rows) >= want:
            return rows
        time.sleep(CHILDREN_POLL_S)
    return rows


def _check(label: str, ok: bool, details: str = "") -> None:
    print_result(label, ok, 0, details)
    if not ok:
        raise AssertionError(f"{label}: {details}")


def _structure_only(child: dict[str, Any]) -> None:
    """A child carries its start and end only, and ends without an error."""
    events = fetch_events_for_session(
        child["session_id"], expect_event_types=["session_start", "session_end"]
    )
    kinds = sorted({e.get("event_type") for e in events})
    _check(
        f"child {child['agent_role']} carries start and end only",
        kinds == ["session_end", "session_start"],
        f"saw {kinds}",
    )
    (end,) = [e for e in events if e.get("event_type") == "session_end"]
    payload = end.get("payload") or {}
    _check(
        f"child {child['agent_role']} closed without an error",
        "error" not in payload and payload.get("state") in (None, "closed"),
        f"payload state={payload.get('state')!r}",
    )


def main() -> None:
    require_env("ANTHROPIC_API_KEY")
    try:
        from langchain_anthropic import ChatAnthropic
        from langchain_core.runnables import RunnableLambda
        from langchain_core.tools import tool
        from langgraph._internal._runnable import RunnableCallable
        from langgraph.graph import END, START, MessagesState, StateGraph
        from langgraph.prebuilt import ToolNode, tools_condition
    except ImportError:
        print("SKIP: pip install langgraph langchain-anthropic")
        sys.exit(2)

    import flightdeck_sensor
    from flightdeck_sensor import Provider

    wait_for_dev_stack()

    @tool
    def multiply(a: int, b: int) -> int:
        """Multiply two integers."""
        return a * b

    llm = ChatAnthropic(model=MODEL, max_tokens=MAX_TOKENS)
    with_tools = llm.bind_tools([multiply])
    question = "Use the multiply tool to compute 6 times 7, then reply with the number only."

    # ---- 1 and 2: the hand-built graphs, under one sensor session -----
    root = str(uuid.uuid4())
    init_sensor(root, flavor=FLAVOR)
    flightdeck_sensor.patch(providers=[Provider.LANGGRAPH, Provider.ANTHROPIC], quiet=True)
    print(f"[playground:41_langgraph_runnable_nodes] session_id={root}")

    graph = StateGraph(MessagesState)
    graph.add_node(
        "model", RunnableLambda(lambda state: {"messages": [with_tools.invoke(state["messages"])]})
    )
    graph.add_node("tools", ToolNode([multiply]))
    graph.add_node("summarise", RunnableLambda(lambda state: {"messages": []}))
    graph.add_edge(START, "model")
    graph.add_conditional_edges(
        "model", tools_condition, {"tools": "tools", "__end__": "summarise"}
    )
    graph.add_edge("tools", "model")
    graph.add_edge("summarise", END)

    t0 = time.monotonic()
    result = graph.compile().invoke({"messages": [("user", question)]})
    print_result(
        "hand-built tool loop (RunnableLambda + ToolNode)",
        True,
        int((time.monotonic() - t0) * 1000),
    )
    answer = result["messages"][-1].content
    _check("the loop answered 42", "42" in str(answer), f"answer={answer!r}")

    async def ask(state: dict[str, Any]) -> dict[str, Any]:
        reply = await llm.ainvoke("Reply with the single word: nested.")
        return {"messages": [reply]}

    inner_graph = StateGraph(MessagesState)
    inner_graph.add_node("inner_model", RunnableCallable(None, ask))
    inner_graph.add_edge(START, "inner_model")
    inner_graph.add_edge("inner_model", END)
    inner = inner_graph.compile()

    async def delegate(state: dict[str, Any]) -> dict[str, Any]:
        nested: dict[str, Any] = await inner.ainvoke(state)
        return nested

    outer_graph = StateGraph(MessagesState)
    outer_graph.add_node("delegate", delegate)
    outer_graph.add_edge(START, "delegate")
    outer_graph.add_edge("delegate", END)

    t0 = time.monotonic()
    asyncio.run(outer_graph.compile().ainvoke({"messages": [("user", "go")]}))
    print_result("graph invoked inside an async node", True, int((time.monotonic() - t0) * 1000))
    flightdeck_sensor.teardown()

    children = _children(root, 5)
    roles = sorted(c.get("agent_role") or "" for c in children)
    tools_runs = roles.count("tools")
    _check(
        "one child per node run under the sensor's session",
        tools_runs >= 1
        and roles.count("model") == tools_runs + 1
        and roles.count("summarise") == 1
        and roles.count("delegate") == 1,
        f"roles={roles}",
    )
    for child in children:
        _structure_only(child)

    (delegate_child,) = [c for c in children if c.get("agent_role") == "delegate"]
    nested = _children(delegate_child["session_id"], 1)
    _check(
        "the inner graph's node nests under the delegate's child",
        [c.get("agent_role") for c in nested] == ["inner_model"],
        f"children of delegate={[c.get('agent_role') for c in nested]}",
    )
    _structure_only(nested[0])

    events = fetch_events_for_session(root, expect_event_types=["post_call", "tool_call"])
    posts = [e for e in events if e.get("event_type") == "post_call"]
    tool_calls = [e.get("tool_name") for e in events if e.get("event_type") == "tool_call"]
    _check(
        "the model calls and the tool call are on the sensor's session",
        len(posts) >= 3 and "multiply" in tool_calls,
        f"post_calls={len(posts)} tool_calls={tool_calls}",
    )

    # ---- 3: create_agent, under a second sensor session ----------------
    from langchain.agents import create_agent

    agent_root = str(uuid.uuid4())
    init_sensor(agent_root, flavor=FLAVOR)
    flightdeck_sensor.patch(providers=[Provider.LANGGRAPH, Provider.ANTHROPIC], quiet=True)
    print(f"[playground:41_langgraph_runnable_nodes] create_agent session_id={agent_root}")
    # A model built under this session: the first one's client belongs to
    # the session that teardown() ended.
    agent = create_agent(ChatAnthropic(model=MODEL, max_tokens=MAX_TOKENS), [multiply])
    t0 = time.monotonic()
    agent_result = agent.invoke({"messages": [{"role": "user", "content": question}]})
    print_result("create_agent run", True, int((time.monotonic() - t0) * 1000))
    flightdeck_sensor.teardown()

    agent_events = fetch_events_for_session(
        agent_root, expect_event_types=["post_call", "session_end"]
    )
    agent_posts = [e for e in agent_events if e.get("event_type") == "post_call"]
    _check(
        "create_agent's model calls are on its sensor session",
        len(agent_posts) >= 1 and "42" in str(agent_result["messages"][-1].content),
        f"post_calls={len(agent_posts)}",
    )
    # The model calls above have landed, and a child's start is posted
    # before the run's queued events, so a child would have landed too.
    req = urllib.request.Request(
        f"{API_URL}/v1/sessions?parent_session_id={agent_root}&limit={SESSIONS_PAGE_LIMIT}",
        headers={"Authorization": f"Bearer {API_TOKEN}"},
    )
    with urllib.request.urlopen(req, timeout=SESSIONS_FETCH_TIMEOUT_S) as r:
        agent_children = json.loads(r.read()).get("sessions", [])
    _check(
        "create_agent's steps open no child sessions",
        agent_children == [],
        f"children={[c.get('agent_role') for c in agent_children]}",
    )


if __name__ == "__main__":
    main()
