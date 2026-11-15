"""Deep Agents runs land one child session per ``task`` sub-agent run.

The real sensor (``flightdeck_sensor.init`` + ``patch``) wraps real Deep
Agents runs whose model is LangChain's ``ChatOpenAI``, with the OpenAI
API mocked at the network boundary (respx), against the stack under
test. The tests read the stored ``sessions`` and ``events`` rows:

* a Deep Agent with one custom sub-agent (``researcher``, with a
  ``lookup`` tool) that the main agent calls once through ``task``: one
  closed child named after the sub-agent under the sensor's session,
  carrying only its start and end, with the task description in its
  incoming message and its answer in its outgoing one; every model call
  on the sensor's session, which reports the ``deepagents`` framework;
* the same Deep Agent answering without a ``task`` call: its main agent
  is a top-level ``create_agent`` run, and no child session lands;
* the sub-agent called through ``ainvoke``: the same one child.
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
    query_rows,
    wait_until,
)
from .test_sensor_e2e import _force_reset_sensor

if TYPE_CHECKING:
    from collections.abc import Iterator

OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions"
MODEL = "gpt-4o-mini"
# Time for the worker to write the sensor's events.
STORED_TIMEOUT_SECS = 20.0


def _sessions(flavor: str) -> list[dict[str, Any]]:
    return query_rows(
        "SELECT session_id::text, parent_session_id::text, agent_role, state, framework,"
        " ended_at IS NOT NULL AS ended FROM sessions WHERE flavor = :'flavor'",
        flavor=flavor,
    )


def _events(flavor: str) -> list[dict[str, Any]]:
    return query_rows(
        "SELECT id::text, session_id::text, event_type, tool_name, payload"
        " FROM events WHERE flavor = :'flavor' ORDER BY occurred_at",
        flavor=flavor,
    )


def _ended(flavor: str, count: int) -> list[dict[str, Any]]:
    def done() -> bool:
        rows = _sessions(flavor)
        return len(rows) >= count and all(r["ended"] for r in rows)

    wait_until(done, timeout=STORED_TIMEOUT_SECS, msg=f"{flavor}: {count} sessions ended")
    return _sessions(flavor)


def _post_calls_stored(flavor: str, count: int) -> list[dict[str, Any]]:
    def stored() -> bool:
        return sum(1 for e in _events(flavor) if e["event_type"] == "post_call") >= count

    wait_until(stored, timeout=STORED_TIMEOUT_SECS, msg=f"{count} post_calls stored")
    return _events(flavor)


def _completion(
    *, content: str | None = None, tool_call: tuple[str, str, dict[str, Any]] | None = None
) -> httpx.Response:
    message: dict[str, Any] = {"role": "assistant", "content": content}
    if tool_call is not None:
        call_id, name, args = tool_call
        message["tool_calls"] = [
            {
                "id": call_id,
                "type": "function",
                "function": {"name": name, "arguments": json.dumps(args)},
            }
        ]
    return httpx.Response(
        200,
        json={
            "id": "chatcmpl-it",
            "object": "chat.completion",
            "created": 1,
            "model": MODEL,
            "choices": [
                {
                    "index": 0,
                    "message": message,
                    "finish_reason": "tool_calls" if tool_call else "stop",
                }
            ],
            "usage": {"prompt_tokens": 50, "completion_tokens": 10, "total_tokens": 60},
        },
    )


def _task_round_trip() -> list[httpx.Response]:
    """The main agent calls ``task``; the sub-agent looks the question up
    and answers; the main agent answers."""
    return [
        _completion(
            tool_call=(
                "call_task",
                "task",
                {"description": "Find the capital of France.", "subagent_type": "researcher"},
            )
        ),
        _completion(tool_call=("call_lookup", "lookup", {"query": "capital of France"})),
        _completion(content="The capital of France is Paris."),
        _completion(content="Paris."),
    ]


@pytest.fixture
def flavor() -> Iterator[str]:
    name = f"test-sensor-deepagents-{uuid.uuid4().hex[:10]}"
    _force_reset_sensor()
    os.environ["AGENT_FLAVOR"] = name
    try:
        yield name
    finally:
        os.environ.pop("AGENT_FLAVOR", None)
        with contextlib.suppress(Exception):
            flightdeck_sensor.teardown()
        _force_reset_sensor()
        delete_flavor_data(name)


@pytest.fixture
def deep() -> dict[str, Any]:
    """Deep Agents and LangChain's pieces, imported before the sensor's
    init (it labels the frameworks loaded then) and only by the tests
    that need them."""
    deepagents = pytest.importorskip("deepagents")
    openai_chat = pytest.importorskip("langchain_openai")
    tools = pytest.importorskip("langchain_core.tools")
    return {
        "create_deep_agent": deepagents.create_deep_agent,
        "ChatOpenAI": openai_chat.ChatOpenAI,
        "tool": tools.tool,
    }


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
        providers=[flightdeck_sensor.Provider.OPENAI, flightdeck_sensor.Provider.LANGGRAPH],
        quiet=True,
    )


def _agent(deep: dict[str, Any]) -> Any:
    def lookup(query: str) -> str:
        """Look a question up."""
        return "Paris is the capital of France."

    lookup.__annotations__ = {"query": str, "return": str}
    llm = deep["ChatOpenAI"](model=MODEL, api_key="test-key", max_retries=0)
    return deep["create_deep_agent"](
        model=llm,
        tools=[],
        system_prompt="Delegate research to the researcher.",
        subagents=[
            {
                "name": "researcher",
                "description": "Researches a question.",
                "system_prompt": "Research the question with lookup.",
                "tools": [deep["tool"](lookup)],
            }
        ],
    )


_QUESTION = {"messages": [{"role": "user", "content": "What is the capital of France?"}]}


def _assert_one_researcher_child(flavor: str, root: str) -> dict[str, Any]:
    rows = _ended(flavor, 2)
    (child,) = [r for r in rows if r["session_id"] != root]
    assert child["agent_role"] == "researcher"
    assert child["parent_session_id"] == root
    assert child["state"] == "closed"
    assert len(rows) == 2

    events = _post_calls_stored(flavor, 4)
    calls = [e for e in events if e["event_type"] == "post_call"]
    assert len(calls) == 4
    assert {e["session_id"] for e in calls} == {root}
    own = [e for e in events if e["session_id"] == child["session_id"]]
    assert sorted(e["event_type"] for e in own) == ["session_end", "session_start"]
    return {"child": child, "events": events, "own": own}


def test_deep_agent_task_lands_one_child_named_after_the_sub_agent(
    flavor: str, deep: dict[str, Any]
) -> None:
    root = str(uuid.uuid4())
    _init(root)
    agent = _agent(deep)
    with respx.mock(assert_all_called=False) as router:
        router.post(OPENAI_CHAT_URL).mock(side_effect=_task_round_trip())
        result = agent.invoke(_QUESTION)
    assert result["messages"][-1].content == "Paris."
    flightdeck_sensor.teardown()

    found = _assert_one_researcher_child(flavor, root)
    (root_row,) = [r for r in _sessions(flavor) if r["session_id"] == root]
    assert root_row["framework"] == "deepagents"
    start = next(e for e in found["own"] if e["event_type"] == "session_start")
    end = next(e for e in found["own"] if e["event_type"] == "session_end")
    assert "state" not in end["payload"]
    # The sub-agent's input state carries the task description; its final
    # state the answer it hands back (small bodies are stored inline).
    incoming = start["payload"]["incoming_message"]["body"]["messages"]
    assert incoming[0]["content"] == "Find the capital of France."
    outgoing = end["payload"]["outgoing_message"]["body"]["messages"]
    assert outgoing[-1]["content"] == "The capital of France is Paris."


def test_deep_agent_answering_without_a_task_lands_no_child(
    flavor: str, deep: dict[str, Any]
) -> None:
    """Without a task call the run is the main agent's alone: a top-level
    create_agent run, which opens no child session."""
    root = str(uuid.uuid4())
    _init(root)
    agent = _agent(deep)
    with respx.mock(assert_all_called=False) as router:
        router.post(OPENAI_CHAT_URL).mock(side_effect=[_completion(content="Paris.")])
        assert agent.invoke(_QUESTION)["messages"][-1].content == "Paris."
    flightdeck_sensor.teardown()

    (row,) = _ended(flavor, 1)
    assert row["session_id"] == root
    events = _post_calls_stored(flavor, 1)
    assert {e["session_id"] for e in events} == {root}
    assert len(_sessions(flavor)) == 1


def test_async_deep_agent_task_lands_one_child(flavor: str, deep: dict[str, Any]) -> None:
    root = str(uuid.uuid4())
    _init(root)
    agent = _agent(deep)
    with respx.mock(assert_all_called=False) as router:
        router.post(OPENAI_CHAT_URL).mock(side_effect=_task_round_trip())
        result = asyncio.run(agent.ainvoke(_QUESTION))
    assert result["messages"][-1].content == "Paris."
    flightdeck_sensor.teardown()

    _assert_one_researcher_child(flavor, root)
