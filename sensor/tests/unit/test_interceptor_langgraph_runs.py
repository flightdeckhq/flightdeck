"""Unit tests for the LangGraph wrap's graph runs: a run of a compiled
graph started inside another graph run, or inside a child, opens a child
session; a top-level run opens none.

Covers the roles (the run's name, the graph's, the enclosing node's, the
generic one), the parents, the three trees the wrap is built for (a
compiled graph used as a node, an agent used as a tool, a Deep Agents
``task`` call), Deep Agents sync, async, streamed, compiled and parallel
sub-agents and a human-in-the-loop interrupt inside one, the ends (error,
interrupt, cancellation, an abandoned stream), the run's messages and the
capture gate, failing open, patching, posting off the event loop, and a
``RemoteGraph``, which runs in its server. Fake chat models only.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import contextlib
import json
import os
import sys
import threading
import time
import uuid
import warnings
from pathlib import Path
from typing import Any, TypedDict
from unittest.mock import MagicMock

import pytest

import flightdeck_sensor
from flightdeck_sensor.core.session import Session
from flightdeck_sensor.core.types import SensorConfig
from flightdeck_sensor.interceptor import langgraph as _langgraph_mod
from flightdeck_sensor.interceptor.langgraph import (
    patch_langgraph_classes,
    set_agent_node_pattern,
    unpatch_langgraph_classes,
)
from flightdeck_sensor.transport.client import ControlPlaneClient

# How long a test waits for child posts queued on a loop's executor, or
# for a post it holds back to be released; each is a call on a mock
# client, done in milliseconds once it may run.
_POSTS_WAIT_SECS = 10.0
# How long a test polls for a state another thread or task reaches (a post
# under way, a post queued): each is reached in milliseconds.
_STATE_DEADLINE_SECS = 10.0


async def _until(reached: Any, what: str) -> None:
    """Yield to the loop until ``reached()`` is true, failing after the
    deadline instead of hanging."""
    deadline = time.monotonic() + _STATE_DEADLINE_SECS
    while not reached():
        assert time.monotonic() < deadline, f"not reached: {what}"
        await asyncio.sleep(0)


class _TextState(TypedDict, total=False):
    text: str


def _build_session(*, capture_prompts: bool = True) -> tuple[Session, MagicMock]:
    config = SensorConfig(
        server="http://localhost:9999",
        token="tok",
        agent_id="33333333-3333-3333-3333-333333333333",
        agent_name="parent-langgraph",
        user_name="tester",
        hostname="host1",
        client_type="flightdeck_sensor",
        agent_flavor="playground-test",
        agent_type="production",
        capture_prompts=capture_prompts,
        quiet=True,
    )
    client = MagicMock(spec=ControlPlaneClient)
    client.post_event.return_value = (None, False)
    return Session(config=config, client=client), client


@pytest.fixture()
def patched() -> Any:
    if not _langgraph_mod._ensure_imported():
        pytest.skip("langgraph not installed")
    session, client = _build_session()
    prior = flightdeck_sensor._session
    flightdeck_sensor._session = session
    patch_langgraph_classes(quiet=True)
    try:
        yield session, client, _langgraph_mod._StateGraph
    finally:
        unpatch_langgraph_classes()
        flightdeck_sensor._session = prior
        set_agent_node_pattern(None)
        with contextlib.suppress(Exception):
            session.event_queue.close()


def _posts(client: MagicMock) -> list[dict[str, Any]]:
    return [call.args[0] for call in client.post_event.call_args_list]


def _starts(client: MagicMock) -> list[dict[str, Any]]:
    return [p for p in _posts(client) if p["event_type"] == "session_start"]


def _ends(client: MagicMock) -> list[dict[str, Any]]:
    return [p for p in _posts(client) if p["event_type"] == "session_end"]


def _tree(session: Session, client: MagicMock) -> list[tuple[str, str]]:
    """(role, parent role) per child in start order; the sensor's session
    is ``root``. Every child that started also ended."""
    starts = _starts(client)
    assert {p["session_id"] for p in _ends(client)} == {p["session_id"] for p in starts}
    roles = {session.config.session_id: "root"}
    roles.update({p["session_id"]: p["agent_role"] for p in starts})
    return [(p["agent_role"], roles[p["parent_session_id"]]) for p in starts]


@contextlib.contextmanager
def _unpatched() -> Any:
    """Build a graph as LangGraph alone would, inside a patched test: its
    nodes open no child, so only its runs are under test."""
    unpatch_langgraph_classes()
    try:
        yield
    finally:
        patch_langgraph_classes(quiet=True)


def _one_node_graph(StateGraph: Any, name: str, action: Any, schema: Any = None) -> Any:
    from langgraph.graph import END, START

    graph = StateGraph(schema or _TextState)
    graph.add_node(name, action)
    graph.add_edge(START, name)
    graph.add_edge(name, END)
    return graph


def _two_node_graph(StateGraph: Any) -> Any:
    from langgraph.graph import END, START

    graph = StateGraph(_TextState)
    graph.add_node("first", lambda state: {"text": state["text"] + "1"})
    graph.add_node("second", lambda state: {"text": state["text"] + "2"})
    graph.add_edge(START, "first")
    graph.add_edge("first", "second")
    graph.add_edge("second", END)
    return graph


def _fake_model(*replies: Any) -> Any:
    """A chat model answering with ``replies`` in turn, accepting tools."""
    from langchain_core.language_models.fake_chat_models import GenericFakeChatModel

    class _FakeToolModel(GenericFakeChatModel):
        def bind_tools(self, tools: Any, **kwargs: Any) -> Any:
            return self

    return _FakeToolModel(messages=iter(replies))


def _call(name: str, args: dict[str, Any], call_id: str = "call-1") -> Any:
    from langchain_core.messages import AIMessage

    return AIMessage(content="", tool_calls=[{"id": call_id, "name": name, "args": args}])


def _answer(text: str) -> Any:
    from langchain_core.messages import AIMessage

    return AIMessage(content=text)


def _lookup_tool() -> Any:
    from langchain_core.tools import tool

    @tool
    def lookup(query: str) -> str:
        """Look a query up."""
        return f"found {query}"

    return lookup


def _deepagents() -> Any:
    return pytest.importorskip("deepagents")


def _task(subagent: str, description: str, call_id: str = "task-1") -> Any:
    return _call("task", {"description": description, "subagent_type": subagent}, call_id)


def _researcher(**extra: Any) -> dict[str, Any]:
    return {
        "name": "researcher",
        "description": "Researches a question.",
        "system_prompt": "Research the question.",
        "tools": [_lookup_tool()],
        **extra,
    }


_QUESTION = {"messages": [{"role": "user", "content": "research q"}]}


# ----------------------------------------------------------------------
# Top-level runs open nothing
# ----------------------------------------------------------------------


async def test_top_level_runs_open_no_child_in_any_entry_point(patched: Any) -> None:
    _session, client, StateGraph = patched
    with _unpatched():
        app = _two_node_graph(StateGraph).compile()
    state = {"text": "in"}

    assert app.invoke(state) == {"text": "in12"}
    assert len(list(app.stream(state, stream_mode="updates"))) == 2
    assert await app.ainvoke(state) == {"text": "in12"}
    assert [c async for c in app.astream(state, stream_mode="values")][-1] == {"text": "in12"}
    assert [e async for e in app.astream_events(state, version="v2")]
    with warnings.catch_warnings():
        # The v3 stream protocol is LangGraph's beta.
        warnings.simplefilter("ignore")
        assert list(app.stream_events(state, version="v3"))
    assert client.post_event.call_count == 0


def test_top_level_create_agent_opens_no_child(patched: Any) -> None:
    _session, client, _StateGraph = patched
    from langchain.agents import create_agent

    agent = create_agent(_fake_model(_answer("done")), [], name="solo")

    assert agent.invoke(_QUESTION)["messages"][-1].content == "done"
    assert client.post_event.call_count == 0


# ----------------------------------------------------------------------
# Nested runs: roles and parents
# ----------------------------------------------------------------------


def test_named_graph_run_inside_a_node_is_named_after_the_graph(patched: Any) -> None:
    session, client, StateGraph = patched
    inner = _two_node_graph(StateGraph)
    with _unpatched():
        inner_app = inner.compile(name="researcher")
        outer = _one_node_graph(StateGraph, "delegate", lambda s: inner_app.invoke(s)).compile()

    assert outer.invoke({"text": "in"}) == {"text": "in12"}
    # The inner graph's nodes were built patched: they nest under its run.
    assert _tree(session, client) == [
        ("researcher", "root"),
        ("first", "researcher"),
        ("second", "researcher"),
    ]
    (start,) = [p for p in _starts(client) if p["agent_role"] == "researcher"]
    assert start["agent_name"] == "parent-langgraph/researcher"
    assert start["agent_id"] == session.derive_subagent_id("researcher")


def test_unnamed_graph_run_takes_the_enclosing_node_name(patched: Any) -> None:
    session, client, StateGraph = patched
    with _unpatched():
        inner = _two_node_graph(StateGraph).compile()
        outer = _one_node_graph(StateGraph, "delegate", lambda s: inner.invoke(s)).compile()

    outer.invoke({"text": "in"})
    assert _tree(session, client) == [("delegate", "root")]


def test_run_name_in_the_config_names_the_run(patched: Any) -> None:
    session, client, StateGraph = patched
    with _unpatched():
        inner = _two_node_graph(StateGraph).compile(name="graph_name")
        bound = _two_node_graph(StateGraph).compile().with_config(run_name="bound_name")

        def delegate(state: dict[str, Any]) -> dict[str, Any]:
            inner.invoke(state, {"run_name": "call_name"})
            result: dict[str, Any] = bound.invoke(state)
            return result

        outer = _one_node_graph(StateGraph, "delegate", delegate).compile()

    outer.invoke({"text": "in"})
    assert _tree(session, client) == [("call_name", "root"), ("bound_name", "root")]


def test_run_inside_a_child_with_no_graph_task_gets_the_generic_role(patched: Any) -> None:
    """A graph run started inside another framework's child (here, a scope
    entered by hand) nests under it; unnamed and in no node, its role is
    the generic one."""
    session, client, StateGraph = patched
    with _unpatched():
        app = _two_node_graph(StateGraph).compile()
    scope = session.new_subagent_scope(
        child_session_id=str(uuid.uuid4()),
        child_agent_id=session.derive_subagent_id("crew_agent"),
        child_agent_name="parent-langgraph/crew_agent",
        agent_role="crew_agent",
    )
    token = session.enter_subagent_scope(scope)
    try:
        assert app.invoke({"text": "in"}) == {"text": "in12"}
    finally:
        session.exit_subagent_scope(token)

    (start,) = _starts(client)
    assert start["agent_role"] == "subgraph"
    assert start["parent_session_id"] == scope.child_session_id


async def test_async_nested_runs_nest_and_post_off_the_loop(patched: Any) -> None:
    session, client, StateGraph = patched
    loop_thread = threading.get_ident()
    threads: list[int] = []

    def post(payload: dict[str, Any], **kwargs: Any) -> tuple[None, bool]:
        threads.append(threading.get_ident())
        return None, False

    client.post_event.side_effect = post
    leaf = _two_node_graph(StateGraph).compile(name="leaf")

    async def call_leaf(state: dict[str, Any]) -> dict[str, Any]:
        result: dict[str, Any] = await leaf.ainvoke(state)
        return result

    middle = _one_node_graph(StateGraph, "call_leaf", call_leaf).compile(name="middle")
    with _unpatched():

        async def call_middle(state: dict[str, Any]) -> dict[str, Any]:
            chunks = [c async for c in middle.astream(state, stream_mode="values")]
            result: dict[str, Any] = chunks[-1]
            return result

        outer = _one_node_graph(StateGraph, "call_middle", call_middle).compile()

    assert await outer.ainvoke({"text": "in"}) == {"text": "in12"}
    assert _tree(session, client) == [
        ("middle", "root"),
        ("call_leaf", "middle"),
        ("leaf", "call_leaf"),
        ("first", "leaf"),
        ("second", "leaf"),
    ]
    assert threads and loop_thread not in threads


# ----------------------------------------------------------------------
# The three trees
# ----------------------------------------------------------------------


def _compiled_node_cases(StateGraph: Any) -> dict[str, tuple[Any, str]]:
    """Node name -> (compiled graph, the role its run gets)."""
    return {
        "sub": (_two_node_graph(StateGraph).compile(), "sub"),
        "named": (_two_node_graph(StateGraph).compile(name="researcher"), "researcher"),
        "bound": (_two_node_graph(StateGraph).compile().with_retry(), "bound"),
    }


def test_compiled_graph_node_gets_one_child_named_unnamed_and_bound(patched: Any) -> None:
    """root -> <the run> -> first, second: one child for the compiled
    graph, whether named, unnamed or bound."""
    session, client, StateGraph = patched
    for node, (inner, role) in _compiled_node_cases(StateGraph).items():
        graph = _one_node_graph(StateGraph, node, inner)
        assert graph.nodes[node].runnable is inner, node
        client.post_event.reset_mock()
        assert graph.compile().invoke({"text": "in"}) == {"text": "in12"}
        assert _tree(session, client) == [(role, "root"), ("first", role), ("second", role)]


async def test_async_compiled_graph_node_gets_one_child(patched: Any) -> None:
    session, client, StateGraph = patched
    for node, (inner, role) in _compiled_node_cases(StateGraph).items():
        client.post_event.reset_mock()
        app = _one_node_graph(StateGraph, node, inner).compile()
        assert await app.ainvoke({"text": "in"}) == {"text": "in12"}
        assert _tree(session, client) == [(role, "root"), ("first", role), ("second", role)]


def test_agent_used_as_a_tool_gets_one_child_under_the_tools_node(patched: Any) -> None:
    """A create_agent graph invoked from a tool a hand-built ToolNode runs:

    root
    ├── model
    ├── tools
    │   └── expert   (the agent's run; its own steps open nothing)
    └── model
    """
    session, client, StateGraph = patched
    from langchain.agents import create_agent
    from langchain_core.tools import tool
    from langgraph.graph import START, MessagesState
    from langgraph.prebuilt import ToolNode, tools_condition

    expert = create_agent(_fake_model(_answer("expert answer")), [], name="expert")

    @tool
    def ask_expert(question: str) -> str:
        """Ask the expert."""
        reply = expert.invoke({"messages": [{"role": "user", "content": question}]})
        return str(reply["messages"][-1].content)

    model = _fake_model(_call("ask_expert", {"question": "q"}), _answer("done"))

    def call_model(state: dict[str, Any]) -> dict[str, Any]:
        return {"messages": [model.invoke(state["messages"])]}

    graph = StateGraph(MessagesState)
    graph.add_node("model", call_model)
    graph.add_node("tools", ToolNode([ask_expert]))
    graph.add_edge(START, "model")
    graph.add_conditional_edges("model", tools_condition)
    graph.add_edge("tools", "model")

    result = graph.compile().invoke(_QUESTION)

    assert result["messages"][-1].content == "done"
    assert result["messages"][-2].content == "expert answer"
    assert _tree(session, client) == [
        ("model", "root"),
        ("tools", "root"),
        ("expert", "tools"),
        ("model", "root"),
    ]


def test_deep_agents_task_call_gets_one_child_named_after_the_sub_agent(patched: Any) -> None:
    """root -> researcher, and nothing else: the task call runs inside
    create_agent's tools node, which has no child of its own."""
    session, client, _StateGraph = patched
    deepagents = _deepagents()
    model = _fake_model(
        _task("researcher", "research q"),
        _call("lookup", {"query": "q"}, "lookup-1"),
        _answer("researched"),
        _answer("all done"),
    )
    agent = deepagents.create_deep_agent(model=model, tools=[], subagents=[_researcher()])

    result = agent.invoke(_QUESTION)

    assert result["messages"][-1].content == "all done"
    assert _tree(session, client) == [("researcher", "root")]
    (start,) = _starts(client)
    (end,) = _ends(client)
    # The sub-agent's input state, with the task description as its message.
    (incoming,) = start["incoming_message"]["body"]["messages"]
    assert incoming["content"] == "research q"
    # Its final state: the answer it hands back.
    assert end["outgoing_message"]["body"]["messages"][-1]["content"] == "researched"
    assert "state" not in end


# ----------------------------------------------------------------------
# Deep Agents
# ----------------------------------------------------------------------


async def test_deep_agents_async_and_streamed_runs(patched: Any) -> None:
    session, client, _StateGraph = patched
    deepagents = _deepagents()

    def agent() -> Any:
        model = _fake_model(
            _task("researcher", "research q"),
            _answer("researched"),
            _answer("all done"),
        )
        return deepagents.create_deep_agent(model=model, tools=[], subagents=[_researcher()])

    result = await agent().ainvoke(_QUESTION)
    assert result["messages"][-1].content == "all done"
    assert _tree(session, client) == [("researcher", "root")]

    client.post_event.reset_mock()
    updates = [c async for c in agent().astream(_QUESTION, stream_mode="updates")]
    assert updates
    assert _tree(session, client) == [("researcher", "root")]

    client.post_event.reset_mock()
    assert list(agent().stream(_QUESTION, stream_mode="values"))[-1]["messages"]
    assert _tree(session, client) == [("researcher", "root")]


def test_deep_agents_compiled_sub_agent_is_named_after_it(patched: Any) -> None:
    """A CompiledSubAgent's graph is unnamed; Deep Agents gives its run
    the sub-agent's name. Its hand-built node nests under it.

    root
    └── worker
        └── work
    """
    session, client, StateGraph = patched
    deepagents = _deepagents()
    from langgraph.graph import MessagesState

    worker = _one_node_graph(
        StateGraph, "work", lambda s: {"messages": [_answer("worked")]}, MessagesState
    ).compile()
    model = _fake_model(_task("worker", "do the work"), _answer("all done"))
    agent = deepagents.create_deep_agent(
        model=model,
        tools=[],
        subagents=[{"name": "worker", "description": "Does work.", "runnable": worker}],
    )

    assert agent.invoke(_QUESTION)["messages"][-1].content == "all done"
    assert _tree(session, client) == [("worker", "root"), ("work", "worker")]


async def test_deep_agents_parallel_task_calls_get_one_child_each(patched: Any) -> None:
    session, client, _StateGraph = patched
    deepagents = _deepagents()
    from langchain_core.messages import AIMessage

    writer = {
        "name": "writer",
        "description": "Writes.",
        "system_prompt": "Write.",
        "tools": [],
    }

    def agent() -> Any:
        both = AIMessage(
            content="",
            tool_calls=[
                {
                    "id": "task-r",
                    "name": "task",
                    "args": {"description": "research", "subagent_type": "researcher"},
                },
                {
                    "id": "task-w",
                    "name": "task",
                    "args": {"description": "write", "subagent_type": "writer"},
                },
            ],
        )
        # Each sub-agent gets its own model, so the replies cannot cross.
        main = _fake_model(both, _answer("all done"))
        return deepagents.create_deep_agent(
            model=main,
            tools=[],
            subagents=[
                _researcher(model=_fake_model(_answer("researched"))),
                {**writer, "model": _fake_model(_answer("written"))},
            ],
        )

    assert agent().invoke(_QUESTION)["messages"][-1].content == "all done"
    assert sorted(_tree(session, client)) == [("researcher", "root"), ("writer", "root")]
    assert len({p["session_id"] for p in _starts(client)}) == 2

    client.post_event.reset_mock()
    result = await agent().ainvoke(_QUESTION)
    assert result["messages"][-1].content == "all done"
    assert sorted(_tree(session, client)) == [("researcher", "root"), ("writer", "root")]
    outgoing = {
        p["agent_role"]: p["outgoing_message"]["body"]["messages"][-1]["content"]
        for p in _ends(client)
    }
    assert outgoing == {"researcher": "researched", "writer": "written"}


def test_deep_agents_interrupt_inside_a_sub_agent_and_resume(patched: Any) -> None:
    """A human-in-the-loop interrupt inside the sub-agent closes its child
    normally; the resume runs the sub-agent again, under a new child."""
    session, client, _StateGraph = patched
    deepagents = _deepagents()
    from langgraph.checkpoint.memory import InMemorySaver
    from langgraph.types import Command

    sub_model = _fake_model(_call("lookup", {"query": "q"}, "lookup-1"), _answer("researched"))
    model = _fake_model(_task("researcher", "research q"), _answer("all done"))
    agent = deepagents.create_deep_agent(
        model=model,
        tools=[],
        subagents=[_researcher(model=sub_model, interrupt_on={"lookup": True})],
        checkpointer=InMemorySaver(),
    )
    config = {"configurable": {"thread_id": "thread-hitl"}}

    first = agent.invoke(_QUESTION, config)
    assert "__interrupt__" in first
    (first_end,) = _ends(client)
    assert "state" not in first_end and "error" not in first_end
    assert "outgoing_message" not in first_end

    resumed = agent.invoke(Command(resume={"decisions": [{"type": "approve"}]}), config)
    assert resumed["messages"][-1].content == "all done"
    assert _tree(session, client) == [("researcher", "root"), ("researcher", "root")]
    starts = _starts(client)
    assert starts[0]["session_id"] != starts[1]["session_id"]
    last_end = _ends(client)[-1]
    assert last_end["outgoing_message"]["body"]["messages"][-1]["content"] == "researched"


# ----------------------------------------------------------------------
# Ends
# ----------------------------------------------------------------------


def test_failed_nested_run_ends_in_error_and_keeps_its_exception(patched: Any) -> None:
    session, client, StateGraph = patched

    def fail(state: dict[str, Any]) -> dict[str, Any]:
        raise ValueError("inner node failed")

    with _unpatched():
        inner = _one_node_graph(StateGraph, "fails", fail).compile(name="inner")
        outer = _one_node_graph(StateGraph, "delegate", lambda s: inner.invoke(s)).compile()

    with pytest.raises(ValueError, match="inner node failed"):
        outer.invoke({"text": "in"})
    (end,) = _ends(client)
    assert end["agent_role"] == "inner"
    assert end["state"] == "error"
    assert end["error"] == {"type": "ValueError", "message": "inner node failed"}


def test_interrupt_inside_a_nested_run_closes_its_child_normally(patched: Any) -> None:
    _session, client, StateGraph = patched
    from langgraph.checkpoint.memory import InMemorySaver
    from langgraph.types import interrupt

    def ask(state: dict[str, Any]) -> dict[str, Any]:
        return {"text": interrupt("approve?")}

    with _unpatched():
        inner = _one_node_graph(StateGraph, "ask", ask).compile(name="inner")
        outer = _one_node_graph(StateGraph, "delegate", lambda s: inner.invoke(s)).compile(
            checkpointer=InMemorySaver()
        )

    first = outer.invoke({"text": "in"}, {"configurable": {"thread_id": "t-1"}})
    assert "__interrupt__" in first
    (end,) = _ends(client)
    assert end["agent_role"] == "inner"
    assert "state" not in end and "error" not in end


def test_abandoned_sync_stream_closes_its_child(patched: Any) -> None:
    _session, client, StateGraph = patched
    with _unpatched():
        inner = _two_node_graph(StateGraph).compile(name="inner")

        def take_first(state: dict[str, Any]) -> dict[str, Any]:
            stream = inner.stream(state, stream_mode="updates")
            first: dict[str, Any] = next(stream)["first"]
            stream.close()
            return first

        outer = _one_node_graph(StateGraph, "delegate", take_first).compile()

    assert outer.invoke({"text": "in"}) == {"text": "in1"}
    (start,) = _starts(client)
    (end,) = _ends(client)
    assert end["session_id"] == start["session_id"]
    assert "state" not in end and "outgoing_message" not in end


async def test_abandoned_async_stream_closes_its_child(patched: Any) -> None:
    _session, client, StateGraph = patched
    with _unpatched():
        inner = _two_node_graph(StateGraph).compile(name="inner")

        async def take_first(state: dict[str, Any]) -> dict[str, Any]:
            stream = inner.astream(state, stream_mode="updates")
            first: dict[str, Any] = (await stream.__anext__())["first"]
            await stream.aclose()
            return first

        outer = _one_node_graph(StateGraph, "delegate", take_first).compile()

    assert await outer.ainvoke({"text": "in"}) == {"text": "in1"}
    session = flightdeck_sensor._session
    assert await asyncio.to_thread(session.wait_child_posts, _POSTS_WAIT_SECS)
    (start,) = _starts(client)
    (end,) = _ends(client)
    assert end["session_id"] == start["session_id"]
    assert "state" not in end and "outgoing_message" not in end


async def test_cancelled_async_run_ends_its_child_in_error(patched: Any) -> None:
    session, client, StateGraph = patched
    entered = asyncio.Event()

    async def wait_forever(state: dict[str, Any]) -> dict[str, Any]:
        entered.set()
        await asyncio.Event().wait()
        return {"text": "never"}

    with _unpatched():
        inner = _one_node_graph(StateGraph, "waits", wait_forever).compile(name="inner")
    scope = session.new_subagent_scope(
        child_session_id=str(uuid.uuid4()),
        child_agent_id=session.derive_subagent_id("outer"),
        child_agent_name="parent-langgraph/outer",
        agent_role="outer",
    )
    token = session.enter_subagent_scope(scope)
    try:
        task = asyncio.ensure_future(inner.ainvoke({"text": "in"}))
    finally:
        session.exit_subagent_scope(token)
    await entered.wait()
    task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await task
    assert await asyncio.to_thread(session.wait_child_posts, _POSTS_WAIT_SECS)
    (end,) = _ends(client)
    assert end["state"] == "error"
    assert end["error"]["type"] == "CancelledError"


# ----------------------------------------------------------------------
# Messages and the capture gate
# ----------------------------------------------------------------------


def test_run_messages_are_its_input_and_its_final_state(patched: Any) -> None:
    """invoke streams (mode, chunk) pairs; the outgoing message is the last
    full state, not a pair. So it is for a v2 stream (its parts carry the
    enclosing task's namespace) and for a run streaming its sub-graphs
    too, whose deeper states are not its own; a run streaming updates only
    hands back its last chunk."""
    _session, client, StateGraph = patched
    with _unpatched():
        inner = _two_node_graph(StateGraph).compile(name="inner")
        wrapping = _one_node_graph(StateGraph, "nested", inner).compile(name="wrapping")

        def delegate(state: dict[str, Any]) -> dict[str, Any]:
            inner.invoke(state)
            list(inner.stream(state, stream_mode="updates"))
            list(inner.stream(state, stream_mode="values", version="v2"))
            list(wrapping.stream(state, stream_mode=["values", "updates"], subgraphs=True))
            return {"text": "done"}

        outer = _one_node_graph(StateGraph, "delegate", delegate).compile()

    outer.invoke({"text": "in"})
    ends = {p["agent_role"]: p for p in _ends(client)}
    assert [p["agent_role"] for p in _starts(client)] == [
        "inner",
        "inner",
        "inner",
        "wrapping",
        "inner",
    ]
    assert {p["incoming_message"]["body"]["text"] for p in _starts(client)} == {"in"}
    outgoing = [p["outgoing_message"]["body"] for p in _ends(client)]
    assert outgoing[:3] == [{"text": "in12"}, {"second": {"text": "in12"}}, {"text": "in12"}]
    assert ends["wrapping"]["outgoing_message"]["body"] == {"text": "in12"}


def test_capture_off_drops_the_run_messages_and_error_text(patched: Any) -> None:
    session, client, StateGraph = patched
    session.config.capture_prompts = False

    def fail(state: dict[str, Any]) -> dict[str, Any]:
        raise ValueError("the secret state")

    with _unpatched():
        ok = _two_node_graph(StateGraph).compile(name="ok")
        failing = _one_node_graph(StateGraph, "fails", fail).compile(name="failing")

        def delegate(state: dict[str, Any]) -> dict[str, Any]:
            ok.invoke(state)
            with contextlib.suppress(ValueError):
                failing.invoke(state)
            return {"text": "done"}

        outer = _one_node_graph(StateGraph, "delegate", delegate).compile()

    outer.invoke({"text": "the secret input"})
    posts = _posts(client)
    assert len(posts) == 4
    assert all("incoming_message" not in p and "outgoing_message" not in p for p in posts)
    assert _ends(client)[1]["error"] == {"type": "ValueError"}
    assert "secret" not in str(posts)


# ----------------------------------------------------------------------
# Failing open
# ----------------------------------------------------------------------


async def test_a_run_whose_child_cannot_be_opened_runs_unchanged(
    patched: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    _session, client, StateGraph = patched

    def broken(graph: Any, config: Any) -> str:
        raise RuntimeError("cannot name the run")

    monkeypatch.setattr(_langgraph_mod, "_run_role", broken)
    with _unpatched():
        inner = _two_node_graph(StateGraph).compile()

        async def delegate(state: dict[str, Any]) -> dict[str, Any]:
            first: dict[str, Any] = inner.invoke(state)
            second: dict[str, Any] = await inner.ainvoke(first)
            return second

        outer = _one_node_graph(StateGraph, "delegate", delegate).compile()

    assert await outer.ainvoke({"text": "in"}) == {"text": "in1212"}
    assert client.post_event.call_count == 0


async def test_failed_posts_never_reach_a_run(patched: Any) -> None:
    _session, client, StateGraph = patched
    client.post_event.side_effect = RuntimeError("control plane down")
    with _unpatched():
        inner = _two_node_graph(StateGraph).compile(name="inner")

        async def delegate(state: dict[str, Any]) -> dict[str, Any]:
            first: dict[str, Any] = await asyncio.to_thread(inner.invoke, state)
            second: dict[str, Any] = await inner.ainvoke(first)
            return second

        outer = _one_node_graph(StateGraph, "delegate", delegate).compile()

    assert await outer.ainvoke({"text": "in"}) == {"text": "in1212"}
    assert client.post_event.call_count == 4


# ----------------------------------------------------------------------
# Patching
# ----------------------------------------------------------------------


def test_patch_is_idempotent_and_unpatch_restores_the_originals(patched: Any) -> None:
    _session, client, StateGraph = patched
    from langgraph.pregel import Pregel

    patched_stream, patched_astream = Pregel.stream, Pregel.astream
    patch_langgraph_classes(quiet=True)
    assert (Pregel.stream, Pregel.astream) == (patched_stream, patched_astream)
    original_stream = patched_stream.__wrapped__
    original_astream = patched_astream.__wrapped__

    unpatch_langgraph_classes()
    unpatch_langgraph_classes()
    try:
        assert Pregel.stream is original_stream
        assert Pregel.astream is original_astream
        inner = _two_node_graph(StateGraph).compile(name="inner")
        outer = _one_node_graph(StateGraph, "delegate", lambda s: inner.invoke(s)).compile()
        assert outer.invoke({"text": "in"}) == {"text": "in12"}
        assert client.post_event.call_count == 0
    finally:
        patch_langgraph_classes(quiet=True)


# ----------------------------------------------------------------------
# Posting
# ----------------------------------------------------------------------


async def test_sync_run_on_the_loop_thread_posts_off_the_loop(patched: Any) -> None:
    """A sync invoke inside a coroutine runs on the loop's thread; its
    child's posts are queued, not made there."""
    session, client, StateGraph = patched
    loop_thread = threading.get_ident()
    threads: list[int] = []

    def post(payload: dict[str, Any], **kwargs: Any) -> tuple[None, bool]:
        threads.append(threading.get_ident())
        return None, False

    client.post_event.side_effect = post
    with _unpatched():
        inner = _two_node_graph(StateGraph).compile(name="inner")

        async def delegate(state: dict[str, Any]) -> dict[str, Any]:
            result: dict[str, Any] = inner.invoke(state)
            return result

        outer = _one_node_graph(StateGraph, "delegate", delegate).compile()

    assert await outer.ainvoke({"text": "in"}) == {"text": "in12"}
    assert await asyncio.to_thread(session.wait_child_posts, _POSTS_WAIT_SECS)
    assert [p["event_type"] for p in _posts(client)] == ["session_start", "session_end"]
    assert len(threads) == 2 and loop_thread not in threads


async def test_end_queued_during_its_start_post_holds_no_thread(patched: Any) -> None:
    """A node cancelled while its start is still being posted queues its
    end from the start post's completion: no executor thread waits for
    the start, and the end still follows it."""
    session, client, StateGraph = patched
    loop = asyncio.get_running_loop()
    # Two workers: the held start post takes one; an end waiting for it in
    # the other would leave none for the probe below.
    executor = concurrent.futures.ThreadPoolExecutor(max_workers=2)
    loop.set_default_executor(executor)
    release = threading.Event()
    start_posting = threading.Event()
    order: list[str] = []

    def post(payload: dict[str, Any], **kwargs: Any) -> tuple[None, bool]:
        if payload["event_type"] == "session_start":
            start_posting.set()
            release.wait(_POSTS_WAIT_SECS)
        order.append(payload["event_type"])
        return None, False

    client.post_event.side_effect = post

    async def node(state: dict[str, Any]) -> dict[str, Any]:
        return {"text": "out"}

    graph = _one_node_graph(StateGraph, "node", node)
    try:
        task = asyncio.ensure_future(graph.nodes["node"].runnable.afunc({"text": "in"}))
        await _until(start_posting.is_set, "the start post under way")
        task.cancel()
        # The cancelled node queues its end (the session tracks the start
        # and the end), then waits for it, shielded, so the task is not
        # awaited until the start is released.
        await _until(lambda: len(session._pending_child_posts) == 2, "the end queued")

        probe = loop.run_in_executor(None, lambda: "a worker is free")
        assert await asyncio.wait_for(probe, _POSTS_WAIT_SECS) == "a worker is free"
        assert order == []
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert await asyncio.to_thread(session.wait_child_posts, _POSTS_WAIT_SECS)
        assert order == ["session_start", "session_end"]
        (end,) = _ends(client)
        assert end["error"]["type"] == "CancelledError"
    finally:
        release.set()
        executor.shutdown(wait=False)


# ----------------------------------------------------------------------
# RemoteGraph
# ----------------------------------------------------------------------


def test_remote_graph_run_opens_no_child(patched: Any) -> None:
    """A RemoteGraph runs in its server: it is not a Pregel, so its run
    never reaches the patched stream, and as a node it is left alone."""
    _session, client, StateGraph = patched
    from langgraph.pregel import Pregel
    from langgraph.pregel.remote import RemoteGraph
    from langgraph_sdk.schema import StreamPart

    class _Runs:
        def stream(self, *args: Any, **kwargs: Any) -> Any:
            yield StreamPart(event="values", data={"text": "remote"})

    class _Client:
        runs = _Runs()

    remote = RemoteGraph("agent", sync_client=_Client())  # type: ignore[arg-type]
    graph = _one_node_graph(StateGraph, "remote", remote)

    assert not isinstance(remote, Pregel)
    assert graph.nodes["remote"].runnable is remote
    assert graph.compile().invoke({"text": "in"}) == {"text": "remote"}
    assert client.post_event.call_count == 0


# ----------------------------------------------------------------------
# Review fixes
# ----------------------------------------------------------------------


def test_streams_left_open_at_loop_shutdown_close_quietly(patched: Any) -> None:
    """asyncio closes every async generator still open when its loop shuts
    down, all at once: a top-level and a nested stream left open then
    close without an error reaching the loop, and the nested run's child
    still ends."""
    session, client, StateGraph = patched
    held: list[Any] = []
    with _unpatched():
        top = _two_node_graph(StateGraph).compile(name="top")
        inner = _two_node_graph(StateGraph).compile(name="inner")

        async def hold(state: dict[str, Any]) -> dict[str, Any]:
            stream = inner.astream(state, stream_mode="updates")
            await stream.__anext__()
            held.append(stream)
            return {}

        outer = _one_node_graph(StateGraph, "outer", hold).compile()
    errors: list[dict[str, Any]] = []

    consuming = asyncio.Event()

    async def consume() -> None:
        # Left streaming: asyncio.run cancels it, and its stream is
        # collected unclosed.
        async for _ in top.astream({"text": "in"}, stream_mode="updates"):
            consuming.set()
            await asyncio.Event().wait()

    async def main() -> None:
        asyncio.get_running_loop().set_exception_handler(lambda loop, ctx: errors.append(ctx))
        stream = top.astream({"text": "in"}, stream_mode="updates")
        await stream.__anext__()
        held.append(stream)
        await outer.ainvoke({"text": "in"})
        held.append(asyncio.ensure_future(consume()))
        await consuming.wait()

    asyncio.run(main())

    assert errors == []
    assert session.wait_child_posts(_POSTS_WAIT_SECS)
    assert _tree(session, client) == [("inner", "root")]
    (end,) = _ends(client)
    assert "state" not in end and "outgoing_message" not in end


# The ways an application closes a stream: awaited in its own coroutine,
# or run as a task of its own by asyncio's helpers.
_CLOSES: dict[str, Any] = {
    "await": lambda close: close,
    "gather": asyncio.gather,
    "create_task": asyncio.ensure_future,
    "shield": asyncio.shield,
    "wait_for": lambda close: asyncio.wait_for(close, _POSTS_WAIT_SECS),
}


def _slow_graph_closer(StateGraph: Any) -> Any:
    """A graph whose node waits until cancelled, and a coroutine function
    that streams it, closes the stream once the node runs (``how``: a key
    of _CLOSES) and returns what LangGraph's clean-up had done when the
    close returned: the run's error callbacks and whether the node was
    cancelled. Built unpatched, so only the run is under test."""
    from langchain_core.callbacks import AsyncCallbackHandler
    from langgraph.config import get_stream_writer

    node: dict[str, bool] = {}

    async def slow(state: dict[str, Any]) -> dict[str, Any]:
        node["started"] = True
        get_stream_writer()({"started": True})
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            node["cancelled"] = True
            raise
        return {"text": "never"}

    class _Ends(AsyncCallbackHandler):
        def __init__(self) -> None:
            self.errors: list[str] = []

        async def on_chain_error(self, error: BaseException, **kwargs: Any) -> None:
            if kwargs.get("parent_run_id") is None:
                self.errors.append(type(error).__name__)

    with _unpatched():
        app = _one_node_graph(StateGraph, "slow", slow).compile(name="slow_graph")

    async def close_early(how: str) -> tuple[list[str], bool]:
        node.clear()
        ends = _Ends()
        stream = app.astream({"text": "in"}, {"callbacks": [ends]}, stream_mode="custom")
        await stream.__anext__()
        await _until(lambda: node.get("started", False), "the node running")
        await _CLOSES[how](stream.aclose())
        return list(ends.errors), node.get("cancelled", False)

    return close_early


@contextlib.contextmanager
def _in_a_child(session: Session, scopes: list[str]) -> Any:
    """Run the block in a child's scope (a run started there is nested),
    recording the child's id in ``scopes``."""
    scope = session.new_subagent_scope(
        child_session_id=str(uuid.uuid4()),
        child_agent_id=session.derive_subagent_id("outer"),
        child_agent_name="parent-langgraph/outer",
        agent_role="outer",
    )
    scopes.append(scope.child_session_id)
    token = session.enter_subagent_scope(scope)
    try:
        yield
    finally:
        session.exit_subagent_scope(token)


async def _assert_closes_as_unpatched(session: Session, close_early: Any, hows: Any) -> list[str]:
    """Each close in ``hows``, top-level and nested, leaves LangGraph's
    clean-up exactly where the unpatched close leaves it: done. Returns
    the scopes the nested runs started in."""
    scopes: list[str] = []
    for how in hows:
        with _unpatched():
            plain = await close_early(how)
        assert plain == (["GeneratorExit"], True), how
        assert await close_early(how) == plain, f"top-level, {how}"
        with _in_a_child(session, scopes):
            assert await close_early(how) == plain, f"nested, {how}"
    return scopes


def _assert_one_closed_child_per_scope(client: MagicMock, scopes: list[str]) -> None:
    starts = _starts(client)
    assert [(p["agent_role"], p["parent_session_id"]) for p in starts] == [
        ("slow_graph", parent) for parent in scopes
    ]
    assert {p["session_id"] for p in _ends(client)} == {p["session_id"] for p in starts}


async def test_an_application_close_runs_the_runs_clean_up_before_it_returns(
    patched: Any,
) -> None:
    """On asyncio's loop, which tracks the stream, a close the application
    makes closes LangGraph's own stream before it returns, however it is
    awaited (in its own coroutine, or as a task of its own through gather,
    create_task, shield or wait_for), top-level and nested, exactly as
    unpatched: the run's error callback has fired and its in-flight node
    is cancelled."""
    session, client, StateGraph = patched
    scopes = await _assert_closes_as_unpatched(session, _slow_graph_closer(StateGraph), _CLOSES)
    assert await asyncio.to_thread(session.wait_child_posts, _POSTS_WAIT_SECS)
    _assert_one_closed_child_per_scope(client, scopes)


async def test_a_stream_no_loop_tracks_is_closed_at_once(patched: Any) -> None:
    """With the loop's async-generator hooks replaced (another library's,
    here none), the loop tracks no stream: a close closes LangGraph's
    stream at once, however it is awaited, top-level and nested, exactly
    as unpatched."""
    session, client, StateGraph = patched
    close_early = _slow_graph_closer(StateGraph)
    hooks = sys.get_asyncgen_hooks()
    sys.set_asyncgen_hooks(firstiter=None, finalizer=None)
    try:
        scopes = await _assert_closes_as_unpatched(session, close_early, _CLOSES)
    finally:
        sys.set_asyncgen_hooks(*hooks)
    assert await asyncio.to_thread(session.wait_child_posts, _POSTS_WAIT_SECS)
    _assert_one_closed_child_per_scope(client, scopes)


# A nest_asyncio run in a process of its own: nest_asyncio.apply() patches
# asyncio for the whole process. The child tries nest_asyncio's re-entrant
# form (asyncio.run inside a running loop, as in a notebook), then a single
# asyncio.run. In each it first streams the graph unpatched: when that
# baseline raises, LangGraph itself cannot stream under nest_asyncio on
# this interpreter, and the child reports the error instead. Otherwise it
# prints, per close and per patched / unpatched / nested run, what
# LangGraph's clean-up had done when the close returned, and whether the
# loop installed async-generator hooks (nest_asyncio's does not).
_NEST_ASYNCIO_CHILD = """
import asyncio, json, sys
sys.path.insert(0, sys.argv[1])
import nest_asyncio
import flightdeck_sensor
import test_interceptor_langgraph_runs as t
from flightdeck_sensor.interceptor import langgraph as lg

nest_asyncio.apply()
lg._ensure_imported()
session, client = t._build_session()
flightdeck_sensor._session = session
close_early = t._slow_graph_closer(lg._StateGraph)

async def compare(report):
    report["untracked"] = sys.get_asyncgen_hooks().firstiter is None
    lg.unpatch_langgraph_classes()
    try:
        await close_early("await")
    except Exception as exc:
        report["unsupported"] = [type(exc).__name__, str(exc)]
        return
    results = report["results"] = {}
    for how in ("await", "gather"):
        lg.unpatch_langgraph_classes()
        results[how + ":plain"] = await close_early(how)
        lg.patch_langgraph_classes(quiet=True)
        results[how + ":top"] = await close_early(how)
        with t._in_a_child(session, []):
            results[how + ":nested"] = await close_early(how)

async def reentrant(report):
    asyncio.run(compare(report))

reports = {}
for form in ("reentrant", "single"):
    report = reports[form] = {}
    asyncio.run(reentrant(report) if form == "reentrant" else compare(report))
    if "results" in report:
        break
session.wait_child_posts(t._POSTS_WAIT_SECS)
print(json.dumps({"python": sys.version.split()[0], "reports": reports}))
"""
# How long the nest_asyncio child may run: it builds one graph and runs
# up to fourteen short streams; a healthy run takes about a second.
_CHILD_TIMEOUT_SECS = 120.0
# The one known way LangGraph's own stream fails under nest_asyncio (Python
# 3.14: asyncio.wait_for in a step waiting on a running node, which
# nest_asyncio's loop runs with no current task); the test skips on that
# RuntimeError alone and fails on any other.
_NEST_ASYNCIO_KNOWN_FAILURE = "Timeout should be used inside a task"


def test_a_stream_under_nest_asyncio_is_closed_at_once() -> None:
    """nest_asyncio's loop tracks no async generator: an application's
    close closes LangGraph's stream at once, top-level and nested, exactly
    as unpatched, and no stream is later collected with "async generator
    ignored GeneratorExit". Skips on an interpreter where LangGraph's own
    stream fails under nest_asyncio in the one known way (Python 3.14); any
    other failure of the unpatched baseline fails the test."""
    import subprocess

    pytest.importorskip("nest_asyncio")
    if not _langgraph_mod._ensure_imported():
        pytest.skip("langgraph not installed")
    here = str(Path(__file__).parent)
    done = subprocess.run(
        [sys.executable, "-c", _NEST_ASYNCIO_CHILD, here],
        capture_output=True,
        text=True,
        timeout=_CHILD_TIMEOUT_SECS,
        env={k: v for k, v in os.environ.items() if not k.startswith("FLIGHTDECK_")},
        check=False,
    )
    assert done.returncode == 0, done.stderr
    assert "ignored GeneratorExit" not in done.stderr, done.stderr
    child = json.loads(done.stdout.strip().splitlines()[-1])
    used = [r for r in child["reports"].values() if "results" in r]
    if not used:
        failures = [r["unsupported"] for r in child["reports"].values()]
        known = all(
            kind == "RuntimeError" and _NEST_ASYNCIO_KNOWN_FAILURE in message
            for kind, message in failures
        )
        assert known, f"the unpatched baseline failed unexpectedly: {failures}\n{done.stderr}"
        pytest.skip(
            f"LangGraph's stream fails under nest_asyncio on Python {child['python']},"
            f" unpatched: RuntimeError: {_NEST_ASYNCIO_KNOWN_FAILURE}"
        )
    (report,) = used
    # The case under test: the loop installed no async-generator hooks.
    assert report["untracked"] is True, child
    results = report["results"]
    # Two closes, each unpatched, top-level and nested; JSON lists.
    assert len(results) == 6, results
    assert all(value == [["GeneratorExit"], True] for value in results.values()), results


def test_a_stream_closed_under_another_loop_is_closed_at_once() -> None:
    """A stream first stepped under one loop (whose set tracks it) and
    closed under another is not the second loop's to close: it is closed
    at once."""
    cleaned: list[str] = []

    async def stream() -> Any:
        try:
            yield 1
            yield 2
        finally:
            cleaned.append("closed")

    inner = stream()
    tracking = _langgraph_mod._LoopTracking()
    first, second = asyncio.new_event_loop(), asyncio.new_event_loop()
    try:

        async def first_step() -> None:
            await inner.__anext__()
            tracking.note(inner)

        first.run_until_complete(first_step())
        second.run_until_complete(_langgraph_mod._aclose(inner, tracking))
    finally:
        first.close()
        second.close()
    assert cleaned == ["closed"]


def test_a_collected_stream_mid_close_is_not_swept_again(patched: Any) -> None:
    """A stream collected unclosed is closed by the loop (its finalizer),
    and the wrapper then closes LangGraph's stream: a shutdown sweep that
    starts while that close is still under way does not close it again,
    and nothing reaches the loop's exception handler."""
    _session, _client, StateGraph = patched
    import gc

    from langchain_core.callbacks import AsyncCallbackHandler

    errors: list[dict[str, Any]] = []
    closing = asyncio.Event()
    release = asyncio.Event()

    class _HoldTheClose(AsyncCallbackHandler):
        async def on_chain_error(self, error: BaseException, **kwargs: Any) -> None:
            if kwargs.get("parent_run_id") is None:
                closing.set()
                await release.wait()

    with _unpatched():
        app = _two_node_graph(StateGraph).compile(name="top")

    async def main() -> None:
        loop = asyncio.get_running_loop()
        loop.set_exception_handler(lambda loop, ctx: errors.append(ctx))
        stream = app.astream(
            {"text": "in"}, {"callbacks": [_HoldTheClose()]}, stream_mode="updates"
        )
        await stream.__anext__()
        del stream
        gc.collect()
        await _until(closing.is_set, "LangGraph's stream mid-close")
        await loop.shutdown_asyncgens()
        release.set()
        others = [t for t in asyncio.all_tasks() if t is not asyncio.current_task()]
        await asyncio.wait_for(asyncio.gather(*others, return_exceptions=True), _POSTS_WAIT_SECS)

    asyncio.run(main())
    assert errors == []


def test_unnamed_run_inside_an_agents_own_step_gets_the_generic_role(patched: Any) -> None:
    """create_agent's tools node is the agent's own step, not a sub-agent:
    an unnamed graph run from a tool it runs is not named after it."""
    session, client, StateGraph = patched
    from langchain.agents import create_agent
    from langchain_core.tools import tool

    with _unpatched():
        inner = _two_node_graph(StateGraph).compile()

    @tool
    def run_inner(text: str) -> str:
        """Run the inner graph."""
        return str(inner.invoke({"text": text})["text"])

    agent = create_agent(
        _fake_model(_call("run_inner", {"text": "in"}), _answer("done")), [run_inner]
    )

    assert agent.invoke(_QUESTION)["messages"][-1].content == "done"
    assert _tree(session, client) == [("subgraph", "root")]


def test_graph_with_graph_fallbacks_used_as_a_node_gets_one_child(patched: Any) -> None:
    """A compiled graph with fallbacks that are all graphs is left alone
    as a node: whichever runs opens the one child. A fallback that is not
    a graph makes it a hand-built node."""
    session, client, StateGraph = patched
    from langchain_core.runnables import RunnableLambda

    primary = _two_node_graph(StateGraph).compile(name="primary")
    graphs = primary.with_fallbacks([_two_node_graph(StateGraph).compile(name="backup")])
    mixed = primary.with_fallbacks([RunnableLambda(lambda state: {"text": "plain"})])

    graph = _one_node_graph(StateGraph, "research", graphs)
    assert graph.nodes["research"].runnable is graphs
    assert graph.compile().invoke({"text": "in"}) == {"text": "in12"}
    assert _tree(session, client) == [
        ("primary", "root"),
        ("first", "primary"),
        ("second", "primary"),
    ]
    assert _one_node_graph(StateGraph, "research", mixed).nodes["research"].runnable is not mixed


def test_patch_langgraph_runs_patches_the_runs_alone(patched: Any) -> None:
    """The patch an import of langgraph.pregel applies (a functional-API
    application) wraps the runs and leaves StateGraph alone."""
    session, client, StateGraph = patched
    from langgraph.func import entrypoint
    from langgraph.pregel import Pregel

    unpatch_langgraph_classes()
    original_stream = Pregel.stream
    try:
        _langgraph_mod.patch_langgraph_runs(quiet=True)
        _langgraph_mod.patch_langgraph_runs(quiet=True)
        assert Pregel.stream is not original_stream
        assert Pregel.stream.__wrapped__ is original_stream
        assert not getattr(StateGraph, "_flightdeck_subagent_patched", False)

        @entrypoint()
        def worker(count: int) -> int:
            return count + 1

        @entrypoint()
        def outer(count: int) -> int:
            result: int = worker.invoke(count)
            return result

        assert outer.invoke(1) == 2
        # The entrypoint's graph is unnamed: its run takes the outer
        # entrypoint's node name.
        assert _tree(session, client) == [("outer", "root")]

        _langgraph_mod.unpatch_langgraph_runs()
        _langgraph_mod.unpatch_langgraph_runs()
        assert Pregel.stream is original_stream
    finally:
        patch_langgraph_classes(quiet=True)
