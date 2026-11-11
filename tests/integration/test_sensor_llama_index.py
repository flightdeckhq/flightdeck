"""LlamaIndex agent workflows land as child sessions; their calls stay on the root.

The real sensor (``flightdeck_sensor.init`` + ``patch``) runs real
LlamaIndex agents on llama-index's OpenAI LLM, with the OpenAI API mocked
at the network boundary (respx), against the dev stack. The test reads
the stored ``sessions``, ``events`` and ``event_content`` rows:

* a multi-agent ``AgentWorkflow`` hand-off: one closed child per agent
  under the sensor's session, carrying only its start, end and (on the
  agent handing off) the ``agent_handoff`` signal; every model call and
  tool call, each once, on the sensor's session and counted on its row;
* a ``ReActAgent``: the tool call it parses from the model's text is
  stored once, on the sensor's session, with its arguments and output
  captured.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import uuid
from typing import TYPE_CHECKING, Any

import httpx
import pytest
import respx

import flightdeck_sensor

from .conftest import (
    INGESTION_URL,
    TOKEN,
    delete_flavor_data,
    exec_sql,
    query_rows,
    wait_until,
)

if TYPE_CHECKING:
    from collections.abc import Iterator

OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions"
# Time for the worker to write the sensor's queued events.
STORED_TIMEOUT_SECS = 20.0


def _sessions(flavor: str) -> list[dict[str, Any]]:
    return query_rows(
        "SELECT session_id::text, parent_session_id::text, agent_role, state, tokens_used"
        " FROM sessions WHERE flavor = :'flavor'",
        flavor=flavor,
    )


def _events(flavor: str) -> list[dict[str, Any]]:
    return query_rows(
        "SELECT id::text, session_id::text, event_type, tool_name, has_content, payload"
        " FROM events WHERE flavor = :'flavor' ORDER BY occurred_at",
        flavor=flavor,
    )


def _completion(
    *, content: str | None = None, tool_calls: list[dict[str, Any]] | None = None
) -> httpx.Response:
    message: dict[str, Any] = {"role": "assistant", "content": content}
    if tool_calls:
        message["tool_calls"] = tool_calls
    return httpx.Response(
        200,
        json={
            "id": "chatcmpl-it",
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
            "usage": {"prompt_tokens": 50, "completion_tokens": 10, "total_tokens": 60},
        },
    )


def _tool_call(call_id: str, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": call_id,
        "type": "function",
        "function": {"name": name, "arguments": json.dumps(arguments)},
    }


async def _run(agent: Any, user_msg: str) -> Any:
    return await agent.run(user_msg=user_msg)


def multiply(a: int, b: int) -> int:
    """Multiply two integers."""
    return a * b


@pytest.fixture
def sensor_flavor() -> Iterator[str]:
    flavor = f"test-sensor-llama-index-{uuid.uuid4().hex[:10]}"
    os.environ["AGENT_FLAVOR"] = flavor
    try:
        yield flavor
    finally:
        os.environ.pop("AGENT_FLAVOR", None)
        with contextlib.suppress(Exception):
            flightdeck_sensor.teardown()
        delete_flavor_data(flavor)


@pytest.fixture
def llama() -> tuple[Any, Any]:
    """LlamaIndex's agent classes and OpenAI LLM, imported by the test that
    needs them (a module-level import would put LlamaIndex in every other
    test's process before its sensor classifies the frameworks)."""
    return (
        pytest.importorskip("llama_index.core.agent.workflow"),
        pytest.importorskip("llama_index.llms.openai"),
    )


def _init(root_id: str, openai_llm: Any) -> Any:
    flightdeck_sensor.init(
        server=INGESTION_URL,
        token=TOKEN,
        session_id=root_id,
        agent_type="coding",
        capture_prompts=True,
        quiet=True,
    )
    flightdeck_sensor.patch(
        providers=[flightdeck_sensor.Provider.OPENAI, flightdeck_sensor.Provider.LLAMA_INDEX],
        quiet=True,
    )
    return openai_llm.OpenAI(model="gpt-4o-mini", api_key="test-key", max_retries=0)


def test_agent_workflow_hand_off_lands_per_agent(
    sensor_flavor: str, llama: tuple[Any, Any]
) -> None:
    workflow, openai_llm = llama
    root_id = str(uuid.uuid4())
    llm = _init(root_id, openai_llm)
    with respx.mock(assert_all_called=False) as router:
        router.post(OPENAI_CHAT_URL).mock(
            side_effect=[
                _completion(tool_calls=[_tool_call("call_1", "multiply", {"a": 6, "b": 7})]),
                _completion(
                    tool_calls=[
                        _tool_call(
                            "call_2", "handoff", {"to_agent": "writer", "reason": "State 42."}
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
        result = asyncio.run(_run(flow, "6 times 7, then hand off to the writer."))
    assert "42" in str(result)
    flightdeck_sensor.teardown()

    def _children_closed() -> bool:
        children = [s for s in _sessions(sensor_flavor) if s["parent_session_id"] == root_id]
        return len(children) == 2 and all(s["state"] == "closed" for s in children)

    wait_until(_children_closed, timeout=STORED_TIMEOUT_SECS, msg="two closed children")

    def _all_events_stored() -> bool:
        return sum(1 for e in _events(sensor_flavor) if e["event_type"] == "post_call") == 3

    wait_until(_all_events_stored, timeout=STORED_TIMEOUT_SECS, msg="three post_calls stored")

    by_role = {
        s["agent_role"]: s for s in _sessions(sensor_flavor) if s["parent_session_id"] == root_id
    }
    calc_id = by_role["calculator"]["session_id"]
    writer_id = by_role["writer"]["session_id"]
    events = _events(sensor_flavor)

    def _of(event_type: str, session_id: str) -> list[dict[str, Any]]:
        return [
            e for e in events if e["event_type"] == event_type and e["session_id"] == session_id
        ]

    # The agents' calls are the sensor's session's, counted on its row.
    assert len(_of("post_call", root_id)) == 3
    (root,) = [s for s in _sessions(sensor_flavor) if s["session_id"] == root_id]
    assert root["tokens_used"] == 180
    assert by_role["calculator"]["tokens_used"] == 0
    assert by_role["writer"]["tokens_used"] == 0
    tool_calls = [e for e in events if e["event_type"] == "tool_call"]
    assert sorted((e["tool_name"], e["session_id"]) for e in tool_calls) == sorted(
        [("multiply", root_id), ("handoff", root_id)]
    )
    # The children carry the structure only.
    assert {e["event_type"] for e in events if e["session_id"] == calc_id} == {
        "session_start",
        "session_signal",
        "session_end",
    }
    assert {e["event_type"] for e in events if e["session_id"] == writer_id} == {
        "session_start",
        "session_end",
    }
    (signal,) = [e for e in events if e["event_type"] == "session_signal"]
    assert signal["session_id"] == calc_id
    assert signal["payload"]["signal_data"] == {"from": "calculator", "to": "writer"}
    # A model call keeps its captured content.
    last_call = _of("post_call", root_id)[-1]
    assert last_call["has_content"] is True
    stored = exec_sql(
        "SELECT session_id::text FROM event_content WHERE event_id = :'id'",
        id=last_call["id"],
    )
    assert stored.strip() == root_id


def test_react_agent_tool_call_is_stored_once(sensor_flavor: str, llama: tuple[Any, Any]) -> None:
    workflow, openai_llm = llama
    root_id = str(uuid.uuid4())
    llm = _init(root_id, openai_llm)
    with respx.mock(assert_all_called=False) as router:
        router.post(OPENAI_CHAT_URL).mock(
            side_effect=[
                _completion(
                    content=(
                        'Thought: use the tool.\nAction: multiply\nAction Input: {"a": 6, "b": 7}'
                    )
                ),
                _completion(content="Thought: done.\nAnswer: 42"),
            ]
        )
        agent = workflow.ReActAgent(name="reactor", tools=[multiply], llm=llm, streaming=False)
        result = asyncio.run(_run(agent, "What is 6 times 7?"))
    assert "42" in str(result)
    flightdeck_sensor.teardown()

    def _stored() -> bool:
        events = _events(sensor_flavor)
        return any(e["event_type"] == "tool_call" for e in events) and any(
            e["event_type"] == "session_end" and e["session_id"] != root_id for e in events
        )

    wait_until(_stored, timeout=STORED_TIMEOUT_SECS, msg="the ReAct child's tool call stored")
    (child,) = [s for s in _sessions(sensor_flavor) if s["parent_session_id"] == root_id]
    assert child["agent_role"] == "reactor"
    assert child["state"] == "closed"
    (tool,) = [e for e in _events(sensor_flavor) if e["event_type"] == "tool_call"]
    assert tool["session_id"] == root_id
    assert tool["tool_name"] == "multiply"
    assert tool["has_content"] is True
    content = query_rows(
        "SELECT tool_input, tool_output FROM event_content WHERE event_id = :'id'",
        id=tool["id"],
    )
    assert content == [{"tool_input": {"a": 6, "b": 7}, "tool_output": "42"}]
