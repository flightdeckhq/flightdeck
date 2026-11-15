"""Unit tests for the LangGraph sub-agent interceptor.

Verifies that wrapping ``StateGraph.add_node`` produces a per-node
child session emission flow with the same shape as the other
sub-agent interceptors, for every node shape a hand-built graph uses
(functions, RunnableCallable, ToolNode, RunnableLambda, LCEL pipes),
and none for create_agent's steps, generator nodes or compiled-graph
nodes. Also covers the agent-bearing predicate (without a regex
override every node gets wrapped; with one only matching node names
get child sessions), nesting, interrupts, cancellation, posting off
the event loop, failing open, and that a wrapped Runnable node streams,
fans out and is introspected exactly as the unwrapped node is.
"""

from __future__ import annotations

import asyncio
import contextlib
import threading
from typing import TYPE_CHECKING, Any, TypedDict
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

if TYPE_CHECKING:
    from langchain_core.runnables import RunnableConfig


def _langgraph_or_skip() -> Any:
    """Resolve the lazily-imported StateGraph class on first call.
    Defers the import to test-body time so unrelated tests that
    expect a clean sys.modules (e.g. framework attribution) aren't
    polluted by importing langgraph at this module's load.
    """
    if not _langgraph_mod._ensure_imported():
        pytest.skip("langgraph not installed")
    return _langgraph_mod._StateGraph


@pytest.fixture()
def StateGraph() -> Any:
    return _langgraph_or_skip()


