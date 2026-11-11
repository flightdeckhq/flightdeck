"""The sensor's OpenAI Agents SDK wrap lands in Postgres as designed.

The real sensor (``flightdeck_sensor.init`` + ``patch``) wraps the real
SDK runner; the Responses endpoint is mocked at the network boundary
with respx serving JSON and server-sent events as api.openai.com does,
and everything from the sensor to Postgres runs against the dev stack.
The tests read the stored ``sessions`` and ``events`` rows: the child
sessions and their parents, the ``agent_handoff`` and
``guardrail_tripwire`` signals with names only, the conversation id in
the child's context, and the model calls on the sensor's own session.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import urllib.error
import urllib.request
import uuid
from typing import TYPE_CHECKING, Any

import pytest

import flightdeck_sensor

from .conftest import (
    API_URL,
    INGESTION_URL,
    TOKEN,
    auth_headers,
    delete_flavor_data,
    exec_sql,
    query_rows,
    wait_until,
)
from .test_sensor_e2e import _force_reset_sensor

if TYPE_CHECKING:
    from collections.abc import Iterator

agents = pytest.importorskip("agents")
httpx = pytest.importorskip("httpx")
respx = pytest.importorskip("respx")
openai = pytest.importorskip("openai")

MODEL = "gpt-4.1-nano"
BASE_URL = "https://api.openai.com/v1"
# Time for the sensor's posts to be written by the worker.
STORED_TIMEOUT_SECS = 20.0
# One content fetch never blocks longer than this; a healthy API answers
# in milliseconds.
CONTENT_FETCH_TIMEOUT_SECS = 10.0
# GET /v1/events/:id/content: stored content, and none (rule 37).
CONTENT_FOUND = 200
CONTENT_ABSENT = 404


# ---- the mocked Responses endpoint ---------------------------------------


def _message(text: str) -> dict[str, Any]:
    return {
        "id": "msg_1",
        "type": "message",
        "role": "assistant",
        "status": "completed",
        "content": [{"type": "output_text", "text": text, "annotations": []}],
    }


def _call(name: str, arguments: dict[str, Any], call_id: str) -> dict[str, Any]:
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
        "id": f"resp_{uuid.uuid4().hex[:8]}",
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
    body = _response(output)
    created = {**body, "status": "in_progress", "output": [], "usage": None}
    events: list[tuple[str, dict[str, Any]]] = [
        ("response.created", {"type": "response.created", "response": created})
    ]
    for i, item in enumerate(output):
        for kind in ("added", "done"):
            name = f"response.output_item.{kind}"
            events.append((name, {"type": name, "output_index": i, "item": item}))
    events.append(("response.completed", {"type": "response.completed", "response": body}))
    return "".join(
        f"event: {name}\ndata: {json.dumps({**data, 'sequence_number': seq})}\n\n"
        for seq, (name, data) in enumerate(events)
    )


# The agent a request comes from, read from its instructions (``_agent``
# writes "You are <name>." for every agent).
_INSTRUCTIONS_RE = re.compile(r"^You are (\w+)\.$")
# The input item a tool's result rides on: a request carrying one is an
# agent's turn after a tool ran.
_TOOL_RESULT_ITEM = "function_call_output"


def _asking_agent(body: dict[str, Any]) -> str:
    match = _INSTRUCTIONS_RE.match(body.get("instructions") or "")
    return match.group(1) if match else ""


def _after_a_tool(body: dict[str, Any]) -> bool:
    items = body.get("input")
    return isinstance(items, list) and any(
        isinstance(i, dict) and i.get("type") == _TOOL_RESULT_ITEM for i in items
    )


def _serve(
    router: Any,
    first: dict[str, list[dict[str, Any]]],
    after_tool: dict[str, list[dict[str, Any]]] | None = None,
) -> None:
    """Mock the Responses endpoint with canned output items chosen by the
    request, never by its place in the sequence: the order requests
    arrive in is not fixed (an input guardrail runs beside the model call
    and can stop the run before its request is sent; xdist workers share
    nothing but still change timings). ``first`` is an agent's output
    keyed by its name, read from the request's instructions;
    ``after_tool`` the output for an agent's turn after one of its tools
    ran (its input carries the tool's result). An agent absent from
    ``after_tool`` gets its ``first`` output on every turn. A request from
    an agent neither names fails the call, and the test, loudly."""

    def respond(request: Any) -> Any:
        body = json.loads(request.content)
        agent = _asking_agent(body)
        table = after_tool if after_tool and agent in after_tool and _after_a_tool(body) else first
        output = table.get(agent)
        if output is None:
            return httpx.Response(
                400,
                json={"error": {"message": f"no canned response for agent {agent!r}"}},
            )
        if body.get("stream"):
            return httpx.Response(
                200, text=_sse(output), headers={"content-type": "text/event-stream"}
            )
        return httpx.Response(200, json=_response(output))

    router.post("/responses").mock(side_effect=respond)


def _agent(name: str, **kwargs: Any) -> Any:
    from agents.models.openai_responses import OpenAIResponsesModel

    model = OpenAIResponsesModel(
        model=MODEL, openai_client=openai.AsyncOpenAI(api_key="sk-test", max_retries=0)
    )
    return agents.Agent(name=name, instructions=f"You are {name}.", model=model, **kwargs)


# ---- the stored rows -------------------------------------------------------


def _sessions(flavor: str) -> list[dict[str, Any]]:
    return query_rows(
        "SELECT session_id::text, parent_session_id::text, agent_role, state, context,"
        " ended_at IS NOT NULL AS ended FROM sessions WHERE flavor = :'flavor'"
        " ORDER BY started_at",
        flavor=flavor,
    )


def _events(flavor: str) -> list[dict[str, Any]]:
    return query_rows(
        "SELECT id::text, session_id::text, event_type, model, tool_name, has_content, payload"
        " FROM events WHERE flavor = :'flavor' ORDER BY occurred_at",
        flavor=flavor,
    )


@pytest.fixture
def flavor() -> Iterator[str]:
    name = f"test-openai-agents-{uuid.uuid4().hex[:10]}"
    _force_reset_sensor()
    os.environ["AGENT_FLAVOR"] = name
    try:
        yield name
    finally:
        os.environ.pop("AGENT_FLAVOR", None)
        _force_reset_sensor()
        delete_flavor_data(name)


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
        providers=[flightdeck_sensor.Provider.OPENAI, flightdeck_sensor.Provider.OPENAI_AGENTS],
        quiet=True,
    )
    agents.set_tracing_disabled(True)


def _ended(flavor: str, count: int) -> list[dict[str, Any]]:
    def done() -> bool:
        rows = _sessions(flavor)
        return len(rows) >= count and all(r["ended"] for r in rows)

    wait_until(done, timeout=STORED_TIMEOUT_SECS, msg=f"{flavor}: {count} sessions ended")
    return _sessions(flavor)


def _content_status(event_id: str) -> int:
    """``GET /v1/events/{id}/content``'s status, through urllib so no
    respx mock sees it."""
    req = urllib.request.Request(f"{API_URL}/v1/events/{event_id}/content", headers=auth_headers())
    try:
        with urllib.request.urlopen(req, timeout=CONTENT_FETCH_TIMEOUT_SECS) as resp:
            return int(resp.status)
    except urllib.error.HTTPError as exc:
        return exc.code


def _content_rows(event_ids: list[str]) -> int:
    return int(
        exec_sql(
            "SELECT count(*) FROM event_content"
            " WHERE event_id = ANY(string_to_array(:'ids', ',')::uuid[])",
            sqlite="SELECT count(*) FROM event_content WHERE instr(:ids, event_id) > 0",
            ids=",".join(event_ids),
        )
    )


def _signal(events: list[dict[str, Any]], name: str) -> list[dict[str, Any]]:
    return [
        e
        for e in events
        if e["event_type"] == "session_signal" and e["payload"].get("signal") == name
    ]


def test_hand_off_nested_agent_and_guardrail_land_as_designed(flavor: str) -> None:
    root = str(uuid.uuid4())
    _init(root)
    weather = _agent("weather_agent")
    expert = _agent("expert_agent")
    triage = _agent(
        "triage_agent",
        handoffs=[weather],
        tools=[expert.as_tool(tool_name="ask_expert", tool_description="Ask the expert.")],
    )
    guarded = _agent(
        "tutor_agent",
        input_guardrails=[
            agents.InputGuardrail(
                guardrail_function=lambda ctx, agent, data: agents.GuardrailFunctionOutput(
                    output_info="the checked text", tripwire_triggered=True
                ),
                name="no_math",
            )
        ],
    )
    from agents.tool_guardrails import ToolGuardrailFunctionOutput, tool_input_guardrail

    @tool_input_guardrail
    def block_secrets(data: Any) -> Any:
        return ToolGuardrailFunctionOutput.reject_content("no secrets")

    @agents.function_tool
    def read_file(path: str) -> str:
        """Read a file."""
        raise AssertionError("the guardrail rejects the call before the tool runs")

    # Set on the tool: function_tool takes the guardrails as arguments
    # not in 0.6.
    read_file.tool_input_guardrails = [block_secrets]
    reader = _agent("reader_agent", tools=[read_file])
    with respx.mock(base_url=BASE_URL, assert_all_called=False) as router:
        _serve(
            router,
            first={
                "triage_agent": [_call("ask_expert", {"input": "why?"}, "c1")],
                "expert_agent": [_message("because")],
                "weather_agent": [_message("sunny")],
                "tutor_agent": [_message("4")],
                "reader_agent": [_call("read_file", {"path": "/etc/shadow"}, "c3")],
            },
            after_tool={
                "triage_agent": [_call("transfer_to_weather_agent", {}, "c2")],
                "reader_agent": [_message("I cannot read that.")],
            },
        )
        result = agents.Runner.run_sync(
            triage, "weather?", run_config=agents.RunConfig(group_id="g-1")
        )
        assert result.final_output == "sunny"
        with pytest.raises(agents.InputGuardrailTripwireTriggered):
            agents.Runner.run_sync(guarded, "2+2?")
        reader_result = agents.Runner.run_sync(reader, "read it")
        assert reader_result.final_output == "I cannot read that."
    flightdeck_sensor.teardown()

    rows = _ended(flavor, 6)
    by_role = {r["agent_role"]: r for r in rows if r["agent_role"]}
    assert set(by_role) == {
        "triage_agent",
        "expert_agent",
        "weather_agent",
        "tutor_agent",
        "reader_agent",
    }
    triage_id = by_role["triage_agent"]["session_id"]
    # Siblings under the sensor's session; the expert nests under triage.
    assert by_role["triage_agent"]["parent_session_id"] == root
    assert by_role["weather_agent"]["parent_session_id"] == root
    assert by_role["tutor_agent"]["parent_session_id"] == root
    assert by_role["expert_agent"]["parent_session_id"] == triage_id
    for role in ("triage_agent", "expert_agent", "weather_agent"):
        assert by_role[role]["context"]["gen_ai_conversation_id"] == "g-1", role

    def signals_stored() -> bool:
        events = _events(flavor)
        return (
            len(_signal(events, "agent_handoff")) == 1
            and len(_signal(events, "guardrail_tripwire")) == 2
        )

    wait_until(signals_stored, timeout=STORED_TIMEOUT_SECS, msg="signals stored")
    events = _events(flavor)
    (handoff,) = _signal(events, "agent_handoff")
    assert handoff["session_id"] == triage_id
    assert handoff["payload"]["signal_data"] == {"from": "triage_agent", "to": "weather_agent"}
    trips = {t["session_id"]: t for t in _signal(events, "guardrail_tripwire")}
    assert len(trips) == 2
    trip = trips[by_role["tutor_agent"]["session_id"]]
    assert trip["payload"] == {
        "signal": "guardrail_tripwire",
        "signal_data": {"guardrail": "no_math", "kind": "input", "agent": "tutor_agent"},
        "parent_session_id": root,
        "agent_role": "tutor_agent",
    }
    assert trip["model"] is None
    assert trip["has_content"] is False
    assert "the checked text" not in json.dumps(events)
    # The tool guardrail's reject_content, on the reader's child, names
    # its kind; nothing the tool was called with rides on it, and the
    # run went on, so the child closed normally.
    reject = trips[by_role["reader_agent"]["session_id"]]
    assert reject["payload"]["signal_data"] == {
        "guardrail": "block_secrets",
        "kind": "tool_input",
        "agent": "reader_agent",
    }
    assert "/etc/shadow" not in json.dumps(reject)
    reader_end = [
        e
        for e in events
        if e["session_id"] == by_role["reader_agent"]["session_id"]
        and e["event_type"] == "session_end"
    ]
    assert len(reader_end) == 1
    assert "state" not in reader_end[0]["payload"]
    # The tutor's child ended in error; the model calls are the sensor's.
    tutor_end = [
        e
        for e in events
        if e["session_id"] == by_role["tutor_agent"]["session_id"]
        and e["event_type"] == "session_end"
    ]
    assert len(tutor_end) == 1
    assert tutor_end[0]["payload"].get("state") == "error"
    posts = [e for e in events if e["event_type"] == "post_call"]
    assert posts and {p["session_id"] for p in posts} == {root}
    # Capture is on: the model calls stored their content, and the
    # signals stored none.
    assert all(p["has_content"] for p in posts)
    wait_until(
        lambda: _content_status(posts[0]["id"]) == CONTENT_FOUND,
        timeout=STORED_TIMEOUT_SECS,
        msg="post_call content stored",
    )
    signals = _signal(events, "agent_handoff") + _signal(events, "guardrail_tripwire")
    assert not any(s["has_content"] for s in signals)
    assert _content_rows([s["id"] for s in signals]) == 0
    assert {_content_status(s["id"]) for s in signals} == {CONTENT_ABSENT}
    # One tool_call per function_call item the model returned, on the
    # sensor's session; the wrap adds none of its own.
    tool_calls = [e for e in events if e["event_type"] == "tool_call"]
    assert sorted(e["tool_name"] for e in tool_calls) == [
        "ask_expert",
        "read_file",
        "transfer_to_weather_agent",
    ]
    assert {e["session_id"] for e in tool_calls} == {root}


async def _stream(agent: Any) -> Any:
    result = agents.Runner.run_streamed(
        agent, "hello", run_config=agents.RunConfig(group_id="g-stream")
    )
    async for _ in result.stream_events():
        pass
    await asyncio.sleep(0)
    return result


def test_a_streamed_run_closes_its_child(flavor: str) -> None:
    root = str(uuid.uuid4())
    _init(root)
    with respx.mock(base_url=BASE_URL, assert_all_called=False) as router:
        _serve(router, first={"streaming_agent": [_message("hi there")]})
        result = asyncio.run(_stream(_agent("streaming_agent")))
    assert result.final_output == "hi there"
    flightdeck_sensor.teardown()

    rows = _ended(flavor, 2)
    children = [r for r in rows if r["agent_role"] == "streaming_agent"]
    assert len(children) == 1
    child = children[0]
    assert child["parent_session_id"] == root
    assert child["context"]["gen_ai_conversation_id"] == "g-stream"
    wait_until(
        lambda: any(e["event_type"] == "post_call" for e in _events(flavor)),
        timeout=STORED_TIMEOUT_SECS,
        msg="streamed post_call stored",
    )
    posts = [e for e in _events(flavor) if e["event_type"] == "post_call"]
    assert len(posts) == 1
    post = posts[0]
    assert post["session_id"] == root
    streaming = post["payload"]["streaming"]
    assert streaming["final_outcome"] == "completed"
    assert isinstance(streaming["ttft_ms"], int)
    assert streaming["ttft_ms"] >= 0
