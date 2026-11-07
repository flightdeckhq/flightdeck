"""The OpenAI Agents SDK wrap.

Driven with the SDK's own runner and its ``OpenAIResponsesModel`` over a
respx-mocked Responses endpoint (JSON and SSE), so the hooks, hand-offs,
nested runs and guardrails under test are the SDK's, not stand-ins. The
sensor's child sessions and signals are read from the control-plane
client's synchronous posts, the OpenAI patch's events from the event
queue. No request leaves the process.

The SDK is imported lazily (``_sdk`` fixture): importing it at module
load would put it in ``sys.modules`` for the framework-attribution tests
collected after this module.
"""

from __future__ import annotations

import asyncio
import importlib.metadata
import json
import logging
import types
from typing import TYPE_CHECKING, Any
from unittest.mock import MagicMock

import pytest

import flightdeck_sensor
from flightdeck_sensor.core.exceptions import DirectiveError
from flightdeck_sensor.core.policy import PolicyCache
from flightdeck_sensor.core.session import (
    GUARDRAIL_KINDS,
    SIGNAL_GUARDRAIL_TRIPWIRE,
    Session,
)
from flightdeck_sensor.core.types import SensorConfig
from flightdeck_sensor.interceptor import openai_agents as wrap
from flightdeck_sensor.transport.client import ControlPlaneClient

if TYPE_CHECKING:
    from collections.abc import Iterator

ROOT = "11111111-1111-4111-8111-111111111111"
MODEL = "gpt-4.1-nano"
BASE_URL = "https://api.openai.com/v1"
PARENT_NAME = "oa-parent"


# ----------------------------------------------------------------------
# Scaffolding
# ----------------------------------------------------------------------


def _session(*, capture_prompts: bool = True) -> tuple[Session, MagicMock]:
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
        session_id=ROOT,
        capture_prompts=capture_prompts,
        quiet=True,
    )
    client = MagicMock(spec=ControlPlaneClient)
    client.post_event.return_value = (None, False)
    session = Session(config=config, client=client, event_queue=MagicMock())
    session.policy = PolicyCache(token_limit=None, block_at_pct=100)
    return session, client


def _posted(client: MagicMock) -> list[dict[str, Any]]:
    return [c.args[0] for c in client.post_event.call_args_list]


def _queued(session: Session, event_type: str) -> list[dict[str, Any]]:
    queue = session.event_queue
    assert isinstance(queue, MagicMock)
    return [
        c.args[0] for c in queue.enqueue.call_args_list if c.args[0].get("event_type") == event_type
    ]


def _starts(client: MagicMock) -> list[dict[str, Any]]:
    return [p for p in _posted(client) if p["event_type"] == "session_start"]


def _ends(client: MagicMock) -> list[dict[str, Any]]:
    return [p for p in _posted(client) if p["event_type"] == "session_end"]


def _signals(client: MagicMock, name: str | None = None) -> list[dict[str, Any]]:
    return [
        p
        for p in _posted(client)
        if p["event_type"] == "session_signal" and (name is None or p["signal"] == name)
    ]


def _structure(client: MagicMock) -> list[tuple[str, str]]:
    """The posts in order, each as (kind, agent_role)."""
    out = []
    for p in _posted(client):
        kind = p["event_type"] if p["event_type"] != "session_signal" else p["signal"]
        out.append((kind, p.get("agent_role") or ""))
    return out


@pytest.fixture
def sdk() -> Any:
    """The SDK, with tracing off (its exporter would post to OpenAI)."""
    agents = pytest.importorskip("agents")
    try:
        importlib.metadata.version("openai-agents")
    except importlib.metadata.PackageNotFoundError:
        pytest.skip("openai-agents not installed")
    agents.set_tracing_disabled(True)
    return agents


@pytest.fixture
def patched(sdk: Any, monkeypatch: pytest.MonkeyPatch) -> Iterator[tuple[Session, MagicMock]]:
    """The wrap and the OpenAI patch installed, a sensor session active."""
    from flightdeck_sensor.interceptor.openai import patch_openai_classes, unpatch_openai_classes

    session, client = _session()
    monkeypatch.setattr(flightdeck_sensor, "_session", session)
    patch_openai_classes(quiet=True)
    wrap.patch_openai_agents(quiet=True)
    try:
        yield session, client
    finally:
        wrap.unpatch_openai_agents()
        unpatch_openai_classes()


# ---- the mocked Responses endpoint ---------------------------------------


def _message_item(text: str) -> dict[str, Any]:
    return {
        "id": "msg_1",
        "type": "message",
        "role": "assistant",
        "status": "completed",
        "content": [{"type": "output_text", "text": text, "annotations": []}],
    }


def _call_item(name: str, arguments: dict[str, Any], call_id: str) -> dict[str, Any]:
    return {
        "id": f"fc_{call_id}",
        "type": "function_call",
        "call_id": call_id,
        "name": name,
        "arguments": json.dumps(arguments),
        "status": "completed",
    }


