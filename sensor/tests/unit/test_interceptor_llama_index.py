"""Unit tests for the LlamaIndex agent-workflow interceptor.

Real LlamaIndex agents (``FunctionAgent``, ``ReActAgent``, a multi-agent
``AgentWorkflow``) run on llama-index's OpenAI LLM over the real
``openai`` client, patched by the sensor, with the HTTP transport mocked
by respx. So the spans the handler reads are the ones LlamaIndex emits,
and the model calls reach the sensor through the same SDK patch as in
production. No request leaves the process.

LlamaIndex is imported inside the fixtures, not at module import: the
framework-attribution tests assume a bare process until a test imports a
framework.
"""

from __future__ import annotations

import asyncio
import contextvars
import json
from typing import Any
from unittest.mock import MagicMock

import httpx
import pytest
import respx

import flightdeck_sensor
from flightdeck_sensor.core.exceptions import DirectiveError
from flightdeck_sensor.core.session import Session
from flightdeck_sensor.core.types import EventType, SensorConfig, TokenUsage
from flightdeck_sensor.interceptor import llama_index as li_mod
from flightdeck_sensor.transport.client import ControlPlaneClient

BASE_URL = "https://api.openai.com/v1"
PARENT_AGENT_NAME = "parent-agent"


# ----- wire bodies the OpenAI API sends ---------------------------------------


def _usage(prompt: int, completion: int) -> dict[str, int]:
    return {
        "prompt_tokens": prompt,
        "completion_tokens": completion,
        "total_tokens": prompt + completion,
    }


def _tool_call(call_id: str, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": call_id,
        "type": "function",
        "function": {"name": name, "arguments": json.dumps(arguments)},
    }


def _completion(
    *,
    content: str | None = None,
    tool_calls: list[dict[str, Any]] | None = None,
    prompt: int = 50,
    completion: int = 10,
) -> httpx.Response:
    message: dict[str, Any] = {"role": "assistant", "content": content}
    if tool_calls:
        message["tool_calls"] = tool_calls
    body = {
        "id": "chatcmpl-1",
        "object": "chat.completion",
        "created": 1,
        "model": "gpt-4o-mini",
        "choices": [
            {
                "index": 0,
                "message": message,
                "finish_reason": "tool_calls" if tool_calls else "stop",
            }
        ],
        "usage": _usage(prompt, completion),
    }
    return httpx.Response(200, json=body)


def _stream(
    *,
    content: str | None = None,
    tool_calls: list[dict[str, Any]] | None = None,
    prompt: int = 50,
    completion: int = 10,
) -> httpx.Response:
    """A chat completion stream: the delta, the finish chunk and the usage
    chunk ``stream_options.include_usage`` asks for."""
    base = {"id": "chatcmpl-1", "object": "chat.completion.chunk", "created": 1}
    base["model"] = "gpt-4o-mini"
    delta: dict[str, Any] = {"role": "assistant", "content": content}
    if tool_calls:
        delta["tool_calls"] = [{"index": i, **tc} for i, tc in enumerate(tool_calls)]
    chunks = [
        {**base, "choices": [{"index": 0, "delta": delta, "finish_reason": None}]},
        {
            **base,
            "choices": [
                {
                    "index": 0,
                    "delta": {},
                    "finish_reason": "tool_calls" if tool_calls else "stop",
                }
            ],
        },
        {**base, "choices": [], "usage": _usage(prompt, completion)},
    ]
    text = "".join(f"data: {json.dumps(c)}\n\n" for c in chunks) + "data: [DONE]\n\n"
    return httpx.Response(200, content=text.encode(), headers={"content-type": "text/event-stream"})


# ----- sensor scaffolding -----------------------------------------------------