def _build_session(*, capture_prompts: bool = True) -> tuple[Session, MagicMock]:
    config = SensorConfig(
        server="http://localhost:9999",
        token="tok",
        agent_id="22222222-2222-2222-2222-222222222222",
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
    session = Session(config=config, client=client)
    return session, client


@pytest.fixture()
def sensor_session() -> Any:
    session, client = _build_session(capture_prompts=True)
    prior = flightdeck_sensor._session
    flightdeck_sensor._session = session
    try:
        yield session, client
    finally:
        flightdeck_sensor._session = prior
        with contextlib.suppress(Exception):
            session.event_queue.close()
        # Reset module-level pattern so other tests start clean.
        set_agent_node_pattern(None)


@pytest.fixture()
def patched_langgraph(sensor_session: Any, StateGraph: Any) -> Any:
    patch_langgraph_classes(quiet=True)
    session, client = sensor_session
    try:
        yield session, client, StateGraph
    finally:
        unpatch_langgraph_classes()


def _build_graph_with_node(StateGraph: Any, node_name: str, action: Any) -> Any:
    """Build a minimal StateGraph that wires a single node and
    returns the compiled graph plus the wrapped action so tests
    can invoke the action directly.
    """
    from typing import TypedDict

    class _State(TypedDict, total=False):
        text: str

    graph = StateGraph(_State)
    graph.add_node(node_name, action)
    return graph


def _post_event_calls(client: MagicMock) -> list[dict[str, Any]]:
    return [call.args[0] for call in client.post_event.call_args_list]


# ----------------------------------------------------------------------
# Wrap-and-run
# ----------------------------------------------------------------------


def test_node_wrap_emits_session_start_then_session_end(
    patched_langgraph: Any,
) -> None:
    session, client, StateGraph = patched_langgraph
    inner = MagicMock(return_value={"text": "out"})
    graph = _build_graph_with_node(StateGraph, "researcher", inner)

    # The user-registered ``inner`` was wrapped at add_node time.
    # Recover the wrapped callable via the graph's internal
    # registry to invoke it directly without compiling.
    wrapped = graph.nodes["researcher"].runnable.func  # type: ignore[attr-defined]
    state = {"text": "in"}
    result = wrapped(state)

    assert result == {"text": "out"}
    assert inner.call_count == 1
    payloads = _post_event_calls(client)
    assert len(payloads) == 2
    start_p, end_p = payloads
    assert start_p["event_type"] == "session_start"
    assert start_p["agent_role"] == "researcher"
    assert start_p["parent_session_id"] == session.config.session_id
    assert start_p["agent_id"] == session.derive_subagent_id("researcher")
    assert start_p["incoming_message"]["body"] == state
    assert end_p["event_type"] == "session_end"
    assert end_p["outgoing_message"]["body"] == {"text": "out"}


def test_distinct_node_names_produce_distinct_agent_ids(
    patched_langgraph: Any,
) -> None:
    session, client, StateGraph = patched_langgraph
    inner_r = MagicMock(return_value={"text": "r"})
    inner_w = MagicMock(return_value={"text": "w"})

    graph_r = _build_graph_with_node(StateGraph, "researcher", inner_r)
    graph_w = _build_graph_with_node(StateGraph, "writer", inner_w)
    graph_r.nodes["researcher"].runnable.func({"text": "in"})
    graph_w.nodes["writer"].runnable.func({"text": "in"})

    starts = [p for p in _post_event_calls(client) if p["event_type"] == "session_start"]
    assert len(starts) == 2
    assert starts[0]["agent_id"] != starts[1]["agent_id"]


def test_exception_emits_state_error(patched_langgraph: Any) -> None:
    session, client, StateGraph = patched_langgraph
    boom = ValueError("graph node crashed")
    inner = MagicMock(side_effect=boom)
    graph = _build_graph_with_node(StateGraph, "researcher", inner)

    with pytest.raises(ValueError, match="graph node crashed"):
        graph.nodes["researcher"].runnable.func({"text": "in"})

    payloads = _post_event_calls(client)
    assert len(payloads) == 2
    end_p = payloads[1]
    assert end_p["event_type"] == "session_end"
    assert end_p["state"] == "error"
    assert end_p["error"] == {"type": "ValueError", "message": "graph node crashed"}


def test_capture_off_sends_the_error_type_without_its_message(patched_langgraph: Any) -> None:
    """An exception's text can quote the node's state, so with capture
    off the child's error block carries its type alone (rule 18)."""
    session, client, StateGraph = patched_langgraph
    session.config.capture_prompts = False
    inner = MagicMock(side_effect=ValueError("the secret state"))
    graph = _build_graph_with_node(StateGraph, "researcher", inner)

    with pytest.raises(ValueError):
        graph.nodes["researcher"].runnable.func({"text": "in"})

    end_p = _post_event_calls(client)[-1]
    assert end_p["state"] == "error"
    assert end_p["error"] == {"type": "ValueError"}
    assert "the secret state" not in str(_post_event_calls(client))


# ----------------------------------------------------------------------
# Agent-bearing predicate
# ----------------------------------------------------------------------


def test_pattern_match_wraps_only_matching_nodes(patched_langgraph: Any) -> None:
    """With a regex set, only nodes whose name matches get wrapped.
    Non-matching nodes pass through unwrapped — no child events.
    """
    set_agent_node_pattern(r"^agent_")
    session, client, StateGraph = patched_langgraph

    matching = MagicMock(return_value={"text": "agent-out"})
    non_matching = MagicMock(return_value={"text": "data-out"})

    graph_m = _build_graph_with_node(StateGraph, "agent_researcher", matching)
    graph_n = _build_graph_with_node(StateGraph, "data_transform", non_matching)
    graph_m.nodes["agent_researcher"].runnable.func({"text": "in"})
    graph_n.nodes["data_transform"].runnable.func({"text": "in"})

    payloads = _post_event_calls(client)
    # Two emits (start + end) for the matching node only; none for
    # the data-transform node.
    assert len(payloads) == 2
    assert all(p["agent_role"] == "agent_researcher" for p in payloads)


def test_default_no_pattern_wraps_every_node(patched_langgraph: Any) -> None:
    """No pattern set → every node gets wrapped. Operators with
    noisy graphs use the regex to narrow.
    """
    set_agent_node_pattern(None)
    session, client, StateGraph = patched_langgraph

    inner_a = MagicMock(return_value={"text": "a"})
    inner_b = MagicMock(return_value={"text": "b"})

    graph_a = _build_graph_with_node(StateGraph, "alpha", inner_a)
    graph_b = _build_graph_with_node(StateGraph, "bravo", inner_b)
    graph_a.nodes["alpha"].runnable.func({"text": "in"})
    graph_b.nodes["bravo"].runnable.func({"text": "in"})

    starts = [p for p in _post_event_calls(client) if p["event_type"] == "session_start"]
    assert len(starts) == 2  # both nodes emitted child sessions


# ----------------------------------------------------------------------
# Sentinel behaviour
# ----------------------------------------------------------------------


def test_no_active_session_passes_through(
    sensor_session: Any,
    StateGraph: Any,
) -> None:
    _, client = sensor_session
    flightdeck_sensor._session = None  # type: ignore[assignment]
    patch_langgraph_classes(quiet=True)
    try:
        inner = MagicMock(return_value={"text": "ok"})
        graph = _build_graph_with_node(StateGraph, "researcher", inner)
        result = graph.nodes["researcher"].runnable.func({"text": "in"})
    finally:
        unpatch_langgraph_classes()
    assert result == {"text": "ok"}
    assert inner.call_count == 1
    assert client.post_event.call_count == 0


def test_patch_idempotent(sensor_session: Any, StateGraph: Any) -> None:
    patch_langgraph_classes(quiet=True)
    first = StateGraph.add_node
    patch_langgraph_classes(quiet=True)
    second = StateGraph.add_node
    unpatch_langgraph_classes()
    assert first is second


# ----------------------------------------------------------------------
# Signature passthrough and message serialisation
# ----------------------------------------------------------------------


def test_node_declaring_config_still_receives_it_when_patched(
    patched_langgraph: Any,
) -> None:
    """LangGraph injects ``config`` only into a node whose signature names
    it. The wrapper keeps the node's signature (``__wrapped__``), so a
    patched node still gets it instead of failing with a missing
    argument."""
    _session, client, StateGraph = patched_langgraph
    from langgraph.graph import END, START

    # LangGraph injects ``config`` only into a parameter annotated
    # RunnableConfig (resolved by name under postponed annotations).
    seen: list[Any] = []

    def researcher(state: dict[str, Any], config: RunnableConfig) -> dict[str, Any]:
        seen.append(config)
        return {"text": "out"}

    graph = _build_graph_with_node(StateGraph, "researcher", researcher)
    graph.add_edge(START, "researcher")
    graph.add_edge("researcher", END)
    result = graph.compile().invoke({"text": "in"})

    assert result == {"text": "out"}
    assert len(seen) == 1 and seen[0] is not None
    event_types = [p["event_type"] for p in _post_event_calls(client)]
    assert event_types == ["session_start", "session_end"]


async def test_async_node_declaring_config_still_receives_it_when_patched(
    patched_langgraph: Any,
) -> None:
    _session, client, StateGraph = patched_langgraph
    from langgraph.graph import END, START

    # LangGraph injects ``config`` only into a parameter annotated
    # RunnableConfig (resolved by name under postponed annotations).
    seen: list[Any] = []

    async def researcher(state: dict[str, Any], config: RunnableConfig) -> dict[str, Any]:
        seen.append(config)
        return {"text": "out"}

    graph = _build_graph_with_node(StateGraph, "researcher", researcher)
    graph.add_edge(START, "researcher")
    graph.add_edge("researcher", END)
    result = await graph.compile().ainvoke({"text": "in"})

    assert result == {"text": "out"}
    assert len(seen) == 1
    event_types = [p["event_type"] for p in _post_event_calls(client)]
    assert event_types == ["session_start", "session_end"]


def test_state_holding_langchain_messages_is_captured(patched_langgraph: Any) -> None:
    """A ``MessagesState``-style body holds LangChain message objects,
    which the json module cannot encode; the child session still gets the
    body, with each message in its JSON form."""
    _session, client, StateGraph = patched_langgraph
    from langchain_core.messages import AIMessage, HumanMessage

    def writer(state: dict[str, Any]) -> dict[str, Any]:
        return {"messages": [AIMessage(content="draft ready")]}

    graph = _build_graph_with_node(StateGraph, "writer", writer)
    wrapped = graph.nodes["writer"].runnable.func  # type: ignore[attr-defined]
    wrapped({"messages": [HumanMessage(content="write a draft")]})

    start_p, end_p = _post_event_calls(client)
    (incoming,) = start_p["incoming_message"]["body"]["messages"]
    assert incoming["content"] == "write a draft"
    assert incoming["type"] == "human"
    (outgoing,) = end_p["outgoing_message"]["body"]["messages"]
    assert outgoing["content"] == "draft ready"
    assert outgoing["type"] == "ai"


async def test_callable_instance_with_async_call_is_awaited(
    patched_langgraph: Any,
) -> None:
    """A node that is an instance with ``async def __call__`` is async only
    through its __call__; the wrapper must await it, and the unnamed node
    keeps the class name LangGraph gives it."""
    _session, client, StateGraph = patched_langgraph
    from typing import TypedDict

    from langgraph.graph import END, START

    class _State(TypedDict, total=False):
        text: str

    class Researcher:
        async def __call__(self, state: dict[str, Any]) -> dict[str, Any]:
            return {"text": "out"}

    graph = StateGraph(_State)
    graph.add_node(Researcher())
    graph.add_edge(START, "Researcher")
    graph.add_edge("Researcher", END)
    result = await graph.compile().ainvoke({"text": "in"})

    assert result == {"text": "out"}
    event_types = [p["event_type"] for p in _post_event_calls(client)]
    assert event_types == ["session_start", "session_end"]


# ----------------------------------------------------------------------
# Helpers for the node shapes of a hand-built graph
# ----------------------------------------------------------------------


class _TextState(TypedDict, total=False):
    text: str


# A node timeout LangGraph only validates here: the tests compile the
# graph and never run a node long enough to reach it.
_NODE_TIMEOUT_SECS = 60.0
# How long a test waits for the child posts an async run queued on the
# loop's executor; each is a call on a mock client, done in milliseconds.
_POSTS_WAIT_SECS = 10.0


def _one_node_graph(StateGraph: Any, name: str, action: Any, schema: Any = None) -> Any:
    from langgraph.graph import END, START

    graph = StateGraph(schema or _TextState)
    graph.add_node(name, action)
    graph.add_edge(START, name)
    graph.add_edge(name, END)
    return graph


def _starts(client: MagicMock) -> list[dict[str, Any]]:
    return [p for p in _post_event_calls(client) if p["event_type"] == "session_start"]


def _ends(client: MagicMock) -> list[dict[str, Any]]:
    return [p for p in _post_event_calls(client) if p["event_type"] == "session_end"]


@contextlib.contextmanager
def _unpatched() -> Any:
    """Build a graph as LangGraph alone would, inside a patched test."""
    unpatch_langgraph_classes()
    try:
        yield
    finally:
        patch_langgraph_classes(quiet=True)


def _tool_call_state(name: str, args: dict[str, Any]) -> dict[str, Any]:
    from langchain_core.messages import AIMessage

    call = {"id": "call-1", "name": name, "args": args}
    return {"messages": [AIMessage(content="", tool_calls=[call], id="ai-1")]}


def _lookup_tool(seen: list[Any]) -> Any:
    """A tool that asks ToolNode for its runtime. Annotated with the class
    itself: this module's postponed annotations would leave a name the
    tool decorator cannot resolve."""
    from langchain_core.tools import tool
    from langgraph.prebuilt import ToolRuntime

    def lookup(query: str, runtime: Any) -> str:
        """Look a query up."""
        seen.append(runtime)
        return f"found {query}"

    lookup.__annotations__ = {"query": str, "runtime": ToolRuntime, "return": str}
    return tool(lookup)


def _fake_tool_model(*replies: Any) -> Any:
    """A chat model answering with ``replies`` in turn, accepting tools."""
    from langchain_core.language_models.fake_chat_models import GenericFakeChatModel

    class _FakeToolModel(GenericFakeChatModel):
        def bind_tools(self, tools: Any, **kwargs: Any) -> Any:
            return self

    return _FakeToolModel(messages=iter(replies))


def _tool_then_answer() -> tuple[Any, Any]:
    from langchain_core.messages import AIMessage

    call = {"id": "call-1", "name": "lookup", "args": {"query": "q"}}
    return AIMessage(content="", tool_calls=[call]), AIMessage(content="done")


# ----------------------------------------------------------------------
# Runnable nodes open child sessions
# ----------------------------------------------------------------------


def test_runnable_callable_node_opens_a_child(patched_langgraph: Any) -> None:
    session, client, StateGraph = patched_langgraph
    from langgraph._internal._runnable import RunnableCallable

    node = RunnableCallable(lambda state: {"text": state["text"] + "!"}, None)
    app = _one_node_graph(StateGraph, "researcher", node).compile()

    assert app.invoke({"text": "in"}) == {"text": "in!"}
    (start,) = _starts(client)
    (end,) = _ends(client)
    assert start["agent_role"] == "researcher"
    assert start["agent_name"] == "parent-langgraph/researcher"
    assert start["agent_id"] == session.derive_subagent_id("researcher")
    assert start["parent_session_id"] == session.config.session_id
    assert start["incoming_message"]["body"] == {"text": "in"}
    assert end["session_id"] == start["session_id"]
    assert end["outgoing_message"]["body"] == {"text": "in!"}
    assert "state" not in end


async def test_async_runnable_callable_node_opens_a_child(patched_langgraph: Any) -> None:
    _session, client, StateGraph = patched_langgraph
    from langgraph._internal._runnable import RunnableCallable

    async def research(state: dict[str, Any]) -> dict[str, Any]:
        return {"text": state["text"] + "!"}

    app = _one_node_graph(StateGraph, "researcher", RunnableCallable(None, research)).compile()

    assert await app.ainvoke({"text": "in"}) == {"text": "in!"}
    assert [p["event_type"] for p in _post_event_calls(client)] == [
        "session_start",
        "session_end",
    ]
    assert _ends(client)[0]["outgoing_message"]["body"] == {"text": "in!"}


def test_tool_node_opens_a_child_and_still_gets_its_tool_runtime(
    patched_langgraph: Any,
) -> None:
    _session, client, StateGraph = patched_langgraph
    from langgraph.graph import MessagesState
    from langgraph.prebuilt import ToolNode

    seen: list[Any] = []
    app = _one_node_graph(
        StateGraph, "tools", ToolNode([_lookup_tool(seen)]), MessagesState
    ).compile()

    result = app.invoke(_tool_call_state("lookup", {"query": "q"}))

    assert result["messages"][-1].content == "found q"
    assert len(seen) == 1 and seen[0] is not None
    (start,) = _starts(client)
    assert start["agent_role"] == "tools"
    (end,) = _ends(client)
    assert end["outgoing_message"]["body"]["messages"][0]["content"] == "found q"


async def test_async_tool_node_opens_a_child(patched_langgraph: Any) -> None:
    _session, client, StateGraph = patched_langgraph
    from langgraph.graph import MessagesState
    from langgraph.prebuilt import ToolNode

    seen: list[Any] = []
    app = _one_node_graph(
        StateGraph, "tools", ToolNode([_lookup_tool(seen)]), MessagesState
    ).compile()

    result = await app.ainvoke(_tool_call_state("lookup", {"query": "q"}))

    assert result["messages"][-1].content == "found q"
    assert [p["agent_role"] for p in _starts(client)] == ["tools"]
    assert len(_ends(client)) == 1


def test_runnable_lambda_node_opens_a_child(patched_langgraph: Any) -> None:
    _session, client, StateGraph = patched_langgraph
    from langchain_core.runnables import RunnableLambda

    node = RunnableLambda(lambda state: {"text": state["text"].upper()})
    app = _one_node_graph(StateGraph, "shout", node).compile()

    assert app.invoke({"text": "in"}) == {"text": "IN"}
    assert [p["agent_role"] for p in _starts(client)] == ["shout"]
    assert _ends(client)[0]["outgoing_message"]["body"] == {"text": "IN"}


def test_lcel_pipe_node_opens_a_child(patched_langgraph: Any) -> None:
    _session, client, StateGraph = patched_langgraph
    from langchain_core.runnables import RunnableLambda

    pipe = RunnableLambda(lambda state: state["text"]) | RunnableLambda(
        lambda text: {"text": text + "|piped"}
    )
    app = _one_node_graph(StateGraph, "pipe", pipe).compile()

    assert app.invoke({"text": "in"}) == {"text": "in|piped"}
    assert [p["agent_role"] for p in _starts(client)] == ["pipe"]
    assert _ends(client)[0]["outgoing_message"]["body"] == {"text": "in|piped"}


def test_unnamed_runnable_node_is_named_as_langgraph_names_it(
    patched_langgraph: Any,
) -> None:
    """A Runnable registered without a name is named by its get_name(), as
    LangGraph names it; edges that use that name keep working."""
    _session, client, StateGraph = patched_langgraph
    from langchain_core.runnables import RunnableLambda
    from langgraph.graph import END, START

    graph = StateGraph(_TextState)
    graph.add_node(RunnableLambda(lambda state: {"text": "out"}, name="summarise"))
    graph.add_edge(START, "summarise")
    graph.add_edge("summarise", END)

    assert list(graph.nodes) == ["summarise"]
    assert graph.compile().invoke({"text": "in"}) == {"text": "out"}
    assert [p["agent_role"] for p in _starts(client)] == ["summarise"]


# ----------------------------------------------------------------------
# An agent's own steps open none
# ----------------------------------------------------------------------


def test_create_agent_graph_opens_no_child_sessions(patched_langgraph: Any) -> None:
    """create_agent's model, tool and middleware nodes are one agent's own
    steps, not sub-agents."""
    _session, client, _StateGraph = patched_langgraph
    from langchain.agents import create_agent

    seen: list[Any] = []
    agent = create_agent(_fake_tool_model(*_tool_then_answer()), [_lookup_tool(seen)])

    result = agent.invoke({"messages": [{"role": "user", "content": "look q up"}]})

    assert result["messages"][-1].content == "done"
    assert len(seen) == 1
    assert client.post_event.call_count == 0


def test_create_react_agent_graph_opens_no_child_sessions(patched_langgraph: Any) -> None:
    _session, client, _StateGraph = patched_langgraph
    import warnings

    with warnings.catch_warnings():
        # Deprecated in favour of create_agent, still shipped.
        warnings.simplefilter("ignore")
        from langgraph.prebuilt import create_react_agent

        seen: list[Any] = []
        agent = create_react_agent(_fake_tool_model(*_tool_then_answer()), [_lookup_tool(seen)])

    result = agent.invoke({"messages": [{"role": "user", "content": "look q up"}]})

    assert result["messages"][-1].content == "done"
    assert client.post_event.call_count == 0


def test_hand_built_model_and_tool_node_graph_opens_one_child_per_node_run(
    patched_langgraph: Any,
) -> None:
    """The same loop built by hand is the application's own graph: its
    model node and its ToolNode open a child each time they run."""
    _session, client, StateGraph = patched_langgraph
    from langgraph.graph import START, MessagesState
    from langgraph.prebuilt import ToolNode, tools_condition

    seen: list[Any] = []
    model = _fake_tool_model(*_tool_then_answer())

    def call_model(state: MessagesState) -> dict[str, Any]:
        return {"messages": [model.invoke(state["messages"])]}

    graph = StateGraph(MessagesState)
    graph.add_node("model", call_model)
    graph.add_node("tools", ToolNode([_lookup_tool(seen)]))
    graph.add_edge(START, "model")
    graph.add_conditional_edges("model", tools_condition)
    graph.add_edge("tools", "model")

    result = graph.compile().invoke({"messages": [{"role": "user", "content": "look q up"}]})

    assert result["messages"][-1].content == "done"
    assert [p["agent_role"] for p in _starts(client)] == ["model", "tools", "model"]
    assert len(_ends(client)) == 3
    assert len({p["session_id"] for p in _starts(client)}) == 3


def test_pattern_narrows_runnable_nodes_too(patched_langgraph: Any) -> None:
    set_agent_node_pattern(r"^agent_")
    _session, client, StateGraph = patched_langgraph
    from langchain_core.runnables import RunnableLambda
    from langgraph.graph import END, START

    graph = StateGraph(_TextState)
    graph.add_node("agent_writer", RunnableLambda(lambda state: {"text": "w"}))
    graph.add_node("format", RunnableLambda(lambda state: {"text": state["text"] + "!"}))
    graph.add_edge(START, "agent_writer")
    graph.add_edge("agent_writer", "format")
    graph.add_edge("format", END)

    assert graph.compile().invoke({"text": "in"}) == {"text": "w!"}
    assert [p["agent_role"] for p in _post_event_calls(client)] == [
        "agent_writer",
        "agent_writer",
    ]


# ----------------------------------------------------------------------
# Nodes registered untouched
# ----------------------------------------------------------------------


def test_sync_generator_node_is_registered_untouched_and_runs(
    patched_langgraph: Any,
) -> None:
    """A generator node function is a stream LangGraph runs as a
    RunnableLambda; a wrapper function hid that and the run failed with
    InvalidUpdateError."""
    _session, client, StateGraph = patched_langgraph

    def shout(state: dict[str, Any]) -> Any:
        yield {"text": state["text"].upper()}

    graph = _one_node_graph(StateGraph, "shout", shout)

    assert graph.nodes["shout"].runnable.func is shout
    assert graph.compile().invoke({"text": "in"}) == {"text": "IN"}
    assert client.post_event.call_count == 0


async def test_async_generator_node_is_registered_untouched_and_runs(
    patched_langgraph: Any,
) -> None:
    _session, client, StateGraph = patched_langgraph

    async def shout(state: dict[str, Any]) -> Any:
        yield {"text": state["text"].upper()}

    graph = _one_node_graph(StateGraph, "shout", shout)

    assert await graph.compile().ainvoke({"text": "in"}) == {"text": "IN"}
    assert client.post_event.call_count == 0


def test_a_node_that_cannot_be_wrapped_is_registered_as_given(
    patched_langgraph: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    _session, client, StateGraph = patched_langgraph

    def broken() -> str:
        raise RuntimeError("frame inspection failed")

    monkeypatch.setattr(_langgraph_mod, "_registering_module", broken)

    def node(state: dict[str, Any]) -> dict[str, Any]:
        return {"text": "out"}

    graph = _one_node_graph(StateGraph, "plain", node)

    assert graph.nodes["plain"].runnable.func is node
    assert graph.compile().invoke({"text": "in"}) == {"text": "out"}
    assert client.post_event.call_count == 0


# ----------------------------------------------------------------------
# Interrupts and other control flow
# ----------------------------------------------------------------------


def test_interrupt_closes_the_child_normally_and_resume_opens_a_new_one(
    patched_langgraph: Any,
) -> None:
    _session, client, StateGraph = patched_langgraph
    from langgraph.checkpoint.memory import InMemorySaver
    from langgraph.types import Command, interrupt

    def ask(state: dict[str, Any]) -> dict[str, Any]:
        return {"text": interrupt("approve?")}

    app = _one_node_graph(StateGraph, "ask", ask).compile(checkpointer=InMemorySaver())
    config = {"configurable": {"thread_id": "thread-1"}}

    first = app.invoke({"text": "in"}, config)
    assert "__interrupt__" in first
    (first_end,) = _ends(client)
    assert "state" not in first_end
    assert "error" not in first_end
    assert "outgoing_message" not in first_end

    assert app.invoke(Command(resume="approved"), config) == {"text": "approved"}
    starts, ends = _starts(client), _ends(client)
    assert len(starts) == 2 and len(ends) == 2
    assert starts[0]["session_id"] != starts[1]["session_id"]
    assert ends[1]["session_id"] == starts[1]["session_id"]
    assert ends[1]["outgoing_message"]["body"] == {"text": "approved"}


def test_parent_command_closes_the_child_normally(patched_langgraph: Any) -> None:
    """A sub-graph invoked inside a node that sends a Command to the parent
    graph raises ParentCommand out of the node, through its wrapper:
    control flow, not a failure."""
    _session, client, StateGraph = patched_langgraph
    from langgraph.graph import END, START
    from langgraph.types import Command

    def hand_back(state: dict[str, Any]) -> Any:
        return Command(graph=Command.PARENT, goto="finish", update={"text": "handed back"})

    inner = _one_node_graph(StateGraph, "hand_back", hand_back).compile()

    graph = StateGraph(_TextState)
    graph.add_node("delegate", lambda state: inner.invoke(state), destinations=("finish",))
    graph.add_node("finish", lambda state: {"text": state["text"] + "!"})
    graph.add_edge(START, "delegate")
    graph.add_edge("finish", END)

    assert graph.compile().invoke({"text": "in"}) == {"text": "handed back!"}
    assert [p["agent_role"] for p in _starts(client)] == ["delegate", "hand_back", "finish"]
    delegate_end = next(p for p in _ends(client) if p["agent_role"] == "delegate")
    assert "state" not in delegate_end
    assert "error" not in delegate_end
    assert "outgoing_message" not in delegate_end


def test_compiled_graph_node_is_registered_untouched(patched_langgraph: Any) -> None:
    """A compiled graph used as a node opens no child; the nodes inside it
    open theirs, under the sensor's session."""
    session, client, StateGraph = patched_langgraph

    inner = _one_node_graph(StateGraph, "inner", lambda state: {"text": "inner"}).compile()
    graph = _one_node_graph(StateGraph, "sub", inner)

    assert graph.nodes["sub"].runnable is inner
    assert graph.compile().invoke({"text": "in"}) == {"text": "inner"}
    (start,) = _starts(client)
    assert start["agent_role"] == "inner"
    assert start["parent_session_id"] == session.config.session_id


# ----------------------------------------------------------------------
# Nesting and the sub-agent scope
# ----------------------------------------------------------------------


def test_child_opened_inside_a_node_nests_under_its_child(patched_langgraph: Any) -> None:
    session, client, StateGraph = patched_langgraph

    inner = _one_node_graph(
        StateGraph, "inner", lambda state: {"text": state["text"] + "+inner"}
    ).compile()
    outer = _one_node_graph(StateGraph, "outer", lambda state: inner.invoke(state)).compile()

    assert outer.invoke({"text": "in"}) == {"text": "in+inner"}
    starts = {p["agent_role"]: p for p in _starts(client)}
    ends = {p["agent_role"]: p for p in _ends(client)}
    outer_id = starts["outer"]["session_id"]
    assert starts["outer"]["parent_session_id"] == session.config.session_id
    assert starts["inner"]["parent_session_id"] == outer_id
    assert ends["inner"]["parent_session_id"] == outer_id
    assert ends["outer"]["parent_session_id"] == session.config.session_id


async def test_async_child_opened_inside_a_node_nests_under_its_child(
    patched_langgraph: Any,
) -> None:
    session, client, StateGraph = patched_langgraph
    from langchain_core.runnables import RunnableLambda

    async def grow(state: dict[str, Any]) -> dict[str, Any]:
        return {"text": state["text"] + "+inner"}

    inner = _one_node_graph(StateGraph, "inner", RunnableLambda(grow)).compile()

    async def delegate(state: dict[str, Any]) -> dict[str, Any]:
        result: dict[str, Any] = await inner.ainvoke(state)
        return result

    outer = _one_node_graph(StateGraph, "outer", delegate).compile()

    assert await outer.ainvoke({"text": "in"}) == {"text": "in+inner"}
    starts = {p["agent_role"]: p for p in _starts(client)}
    assert starts["outer"]["parent_session_id"] == session.config.session_id
    assert starts["inner"]["parent_session_id"] == starts["outer"]["session_id"]


def test_node_runs_inside_its_child_scope(patched_langgraph: Any) -> None:
    session, client, StateGraph = patched_langgraph
    from langchain_core.runnables import RunnableLambda

    scopes: list[Any] = []

    def look(state: dict[str, Any]) -> dict[str, Any]:
        scopes.append(session.active_subagent_scope())
        return {"text": "out"}

    _one_node_graph(StateGraph, "plain", look).compile().invoke({"text": "in"})
    _one_node_graph(StateGraph, "runnable", RunnableLambda(look)).compile().invoke({"text": "in"})

    starts = _starts(client)
    assert [s.child_session_id for s in scopes] == [p["session_id"] for p in starts]
    assert [s.agent_role for s in scopes] == ["plain", "runnable"]
    assert session.active_subagent_scope() is None


# ----------------------------------------------------------------------
# Posting
# ----------------------------------------------------------------------


async def test_async_nodes_post_off_the_event_loop(patched_langgraph: Any) -> None:
    """The child posts are synchronous HTTP round trips: an async run posts
    them in worker threads, never on the loop's thread. Covers an async
    function node, a natively async Runnable and a sync-only Runnable,
    which runs in the loop's executor as a sync node function does."""
    _session, client, StateGraph = patched_langgraph
    from langchain_core.runnables import RunnableLambda
    from langgraph._internal._runnable import RunnableCallable
    from langgraph.graph import END, START

    loop_thread = threading.get_ident()
    threads: list[int] = []

    def post(payload: dict[str, Any], **kwargs: Any) -> tuple[None, bool]:
        threads.append(threading.get_ident())
        return None, False

    client.post_event.side_effect = post

    async def first(state: dict[str, Any]) -> dict[str, Any]:
        return {"text": state["text"] + "1"}

    async def second(state: dict[str, Any]) -> dict[str, Any]:
        return {"text": state["text"] + "2"}

    graph = StateGraph(_TextState)
    graph.add_node("function", first)
    graph.add_node("native", RunnableCallable(None, second))
    graph.add_node("sync_only", RunnableLambda(lambda state: {"text": state["text"] + "3"}))
    graph.add_edge(START, "function")
    graph.add_edge("function", "native")
    graph.add_edge("native", "sync_only")
    graph.add_edge("sync_only", END)

    assert await graph.compile().ainvoke({"text": "in"}) == {"text": "in123"}
    assert [p["agent_role"] for p in _starts(client)] == ["function", "native", "sync_only"]
    assert len(threads) == 6
    assert loop_thread not in threads


def test_runnable_node_error_ends_its_child_in_error(patched_langgraph: Any) -> None:
    _session, client, StateGraph = patched_langgraph
    from langchain_core.runnables import RunnableLambda

    def fail(state: dict[str, Any]) -> dict[str, Any]:
        raise ValueError("runnable node crashed")

    app = _one_node_graph(StateGraph, "fails", RunnableLambda(fail)).compile()

    with pytest.raises(ValueError, match="runnable node crashed"):
        app.invoke({"text": "in"})
    (end,) = _ends(client)
    assert end["state"] == "error"
    assert end["error"] == {"type": "ValueError", "message": "runnable node crashed"}
    assert "outgoing_message" not in end


async def test_cancelled_async_node_ends_its_child_in_error(patched_langgraph: Any) -> None:
    """A node timeout or a failed parallel node cancels a node's task; its
    child ends in error instead of staying open."""
    _session, client, StateGraph = patched_langgraph
    entered = asyncio.Event()

    async def wait_forever(state: dict[str, Any]) -> dict[str, Any]:
        entered.set()
        await asyncio.Event().wait()
        return {"text": "never"}

    graph = _one_node_graph(StateGraph, "waits", wait_forever)
    task = asyncio.ensure_future(graph.nodes["waits"].runnable.afunc({"text": "in"}))
    await entered.wait()
    task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await task
    (start,) = _starts(client)
    (end,) = _ends(client)
    assert end["session_id"] == start["session_id"]
    assert end["state"] == "error"
    assert end["error"]["type"] == "CancelledError"


def test_failed_posts_never_reach_a_sync_node(patched_langgraph: Any) -> None:
    _session, client, StateGraph = patched_langgraph
    from langchain_core.runnables import RunnableLambda

    client.post_event.side_effect = RuntimeError("control plane down")
    graph = StateGraph(_TextState)
    from langgraph.graph import END, START

    graph.add_node("plain", lambda state: {"text": state["text"] + "1"})
    graph.add_node("runnable", RunnableLambda(lambda state: {"text": state["text"] + "2"}))
    graph.add_edge(START, "plain")
    graph.add_edge("plain", "runnable")
    graph.add_edge("runnable", END)

    assert graph.compile().invoke({"text": "in"}) == {"text": "in12"}
    assert client.post_event.call_count == 4


async def test_failed_posts_never_reach_an_async_node(patched_langgraph: Any) -> None:
    _session, client, StateGraph = patched_langgraph
    from langgraph._internal._runnable import RunnableCallable

    client.post_event.side_effect = RuntimeError("control plane down")

    async def grow(state: dict[str, Any]) -> dict[str, Any]:
        return {"text": state["text"] + "!"}

    app = _one_node_graph(StateGraph, "native", RunnableCallable(None, grow)).compile()

    assert await app.ainvoke({"text": "in"}) == {"text": "in!"}
    assert client.post_event.call_count == 2


# ----------------------------------------------------------------------
# A wrapped Runnable node runs as the unwrapped node does
# ----------------------------------------------------------------------


def _fan_out_graph(StateGraph: Any) -> Any:
    """A graph whose Runnable nodes return a Command and fan out with Send."""
    import operator
    from typing import Annotated

    from langchain_core.runnables import RunnableLambda
    from langgraph._internal._runnable import RunnableCallable
    from langgraph.graph import END, START
    from langgraph.types import Command, Send

    # The functional form evaluates the reducer now; this module's
    # postponed annotations would leave names LangGraph cannot resolve.
    _State = TypedDict(  # noqa: UP013
        "_State", {"text": str, "items": Annotated[list[str], operator.add]}, total=False
    )

    def plan(state: dict[str, Any]) -> Any:
        return Command(update={"text": state["text"] + ":planned"}, goto="spread")

    def spread(state: dict[str, Any]) -> list[Any]:
        return [Send("work", {"text": f"{state['text']}#{i}"}) for i in range(3)]

    graph = StateGraph(_State)
    graph.add_node("plan", RunnableCallable(plan, None), destinations=("spread",))
    graph.add_node("spread", RunnableLambda(lambda state: {}))
    graph.add_node("work", RunnableLambda(lambda state: {"items": [state["text"].upper()]}))
    graph.add_edge(START, "plan")
    graph.add_conditional_edges("spread", spread, ["work"])
    graph.add_edge("work", END)
    return graph


def test_wrapped_runnable_graph_streams_as_unwrapped(patched_langgraph: Any) -> None:
    _session, client, StateGraph = patched_langgraph
    patched = _fan_out_graph(StateGraph).compile()
    with _unpatched():
        plain = _fan_out_graph(StateGraph).compile()

    for mode in ("values", "updates", "custom", "tasks"):

        def run(app: Any, mode: str = mode) -> list[Any]:
            chunks = list(app.stream({"text": "go"}, stream_mode=mode))
            # A task event carries the task's id; compare the rest. The
            # three Send workers run in parallel and finish in any order.
            return sorted(
                repr({k: v for k, v in c.items() if k != "id"} if isinstance(c, dict) else c)
                for c in chunks
            )

        assert run(patched) == run(plain), mode
    assert sorted(p["agent_role"] for p in _starts(client)).count("work") == 3 * 4


async def test_wrapped_runnable_nodes_emit_the_same_astream_events(
    patched_langgraph: Any,
) -> None:
    """Under astream_events LangGraph streams each node; the wrapper hands
    that to the Runnable's own astream, so a RunnableLambda (an async
    generator one included) and a ToolNode emit the events they emit
    unwrapped."""
    _session, client, StateGraph = patched_langgraph
    from langchain_core.runnables import RunnableLambda
    from langgraph.graph import MessagesState
    from langgraph.prebuilt import ToolNode

    async def chunks(state: dict[str, Any]) -> Any:
        yield {"text": state["text"] + "a"}
        yield {"text": state["text"] + "ab"}

    shapes = [
        (_TextState, lambda: RunnableLambda(lambda state: {"text": "out"}), {"text": "in"}),
        (_TextState, lambda: RunnableLambda(chunks), {"text": "in"}),
        (
            MessagesState,
            lambda: ToolNode([_lookup_tool([])]),
            _tool_call_state("lookup", {"query": "q"}),
        ),
    ]

    async def events(app: Any, state: Any) -> list[tuple[str, str]]:
        return [(e["event"], e["name"]) async for e in app.astream_events(state, version="v2")]

    for schema, make, state in shapes:
        patched = _one_node_graph(StateGraph, "node", make(), schema).compile()
        with _unpatched():
            plain = _one_node_graph(StateGraph, "node", make(), schema).compile()
        assert await events(patched, state) == await events(plain, state)
    assert len(_starts(client)) == 3
    ends = _ends(client)
    # A streamed node's outgoing message is its last chunk.
    assert ends[1]["outgoing_message"]["body"] == {"text": "inab"}


def test_subgraph_detection_unchanged_for_wrapped_runnable(patched_langgraph: Any) -> None:
    """LangGraph finds a sub-graph a Runnable node calls through the
    values its function captures; the wrapper captures the Runnable, so
    checkpoint namespaces and get_subgraphs see the same sub-graph."""
    _session, _client, StateGraph = patched_langgraph
    from langchain_core.runnables import RunnableLambda

    inner = _one_node_graph(StateGraph, "inner", lambda state: {"text": "inner"}).compile()

    def build() -> Any:
        node = RunnableLambda(lambda state: inner.invoke(state))
        return _one_node_graph(StateGraph, "delegate", node).compile()

    patched = build()
    with _unpatched():
        plain = build()

    assert [name for name, _ in patched.get_subgraphs()] == ["delegate"]
    assert [name for name, _ in plain.get_subgraphs()] == ["delegate"]


def test_node_timeout_check_sees_the_same_node(patched_langgraph: Any) -> None:
    """LangGraph refuses a timeout on a node with no async code of its own
    and accepts one on a natively async node; a wrapped node gets the same
    answer."""
    import inspect

    _session, _client, StateGraph = patched_langgraph
    with _unpatched():
        has_timeouts = "timeout" in inspect.signature(StateGraph.add_node).parameters
    if not has_timeouts:
        pytest.skip("this LangGraph has no node timeouts")
    from langchain_core.runnables import RunnableLambda
    from langgraph._internal._runnable import RunnableCallable

    async def grow(state: dict[str, Any]) -> dict[str, Any]:
        return {"text": "out"}

    def compile_with_timeout(node: Any) -> Exception | None:
        graph = StateGraph(_TextState)
        graph.add_node("node", node, timeout=_NODE_TIMEOUT_SECS)
        graph.set_entry_point("node")
        try:
            graph.compile()
        except Exception as exc:  # noqa: BLE001 - the outcome is compared
            return exc
        return None

    for make in (
        lambda: RunnableLambda(lambda state: {"text": "out"}),
        lambda: RunnableCallable(None, grow),
    ):
        patched = compile_with_timeout(make())
        with _unpatched():
            plain = compile_with_timeout(make())
        assert type(patched) is type(plain)


async def test_lcel_pipe_node_keeps_its_steps_events(patched_langgraph: Any) -> None:
    """An LCEL pipe node streams its model's and parser's chunks as it does
    unwrapped; the one difference is the RunnableSequence run LangGraph
    no longer flattens into the node's own run."""
    _session, _client, StateGraph = patched_langgraph
    from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
    from langchain_core.messages import AIMessage
    from langchain_core.output_parsers import StrOutputParser
    from langchain_core.runnables import RunnableLambda

    def make() -> Any:
        model = GenericFakeChatModel(messages=iter([AIMessage(content="three word reply")]))
        return (
            RunnableLambda(lambda state: state["text"])
            | model
            | StrOutputParser()
            | RunnableLambda(lambda text: {"text": text})
        )

    async def events(app: Any) -> list[tuple[str, str]]:
        return [
            (e["event"], e["name"]) async for e in app.astream_events({"text": "in"}, version="v2")
        ]

    patched = await events(_one_node_graph(StateGraph, "pipe", make()).compile())
    with _unpatched():
        plain = await events(_one_node_graph(StateGraph, "pipe", make()).compile())

    assert [e for e in patched if e[1] != "RunnableSequence"] == plain
    assert sorted(e[0] for e in patched if e[1] == "RunnableSequence") == [
        "on_chain_end",
        "on_chain_start",
        "on_chain_stream",
    ]
    assert ("on_parser_stream", "StrOutputParser") in patched


# ----------------------------------------------------------------------
# Review fixes
# ----------------------------------------------------------------------


async def test_each_step_keeps_its_own_dispatch_under_ainvoke(patched_langgraph: Any) -> None:
    """Under ainvoke a wrapped node hands the run to the Runnable's own
    ainvoke, so each step of a pipe is dispatched as it is unwrapped: a
    model with async code gets ainvoke on the loop, not invoke in a worker
    thread (which would bypass an async-only client and outlive a
    cancellation). Covers a mixed pipe, a pure sync Runnable and a pure
    async one."""
    _session, _client, StateGraph = patched_langgraph
    from langchain_core.runnables import Runnable, RunnableLambda
    from langgraph._internal._runnable import RunnableCallable

    loop_thread = threading.get_ident()
    calls: list[tuple[str, bool]] = []

    class _Model(Runnable):
        """Stands for a chat model: a native ainvoke and a separate invoke."""

        def invoke(self, input: Any, config: Any = None, **kwargs: Any) -> Any:
            calls.append(("invoke", threading.get_ident() == loop_thread))
            return {"text": f"{input}!"}

        async def ainvoke(self, input: Any, config: Any = None, **kwargs: Any) -> Any:
            calls.append(("ainvoke", threading.get_ident() == loop_thread))
            return {"text": f"{input}!"}

    class _SyncOnly(Runnable):
        def invoke(self, input: Any, config: Any = None, **kwargs: Any) -> Any:
            calls.append(("invoke", threading.get_ident() == loop_thread))
            return {"text": "sync"}

    async def native(state: dict[str, Any]) -> dict[str, Any]:
        calls.append(("afunc", threading.get_ident() == loop_thread))
        return {"text": "async"}

    shapes = {
        "mixed pipe": lambda: RunnableLambda(lambda state: state["text"]) | _Model(),
        "pure sync": _SyncOnly,
        "pure async": lambda: RunnableCallable(None, native),
    }
    for label, make in shapes.items():
        calls.clear()
        await _one_node_graph(StateGraph, "node", make()).compile().ainvoke({"text": "in"})
        patched = list(calls)
        calls.clear()
        with _unpatched():
            plain = _one_node_graph(StateGraph, "node", make()).compile()
        await plain.ainvoke({"text": "in"})
        assert patched == calls, label


def test_node_defaults_timeout_compiles_as_unwrapped(patched_langgraph: Any) -> None:
    """A graph-wide timeout (set_node_defaults, applied at compile, before
    or after add_node) is refused for a node with no async code of its
    own and accepted for a natively async one, wrapped or not."""
    import inspect

    _session, _client, StateGraph = patched_langgraph
    if (
        not hasattr(StateGraph, "set_node_defaults")
        or "timeout" not in inspect.signature(StateGraph.set_node_defaults).parameters
    ):
        pytest.skip("this LangGraph has no node-default timeouts")
    from langchain_core.runnables import RunnableLambda
    from langgraph._internal._runnable import RunnableCallable

    async def grow(state: dict[str, Any]) -> dict[str, Any]:
        return {"text": "out"}

    def outcome(node: Any, *, defaults_first: bool) -> type[BaseException] | None:
        graph = StateGraph(_TextState)
        if defaults_first:
            graph.set_node_defaults(timeout=_NODE_TIMEOUT_SECS)
        graph.add_node("node", node)
        if not defaults_first:
            graph.set_node_defaults(timeout=_NODE_TIMEOUT_SECS)
        graph.set_entry_point("node")
        try:
            graph.compile()
        except Exception as exc:  # noqa: BLE001 - the outcome is compared
            return type(exc)
        return None

    makers = (
        lambda: RunnableLambda(lambda state: {"text": "out"}),
        lambda: RunnableCallable(None, grow),
    )
    for make in makers:
        for defaults_first in (True, False):
            patched = outcome(make(), defaults_first=defaults_first)
            with _unpatched():
                plain = outcome(make(), defaults_first=defaults_first)
            assert patched is plain
    with _unpatched():
        assert outcome(makers[0](), defaults_first=False) is not None
        assert outcome(makers[1](), defaults_first=False) is None


async def test_sibling_cancelled_by_a_failed_parallel_node_ends_its_child(
    patched_langgraph: Any,
) -> None:
    """LangGraph cancels a failed run's other nodes twice; the second
    cancellation must not drop the waiting sibling's session_end."""
    session, client, StateGraph = patched_langgraph
    from langgraph.graph import END, START

    sibling_waiting = asyncio.Event()

    async def fails(state: dict[str, Any]) -> dict[str, Any]:
        await sibling_waiting.wait()
        raise ValueError("parallel node failed")

    async def waits(state: dict[str, Any]) -> dict[str, Any]:
        sibling_waiting.set()
        await asyncio.Event().wait()
        return {}

    graph = StateGraph(_TextState)
    graph.add_node("fails", fails)
    graph.add_node("waits", waits)
    graph.add_edge(START, "fails")
    graph.add_edge(START, "waits")
    graph.add_edge("fails", END)
    graph.add_edge("waits", END)

    with pytest.raises(ValueError, match="parallel node failed"):
        await graph.compile().ainvoke({"text": "in"})
    # The end is queued apart from the cancelled task and tracked by the
    # session, which waits for it.
    assert await asyncio.to_thread(session.wait_child_posts, _POSTS_WAIT_SECS)
    ends = {p["agent_role"]: p for p in _ends(client)}
    assert set(ends) == {"fails", "waits"}
    assert ends["waits"]["state"] == "error"
    assert ends["waits"]["error"]["type"] == "CancelledError"
    assert ends["fails"]["error"]["type"] == "ValueError"


class _Unprintable(Exception):
    """An exception whose text cannot be rendered."""

    def __str__(self) -> str:
        raise TypeError("cannot render this exception")


def test_unprintable_exception_from_a_sync_node_still_propagates(
    patched_langgraph: Any,
) -> None:
    _session, client, StateGraph = patched_langgraph

    def node(state: dict[str, Any]) -> dict[str, Any]:
        raise _Unprintable()

    with pytest.raises(_Unprintable):
        _one_node_graph(StateGraph, "odd", node).compile().invoke({"text": "in"})
    (end,) = _ends(client)
    assert end["state"] == "error"
    assert end["error"] == {"type": "_Unprintable"}


async def test_unprintable_exception_from_an_async_node_still_propagates(
    patched_langgraph: Any,
) -> None:
    _session, client, StateGraph = patched_langgraph

    async def node(state: dict[str, Any]) -> dict[str, Any]:
        raise _Unprintable()

    with pytest.raises(_Unprintable):
        await _one_node_graph(StateGraph, "odd", node).compile().ainvoke({"text": "in"})
    (end,) = _ends(client)
    assert end["error"] == {"type": "_Unprintable"}


def _add_node_from(module: str, graph: Any, name: str, action: Any) -> None:
    """Call add_node from a frame whose module is ``module``."""
    namespace: dict[str, Any] = {"__name__": module}
    exec("def register(graph, name, action):\n    graph.add_node(name, action)\n", namespace)
    namespace["register"](graph, name, action)


def test_agent_builder_packages_are_matched_as_packages(patched_langgraph: Any) -> None:
    """Any module of langchain.agents or langgraph.prebuilt registers an
    agent's own steps (a release may move the add_node calls); a module
    that only contains those words elsewhere in its name is the
    application's."""
    _session, _client, StateGraph = patched_langgraph
    excluded = ("langchain.agents.experimental", "langgraph.prebuilt.new_agent")
    wrapped = ("myapp.langchain.agents.graph", "langchain_agents_ext", "langgraph.prebuiltish")

    def node(state: dict[str, Any]) -> dict[str, Any]:
        return {"text": "out"}

    for module in excluded + wrapped:
        graph = StateGraph(_TextState)
        _add_node_from(module, graph, "node", node)
        registered = graph.nodes["node"].runnable.func
        assert (registered is node) == (module in excluded), module