def _response(output: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "id": "resp_1",
        "object": "response",
        "created_at": 1.0,
        "model": MODEL,
        "status": "completed",
        "output": output,
        "parallel_tool_calls": True,
        "tool_choice": "auto",
        "tools": [],
        "usage": {
            "input_tokens": 20,
            "output_tokens": 5,
            "total_tokens": 25,
            "input_tokens_details": {"cached_tokens": 0},
            "output_tokens_details": {"reasoning_tokens": 0},
        },
    }


def _sse(output: list[dict[str, Any]]) -> str:
    """A streamed response: created, one added/done pair per item, then
    completed with the whole response."""
    body = _response(output)
    created = {**body, "status": "in_progress", "output": [], "usage": None}
    events: list[tuple[str, dict[str, Any]]] = [
        ("response.created", {"type": "response.created", "response": created})
    ]
    for i, item in enumerate(output):
        events.append(
            (
                "response.output_item.added",
                {"type": "response.output_item.added", "output_index": i, "item": item},
            )
        )
        events.append(
            (
                "response.output_item.done",
                {"type": "response.output_item.done", "output_index": i, "item": item},
            )
        )
    events.append(("response.completed", {"type": "response.completed", "response": body}))
    chunks = []
    for seq, (name, data) in enumerate(events):
        chunks.append(f"event: {name}\ndata: {json.dumps({**data, 'sequence_number': seq})}\n\n")
    return "".join(chunks)


class Script:
    """Responses the mocked endpoint returns, in order; JSON or SSE as the
    request asks."""

    def __init__(self, *outputs: list[dict[str, Any]]) -> None:
        self.outputs = list(outputs)
        self.requests: list[dict[str, Any]] = []

    def __call__(self, request: Any) -> Any:
        import httpx

        body = json.loads(request.content)
        self.requests.append(body)
        if not self.outputs:
            return httpx.Response(500, json={"error": {"message": "script exhausted"}})
        output = self.outputs.pop(0)
        if body.get("stream"):
            return httpx.Response(
                200, text=_sse(output), headers={"content-type": "text/event-stream"}
            )
        return httpx.Response(200, json=_response(output))


@pytest.fixture
def responses() -> Iterator[Any]:
    respx = pytest.importorskip("respx")
    with respx.mock(base_url=BASE_URL, assert_all_called=False) as router:
        yield router


def _script(router: Any, *outputs: list[dict[str, Any]]) -> Script:
    script = Script(*outputs)
    router.post("/responses").mock(side_effect=script)
    return script


def _model(sdk: Any) -> Any:
    import openai
    from agents.models.openai_responses import OpenAIResponsesModel

    return OpenAIResponsesModel(
        model=MODEL, openai_client=openai.AsyncOpenAI(api_key="sk-test", max_retries=0)
    )


def _agent(sdk: Any, name: str, **kwargs: Any) -> Any:
    return sdk.Agent(name=name, instructions=f"You are {name}.", model=_model(sdk), **kwargs)


def _run(sdk: Any, agent: Any, text: str = "hello", **kwargs: Any) -> Any:
    return asyncio.run(sdk.Runner.run(agent, text, **kwargs))


async def _stream(sdk: Any, agent: Any, text: str = "hello", **kwargs: Any) -> Any:
    result = sdk.Runner.run_streamed(agent, text, **kwargs)
    async for _ in result.stream_events():
        pass
    # Let the run loop task's done callback run.
    await asyncio.sleep(0)
    return result


# ----------------------------------------------------------------------
# One agent
# ----------------------------------------------------------------------


def test_an_agent_runs_in_a_child_session_of_the_sensors(
    sdk: Any, patched: tuple[Session, MagicMock], responses: Any
) -> None:
    session, client = patched
    _script(responses, [_message_item("hi there")])

    result = _run(sdk, _agent(sdk, "assistant"))

    assert result.final_output == "hi there"
    (start,) = _starts(client)
    (end,) = _ends(client)
    assert start["parent_session_id"] == ROOT
    assert start["agent_role"] == "assistant"
    assert start["agent_name"] == f"{PARENT_NAME}/assistant"
    assert start["agent_id"] == session.derive_subagent_id("assistant")
    assert start["session_id"] == end["session_id"] != ROOT
    assert start["framework"] == end["framework"]
    assert "state" not in end
    # Capture on: the run's input in, the final output out.
    assert start["incoming_message"]["body"] == "hello"
    assert end["outgoing_message"]["body"] == "hi there"
    # The model call stays on the sensor's own session.
    (post,) = _queued(session, "post_call")
    assert post["session_id"] == ROOT
    assert post["model"] == MODEL


