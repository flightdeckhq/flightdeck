"""The Google ADK wrap.

Driven with ADK's own runners, agents, workflow agents and ``AgentTool``
over a scripted model (a ``BaseLlm`` subclass that answers from a list),
so the plugin callbacks, the task layout of each runtime and the nested
runs under test are ADK's own. The sensor's child sessions and signals
are read from the control-plane client's posts. No request leaves the
process.

ADK is imported lazily (``adk`` fixture): importing it at module load
would put it in ``sys.modules`` for the framework-attribution tests
collected after this module.
"""

from __future__ import annotations

import asyncio
import subprocess
import sys
import textwrap
from typing import TYPE_CHECKING, Any
from unittest.mock import MagicMock

import pytest

import flightdeck_sensor
from flightdeck_sensor.core.exceptions import DirectiveError
from flightdeck_sensor.core.policy import PolicyCache
from flightdeck_sensor.core.session import Session
from flightdeck_sensor.core.types import SensorConfig
from flightdeck_sensor.interceptor import google_adk as wrap
from flightdeck_sensor.transport.client import ControlPlaneClient

if TYPE_CHECKING:
    from collections.abc import Iterator

ROOT = "22222222-2222-4222-8222-222222222222"
# The sensor session of a second init() after a teardown.
SECOND_ROOT = "33333333-3333-4333-8333-333333333333"
PARENT_NAME = "adk-parent"
APP = "adk_test"
USER = "tester"
# How long a test waits for the posts a run's end queued (they run in the
# loop's executor and take microseconds against the mocked client).
POSTS_SETTLED_S = 5.0
# How long the cancellation tests let a run get into its slow model call.
CANCEL_AFTER_S = 0.3
# The scripted model's sleep in those tests: far longer than the wait.
SLOW_CALL_S = 30.0
# What the scripted model answers when its script is used up.
DEFAULT_ANSWER = "done"


# ----------------------------------------------------------------------
# Scaffolding
# ----------------------------------------------------------------------


def _session(*, capture_prompts: bool = True, session_id: str = ROOT) -> tuple[Session, MagicMock]:
    config = SensorConfig(
        server="http://localhost:4000/ingest",
        token="tok",
        agent_id="44444444-4444-4444-4444-444444444444",
        agent_name=PARENT_NAME,
        user_name="tester",
        hostname="host1",
        client_type="flightdeck_sensor",
        agent_flavor="playground-test",
        agent_type="coding",
        session_id=session_id,
        capture_prompts=capture_prompts,
        quiet=True,
    )
    client = MagicMock(spec=ControlPlaneClient)
    client.post_event.return_value = (None, False)
    session = Session(config=config, client=client, event_queue=MagicMock())
    session.policy = PolicyCache(token_limit=None, block_at_pct=100)
    return session, client


class _Sleep:
    """A scripted model step that waits (to be cancelled or closed)."""

    def __init__(self, seconds: float) -> None:
        self.seconds = seconds


class _Call:
    """A scripted model step that calls a function (a tool, an AgentTool,
    ``transfer_to_agent``)."""

    def __init__(self, name: str, **args: Any) -> None:
        self.name = name
        self.args = args


class ADK:
    """The ADK names the tests use, imported once ADK is available."""

    def __init__(self) -> None:
        from google.adk.agents import LlmAgent, LoopAgent, ParallelAgent, SequentialAgent
        from google.adk.apps import App
        from google.adk.models.base_llm import BaseLlm
        from google.adk.models.llm_response import LlmResponse
        from google.adk.plugins.base_plugin import BasePlugin
        from google.adk.runners import InMemoryRunner, Runner
        from google.adk.sessions.in_memory_session_service import InMemorySessionService
        from google.adk.tools.agent_tool import AgentTool
        from google.genai import types

        self.LlmAgent, self.LoopAgent = LlmAgent, LoopAgent
        self.ParallelAgent, self.SequentialAgent = ParallelAgent, SequentialAgent
        self.App, self.BasePlugin, self.AgentTool = App, BasePlugin, AgentTool
        self.InMemoryRunner, self.Runner = InMemoryRunner, Runner
        self.InMemorySessionService = InMemorySessionService
        self.types = types

        class Scripted(BaseLlm):
            """Answers each model call with the next scripted step: text,
            a function call, an exception to raise, or a wait."""

            model: str = "scripted"
            script: list[Any] = []

            async def generate_content_async(  # type: ignore[override]
                self, llm_request: Any, stream: bool = False
            ) -> Any:
                step = self.script.pop(0) if self.script else DEFAULT_ANSWER
                if isinstance(step, _Sleep):
                    await asyncio.sleep(step.seconds)
                    step = DEFAULT_ANSWER
                if isinstance(step, BaseException):
                    raise step
                if isinstance(step, _Call):
                    part = types.Part.from_function_call(name=step.name, args=step.args)
                else:
                    part = types.Part.from_text(text=step)
                yield LlmResponse(content=types.Content(role="model", parts=[part]))

        self.Scripted = Scripted

    def agent(self, name: str, *script: Any, **kwargs: Any) -> Any:
        kwargs.setdefault("description", name)
        return self.LlmAgent(name=name, model=self.Scripted(script=list(script)), **kwargs)

    def message(self, text: str) -> Any:
        return self.types.Content(role="user", parts=[self.types.Part.from_text(text=text)])


