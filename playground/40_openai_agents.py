"""The sensor's OpenAI Agents SDK wrap against a real model and the dev stack.

Four runs, each its own sensor session, through ``flightdeck_sensor``'s
native wrap (``Provider.OPENAI_AGENTS``) and the OpenAI patch:

1. hand-off: ``triage_agent`` hands off to ``weather_agent``. Two sibling
   child sessions under the sensor's session, the ``agent_handoff``
   signal on the triage child, the model calls on the sensor's session.
2. tools: ``lead_agent`` calls a function tool and an agent used as a
   tool (``ask_expert``). The expert's child nests under the lead's
   child; one ``tool_call`` per function call, on the sensor's session.
3. streamed: a ``Runner.run_streamed`` run with ``run_config.group_id``.
   Its child closes when the stream ends, its ``context`` carries the
   group id as ``gen_ai_conversation_id``, and its model call is a
   streamed ``post_call`` with a time to first token.
4. guardrails: an input guardrail whose tripwire triggers (the run
   raises, the ``guardrail_tripwire`` signal lands on the child, which
   ends in error), then a tool input guardrail that rejects a call (the
   signal lands and the run goes on).

Model: ``gpt-4.1-nano`` unless ``PLAYGROUND_OPENAI_AGENTS_MODEL`` names
another; when the account cannot use it, ``gpt-4o-mini``. Needs
``OPENAI_API_KEY`` and ``openai-agents`` (SKIP otherwise). Prints every
session id so the runs can be found on the dashboard and deleted by id.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
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
    wait_for_streamed_post_calls,
)

FLAVOR = "playground-openai-agents"
MODEL_ENV = "PLAYGROUND_OPENAI_AGENTS_MODEL"
DEFAULT_MODEL = "gpt-4.1-nano"
FALLBACK_MODEL = "gpt-4o-mini"
# Enough for a short answer or a tool call, and cheap.
MAX_TOKENS = 200
# The model probe's output bound: the Responses API's minimum.
PROBE_MAX_TOKENS = 16
# Time for a run's child sessions to land: they post synchronously, and
# the worker writes within a second or two on an idle stack.
CHILDREN_LANDED_S = 25.0
CHILDREN_POLL_S = 0.5
EVENTS_LANDED_S = 15.0
API_TIMEOUT_S = 5.0
MS_PER_S = 1000
# How much of a payload a failure message quotes.
FAILURE_DUMP_CHARS = 2000

session_ids: list[str] = []


def _get(path: str) -> dict[str, Any]:
    req = urllib.request.Request(
        f"{API_URL}{path}", headers={"Authorization": f"Bearer {API_TOKEN}"}
    )
    with urllib.request.urlopen(req, timeout=API_TIMEOUT_S) as r:
        return json.loads(r.read())  # type: ignore[no-any-return]


def _children(parent: str, expected: int) -> list[dict[str, Any]]:
    """The child sessions of ``parent`` once ``expected`` of them have
    ended (a session_end landed for each), or what is there at the
    deadline."""
    deadline = time.monotonic() + CHILDREN_LANDED_S
    children: list[dict[str, Any]] = []
    while time.monotonic() < deadline:
        try:
            children = _get(f"/v1/sessions?parent_session_id={parent}&limit=50")["sessions"]
        except Exception:
            children = []
        if len(children) >= expected and all(c.get("ended_at") for c in children):
            break
        time.sleep(CHILDREN_POLL_S)
    session_ids.extend(c["session_id"] for c in children)
    return children


def _events(session_id: str, *types: str) -> list[dict[str, Any]]:
    return fetch_events_for_session(
        session_id, expect_event_types=list(types), timeout_s=EVENTS_LANDED_S
    )


def _of_type(session_id: str, event_type: str, count: int) -> list[dict[str, Any]]:
    """The session's events of ``event_type`` once ``count`` of them have
    landed, or those there at the deadline: the queued model and tool
    events reach the worker after the synchronous child posts, so the
    first one being there does not mean the last is."""
    deadline = time.monotonic() + EVENTS_LANDED_S
    while True:
        found = [e for e in _events(session_id, event_type) if e["event_type"] == event_type]
        if len(found) >= count or time.monotonic() > deadline:
            return found
        time.sleep(CHILDREN_POLL_S)


def _check(label: str, ok: bool, detail: Any = "") -> None:
    print_result(label, ok, 0, str(detail)[:FAILURE_DUMP_CHARS] if not ok else "")
    if not ok:
        raise AssertionError(f"{label}: {str(detail)[:FAILURE_DUMP_CHARS]}")


def _start(section: str) -> str:
    import flightdeck_sensor
    from flightdeck_sensor import Provider

    root = str(uuid.uuid4())
    session_ids.append(root)
    init_sensor(root, flavor=FLAVOR)
    flightdeck_sensor.patch(providers=[Provider.OPENAI, Provider.OPENAI_AGENTS], quiet=True)
    print(f"[playground:40_openai_agents] {section}: session_id={root}")
    return root


def _end() -> None:
    import flightdeck_sensor

    flightdeck_sensor.teardown()


def _pick_model() -> str:
    """The model to run: the env override or the default, else the
    fallback when the account cannot use it. Probed with one tiny call
    before the sensor is patched (a model the models API lists can still
    be retired for calls)."""
    import openai

    wanted = os.environ.get(MODEL_ENV) or DEFAULT_MODEL
    try:
        openai.OpenAI().responses.create(
            model=wanted, input="Say ok.", max_output_tokens=PROBE_MAX_TOKENS
        )
        return wanted
    except openai.NotFoundError:
        print(f"[playground:40_openai_agents] {wanted} unavailable; using {FALLBACK_MODEL}")
        return FALLBACK_MODEL


def _signals(events: list[dict[str, Any]], name: str) -> list[dict[str, Any]]:
    return [
        e
        for e in events
        if e.get("event_type") == "session_signal"
        and (e.get("payload") or {}).get("signal") == name
    ]


def section_handoff(sdk: Any, settings: Any, model: str) -> None:
    root = _start("hand-off")
    weather = sdk.Agent(
        name="weather_agent",
        instructions="Answer weather questions in one short sentence. Say it is sunny.",
        model=model,
        model_settings=settings,
    )
    triage = sdk.Agent(
        name="triage_agent",
        instructions=(
            "You route requests. For any question about weather, always hand off "
            "to weather_agent immediately; never answer yourself."
        ),
        handoffs=[weather],
        model=model,
        model_settings=settings,
    )
    t0 = time.monotonic()
    result = sdk.Runner.run_sync(triage, "What is the weather in Paris today?")
    print_result("Runner.run_sync(triage_agent)", True, int((time.monotonic() - t0) * MS_PER_S))
    _end()
    _check("the run ended on weather_agent", result.last_agent.name == "weather_agent")

    children = {c["agent_role"]: c for c in _children(root, 2)}
    _check(
        "two sibling children under the sensor's session",
        set(children) == {"triage_agent", "weather_agent"},
        children,
    )
    triage_events = _events(children["triage_agent"]["session_id"], "session_signal")
    (handoff,) = _signals(triage_events, "agent_handoff") or [None]
    _check(
        "agent_handoff on the triage child, from and to named",
        handoff is not None
        and handoff["payload"]["signal_data"] == {"from": "triage_agent", "to": "weather_agent"},
        triage_events,
    )
    # The events' own times: a session row's ended_at is when the worker
    # wrote the end, which can trail the next child's start.
    weather_events = _events(children["weather_agent"]["session_id"], "session_start")
    triage_end = [e["occurred_at"] for e in triage_events if e["event_type"] == "session_end"]
    weather_start = [e["occurred_at"] for e in weather_events if e["event_type"] == "session_start"]
    _check(
        "the triage child ended before the weather child started",
        bool(triage_end and weather_start) and triage_end[0] <= weather_start[0],
        (triage_end, weather_start),
    )
    posts = _of_type(root, "post_call", 2)
    _check("the model calls stay on the sensor's session", len(posts) >= 2, len(posts))


def section_tools(sdk: Any, settings: Any, model: str) -> None:
    root = _start("tools")

    @sdk.function_tool
    def get_temperature(city: str) -> str:
        """The temperature in a city, in Celsius."""
        return f"21 degrees in {city}"

    expert = sdk.Agent(
        name="expert_agent",
        instructions="Answer in one short sentence.",
        model=model,
        model_settings=settings,
    )
    lead = sdk.Agent(
        name="lead_agent",
        instructions=(
            "Call get_temperature for Paris and call ask_expert with the question "
            "'Why is the sky blue?'. Call both tools, then answer in one sentence."
        ),
        tools=[
            get_temperature,
            expert.as_tool(tool_name="ask_expert", tool_description="Ask the expert a question."),
        ],
        model=model,
        model_settings=settings,
    )
    result = sdk.Runner.run_sync(lead, "Go.")
    print_result("Runner.run_sync(lead_agent) with two tools", bool(result.final_output), 0)
    _end()

    (lead_child,) = [c for c in _children(root, 1) if c["agent_role"] == "lead_agent"] or [None]
    _check("lead_agent's child under the sensor's session", lead_child is not None)
    grandchildren = _children(lead_child["session_id"], 1)
    _check(
        "expert_agent nests under lead_agent's child",
        [g["agent_role"] for g in grandchildren] == ["expert_agent"],
        grandchildren,
    )
    tools = sorted(e.get("tool_name") for e in _of_type(root, "tool_call", 2))
    _check(
        "one tool_call per function call, on the sensor's session",
        tools == ["ask_expert", "get_temperature"],
        tools,
    )


async def _stream(sdk: Any, agent: Any, group_id: str) -> Any:
    result = sdk.Runner.run_streamed(
        agent, "Say hello in five words.", run_config=sdk.RunConfig(group_id=group_id)
    )
    async for _ in result.stream_events():
        pass
    await asyncio.sleep(0)
    return result


def section_streamed(sdk: Any, settings: Any, model: str) -> None:
    root = _start("streamed")
    group_id = f"playground-thread-{uuid.uuid4().hex[:8]}"
    agent = sdk.Agent(
        name="streaming_agent", instructions="Be brief.", model=model, model_settings=settings
    )
    result = asyncio.run(_stream(sdk, agent, group_id))
    print_result("Runner.run_streamed(streaming_agent)", bool(result.final_output), 0)
    _end()

    children = _children(root, 1)
    _check("the streamed run's child ended", len(children) == 1 and children[0]["ended_at"])
    _check(
        "the child's context carries the group id as gen_ai_conversation_id",
        (children[0].get("context") or {}).get("gen_ai_conversation_id") == group_id,
        children[0].get("context"),
    )
    _, streamed = wait_for_streamed_post_calls(root, 1)
    ttft = (
        ((streamed[0]["payload"] or {}).get("streaming") or {}).get("ttft_ms") if streamed else None
    )
    _check("a streamed post_call with a time to first token", ttft is not None, streamed)


def section_guardrails(sdk: Any, settings: Any, model: str) -> None:
    from agents.tool_guardrails import ToolGuardrailFunctionOutput, tool_input_guardrail

    root = _start("guardrails")

    @sdk.input_guardrail(name="no_math_homework")
    def no_math(ctx: Any, agent: Any, data: Any) -> Any:
        return sdk.GuardrailFunctionOutput(output_info="math", tripwire_triggered="+" in str(data))

    tutor = sdk.Agent(
        name="tutor_agent",
        instructions="Help with history only.",
        input_guardrails=[no_math],
        model=model,
        model_settings=settings,
    )
    try:
        sdk.Runner.run_sync(tutor, "What is 17 + 25?")
        tripped = False
    except sdk.InputGuardrailTripwireTriggered:
        tripped = True
    _check("the input tripwire stopped the run", tripped)

    @tool_input_guardrail
    def block_secrets(data: Any) -> Any:
        return ToolGuardrailFunctionOutput.reject_content("Reading secrets is not allowed.")

    @sdk.function_tool
    def read_file(path: str) -> str:
        """Read a file from disk."""
        return "never read"

    read_file.tool_input_guardrails = [block_secrets]
    reader = sdk.Agent(
        name="reader_agent",
        instructions="Call read_file with path /etc/secrets, then report what happened.",
        tools=[read_file],
        model=model,
        model_settings=settings,
    )
    result = sdk.Runner.run_sync(reader, "Go.")
    print_result("the rejected tool call let the run go on", bool(result.final_output), 0)
    _end()

    children = {c["agent_role"]: c for c in _children(root, 2)}
    _check("a child per guarded agent", set(children) == {"tutor_agent", "reader_agent"}, children)
    tutor_events = _events(children["tutor_agent"]["session_id"], "session_signal", "session_end")
    (trip,) = _signals(tutor_events, "guardrail_tripwire") or [None]
    _check(
        "guardrail_tripwire on the tutor child, names only",
        trip is not None
        and trip["payload"]["signal_data"]
        == {"guardrail": "no_math_homework", "kind": "input", "agent": "tutor_agent"}
        and not trip.get("has_content"),
        tutor_events,
    )
    (end,) = [e for e in tutor_events if e["event_type"] == "session_end"] or [None]
    _check(
        "the tutor child ended in error",
        end is not None and (end.get("payload") or {}).get("state") == "error",
        end,
    )
    reader_events = _events(children["reader_agent"]["session_id"], "session_signal")
    (reject,) = _signals(reader_events, "guardrail_tripwire") or [None]
    _check(
        "guardrail_tripwire on the reader child for the rejected tool call",
        reject is not None and reject["payload"]["signal_data"]["kind"] == "tool_input",
        reader_events,
    )


def main() -> None:
    require_env("OPENAI_API_KEY")
    try:
        import agents as sdk
    except ImportError:
        print("SKIP: pip install openai-agents", file=sys.stderr)
        sys.exit(2)

    wait_for_dev_stack()
    # Tracing would also send every run to the OpenAI platform.
    sdk.set_tracing_disabled(True)
    model = _pick_model()
    settings = sdk.ModelSettings(max_tokens=MAX_TOKENS)
    print(f"[playground:40_openai_agents] model={model}")
    try:
        section_handoff(sdk, settings, model)
        section_tools(sdk, settings, model)
        section_streamed(sdk, settings, model)
        section_guardrails(sdk, settings, model)
    finally:
        print(f"[playground:40_openai_agents] sessions: {' '.join(session_ids)}")


if __name__ == "__main__":
    main()