def test_capture_off_sends_no_messages(
    sdk: Any, monkeypatch: pytest.MonkeyPatch, responses: Any
) -> None:
    session, client = _session(capture_prompts=False)
    monkeypatch.setattr(flightdeck_sensor, "_session", session)
    wrap.patch_openai_agents(quiet=True)
    try:
        _script(responses, [_message_item("secret answer")])
        _run(sdk, _agent(sdk, "assistant"))
    finally:
        wrap.unpatch_openai_agents()
    (start,) = _starts(client)
    (end,) = _ends(client)
    assert "incoming_message" not in start
    assert "outgoing_message" not in end
    assert "secret answer" not in json.dumps(_posted(client))


def test_no_session_runs_untouched(
    sdk: Any, monkeypatch: pytest.MonkeyPatch, responses: Any
) -> None:
    monkeypatch.setattr(flightdeck_sensor, "_session", None)
    wrap.patch_openai_agents(quiet=True)
    try:
        _script(responses, [_message_item("ok")])
        assert _run(sdk, _agent(sdk, "assistant")).final_output == "ok"
    finally:
        wrap.unpatch_openai_agents()


def test_run_sync_is_wrapped(sdk: Any, patched: tuple[Session, MagicMock], responses: Any) -> None:
    _, client = patched
    _script(responses, [_message_item("ok")])

    def in_thread() -> Any:
        # run_sync refuses a running loop; give it a thread with none.
        return sdk.Runner.run_sync(_agent(sdk, "assistant"), "hi")

    import concurrent.futures

    with concurrent.futures.ThreadPoolExecutor(1) as pool:
        assert pool.submit(in_thread).result().final_output == "ok"
    assert [s["agent_role"] for s in _starts(client)] == ["assistant"]
    assert len(_ends(client)) == 1


# ----------------------------------------------------------------------
# Hand-offs
# ----------------------------------------------------------------------


def test_a_hand_off_signals_on_the_agent_handing_off_and_closes_it(
    sdk: Any, patched: tuple[Session, MagicMock], responses: Any
) -> None:
    _, client = patched
    weather = _agent(sdk, "weather_agent")
    triage = _agent(sdk, "triage_agent", handoffs=[weather])
    _script(
        responses,
        [_call_item("transfer_to_weather_agent", {}, "c1")],
        [_message_item("sunny")],
    )

    assert _run(sdk, triage).final_output == "sunny"

    assert _structure(client) == [
        ("session_start", "triage_agent"),
        ("agent_handoff", "triage_agent"),
        ("session_end", "triage_agent"),
        ("session_start", "weather_agent"),
        ("session_end", "weather_agent"),
    ]
    (handoff,) = _signals(client, "agent_handoff")
    starts = {s["agent_role"]: s for s in _starts(client)}
    assert handoff["signal_data"] == {"from": "triage_agent", "to": "weather_agent"}
    assert handoff["session_id"] == starts["triage_agent"]["session_id"]
    # Siblings: both under the sensor's session.
    assert {s["parent_session_id"] for s in starts.values()} == {ROOT}
    # Only the first agent carries the run's input.
    assert "incoming_message" not in starts["weather_agent"]


# ----------------------------------------------------------------------
# Tools
# ----------------------------------------------------------------------


def test_a_function_tool_adds_no_wrap_event_and_one_tool_call(
    sdk: Any, patched: tuple[Session, MagicMock], responses: Any
) -> None:
    session, client = patched
    calls: list[str] = []

    @sdk.function_tool
    def get_weather(city: str) -> str:
        """Weather for a city."""
        calls.append(city)
        return "sunny"

    _script(
        responses,
        [_call_item("get_weather", {"city": "Paris"}, "c1")],
        [_message_item("It is sunny.")],
    )
    _run(sdk, _agent(sdk, "assistant", tools=[get_weather]))

    assert calls == ["Paris"]
    assert _structure(client) == [("session_start", "assistant"), ("session_end", "assistant")]
    tool_calls = _queued(session, "tool_call")
    assert [t["tool_name"] for t in tool_calls] == ["get_weather"]
    assert {t["session_id"] for t in tool_calls} == {ROOT}


def test_an_agent_used_as_a_tool_nests_under_the_calling_agent(
    sdk: Any, patched: tuple[Session, MagicMock], responses: Any
) -> None:
    session, client = patched
    expert = _agent(sdk, "expert")
    lead = _agent(
        sdk,
        "lead",
        tools=[expert.as_tool(tool_name="ask_expert", tool_description="Ask the expert.")],
    )
    _script(
        responses,
        [_call_item("ask_expert", {"input": "why?"}, "c1")],
        [_message_item("because")],
        [_message_item("The expert says: because")],
    )

    _run(sdk, lead, conversation_id="conv_outer")

    starts = {s["agent_role"]: s for s in _starts(client)}
    ends = {e["agent_role"]: e for e in _ends(client)}
    assert starts["lead"]["parent_session_id"] == ROOT
    assert starts["expert"]["parent_session_id"] == starts["lead"]["session_id"]
    assert ends["expert"]["parent_session_id"] == starts["lead"]["session_id"]
    # The nested run ends before the outer one.
    assert _structure(client) == [
        ("session_start", "lead"),
        ("session_start", "expert"),
        ("session_end", "expert"),
        ("session_end", "lead"),
    ]
    # The nested run inherits the conversation id.
    assert starts["expert"]["context"]["gen_ai_conversation_id"] == "conv_outer"
    # One tool_call per function_call item, all on the sensor's session.
    assert [t["tool_name"] for t in _queued(session, "tool_call")] == ["ask_expert"]