@pytest.fixture
def adk() -> ADK:
    pytest.importorskip("google.adk.runners")
    return ADK()


@pytest.fixture
def patched(adk: ADK, monkeypatch: pytest.MonkeyPatch) -> Iterator[tuple[Session, MagicMock]]:
    """The wrap installed, a sensor session active."""
    session, client = _session()
    monkeypatch.setattr(flightdeck_sensor, "_session", session)
    wrap.patch_google_adk(quiet=True)
    try:
        yield session, client
    finally:
        wrap.unpatch_google_adk()


async def _consume(
    runner: Any, adk: ADK, *, text: str = "hello", close_after: int | None = None
) -> list[Any]:
    session = await runner.session_service.create_session(app_name=APP, user_id=USER)
    events = []
    agen = runner.run_async(user_id=USER, session_id=session.id, new_message=adk.message(text))
    try:
        async for event in agen:
            events.append(event)
            if close_after is not None and len(events) >= close_after:
                break
    finally:
        await agen.aclose()
    return events


def _run(adk: ADK, root: Any, **kwargs: Any) -> list[Any]:
    runner = adk.InMemoryRunner(agent=root, app_name=APP)
    return asyncio.run(_consume(runner, adk, **kwargs))


def _posted(session: Session, client: MagicMock) -> list[dict[str, Any]]:
    assert session.wait_child_posts(POSTS_SETTLED_S)
    return [c.args[0] for c in client.post_event.call_args_list]