class _Recorder:
    """A Session whose synchronous posts and queued events land, in the
    order the sensor sent them, on one timeline."""

    def __init__(self, *, capture_prompts: bool = True) -> None:
        config = SensorConfig(
            server="http://localhost:9999",
            token="tok",
            agent_id="11111111-1111-1111-1111-111111111111",
            agent_name=PARENT_AGENT_NAME,
            user_name="tester",
            hostname="host1",
            client_type="flightdeck_sensor",
            agent_flavor="playground-test",
            agent_type="coding",
            capture_prompts=capture_prompts,
            quiet=True,
        )
        self.timeline: list[dict[str, Any]] = []
        self.client = MagicMock(spec=ControlPlaneClient)

        def _post(payload: dict[str, Any], **_kw: Any) -> tuple[None, bool]:
            self.timeline.append(payload)
            return None, False

        self.client.post_event.side_effect = _post
        queue = MagicMock()
        queue.enqueue.side_effect = self.timeline.append
        self.session = Session(config=config, client=self.client, event_queue=queue)

    @property
    def session_id(self) -> str:
        return self.session.config.session_id

    def of(self, event_type: str, session_id: str | None = None) -> list[dict[str, Any]]:
        return [
            e
            for e in self.timeline
            if e.get("event_type") == event_type
            and (session_id is None or e.get("session_id") == session_id)
        ]

    def children(self) -> dict[str, dict[str, Any]]:
        """The child session_start events by agent role (the last one of a
        role wins)."""
        return {
            e["agent_role"]: e
            for e in self.of("session_start")
            if e.get("parent_session_id") == self.session_id
        }


@pytest.fixture()
def llama() -> Any:
    """Import LlamaIndex's agent classes and OpenAI LLM, or skip."""
    workflow = pytest.importorskip("llama_index.core.agent.workflow")
    openai_llm = pytest.importorskip("llama_index.llms.openai")
    return workflow, openai_llm


def _install(capture_prompts: bool = True) -> _Recorder:
    from flightdeck_sensor.interceptor.openai import patch_openai_classes

    recorder = _Recorder(capture_prompts=capture_prompts)
    flightdeck_sensor._session = recorder.session
    patch_openai_classes(quiet=True)
    li_mod.patch_llama_index(quiet=True)
    return recorder


@pytest.fixture()
def sensor() -> Any:
    prior = flightdeck_sensor._session
    holder: dict[str, _Recorder] = {}

    def _make(capture_prompts: bool = True) -> _Recorder:
        holder["r"] = _install(capture_prompts)
        return holder["r"]

    try:
        yield _make
    finally:
        from flightdeck_sensor.interceptor.openai import unpatch_openai_classes

        li_mod.unpatch_llama_index()
        unpatch_openai_classes()
        flightdeck_sensor._session = prior


def multiply(a: int, b: int) -> int:
    """Multiply two integers."""
    return a * b


def _llm(llama: Any) -> Any:
    _, openai_llm = llama
    return openai_llm.OpenAI(model="gpt-4o-mini", api_key="sk-test", max_retries=0)


# ----- single agent -------------------------------------------------------------


@pytest.mark.parametrize("streaming", [False, True])
async def test_function_agent_run_is_a_child_session_its_calls_stay_on_the_root(
    llama: Any, sensor: Any, streaming: bool
) -> None:
    workflow, _ = llama
    rec = sensor()
    reply = _stream if streaming else _completion
    with respx.mock(base_url=BASE_URL) as router:
        router.post("/chat/completions").mock(
            side_effect=[
                reply(tool_calls=[_tool_call("call_1", "multiply", {"a": 6, "b": 7})]),
                reply(content="6 times 7 is 42.", prompt=70, completion=8),
            ]
        )
        agent = workflow.FunctionAgent(
            name="calculator", tools=[multiply], llm=_llm(llama), streaming=streaming
        )
        result = await agent.run(user_msg="What is 6 times 7?")
    assert "42" in str(result)

    child = rec.children()["calculator"]
    child_id = child["session_id"]
    assert child["agent_name"] == f"{PARENT_AGENT_NAME}/calculator"
    assert child["agent_id"] == rec.session.derive_subagent_id("calculator")
    assert child["incoming_message"]["body"] == "What is 6 times 7?"

    # Both model calls, and the one tool call the first response asked
    # for, are on the sensor's session; the child carries the structure.
    calls = rec.of("post_call", rec.session_id)
    assert len(calls) == 2
    for event in [*calls, *rec.of("pre_call")]:
        assert event["session_id"] == rec.session_id
        assert "parent_session_id" not in event
        assert "agent_role" not in event
    assert [c["tokens_used_session"] for c in calls] == [60, 138]
    (tool,) = rec.of("tool_call")
    assert tool["session_id"] == rec.session_id
    assert tool["tool_name"] == "multiply"
    assert {e["event_type"] for e in rec.timeline if e["session_id"] == child_id} == {
        "session_start",
        "session_end",
    }

    (end,) = rec.of("session_end", child_id)
    assert "state" not in end
    assert end["outgoing_message"]["body"] == "6 times 7 is 42."
    # The child's start and end are posted at once, as the other wraps'.
    posted = [c.args[0] for c in rec.client.post_event.call_args_list]
    assert child in posted
    assert end in posted