# ----------------------------------------------------------------------
# Streaming
# ----------------------------------------------------------------------


def test_a_streamed_run_closes_its_children_when_it_ends(
    sdk: Any, patched: tuple[Session, MagicMock], responses: Any
) -> None:
    session, client = patched
    weather = _agent(sdk, "weather_agent")
    triage = _agent(sdk, "triage_agent", handoffs=[weather])
    _script(
        responses,
        [_call_item("transfer_to_weather_agent", {}, "c1")],
        [_message_item("sunny")],
    )

    result = asyncio.run(_stream(sdk, triage, conversation_id="conv_1"))

    assert result.final_output == "sunny"
    assert _structure(client) == [
        ("session_start", "triage_agent"),
        ("agent_handoff", "triage_agent"),
        ("session_end", "triage_agent"),
        ("session_start", "weather_agent"),
        ("session_end", "weather_agent"),
    ]
    assert all("state" not in e for e in _ends(client))
    assert {s["context"]["gen_ai_conversation_id"] for s in _starts(client)} == {"conv_1"}
    assert {p["session_id"] for p in _queued(session, "post_call")} == {ROOT}


def test_a_failed_streamed_run_ends_its_child_in_error(
    sdk: Any, patched: tuple[Session, MagicMock], responses: Any
) -> None:
    _, client = patched
    _script(responses)  # the endpoint answers 500

    async def go() -> None:
        result = sdk.Runner.run_streamed(_agent(sdk, "assistant"), "hi")
        with pytest.raises(Exception):  # noqa: B017 - the SDK's error for a 500
            async for _ in result.stream_events():
                pass
        await asyncio.sleep(0)

    asyncio.run(go())
    (end,) = _ends(client)
    assert end["state"] == "error"
    assert end["error"]["type"]


# ----------------------------------------------------------------------
# Conversation id
# ----------------------------------------------------------------------


def test_conversation_id_precedence(sdk: Any) -> None:
    sdk_session = types.SimpleNamespace(session_id="mem_1")
    cfg = types.SimpleNamespace(group_id="group_1")
    both = {"conversation_id": "conv_1", "session": sdk_session, "run_config": cfg}
    assert wrap._conversation_id(both, None) == "conv_1"
    assert wrap._conversation_id({"session": sdk_session, "run_config": cfg}, None) == "mem_1"
    assert wrap._conversation_id({"run_config": cfg}, None) == "group_1"
    assert wrap._conversation_id({"run_config": {"group_id": "group_2"}}, None) == "group_2"
    assert wrap._conversation_id({}, "outer") == "outer"
    assert wrap._conversation_id({}, None) is None
    assert wrap._conversation_id({"conversation_id": "  "}, None) is None


def test_group_id_reaches_the_child_context(
    sdk: Any, patched: tuple[Session, MagicMock], responses: Any
) -> None:
    _, client = patched
    _script(responses, [_message_item("ok")])
    _run(sdk, _agent(sdk, "assistant"), run_config=sdk.RunConfig(group_id="thread_7"))
    (start,) = _starts(client)
    assert start["context"]["gen_ai_conversation_id"] == "thread_7"
    (end,) = _ends(client)
    assert "context" not in end


def test_no_conversation_id_leaves_the_context_alone(
    sdk: Any, patched: tuple[Session, MagicMock], responses: Any
) -> None:
    _, client = patched
    _script(responses, [_message_item("ok")])
    _run(sdk, _agent(sdk, "assistant"))
    (start,) = _starts(client)
    assert "gen_ai_conversation_id" not in start.get("context", {})


# ----------------------------------------------------------------------
# Guardrails
# ----------------------------------------------------------------------


def _tripwire(sdk: Any, tripped: bool) -> Any:
    def check(ctx: Any, agent: Any, data: Any) -> Any:
        return sdk.GuardrailFunctionOutput(output_info="checked", tripwire_triggered=tripped)

    return check


