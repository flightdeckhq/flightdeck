"""Unit tests for the LangGraph sub-agent interceptor.

Verifies that wrapping ``StateGraph.add_node`` produces a per-node
child session emission flow with the same shape as the other three
sub-agent interceptors. Also covers the agent-bearing predicate:
without a regex override every node gets wrapped (default-on);
with one only matching node names get child sessions.
"""

from __future__ import annotations

import contextlib
from typing import TYPE_CHECKING, Any
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