async def test_react_agent_tool_run_is_reported_once_by_the_wrap(llama: Any, sensor: Any) -> None:
    workflow, _ = llama
    rec = sensor()
    with respx.mock(base_url=BASE_URL) as router:
        router.post("/chat/completions").mock(
            side_effect=[
                _completion(
                    content=(
                        "Thought: I need the multiply tool.\n"
                        "Action: multiply\n"
                        'Action Input: {"a": 6, "b": 7}'
                    )
                ),
                _completion(content="Thought: I can answer.\nAnswer: 42"),
            ]
        )
        agent = workflow.ReActAgent(
            name="reactor", tools=[multiply], llm=_llm(llama), streaming=False
        )
        result = await agent.run(user_msg="What is 6 times 7?")
    assert "42" in str(result)

    assert "reactor" in rec.children()
    calls = rec.of("post_call", rec.session_id)
    assert len(calls) == 2
    # The model asked in text, so no response reported the tool call; the
    # wrap reports it, once, on the sensor's session, with its arguments
    # and output under capture.
    (tool,) = rec.of("tool_call")
    assert tool["session_id"] == rec.session_id
    assert "agent_role" not in tool
    assert tool["tool_name"] == "multiply"
    assert isinstance(tool["latency_ms"], int)
    assert tool["has_content"] is True
    assert tool["content"]["tool_input"] == {"a": 6, "b": 7}
    assert tool["content"]["tool_output"] == "42"
    assert tool["content"]["session_id"] == rec.session_id
    assert tool["originating_event_id"] == calls[0]["id"]


async def test_react_tool_run_carries_no_content_with_capture_off(llama: Any, sensor: Any) -> None:
    workflow, _ = llama
    rec = sensor(capture_prompts=False)
    with respx.mock(base_url=BASE_URL) as router:
        router.post("/chat/completions").mock(
            side_effect=[
                _completion(content='Thought: t\nAction: multiply\nAction Input: {"a": 2, "b": 3}'),
                _completion(content="Thought: done\nAnswer: 6"),
            ]
        )
        agent = workflow.ReActAgent(
            name="reactor", tools=[multiply], llm=_llm(llama), streaming=False
        )
        await agent.run(user_msg="2 times 3?")

    (tool,) = rec.of("tool_call")
    assert tool["tool_name"] == "multiply"
    assert tool["has_content"] is False
    assert tool["content"] is None
    child = rec.children()["reactor"]
    assert "incoming_message" not in child
    assert "outgoing_message" not in rec.of("session_end", child["session_id"])[0]
    for event in rec.timeline:
        assert "6" not in json.dumps(event.get("content") or {})


# ----- multi-agent hand-off ------------------------------------------------------