def test_an_input_tripwire_signals_and_ends_the_child_in_error(
    sdk: Any, patched: tuple[Session, MagicMock], responses: Any
) -> None:
    _, client = patched
    guard = sdk.InputGuardrail(guardrail_function=_tripwire(sdk, True), name="no_math")
    _script(responses, [_message_item("4")])

    with pytest.raises(sdk.InputGuardrailTripwireTriggered):
        _run(sdk, _agent(sdk, "tutor", input_guardrails=[guard]), "2+2?")

    (signal,) = _signals(client, SIGNAL_GUARDRAIL_TRIPWIRE)
    assert signal["signal_data"] == {"guardrail": "no_math", "kind": "input", "agent": "tutor"}
    (start,) = _starts(client)
    (end,) = _ends(client)
    assert signal["session_id"] == start["session_id"]
    assert end["state"] == "error"
    assert end["error"]["type"] == "InputGuardrailTripwireTriggered"
    # Names only: nothing the guardrail checked or returned.
    assert "checked" not in json.dumps(signal)
    assert signal["model"] is None
    assert signal["has_content"] is False


def test_a_guardrail_that_passes_sends_nothing(
    sdk: Any, patched: tuple[Session, MagicMock], responses: Any
) -> None:
    _, client = patched
    guard = sdk.InputGuardrail(guardrail_function=_tripwire(sdk, False), name="no_math")
    out = sdk.OutputGuardrail(guardrail_function=_tripwire(sdk, False), name="tone")
    _script(responses, [_message_item("hello")])
    _run(sdk, _agent(sdk, "tutor", input_guardrails=[guard], output_guardrails=[out]))
    assert _signals(client) == []
    assert "state" not in _ends(client)[0]


def test_an_output_tripwire_signals_on_the_final_agent(
    sdk: Any, patched: tuple[Session, MagicMock], responses: Any
) -> None:
    _, client = patched
    guard = sdk.OutputGuardrail(guardrail_function=_tripwire(sdk, True), name="tone")
    _script(responses, [_message_item("rude")])

    with pytest.raises(sdk.OutputGuardrailTripwireTriggered):
        _run(sdk, _agent(sdk, "writer", output_guardrails=[guard]))

    (signal,) = _signals(client, SIGNAL_GUARDRAIL_TRIPWIRE)
    assert signal["signal_data"] == {"guardrail": "tone", "kind": "output", "agent": "writer"}
    assert _structure(client) == [
        ("session_start", "writer"),
        ("guardrail_tripwire", "writer"),
        ("session_end", "writer"),
    ]
    assert _ends(client)[0]["state"] == "error"


def _tool_guardrails(sdk: Any) -> Any:
    return pytest.importorskip("agents.tool_guardrails")


def test_a_tool_guardrail_that_rejects_content_signals_and_the_run_goes_on(
    sdk: Any, patched: tuple[Session, MagicMock], responses: Any
) -> None:
    tg = _tool_guardrails(sdk)
    _, client = patched

    @tg.tool_input_guardrail
    def block_secrets(data: Any) -> Any:
        return tg.ToolGuardrailFunctionOutput.reject_content("no secrets")

    @sdk.function_tool
    def read_file(path: str) -> str:
        """Read a file."""
        raise AssertionError("the guardrail rejects the call before the tool runs")

    # Set on the tool: function_tool takes the guardrails as arguments
    # not in 0.6.
    read_file.tool_input_guardrails = [block_secrets]

    _script(
        responses,
        [_call_item("read_file", {"path": "/etc/shadow"}, "c1")],
        [_message_item("I cannot read that.")],
    )
    result = _run(sdk, _agent(sdk, "reader", tools=[read_file]))

    assert result.final_output == "I cannot read that."
    (signal,) = _signals(client, SIGNAL_GUARDRAIL_TRIPWIRE)
    assert signal["signal_data"] == {
        "guardrail": "block_secrets",
        "kind": "tool_input",
        "agent": "reader",
    }
    assert "/etc/shadow" not in json.dumps(signal)
    # A rejection does not stop the run: the child closes normally.
    assert "state" not in _ends(client)[0]


def test_a_tool_output_guardrail_that_raises_ends_the_child_in_error(
    sdk: Any, patched: tuple[Session, MagicMock], responses: Any
) -> None:
    tg = _tool_guardrails(sdk)
    _, client = patched

    @tg.tool_output_guardrail
    def no_leaks(data: Any) -> Any:
        return tg.ToolGuardrailFunctionOutput.raise_exception(output_info="leak")

    @sdk.function_tool
    def lookup(key: str) -> str:
        """Look a key up."""
        return "s3cr3t"

    lookup.tool_output_guardrails = [no_leaks]

    _script(responses, [_call_item("lookup", {"key": "k"}, "c1")])
    with pytest.raises(sdk.ToolOutputGuardrailTripwireTriggered):
        _run(sdk, _agent(sdk, "looker", tools=[lookup]))

    (signal,) = _signals(client, SIGNAL_GUARDRAIL_TRIPWIRE)
    assert signal["signal_data"]["kind"] == "tool_output"
    assert _ends(client)[0]["state"] == "error"


