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
import contextlib
import json
import os
import uuid
from typing import TYPE_CHECKING, Any

import pytest

import flightdeck_sensor

from .conftest import INGESTION_URL, TOKEN, delete_flavor_data, exec_sql, wait_until

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


def _serve(router: Any, *outputs: list[dict[str, Any]]) -> None:
    queue = list(outputs)

    def respond(request: Any) -> Any:
        output = queue.pop(0)
        if json.loads(request.content).get("stream"):
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


def _rows(sql: str, **bindings: Any) -> list[dict[str, Any]]:
    out = exec_sql(f"SELECT coalesce(json_agg(r), '[]'::json) FROM ({sql}) r", **bindings)
    return json.loads(out or "[]")  # type: ignore[no-any-return]


def _sessions(flavor: str) -> list[dict[str, Any]]:
    return _rows(
        "SELECT session_id::text, parent_session_id::text, agent_role, state, context,"
        " ended_at IS NOT NULL AS ended FROM sessions WHERE flavor = :'flavor'"
        " ORDER BY started_at",
        flavor=flavor,
    )


def _events(flavor: str) -> list[dict[str, Any]]:
    return _rows(
        "SELECT id::text, session_id::text, event_type, model, tool_name, has_content, payload"
        " FROM events WHERE flavor = :'flavor' ORDER BY occurred_at",
        flavor=flavor,
    )


@pytest.fixture
def flavor() -> Iterator[str]:
    name = f"test-openai-agents-{uuid.uuid4().hex[:10]}"
    os.environ["AGENT_FLAVOR"] = name
    try:
        yield name
    finally:
        os.environ.pop("AGENT_FLAVOR", None)
        with contextlib.suppress(Exception):
            flightdeck_sensor.teardown()
        flightdeck_sensor._session = None
        flightdeck_sensor._client = None
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
    with respx.mock(base_url=BASE_URL, assert_all_called=False) as router:
        _serve(
            router,
            [_call("ask_expert", {"input": "why?"}, "c1")],
            [_message("because")],
            [_call("transfer_to_weather_agent", {}, "c2")],
            [_message("sunny")],
            [_message("4")],
        )
        result = agents.Runner.run_sync(
            triage, "weather?", run_config=agents.RunConfig(group_id="g-1")
        )
        assert result.final_output == "sunny"
        with pytest.raises(agents.InputGuardrailTripwireTriggered):
            agents.Runner.run_sync(guarded, "2+2?")
    flightdeck_sensor.teardown()

    rows = _ended(flavor, 5)
    by_role = {r["agent_role"]: r for r in rows if r["agent_role"]}
    assert set(by_role) == {"triage_agent", "expert_agent", "weather_agent", "tutor_agent"}
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
        return bool(_signal(events, "agent_handoff")) and bool(
            _signal(events, "guardrail_tripwire")
        )

    wait_until(signals_stored, timeout=STORED_TIMEOUT_SECS, msg="signals stored")
    events = _events(flavor)
    (handoff,) = _signal(events, "agent_handoff")
    assert handoff["session_id"] == triage_id
    assert handoff["payload"]["signal_data"] == {"from": "triage_agent", "to": "weather_agent"}
    (trip,) = _signal(events, "guardrail_tripwire")
    assert trip["session_id"] == by_role["tutor_agent"]["session_id"]
    assert trip["payload"] == {
        "signal": "guardrail_tripwire",
        "signal_data": {"guardrail": "no_math", "kind": "input", "agent": "tutor_agent"},
        "parent_session_id": root,
        "agent_role": "tutor_agent",
    }
    assert trip["model"] is None
    assert trip["has_content"] is False
    assert "the checked text" not in json.dumps(events)
    # The tutor's child ended in error; the model calls are the sensor's.
    tutor_end = [
        e
        for e in events
        if e["session_id"] == by_role["tutor_agent"]["session_id"]
        and e["event_type"] == "session_end"
    ]
    assert tutor_end and tutor_end[0]["payload"].get("state") == "error"
    posts = [e for e in events if e["event_type"] == "post_call"]
    assert posts and {p["session_id"] for p in posts} == {root}
    # One tool_call per function_call item the model returned, on the
    # sensor's session; the wrap adds none of its own.
    tool_calls = [e for e in events if e["event_type"] == "tool_call"]
    assert sorted(e["tool_name"] for e in tool_calls) == [
        "ask_expert",
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
        _serve(router, [_message("hi there")])
        result = asyncio.run(_stream(_agent("streaming_agent")))
    assert result.final_output == "hi there"
    flightdeck_sensor.teardown()

    rows = _ended(flavor, 2)
    (child,) = [r for r in rows if r["agent_role"] == "streaming_agent"]
    assert child["parent_session_id"] == root
    assert child["context"]["gen_ai_conversation_id"] == "g-stream"
    wait_until(
        lambda: any(e["event_type"] == "post_call" for e in _events(flavor)),
        timeout=STORED_TIMEOUT_SECS,
        msg="streamed post_call stored",
    )
    (post,) = [e for e in _events(flavor) if e["event_type"] == "post_call"]
    assert post["session_id"] == root
    assert post["payload"]["streaming"]["final_outcome"] == "completed"