async def test_agent_workflow_hand_off_ends_one_child_and_opens_the_next(
    llama: Any, sensor: Any
) -> None:
    workflow, _ = llama
    rec = sensor()
    llm = _llm(llama)
    with respx.mock(base_url=BASE_URL) as router:
        router.post("/chat/completions").mock(
            side_effect=[
                _completion(tool_calls=[_tool_call("call_1", "multiply", {"a": 6, "b": 7})]),
                _completion(
                    tool_calls=[
                        _tool_call(
                            "call_2",
                            "handoff",
                            {"to_agent": "writer", "reason": "State the product, 42."},
                        )
                    ]
                ),
                _completion(content="The answer is 42."),
            ]
        )
        calculator = workflow.FunctionAgent(
            name="calculator",
            description="Does arithmetic.",
            tools=[multiply],
            llm=llm,
            can_handoff_to=["writer"],
            streaming=False,
        )
        writer = workflow.FunctionAgent(
            name="writer", description="Writes the answer.", llm=llm, streaming=False
        )
        flow = workflow.AgentWorkflow(agents=[calculator, writer], root_agent="calculator")
        result = await flow.run(user_msg="6 times 7, then hand off to the writer.")
    assert "42" in str(result)

    children = rec.children()
    calc_id = children["calculator"]["session_id"]
    writer_id = children["writer"]["session_id"]
    # Every call of both agents is on the sensor's session, each tool call
    # once.
    assert len(rec.of("post_call", rec.session_id)) == 3
    assert len(rec.of("post_call")) == 3
    assert {t["tool_name"]: t["session_id"] for t in rec.of("tool_call")} == {
        "multiply": rec.session_id,
        "handoff": rec.session_id,
    }
    assert children["writer"]["incoming_message"]["body"] == "State the product, 42."

    # The hand-off is on the agent handing off, before its end.
    (signal,) = rec.of("session_signal")
    assert signal["session_id"] == calc_id
    assert signal["signal_data"] == {"from": "calculator", "to": "writer"}
    (calc_end,) = rec.of("session_end", calc_id)
    (writer_end,) = rec.of("session_end", writer_id)
    order = rec.timeline.index
    assert order(signal) < order(calc_end) < order(children["writer"])
    assert writer_end["outgoing_message"]["body"] == "The answer is 42."


async def test_agent_handed_back_to_opens_a_new_child(llama: Any, sensor: Any) -> None:
    workflow, _ = llama
    rec = sensor()
    llm = _llm(llama)
    with respx.mock(base_url=BASE_URL) as router:
        router.post("/chat/completions").mock(
            side_effect=[
                _completion(
                    tool_calls=[_tool_call("c1", "handoff", {"to_agent": "b", "reason": "r1"})]
                ),
                _completion(
                    tool_calls=[_tool_call("c2", "handoff", {"to_agent": "a", "reason": "r2"})]
                ),
                _completion(content="done"),
            ]
        )
        a = workflow.FunctionAgent(
            name="a", description="A.", llm=llm, can_handoff_to=["b"], streaming=False
        )
        b = workflow.FunctionAgent(
            name="b", description="B.", llm=llm, can_handoff_to=["a"], streaming=False
        )
        await workflow.AgentWorkflow(agents=[a, b], root_agent="a").run(user_msg="go")

    starts = [e for e in rec.of("session_start") if e.get("parent_session_id")]
    assert [e["agent_role"] for e in starts] == ["a", "b", "a"]
    assert len({e["session_id"] for e in starts}) == 3
    assert [e["signal_data"] for e in rec.of("session_signal")] == [
        {"from": "a", "to": "b"},
        {"from": "b", "to": "a"},
    ]
    assert len(rec.of("session_end")) == 3


# ----- failures and enforcement -------------------------------------------------


async def test_a_shutdown_stops_the_run_at_its_next_model_call(llama: Any, sensor: Any) -> None:
    workflow, _ = llama
    rec = sensor()
    rec.session._shutdown_requested = True
    rec.session._shutdown_reason = "stopped from the dashboard"
    with respx.mock(base_url=BASE_URL, assert_all_called=False) as router:
        route = router.post("/chat/completions").mock(return_value=_completion(content="x"))
        agent = workflow.FunctionAgent(name="calculator", llm=_llm(llama), streaming=False)
        with pytest.raises(DirectiveError):
            await agent.run(user_msg="hi")
    assert route.call_count == 0
    child_id = rec.children()["calculator"]["session_id"]
    (end,) = rec.of("session_end", child_id)
    assert end["state"] == "error"
    assert end["error"]["type"] == "DirectiveError"