def test_a_streamed_input_tripwire_ends_the_child_in_error(
    sdk: Any, patched: tuple[Session, MagicMock], responses: Any
) -> None:
    _, client = patched
    guard = sdk.InputGuardrail(guardrail_function=_tripwire(sdk, True), name="no_math")
    _script(responses, [_message_item("4")])

    async def go() -> None:
        result = sdk.Runner.run_streamed(_agent(sdk, "tutor", input_guardrails=[guard]), "2+2?")
        with pytest.raises(sdk.InputGuardrailTripwireTriggered):
            async for _ in result.stream_events():
                pass
        await asyncio.sleep(0)

    asyncio.run(go())
    (signal,) = _signals(client, SIGNAL_GUARDRAIL_TRIPWIRE)
    assert signal["signal_data"]["kind"] == "input"
    (end,) = _ends(client)
    assert end["state"] == "error"
    assert end["error"]["type"] == "InputGuardrailTripwireTriggered"


# ----------------------------------------------------------------------
# Failures and enforcement
# ----------------------------------------------------------------------


def test_max_turns_ends_the_child_in_error(
    sdk: Any, patched: tuple[Session, MagicMock], responses: Any
) -> None:
    _, client = patched

    @sdk.function_tool
    def ping() -> str:
        """Ping."""
        return "pong"

    _script(responses, [_call_item("ping", {}, "c1")], [_call_item("ping", {}, "c2")])
    with pytest.raises(sdk.MaxTurnsExceeded):
        _run(sdk, _agent(sdk, "looper", tools=[ping]), max_turns=1)
    (end,) = _ends(client)
    assert end["state"] == "error"
    assert end["error"]["type"] == "MaxTurnsExceeded"


def test_a_shutdown_stops_the_run_at_the_next_model_call(
    sdk: Any, patched: tuple[Session, MagicMock], responses: Any
) -> None:
    session, client = patched

    @sdk.function_tool
    def stop_me() -> str:
        """Simulates a Stop arriving mid-run."""
        session._shutdown_requested = True
        session._shutdown_reason = "operator stop"
        return "ok"

    script = _script(responses, [_call_item("stop_me", {}, "c1")], [_message_item("never")])
    with pytest.raises(DirectiveError) as err:
        _run(sdk, _agent(sdk, "worker", tools=[stop_me]))
    assert err.value.action == "shutdown"
    # The second model call never left the process.
    assert len(script.requests) == 1
    (end,) = _ends(client)
    assert end["state"] == "error"
    assert end["error"]["type"] == "DirectiveError"


def test_a_shutdown_stops_the_next_agent_from_starting(
    sdk: Any, patched: tuple[Session, MagicMock], responses: Any
) -> None:
    session, client = patched
    session._shutdown_requested = True
    _script(responses, [_message_item("never")])
    with pytest.raises(DirectiveError):
        _run(sdk, _agent(sdk, "worker"))
    assert _starts(client) == []


def test_a_shutdown_stops_a_hand_off(sdk: Any, patched: tuple[Session, MagicMock]) -> None:
    session, _ = patched
    scope = wrap._RunScope(session, parent_session_id=None, conversation_id=None, run_input="x")
    hooks = wrap._make_hooks_class()(scope, None)
    session._shutdown_requested = True
    with pytest.raises(DirectiveError):
        asyncio.run(hooks.on_handoff(None, object(), object()))


# ----------------------------------------------------------------------
# The caller's hooks
# ----------------------------------------------------------------------


def test_the_callers_hooks_run_after_the_sensors(
    sdk: Any, patched: tuple[Session, MagicMock], responses: Any
) -> None:
    _, client = patched
    seen: list[str] = []

    class Hooks(sdk.RunHooks):  # type: ignore[misc,name-defined]
        async def on_agent_start(self, context: Any, agent: Any) -> None:
            # The sensor opened the child first.
            seen.append(f"agent_start:{len(_starts(client))}")

        async def on_llm_start(self, *args: Any) -> None:
            seen.append("llm_start")

        async def on_llm_end(self, *args: Any) -> None:
            seen.append("llm_end")

        async def on_agent_end(self, context: Any, agent: Any, output: Any) -> None:
            seen.append(f"agent_end:{output}")

    _script(responses, [_message_item("done")])
    _run(sdk, _agent(sdk, "assistant"), hooks=Hooks())
    assert seen == ["agent_start:1", "llm_start", "llm_end", "agent_end:done"]


def test_a_callers_hook_that_raises_fails_the_run(
    sdk: Any, patched: tuple[Session, MagicMock], responses: Any
) -> None:
    _, client = patched

    class Boom(sdk.RunHooks):  # type: ignore[misc,name-defined]
        async def on_agent_start(self, context: Any, agent: Any) -> None:
            raise RuntimeError("hook failed")

    _script(responses, [_message_item("x")])
    with pytest.raises(RuntimeError, match="hook failed"):
        _run(sdk, _agent(sdk, "assistant"), hooks=Boom())
    assert _ends(client)[0]["state"] == "error"