def _children(posts: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    """Each child's start and end, by role, in the order they started:
    {role: [{"id", "parent", "start", "end"}, ...]}."""
    out: dict[str, list[dict[str, Any]]] = {}
    by_id: dict[str, dict[str, Any]] = {}
    for p in posts:
        if p["session_id"] == ROOT:
            continue
        if p["event_type"] == "session_start":
            entry = {"id": p["session_id"], "parent": p["parent_session_id"], "start": p}
            entry["end"] = None
            by_id[p["session_id"]] = entry
            out.setdefault(p["agent_role"], []).append(entry)
        elif p["event_type"] == "session_end":
            by_id[p["session_id"]]["end"] = p
    return out


def _one(children: dict[str, list[dict[str, Any]]], role: str) -> dict[str, Any]:
    entries = children[role]
    assert len(entries) == 1, entries
    return entries[0]


def _handoffs(posts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        p for p in posts if p["event_type"] == "session_signal" and p["signal"] == "agent_handoff"
    ]


def _order(posts: list[dict[str, Any]]) -> list[tuple[str, str]]:
    """The child posts in order, each as (kind, role)."""
    out = []
    for p in posts:
        if p["session_id"] == ROOT and p["event_type"] != "session_signal":
            continue
        kind = p["event_type"] if p["event_type"] != "session_signal" else p["signal"]
        out.append((kind, p.get("agent_role") or ""))
    return out


def _closed(entry: dict[str, Any]) -> bool:
    end = entry["end"]
    return end is not None and "state" not in end


def _errored(entry: dict[str, Any], error_type: str) -> bool:
    end = entry["end"]
    return end is not None and end.get("state") == "error" and end["error"]["type"] == error_type


def get_weather(city: str) -> dict[str, str]:
    """The weather in a city."""
    return {"city": city, "weather": "sunny"}


def broken_tool(x: str) -> dict[str, str]:
    """A tool that fails."""
    raise ValueError("the tool failed")


# ----------------------------------------------------------------------
# Session trees
# ----------------------------------------------------------------------


def test_transfer_opens_a_child_and_reports_the_hand_off_on_the_root(
    adk: ADK, patched: Any
) -> None:
    session, client = patched
    b = adk.agent("b_agent", "from b")
    root = adk.agent("root_agent", _Call("transfer_to_agent", agent_name="b_agent"), sub_agents=[b])
    _run(adk, root)
    posts = _posted(session, client)
    children = _children(posts)
    assert set(children) == {"b_agent"}, "the root agent is the sensor's session"
    b_child = _one(children, "b_agent")
    assert b_child["parent"] == ROOT
    assert _closed(b_child)
    (handoff,) = _handoffs(posts)
    assert handoff["session_id"] == ROOT
    assert handoff["signal_data"] == {"from": "root_agent", "to": "b_agent"}


def test_a_transferring_child_is_closed_when_the_run_ends(adk: ADK, patched: Any) -> None:
    session, client = patched
    d = adk.agent("d_agent", "from d")
    b = adk.agent("b_agent", _Call("transfer_to_agent", agent_name="d_agent"), sub_agents=[d])
    root = adk.agent("root_agent", _Call("transfer_to_agent", agent_name="b_agent"), sub_agents=[b])
    _run(adk, root)
    posts = _posted(session, client)
    children = _children(posts)
    b_child, d_child = _one(children, "b_agent"), _one(children, "d_agent")
    assert b_child["parent"] == ROOT
    assert d_child["parent"] == b_child["id"], "the nearest ancestor with an open child"
    assert _closed(b_child) and _closed(d_child)
    handoffs = _handoffs(posts)
    assert [(h["session_id"], h["signal_data"]) for h in handoffs] == [
        (ROOT, {"from": "root_agent", "to": "b_agent"}),
        (b_child["id"], {"from": "b_agent", "to": "d_agent"}),
    ]
    order = _order(posts)
    # b gets no after_agent once it transfers: its end comes at the run's
    # end, after its hand-off and after d's own end.
    assert order.index(("agent_handoff", "b_agent")) < order.index(("session_end", "b_agent"))
    assert order.index(("session_end", "d_agent")) < order.index(("session_end", "b_agent"))


def test_agent_tool_nests_under_the_caller(adk: ADK, patched: Any) -> None:
    session, client = patched
    c = adk.agent("c_agent", "from c")
    root = adk.agent(
        "root_agent",
        _Call("c_agent", request="q"),
        _Call("get_weather", city="Paris"),
        "final",
        tools=[adk.AgentTool(c), get_weather],
    )
    _run(adk, root)
    posts = _posted(session, client)
    children = _children(posts)
    assert set(children) == {"c_agent"}, "a function tool opens no child"
    assert _one(children, "c_agent")["parent"] == ROOT
    assert _closed(_one(children, "c_agent"))
    assert not _handoffs(posts)


def test_nested_agent_tools_nest_under_each_caller(adk: ADK, patched: Any) -> None:
    session, client = patched
    inner = adk.agent("inner_agent", "from inner")
    mid = adk.agent(
        "mid_agent", _Call("inner_agent", request="q"), "mid done", tools=[adk.AgentTool(inner)]
    )
    root = adk.agent(
        "root_agent", _Call("mid_agent", request="q"), "final", tools=[adk.AgentTool(mid)]
    )
    _run(adk, root)
    children = _children(_posted(session, client))
    mid_child, inner_child = _one(children, "mid_agent"), _one(children, "inner_agent")
    assert mid_child["parent"] == ROOT
    assert inner_child["parent"] == mid_child["id"]
    assert _closed(mid_child) and _closed(inner_child)


def test_agent_tool_without_plugins_is_still_observed(adk: ADK, patched: Any) -> None:
    session, client = patched
    c = adk.agent("c_agent", "from c")
    root = adk.agent(
        "root_agent",
        _Call("c_agent", request="q"),
        "final",
        tools=[adk.AgentTool(c, include_plugins=False)],
    )
    _run(adk, root)
    children = _children(_posted(session, client))
    assert _one(children, "c_agent")["parent"] == ROOT


def test_sequential_sub_agents_are_children_and_the_workflow_is_not(adk: ADK, patched: Any) -> None:
    session, client = patched
    a, b = adk.agent("a_agent", "from a"), adk.agent("b_agent", "from b")
    _run(adk, adk.SequentialAgent(name="pipeline", sub_agents=[a, b]))
    posts = _posted(session, client)
    children = _children(posts)
    assert set(children) == {"a_agent", "b_agent"}
    assert {_one(children, r)["parent"] for r in children} == {ROOT}
    assert _order(posts) == [
        ("session_start", "a_agent"),
        ("session_end", "a_agent"),
        ("session_start", "b_agent"),
        ("session_end", "b_agent"),
    ]


def test_parallel_branches_are_open_at_once_under_the_same_parent(adk: ADK, patched: Any) -> None:
    session, client = patched
    a = adk.agent("a_agent", _Sleep(0.05), "from a")
    b = adk.agent("b_agent", _Sleep(0.05), "from b")
    _run(adk, adk.ParallelAgent(name="fan_out", sub_agents=[a, b]))
    posts = _posted(session, client)
    children = _children(posts)
    assert set(children) == {"a_agent", "b_agent"}
    assert {_one(children, r)["parent"] for r in children} == {ROOT}
    kinds = [kind for kind, _ in _order(posts)]
    assert kinds[:2] == ["session_start", "session_start"], "both open before either ends"


def test_a_parallel_inside_an_agent_tool_nests_under_the_tool_agent(adk: ADK, patched: Any) -> None:
    session, client = patched
    a, b = adk.agent("a_agent", "from a"), adk.agent("b_agent", "from b")
    fan_out = adk.ParallelAgent(name="fan_out", sub_agents=[a, b], description="fan out")
    lead = adk.agent(
        "lead_agent", _Call("fan_out", request="q"), "done", tools=[adk.AgentTool(fan_out)]
    )
    outer = adk.agent(
        "outer_agent", _Call("lead_agent", request="q"), "final", tools=[adk.AgentTool(lead)]
    )
    _run(adk, outer)
    children = _children(_posted(session, client))
    lead_child = _one(children, "lead_agent")
    assert "fan_out" not in children
    assert _one(children, "a_agent")["parent"] == lead_child["id"]
    assert _one(children, "b_agent")["parent"] == lead_child["id"]


def test_each_loop_iteration_is_a_new_child(adk: ADK, patched: Any) -> None:
    session, client = patched
    a = adk.agent("a_agent", "one", "two")
    _run(adk, adk.LoopAgent(name="loop", sub_agents=[a], max_iterations=2))
    posts = _posted(session, client)
    entries = _children(posts)["a_agent"]
    assert len(entries) == 2
    assert entries[0]["id"] != entries[1]["id"]
    assert all(_closed(e) and e["parent"] == ROOT for e in entries)
    assert _order(posts) == [
        ("session_start", "a_agent"),
        ("session_end", "a_agent"),
        ("session_start", "a_agent"),
        ("session_end", "a_agent"),
    ]


def test_the_consumer_never_runs_in_a_child_scope(adk: ADK, patched: Any) -> None:
    """A workflow agent runs its sub-agents on the consumer's own task:
    the child's scope is set around each step of the run and left before
    each event reaches the consumer."""
    session, _ = patched
    a, b = adk.agent("a_agent", "from a"), adk.agent("b_agent", "from b")
    root = adk.SequentialAgent(name="pipeline", sub_agents=[a, b])
    seen: list[Any] = []

    async def main() -> None:
        runner = adk.InMemoryRunner(agent=root, app_name=APP)
        adk_session = await runner.session_service.create_session(app_name=APP, user_id=USER)
        async for _ in runner.run_async(
            user_id=USER, session_id=adk_session.id, new_message=adk.message("hi")
        ):
            seen.append(session.active_subagent_scope())
        seen.append(session.active_subagent_scope())

    asyncio.run(main())
    assert len(seen) > 1
    assert seen == [None] * len(seen)


# ----------------------------------------------------------------------
# Errors, cancellation, early close
# ----------------------------------------------------------------------


def test_a_tool_error_ends_the_agent_child_in_error(adk: ADK, patched: Any) -> None:
    session, client = patched
    worker = adk.agent("worker_agent", _Call("broken_tool", x="1"), tools=[broken_tool])
    root = adk.agent(
        "root_agent", _Call("worker_agent", request="q"), tools=[adk.AgentTool(worker)]
    )
    with pytest.raises(ValueError, match="the tool failed"):
        _run(adk, root)
    worker_child = _one(_children(_posted(session, client)), "worker_agent")
    assert _errored(worker_child, "ValueError")
    assert worker_child["end"]["error"]["message"] == "the tool failed"


def test_a_model_error_in_a_transferred_agent_ends_its_child_in_error(
    adk: ADK, patched: Any
) -> None:
    session, client = patched
    b = adk.agent("b_agent", RuntimeError("model down"))
    root = adk.agent("root_agent", _Call("transfer_to_agent", agent_name="b_agent"), sub_agents=[b])
    with pytest.raises(RuntimeError, match="model down"):
        _run(adk, root)
    assert _errored(_one(_children(_posted(session, client)), "b_agent"), "RuntimeError")


@pytest.mark.parametrize("workflow", [False, True], ids=["node-runtime", "workflow-runtime"])
def test_a_cancelled_run_ends_the_open_child_in_error(
    adk: ADK, patched: Any, workflow: bool
) -> None:
    session, client = patched
    b = adk.agent("b_agent", _Sleep(SLOW_CALL_S))
    if workflow:
        root = adk.SequentialAgent(name="pipeline", sub_agents=[b])
    else:
        root = adk.agent(
            "root_agent", _Call("transfer_to_agent", agent_name="b_agent"), sub_agents=[b]
        )

    async def main() -> None:
        runner = adk.InMemoryRunner(agent=root, app_name=APP)
        task = asyncio.create_task(_consume(runner, adk))
        await asyncio.sleep(CANCEL_AFTER_S)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(main())
    assert _errored(_one(_children(_posted(session, client)), "b_agent"), "CancelledError")


def test_an_early_close_closes_the_open_child(adk: ADK, patched: Any) -> None:
    session, client = patched
    a, b = adk.agent("a_agent", "from a"), adk.agent("b_agent", "from b")
    _run(adk, adk.SequentialAgent(name="pipeline", sub_agents=[a, b]), close_after=1)
    children = _children(_posted(session, client))
    assert set(children) == {"a_agent"}
    assert _closed(_one(children, "a_agent")), "closed by the run's end, without after_agent"


def test_a_directive_error_from_the_model_reaches_the_caller_unwrapped(
    adk: ADK, patched: Any
) -> None:
    session, client = patched
    b = adk.agent("b_agent", DirectiveError("shutdown", "stopped"))
    root = adk.agent("root_agent", _Call("transfer_to_agent", agent_name="b_agent"), sub_agents=[b])
    with pytest.raises(DirectiveError):
        _run(adk, root)
    assert _errored(_one(_children(_posted(session, client)), "b_agent"), "DirectiveError")


def test_a_run_started_after_a_shutdown_raises_before_any_child(adk: ADK, patched: Any) -> None:
    session, client = patched
    session._shutdown_requested = True
    b = adk.agent("b_agent", "from b")
    root = adk.agent("root_agent", _Call("transfer_to_agent", agent_name="b_agent"), sub_agents=[b])
    with pytest.raises(DirectiveError):
        _run(adk, root)
    assert not _children(_posted(session, client))


# ----------------------------------------------------------------------
# Plugins, patching
# ----------------------------------------------------------------------


def _recording_plugin(adk: ADK, name: str, seen: list[str]) -> Any:
    class Recorder(adk.BasePlugin):  # type: ignore[misc, name-defined]
        async def before_agent_callback(self, *, agent: Any, callback_context: Any) -> None:
            seen.append(f"{name}:{agent.name}")

    return Recorder(name=name)


def test_user_plugins_are_kept_on_the_app_path(adk: ADK, patched: Any) -> None:
    session, client = patched
    seen: list[str] = []
    user = _recording_plugin(adk, "user_plugin", seen)
    b = adk.agent("b_agent", "from b")
    root = adk.agent("root_agent", _Call("transfer_to_agent", agent_name="b_agent"), sub_agents=[b])
    app = adk.App(name=APP, root_agent=root, plugins=[user])
    runner = adk.Runner(app=app, session_service=adk.InMemorySessionService())
    asyncio.run(_consume(runner, adk))
    assert [p.name for p in runner.plugin_manager.plugins] == [wrap.PLUGIN_NAME, "user_plugin"]
    assert app.plugins == [user], "the App's own list is left as given"
    assert seen == ["user_plugin:root_agent", "user_plugin:b_agent"]
    assert _one(_children(_posted(session, client)), "b_agent")["parent"] == ROOT


def test_user_plugins_are_kept_on_the_deprecated_runner_path(adk: ADK, patched: Any) -> None:
    session, client = patched
    seen: list[str] = []
    user = _recording_plugin(adk, "user_plugin", seen)
    b = adk.agent("b_agent", "from b")
    root = adk.agent("root_agent", _Call("transfer_to_agent", agent_name="b_agent"), sub_agents=[b])
    runner = adk.InMemoryRunner(agent=root, app_name=APP, plugins=[user])
    asyncio.run(_consume(runner, adk))
    assert [p.name for p in runner.plugin_manager.plugins] == [wrap.PLUGIN_NAME, "user_plugin"]
    assert seen == ["user_plugin:root_agent", "user_plugin:b_agent"]
    assert set(_children(_posted(session, client))) == {"b_agent"}


def test_patch_is_idempotent_and_unpatch_restores_the_runner(adk: ADK) -> None:
    runner_cls = adk.Runner
    originals = {name: runner_cls.__dict__[name] for name in ("__init__", "run_async", "run_live")}
    wrap.patch_google_adk(quiet=True)
    once = {name: runner_cls.__dict__[name] for name in originals}
    wrap.patch_google_adk(quiet=True)
    try:
        assert {name: runner_cls.__dict__[name] for name in originals} == once
        assert all(once[name] is not originals[name] for name in originals)
        b = adk.agent("b_agent", "from b")
        assert wrap._has_plugin(adk.InMemoryRunner(agent=b, app_name=APP))
    finally:
        wrap.unpatch_google_adk()
    assert {name: runner_cls.__dict__[name] for name in originals} == originals
    wrap.unpatch_google_adk()
    b = adk.agent("b_agent", "from b")
    assert not wrap._has_plugin(adk.InMemoryRunner(agent=b, app_name=APP))


def test_a_runner_built_before_patch_is_not_observed(
    adk: ADK, monkeypatch: pytest.MonkeyPatch
) -> None:
    session, client = _session()
    monkeypatch.setattr(flightdeck_sensor, "_session", session)
    b = adk.agent("b_agent", "from b")
    root = adk.agent("root_agent", _Call("transfer_to_agent", agent_name="b_agent"), sub_agents=[b])
    runner = adk.InMemoryRunner(agent=root, app_name=APP)
    wrap.patch_google_adk(quiet=True)
    try:
        asyncio.run(_consume(runner, adk))
    finally:
        wrap.unpatch_google_adk()
    assert not _posted(session, client), "the documented limit: no plugin, no children"


def test_the_plugin_does_nothing_without_a_session(
    adk: ADK, monkeypatch: pytest.MonkeyPatch
) -> None:
    session, client = _session()
    monkeypatch.setattr(flightdeck_sensor, "_session", session)
    wrap.patch_google_adk(quiet=True)
    try:
        b = adk.agent("b_agent", "from b")
        root = adk.agent(
            "root_agent", _Call("transfer_to_agent", agent_name="b_agent"), sub_agents=[b]
        )
        runner = adk.InMemoryRunner(agent=root, app_name=APP)
        monkeypatch.setattr(flightdeck_sensor, "_session", None)
        events = asyncio.run(_consume(runner, adk))
    finally:
        wrap.unpatch_google_adk()
    assert events[-1].content.parts[0].text == "from b"
    assert not client.post_event.called


def test_a_runner_reports_to_the_session_active_at_each_run(
    adk: ADK, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A runner built in one session, the sensor torn down and initialised
    again: its runs report to the session active when each run starts, and
    to none while there is none, the run unaffected."""
    first, first_client = _session()
    monkeypatch.setattr(flightdeck_sensor, "_session", first)
    wrap.patch_google_adk(quiet=True)
    try:
        transfer = _Call("transfer_to_agent", agent_name="b_agent")
        b = adk.agent("b_agent", "from b", "from b", "from b")
        root = adk.agent("root_agent", transfer, transfer, transfer, sub_agents=[b])
        runner = adk.InMemoryRunner(agent=root, app_name=APP)
        asyncio.run(_consume(runner, adk))
        monkeypatch.setattr(flightdeck_sensor, "_session", None)
        torn_down = asyncio.run(_consume(runner, adk))
        second, second_client = _session(session_id=SECOND_ROOT)
        monkeypatch.setattr(flightdeck_sensor, "_session", second)
        asyncio.run(_consume(runner, adk))
    finally:
        wrap.unpatch_google_adk()
    assert torn_down[-1].content.parts[0].text == "from b"
    first_posts = _posted(first, first_client)
    assert [p["parent_session_id"] for p in first_posts if p["event_type"] == "session_start"] == [
        ROOT
    ]
    second_posts = _posted(second, second_client)
    starts = [p for p in second_posts if p["event_type"] == "session_start"]
    assert [(p["agent_role"], p["parent_session_id"]) for p in starts] == [("b_agent", SECOND_ROOT)]
    (handoff,) = _handoffs(second_posts)
    assert handoff["session_id"] == SECOND_ROOT
    # Nothing from the torn-down run reached either session.
    assert len([p for p in first_posts if p["event_type"] == "session_start"]) == 1


# ----------------------------------------------------------------------
# Fail open
# ----------------------------------------------------------------------


def _texts(events: list[Any]) -> list[tuple[str, str | None]]:
    return [
        (e.author, e.content.parts[0].text if e.content and e.content.parts else None)
        for e in events
    ]


def _scenario(adk: ADK) -> Any:
    c = adk.agent("c_agent", "from c")
    d = adk.agent("d_agent", _Call("c_agent", request="q"), "from d", tools=[adk.AgentTool(c)])
    return adk.agent("root_agent", _Call("transfer_to_agent", agent_name="d_agent"), sub_agents=[d])


def test_a_sensor_failure_in_every_callback_never_changes_the_run(
    adk: ADK, monkeypatch: pytest.MonkeyPatch
) -> None:
    unpatched = _texts(_run(adk, _scenario(adk)))

    def boom(*args: Any, **kwargs: Any) -> Any:
        raise RuntimeError("sensor bug")

    session, client = _session()
    monkeypatch.setattr(flightdeck_sensor, "_session", session)
    for name in ("_agent_started", "_agent_ended", "_event_seen"):
        monkeypatch.setattr(wrap, name, boom)
    wrap.patch_google_adk(quiet=True)
    try:
        assert _texts(_run(adk, _scenario(adk))) == unpatched
    finally:
        wrap.unpatch_google_adk()


def test_a_failing_post_never_changes_the_run_or_its_exception(adk: ADK, patched: Any) -> None:
    session, client = patched
    reported = _texts(_run(adk, _scenario(adk)))
    client.post_event.side_effect = RuntimeError("control plane down")
    assert _texts(_run(adk, _scenario(adk))) == reported
    b = adk.agent("b_agent", ValueError("model failed"))
    root = adk.agent("root_agent", _Call("transfer_to_agent", agent_name="b_agent"), sub_agents=[b])
    with pytest.raises(ValueError, match="model failed"):
        _run(adk, root)


# ----------------------------------------------------------------------
# Capture
# ----------------------------------------------------------------------


def test_capture_on_carries_the_messages(adk: ADK, patched: Any) -> None:
    session, client = patched
    a, b = adk.agent("a_agent", "answer a"), adk.agent("b_agent", "answer b")
    _run(adk, adk.SequentialAgent(name="pipeline", sub_agents=[a, b]), text="the question")
    children = _children(_posted(session, client))
    a_child, b_child = _one(children, "a_agent"), _one(children, "b_agent")
    assert a_child["start"]["incoming_message"]["body"] == "the question"
    assert "incoming_message" not in b_child["start"], "only a run's first child takes it"
    assert a_child["end"]["outgoing_message"]["body"] == "answer a"
    assert b_child["end"]["outgoing_message"]["body"] == "answer b"


def test_capture_off_sends_no_content(adk: ADK, monkeypatch: pytest.MonkeyPatch) -> None:
    session, client = _session(capture_prompts=False)
    monkeypatch.setattr(flightdeck_sensor, "_session", session)
    wrap.patch_google_adk(quiet=True)
    try:
        worker = adk.agent("worker_agent", _Call("broken_tool", x="secret"), tools=[broken_tool])
        a = adk.agent("a_agent", "the secret answer")
        root = adk.agent(
            "root_agent",
            _Call("transfer_to_agent", agent_name="a_agent"),
            sub_agents=[a],
        )
        _run(adk, root, text="the secret question")
        lead = adk.agent(
            "lead_agent", _Call("worker_agent", request="secret"), tools=[adk.AgentTool(worker)]
        )
        with pytest.raises(ValueError):
            _run(adk, lead, text="the secret question")
    finally:
        wrap.unpatch_google_adk()
    posts = _posted(session, client)
    assert posts
    for p in posts:
        assert "incoming_message" not in p and "outgoing_message" not in p
        assert not p.get("has_content") and p.get("content") is None
    worker_end = _one(_children(posts), "worker_agent")["end"]
    assert worker_end["error"] == {"type": "ValueError"}
    assert "secret" not in repr(posts)


def test_the_plugin_reports_no_tool_calls(adk: ADK, patched: Any) -> None:
    session, client = patched
    c = adk.agent("c_agent", "from c")
    root = adk.agent(
        "root_agent",
        _Call("c_agent", request="q"),
        _Call("get_weather", city="Paris"),
        "final",
        tools=[adk.AgentTool(c), get_weather],
    )
    _run(adk, root)
    posts = _posted(session, client)
    queue = session.event_queue
    assert isinstance(queue, MagicMock)
    queued = [c.args[0]["event_type"] for c in queue.enqueue.call_args_list]
    assert "tool_call" not in queued
    assert {p["event_type"] for p in posts} <= {"session_start", "session_end", "session_signal"}


# ----------------------------------------------------------------------
# Lazy import
# ----------------------------------------------------------------------


def _python(code: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-c", textwrap.dedent(code)],
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )


def test_importing_the_sensor_imports_no_adk() -> None:
    result = _python(
        """
        import sys
        import flightdeck_sensor
        from flightdeck_sensor import Provider
        assert Provider.GOOGLE_ADK == "google_adk"
        loaded = [m for m in sys.modules if m.startswith("google.adk")]
        assert not loaded, loaded
        """
    )
    assert result.returncode == 0, result.stderr


def test_patch_and_unpatch_without_any_google_package() -> None:
    """With no ``google`` package at all (no ADK, no google-genai), patch()
    and unpatch() for Google ADK do nothing and raise nothing."""
    result = _python(
        """
        import sys
        # Every google.* import fails, as on a lane that installs none.
        sys.modules["google"] = None
        import flightdeck_sensor
        from flightdeck_sensor.interceptor import google_adk
        flightdeck_sensor.init(server="http://127.0.0.1:9/ingest", token="tok", quiet=True)
        flightdeck_sensor.patch(providers=["google_adk"], quiet=True)
        flightdeck_sensor.patch(quiet=True)
        google_adk.patch_google_adk(quiet=False)
        google_adk.unpatch_google_adk()
        flightdeck_sensor.unpatch()
        flightdeck_sensor.teardown()
        assert not [m for m in sys.modules if m.startswith("google.")]
        """
    )
    assert result.returncode == 0, result.stderr


def test_patch_before_import_patches_the_runner_when_adk_is_imported(adk: ADK) -> None:
    result = _python(
        """
        import sys
        import flightdeck_sensor
        flightdeck_sensor.init(server="http://127.0.0.1:9/ingest", token="tok", quiet=True)
        flightdeck_sensor.patch(providers=["google_adk"], quiet=True)
        assert "google.adk.runners" not in sys.modules
        from google.adk.runners import Runner
        assert Runner.__dict__.get("_flightdeck_google_adk_patched") is True
        flightdeck_sensor.unpatch()
        assert "_flightdeck_google_adk_patched" not in Runner.__dict__
        """
    )
    assert result.returncode == 0, result.stderr