async def test_a_provider_error_ends_the_child_in_error(llama: Any, sensor: Any) -> None:
    workflow, _ = llama
    rec = sensor()
    with respx.mock(base_url=BASE_URL) as router:
        router.post("/chat/completions").mock(
            return_value=httpx.Response(400, json={"error": {"message": "bad", "type": "x"}})
        )
        agent = workflow.FunctionAgent(name="calculator", llm=_llm(llama), streaming=False)
        with pytest.raises(Exception):  # noqa: B017 -- whatever the SDK raises
            await agent.run(user_msg="hi")
    child_id = rec.children()["calculator"]["session_id"]
    (err,) = rec.of("llm_error")
    assert err["session_id"] == rec.session_id
    (end,) = rec.of("session_end", child_id)
    assert end["state"] == "error"


class _Bound:
    """Stands in for the ``inspect.BoundArguments`` a span carries."""

    def __init__(self, **arguments: Any) -> None:
        self.arguments = arguments


class _AgentInput:
    def __init__(self, name: str) -> None:
        self.current_agent_name = name


def _followed_run(llama: Any, rec: _Recorder) -> tuple[li_mod._Tracker, str]:
    """A tracker following one FunctionAgent run whose agent ``solo`` has
    opened its child."""
    workflow, _ = llama
    flightdeck_sensor._session = rec.session
    tracker = li_mod._Tracker()
    agent = workflow.FunctionAgent(name="solo", llm=_llm(llama))
    run_id = "FunctionAgent.run-1"
    tracker.enter(run_id, _Bound(), agent, None)
    tracker.enter("BaseWorkflowAgent.setup_agent-1", _Bound(ev=_AgentInput("solo")), None, run_id)
    tracker.exit("BaseWorkflowAgent.setup_agent-1", None)
    return tracker, run_id


@pytest.mark.parametrize(
    ("later_step_completes", "state"), [(False, "error"), (True, None)], ids=["failed", "retried"]
)
def test_a_failed_step_ends_the_run_in_error_unless_a_later_step_completes(
    llama: Any, later_step_completes: bool, state: str | None
) -> None:
    prior = flightdeck_sensor._session
    rec = _Recorder()
    try:
        tracker, run_id = _followed_run(llama, rec)
        tracker.enter("BaseWorkflowAgent.run_agent_step-1", _Bound(ev=None), None, run_id)
        tracker.drop("BaseWorkflowAgent.run_agent_step-1", RuntimeError("model down"))
        if later_step_completes:
            tracker.enter("BaseWorkflowAgent.run_agent_step-2", _Bound(ev=None), None, run_id)
            tracker.exit("BaseWorkflowAgent.run_agent_step-2", None)
        # The run span exits, as early llama-index-workflows releases do
        # for a failed run too.
        tracker.exit(run_id, None)
    finally:
        flightdeck_sensor._session = prior
    (end,) = rec.of("session_end")
    assert end.get("state") == state
    if state == "error":
        assert end["error"] == {"type": "RuntimeError", "message": "model down"}


def test_control_flow_step_drops_are_not_failures(llama: Any) -> None:
    prior = flightdeck_sensor._session
    rec = _Recorder()

    class WorkflowDone(Exception):
        pass

    try:
        tracker, run_id = _followed_run(llama, rec)
        tracker.enter("AgentWorkflow._done-1", _Bound(ev=None), None, run_id)
        tracker.drop("AgentWorkflow._done-1", WorkflowDone())
        tracker.exit(run_id, None)
    finally:
        flightdeck_sensor._session = prior
    (end,) = rec.of("session_end")
    assert "state" not in end