def test_agent_hooks_passed_as_run_hooks_get_the_sdks_error(
    sdk: Any, patched: tuple[Session, MagicMock], responses: Any
) -> None:
    _, client = patched
    _script(responses, [_message_item("x")])
    with pytest.raises(TypeError, match="RunHooks"):
        _run(sdk, _agent(sdk, "assistant"), hooks=sdk.AgentHooks())
    assert _posted(client) == []


def test_every_hook_the_sdk_defines_is_forwarded(sdk: Any) -> None:
    from agents.lifecycle import RunHooksBase

    cls = wrap._make_hooks_class()
    names = {n for n in dir(RunHooksBase) if n.startswith("on_")}
    for name in names:
        assert getattr(cls, name) is not getattr(RunHooksBase, name), name


# ----------------------------------------------------------------------
# Session calls the wrap makes
# ----------------------------------------------------------------------


def test_guardrail_signal_names_only_known_kinds_and_bounds_names() -> None:
    session, client = _session(capture_prompts=True)
    session.emit_guardrail_tripwire(guardrail="g" * 300, kind="sideways", agent=" a ")
    (p,) = _posted(client)
    assert p["signal"] == "guardrail_tripwire"
    assert p["signal_data"] == {"guardrail": "g" * 256, "agent": "a"}
    assert p["session_id"] == ROOT
    assert {"input", "output", "tool_input", "tool_output"} == GUARDRAIL_KINDS


def test_child_posts_name_the_given_parent() -> None:
    session, client = _session()
    child = {
        "child_session_id": "22222222-2222-4222-8222-222222222222",
        "child_agent_id": "33333333-3333-4333-8333-333333333333",
        "child_agent_name": f"{PARENT_NAME}/expert",
        "agent_role": "expert",
        "parent_session_id": "55555555-5555-4555-8555-555555555555",
    }
    session._context = {"os": "linux"}
    session.emit_subagent_session_start(context_extra={"gen_ai_conversation_id": "c"}, **child)
    session.emit_guardrail_tripwire(guardrail="g", kind="input", agent="expert", **child)
    session.emit_agent_handoff(from_agent="expert", to_agent="other", **child)
    session.emit_subagent_session_end(**child)
    posts = _posted(client)
    assert {p["parent_session_id"] for p in posts} == {child["parent_session_id"]}
    # The inherited context (the late framework scan may add frameworks)
    # plus the extra key.
    assert posts[0]["context"]["os"] == "linux"
    assert posts[0]["context"]["gen_ai_conversation_id"] == "c"
    # context_extra does not change the sensor's own context.
    assert "gen_ai_conversation_id" not in session._context


def test_child_posts_default_to_the_sensors_session() -> None:
    session, client = _session()
    child = {
        "child_session_id": "22222222-2222-4222-8222-222222222222",
        "child_agent_id": "33333333-3333-4333-8333-333333333333",
        "child_agent_name": f"{PARENT_NAME}/expert",
        "agent_role": "expert",
    }
    session.emit_subagent_session_start(**child)
    session.emit_guardrail_tripwire(guardrail="g", kind="output", agent="expert", **child)
    session.emit_subagent_session_end(**child)
    assert {p["parent_session_id"] for p in _posted(client)} == {ROOT}


def test_a_partial_child_identity_drops_the_guardrail_signal(
    caplog: pytest.LogCaptureFixture,
) -> None:
    session, client = _session()
    with caplog.at_level(logging.WARNING):
        session.emit_guardrail_tripwire(
            guardrail="g", kind="input", agent="a", child_session_id="x"
        )
    assert _posted(client) == []
    assert "guardrail_tripwire names part of a child session's identity" in caplog.text


# ----------------------------------------------------------------------
# A run reported twice
# ----------------------------------------------------------------------


@pytest.fixture
def otel_processor(sdk: Any) -> Iterator[Any]:
    """A tracing processor whose class lives in the OpenTelemetry
    instrumentation's module, registered with tracing on."""
    from agents.tracing import get_trace_provider

    provider = get_trace_provider()
    saved = provider._multi_processor._processors
    module = types.ModuleType("opentelemetry.instrumentation.openai_agents.span_processor")
    proc_cls = type("GenAISemanticProcessor", (), {"__module__": module.__name__})
    provider._multi_processor._processors = (proc_cls(),)
    sdk.set_tracing_disabled(False)
    wrap._double_count_checked = False
    try:
        yield provider
    finally:
        provider._multi_processor._processors = saved
        sdk.set_tracing_disabled(True)
        wrap._double_count_checked = False


def test_an_otel_processor_with_an_unknown_endpoint_warns_once(
    otel_processor: Any, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    for key in wrap._OTLP_ENDPOINT_ENV:
        monkeypatch.delenv(key, raising=False)
    session, _ = _session()
    with caplog.at_level(logging.DEBUG, logger="flightdeck_sensor.interceptor.openai_agents"):
        wrap._check_double_count(session, None)
        wrap._check_double_count(session, None)
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings) == 1
    assert "may be counted twice" in warnings[0].getMessage()
    assert "cannot read" in warnings[0].getMessage()
    assert "issues/279" in warnings[0].getMessage()


def test_an_otel_processor_aimed_at_this_flightdeck_warns(
    otel_processor: Any, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://LOCALHOST:4000/ingest/v1/otlp")
    session, _ = _session()
    with caplog.at_level(logging.WARNING):
        wrap._check_double_count(session, None)
    assert "may be counted twice" in caplog.text


def test_an_otel_processor_aimed_elsewhere_only_debugs(
    otel_processor: Any, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "https://collector.example:4318")
    session, _ = _session()
    with caplog.at_level(logging.DEBUG, logger="flightdeck_sensor.interceptor.openai_agents"):
        wrap._check_double_count(session, None)
    assert not [r for r in caplog.records if r.levelno >= logging.WARNING]
    assert "not this sensor's server" in caplog.text


def test_tracing_off_or_no_otel_processor_never_warns(
    otel_processor: Any, sdk: Any, caplog: pytest.LogCaptureFixture
) -> None:
    session, _ = _session()
    with caplog.at_level(logging.WARNING):
        wrap._check_double_count(session, sdk.RunConfig(tracing_disabled=True))
        wrap._check_double_count(session, {"tracing_disabled": True})
        otel_processor._multi_processor._processors = ()
        wrap._check_double_count(session, None)
    assert caplog.text == ""
    assert wrap._double_count_checked is False


# ----------------------------------------------------------------------
# Patching
# ----------------------------------------------------------------------


def test_patch_is_idempotent_and_unpatch_restores(sdk: Any) -> None:
    from agents.guardrail import InputGuardrail
    from agents.run import AgentRunner

    run, streamed = AgentRunner.__dict__["run"], AgentRunner.__dict__["run_streamed"]
    guard_run = InputGuardrail.__dict__["run"]
    wrap.patch_openai_agents(quiet=True)
    wrapped = AgentRunner.__dict__["run"]
    wrap.patch_openai_agents(quiet=True)
    assert AgentRunner.__dict__["run"] is wrapped is not run
    assert InputGuardrail.__dict__["run"] is not guard_run
    wrap.unpatch_openai_agents()
    wrap.unpatch_openai_agents()
    assert AgentRunner.__dict__["run"] is run
    assert AgentRunner.__dict__["run_streamed"] is streamed
    assert InputGuardrail.__dict__["run"] is guard_run


def test_an_agents_module_from_another_distribution_is_left_alone(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def missing(name: str) -> str:
        raise importlib.metadata.PackageNotFoundError(name)

    monkeypatch.setattr(wrap, "_AVAILABLE", None)
    monkeypatch.setattr(importlib.metadata, "version", missing)
    assert wrap._ensure_imported() is False
    wrap.patch_openai_agents(quiet=True)  # no-op, no error
    monkeypatch.setattr(wrap, "_AVAILABLE", None)


def test_patch_selects_the_openai_agents_target() -> None:
    target = next(
        t
        for t in flightdeck_sensor._SDK_TARGETS
        if t.provider is flightdeck_sensor.Provider.OPENAI_AGENTS
    )
    assert (target.module, target.interceptor) == ("agents", "openai_agents")
    assert flightdeck_sensor.Provider.OPENAI_AGENTS == "openai_agents"


# ----------------------------------------------------------------------
# Canary: the SDK names the wrap reads
# ----------------------------------------------------------------------


def test_canary_sdk_names_the_wrap_reads(sdk: Any) -> None:
    """Fails when an openai-agents release renames something the wrap
    relies on, so the SDK-majors and SDK-floors lanes catch it."""
    from agents.guardrail import InputGuardrail, OutputGuardrail
    from agents.lifecycle import RunHooksBase
    from agents.result import RunResultStreaming
    from agents.run import AgentRunner
    from agents.tracing import get_trace_provider

    assert "run" in AgentRunner.__dict__
    assert "run_streamed" in AgentRunner.__dict__
    hooks = {n for n in dir(RunHooksBase) if n.startswith("on_")}
    assert {"on_agent_start", "on_agent_end", "on_handoff"} <= hooks
    fields = set(getattr(RunResultStreaming, "__dataclass_fields__", {}))
    assert fields & {"run_loop_task", "_run_impl_task"}
    for cls in (InputGuardrail, OutputGuardrail):
        assert "run" in cls.__dict__
        assert callable(cls.get_name)
    tg = pytest.importorskip("agents.tool_guardrails")
    for cls in (tg.ToolInputGuardrail, tg.ToolOutputGuardrail):
        assert "run" in cls.__dict__
    provider = get_trace_provider()
    assert isinstance(provider._multi_processor._processors, tuple)
    assert hasattr(provider, "_disabled")
    assert hasattr(sdk.RunConfig(), "group_id")