def test_a_span_outside_a_followed_run_is_ignored(llama: Any) -> None:
    prior = flightdeck_sensor._session
    rec = _Recorder()
    flightdeck_sensor._session = rec.session
    try:
        tracker = li_mod._Tracker()
        tracker.enter("OpenAI.achat-1", _Bound(), object(), "SomeQueryEngine.query-1")
        tracker.enter("Workflow.run-1", _Bound(), object(), None)
        tracker.exit("OpenAI.achat-1", None)
        tracker.drop("Workflow.run-1", RuntimeError("x"))
    finally:
        flightdeck_sensor._session = prior
    assert rec.timeline == []
    assert rec.session.active_subagent_scope() is None


async def test_an_agent_run_inside_a_tool_opens_its_own_child(llama: Any, sensor: Any) -> None:
    workflow, _ = llama
    rec = sensor()
    llm = _llm(llama)

    async def ask_expert(question: str) -> str:
        """Ask the expert agent a question."""
        expert = workflow.FunctionAgent(name="expert", llm=llm, streaming=False)
        return str(await expert.run(user_msg=question))

    with respx.mock(base_url=BASE_URL) as router:
        router.post("/chat/completions").mock(
            side_effect=[
                _completion(tool_calls=[_tool_call("c1", "ask_expert", {"question": "why?"})]),
                _completion(content="because"),
                _completion(content="The expert says: because."),
            ]
        )
        lead = workflow.FunctionAgent(name="lead", tools=[ask_expert], llm=llm, streaming=False)
        await lead.run(user_msg="Ask the expert why.")

    children = rec.children()
    assert set(children) == {"lead", "expert"}
    expert_id = children["expert"]["session_id"]
    # Both children hang off the sensor's session, which has every call.
    assert children["expert"]["parent_session_id"] == rec.session_id
    assert children["expert"]["incoming_message"]["body"] == "why?"
    assert len(rec.of("post_call", rec.session_id)) == 3
    (tool,) = rec.of("tool_call")
    assert tool["tool_name"] == "ask_expert"
    (expert_end,) = rec.of("session_end", expert_id)
    assert expert_end["outgoing_message"]["body"] == "because"


# ----- scope and lifecycle -------------------------------------------------------


async def test_no_scope_is_left_behind_after_the_run(llama: Any, sensor: Any) -> None:
    workflow, _ = llama
    rec = sensor()
    llm = _llm(llama)
    with respx.mock(base_url=BASE_URL) as router:
        router.post("/chat/completions").mock(return_value=_completion(content="ok"))
        await workflow.FunctionAgent(name="solo", llm=llm, streaming=False).run(user_msg="hi")
        assert rec.session.active_subagent_scope() is None
        await llm.acomplete("plain call")
    assert len(rec.of("post_call", rec.session_id)) == 2


async def test_no_session_leaves_the_run_alone(llama: Any) -> None:
    workflow, _ = llama
    prior = flightdeck_sensor._session
    flightdeck_sensor._session = None
    li_mod.patch_llama_index(quiet=True)
    try:
        with respx.mock(base_url=BASE_URL) as router:
            router.post("/chat/completions").mock(return_value=_completion(content="ok"))
            result = await workflow.FunctionAgent(
                name="solo", llm=_llm(llama), streaming=False
            ).run(user_msg="hi")
        assert str(result) == "ok"
    finally:
        li_mod.unpatch_llama_index()
        flightdeck_sensor._session = prior


def test_patch_is_idempotent_and_unpatch_detaches(llama: Any, sensor: Any) -> None:
    sensor()
    dispatcher = li_mod._root_dispatcher()
    li_mod.patch_llama_index(quiet=True)
    ours = [h for h in dispatcher.span_handlers if h is li_mod._handler]
    assert len(ours) == 1
    handler = li_mod._handler
    li_mod.unpatch_llama_index()
    assert handler not in dispatcher.span_handlers
    assert li_mod._handler is None
    li_mod.unpatch_llama_index()


def test_a_release_below_the_floor_is_left_unwrapped(
    llama: Any, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setattr(li_mod, "_core_version", lambda: (0, 13))
    with caplog.at_level("WARNING", logger="flightdeck_sensor.interceptor.llama_index"):
        li_mod.patch_llama_index(quiet=True)
    assert li_mod._handler is None
    assert "older than 0.14" in caplog.text


def test_the_floor_is_the_release_line_the_wrap_was_built_on() -> None:
    assert li_mod.LLAMA_INDEX_CORE_FLOOR == (0, 14)


async def test_a_failing_handler_never_breaks_the_run(
    llama: Any, sensor: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    workflow, _ = llama
    sensor()

    def _boom(*_a: Any, **_k: Any) -> None:
        raise RuntimeError("tracker bug")

    monkeypatch.setattr(li_mod._tracker, "enter", _boom)
    with respx.mock(base_url=BASE_URL) as router:
        router.post("/chat/completions").mock(return_value=_completion(content="ok"))
        result = await workflow.FunctionAgent(name="solo", llm=_llm(llama), streaming=False).run(
            user_msg="hi"
        )
    assert str(result) == "ok"


# ----- the Session's sub-agent scope ----------------------------------------------


def _scoped() -> tuple[_Recorder, Any]:
    rec = _Recorder()
    scope = rec.session.new_subagent_scope(
        child_session_id="22222222-2222-2222-2222-222222222222",
        child_agent_id="33333333-3333-3333-3333-333333333333",
        child_agent_name="parent-agent/child",
        agent_role="child",
    )
    return rec, scope


def test_an_event_built_in_a_scope_stays_on_the_sensors_session() -> None:
    rec, scope = _scoped()
    token = Session.enter_subagent_scope(scope)
    try:
        assert rec.session.active_subagent_scope() is scope
        total = rec.session.record_usage(TokenUsage(input_tokens=10, output_tokens=5))
        payload = rec.session._build_payload(EventType.TOOL_CALL, tool_name="t")
    finally:
        Session.exit_subagent_scope(token)
    assert payload["session_id"] == rec.session_id
    assert payload["agent_id"] == rec.session.config.agent_id
    assert "parent_session_id" not in payload
    assert "agent_role" not in payload
    assert total == 15
    assert rec.session.active_subagent_scope() is None


def test_another_sessions_scope_is_ignored() -> None:
    rec, scope = _scoped()
    other = _Recorder()
    token = Session.enter_subagent_scope(scope)
    try:
        assert other.session.active_subagent_scope() is None
        other.session.note_reported_tool_call("call_1")
    finally:
        Session.exit_subagent_scope(token)
    assert not rec.session.tool_call_reported(scope, "call_1")


def test_exiting_a_scope_from_another_context_is_ignored() -> None:
    rec, scope = _scoped()
    token = Session.enter_subagent_scope(scope)
    contextvars.copy_context().run(Session.exit_subagent_scope, token)
    assert rec.session.active_subagent_scope() is scope
    Session.exit_subagent_scope(token)
    assert rec.session.active_subagent_scope() is None


def test_reported_tool_calls_are_kept_per_child() -> None:
    rec, scope = _scoped()
    rec.session.note_reported_tool_call("call_outside")
    token = Session.enter_subagent_scope(scope)
    try:
        rec.session.note_reported_tool_call("call_1")
        rec.session.note_reported_tool_call(None)
    finally:
        Session.exit_subagent_scope(token)
    assert rec.session.tool_call_reported(scope, "call_1")
    assert not rec.session.tool_call_reported(scope, "call_outside")
    assert not rec.session.tool_call_reported(scope, None)


async def test_a_scope_follows_the_tasks_started_inside_it() -> None:
    rec, scope = _scoped()

    async def _inner() -> Any:
        return rec.session.active_subagent_scope()

    token = Session.enter_subagent_scope(scope)
    try:
        inside = await asyncio.create_task(_inner())
    finally:
        Session.exit_subagent_scope(token)
    outside = await asyncio.create_task(_inner())
    assert inside is scope
    assert outside is None
