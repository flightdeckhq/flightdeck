"""The sensor's Google ADK wrap lands in the database as designed.

The real sensor (``flightdeck_sensor.init`` + ``patch``) wraps the real
ADK runner, whose agents call ``LiteLlm`` against a fake OpenAI-compatible
endpoint: an HTTP server on this machine answering chat completions as
api.openai.com does, picking each answer by the agent that asks (named in
its instruction) and by how many turns that agent has had. Everything
from the sensor to the database runs against the dev stack. The tests read
the stored ``sessions`` and ``events`` rows: the child sessions, their
parents and roles, the ``agent_handoff`` signal, an error state, and the
model and tool calls on the sensor's own session.

Runs from the sensor ADK venv (``make test-integration-google-adk``):
Google ADK holds websockets and OpenTelemetry below the dev venv's.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import TYPE_CHECKING, Any

import pytest

import flightdeck_sensor

from .conftest import (
    INGESTION_URL,
    TOKEN,
    delete_flavor_data,
    query_rows,
    wait_until,
)

if TYPE_CHECKING:
    from collections.abc import Iterator

pytest.importorskip("google.adk.runners")
pytest.importorskip("litellm")

MODEL = "openai/gpt-4o-mini"
APP = "adk_integration"
USER = "tester"
# Time for the sensor's posts to be written by the worker.
STORED_TIMEOUT_SECS = 20.0
# The token counts every fake answer reports.
PROMPT_TOKENS = 20
COMPLETION_TOKENS = 5


# ---- the fake OpenAI-compatible endpoint ---------------------------------


def _answer(step: Any) -> dict[str, Any]:
    """A chat completion for one scripted step: text, or a function call
    given as (name, arguments)."""
    if isinstance(step, tuple):
        name, arguments = step
        message: dict[str, Any] = {
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {
                    "id": f"call_{uuid.uuid4().hex[:8]}",
                    "type": "function",
                    "function": {"name": name, "arguments": json.dumps(arguments)},
                }
            ],
        }
        finish = "tool_calls"
    else:
        message, finish = {"role": "assistant", "content": step}, "stop"
    return {
        "id": f"chatcmpl-{uuid.uuid4().hex[:8]}",
        "object": "chat.completion",
        "created": 1,
        "model": "gpt-4o-mini",
        "choices": [{"index": 0, "message": message, "finish_reason": finish}],
        "usage": {
            "prompt_tokens": PROMPT_TOKENS,
            "completion_tokens": COMPLETION_TOKENS,
            "total_tokens": PROMPT_TOKENS + COMPLETION_TOKENS,
        },
    }


class _Endpoint:
    """Chat completions scripted per agent: each agent's instruction says
    "You are <name>.", and its n-th request gets its n-th step."""

    def __init__(self, scripts: dict[str, list[Any]]) -> None:
        self.scripts = {name: list(steps) for name, steps in scripts.items()}
        self.lock = threading.Lock()
        endpoint = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                text = json.dumps(body.get("messages", []))
                agent = next((n for n in endpoint.scripts if f"You are {n}." in text), None)
                with endpoint.lock:
                    steps = endpoint.scripts.get(agent) if agent else None
                    step = steps.pop(0) if steps else None
                if step is None:
                    self.send_response(400)
                    self.end_headers()
                    self.wfile.write(b'{"error": {"message": "no scripted answer"}}')
                    return
                payload = json.dumps(_answer(step)).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *args: Any) -> None:
                return

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_address[1]}/v1"

    def __enter__(self) -> _Endpoint:
        self.thread.start()
        return self

    def __exit__(self, *exc: Any) -> None:
        self.server.shutdown()
        self.server.server_close()


# ---- the ADK app --------------------------------------------------------


def get_weather(city: str) -> dict[str, str]:
    """The weather in a city."""
    return {"city": city, "weather": "sunny"}


def broken_tool(item: str) -> dict[str, str]:
    """A tool that fails."""
    raise ValueError("the tool failed")


def _agent(name: str, base_url: str, **kwargs: Any) -> Any:
    from google.adk.agents import LlmAgent
    from google.adk.models.lite_llm import LiteLlm

    model = LiteLlm(model=MODEL, api_base=base_url, api_key="sk-test")
    kwargs.setdefault("description", name)
    return LlmAgent(name=name, model=model, instruction=f"You are {name}.", **kwargs)


async def _run(root: Any, text: str) -> list[Any]:
    from google.adk.runners import InMemoryRunner
    from google.genai import types

    runner = InMemoryRunner(agent=root, app_name=APP)
    adk_session = await runner.session_service.create_session(app_name=APP, user_id=USER)
    message = types.Content(role="user", parts=[types.Part.from_text(text=text)])
    return [
        event
        async for event in runner.run_async(
            user_id=USER, session_id=adk_session.id, new_message=message
        )
    ]


# ---- the stored rows -------------------------------------------------------


def _sessions(flavor: str) -> list[dict[str, Any]]:
    return query_rows(
        "SELECT session_id::text, parent_session_id::text, agent_role, state,"
        " ended_at IS NOT NULL AS ended FROM sessions WHERE flavor = :'flavor'"
        " ORDER BY started_at",
        flavor=flavor,
    )


def _events(flavor: str) -> list[dict[str, Any]]:
    return query_rows(
        "SELECT id::text, session_id::text, event_type, model, tool_name, has_content,"
        " tokens_total, payload FROM events WHERE flavor = :'flavor' ORDER BY occurred_at",
        flavor=flavor,
    )


@pytest.fixture
def flavor() -> Iterator[str]:
    name = f"test-google-adk-{uuid.uuid4().hex[:10]}"
    _reset()
    os.environ["AGENT_FLAVOR"] = name
    try:
        yield name
    finally:
        os.environ.pop("AGENT_FLAVOR", None)
        _reset()
        delete_flavor_data(name)


def _reset() -> None:
    # teardown() of a sensor never initialised, or one a test left half
    # set up, must not stop the reset.
    with contextlib.suppress(Exception):
        flightdeck_sensor.teardown()
    flightdeck_sensor._session = None
    flightdeck_sensor._client = None


def test_sub_agents_hand_off_and_error_land_as_designed(flavor: str) -> None:
    root = str(uuid.uuid4())
    flightdeck_sensor.init(
        server=INGESTION_URL,
        token=TOKEN,
        session_id=root,
        agent_type="coding",
        capture_prompts=True,
        quiet=True,
    )
    flightdeck_sensor.patch(
        providers=[flightdeck_sensor.Provider.LITELLM, flightdeck_sensor.Provider.GOOGLE_ADK],
        quiet=True,
    )
    from google.adk.tools.agent_tool import AgentTool

    scripts = {
        "triage_agent": [
            ("get_weather", {"city": "Paris"}),
            ("expert_agent", {"request": "why?"}),
            ("transfer_to_agent", {"agent_name": "booking_agent"}),
        ],
        "expert_agent": ["because"],
        "booking_agent": ["booked"],
        "lead_agent": [("failing_agent", {"request": "go"})],
        "failing_agent": [("broken_tool", {"item": "x"})],
    }
    with _Endpoint(scripts) as endpoint:
        url = endpoint.base_url
        expert = _agent("expert_agent", url)
        booking = _agent("booking_agent", url)
        triage = _agent(
            "triage_agent", url, tools=[get_weather, AgentTool(expert)], sub_agents=[booking]
        )
        events = asyncio.run(_run(triage, "plan my day"))
        assert events[-1].author == "booking_agent"
        assert events[-1].content.parts[0].text == "booked"
        failing = _agent("failing_agent", url, tools=[broken_tool])
        lead = _agent("lead_agent", url, tools=[AgentTool(failing)])
        with pytest.raises(ValueError, match="the tool failed"):
            asyncio.run(_run(lead, "go"))
    flightdeck_sensor.teardown()

    def ended() -> bool:
        rows = _sessions(flavor)
        return len(rows) >= 4 and all(r["ended"] for r in rows)

    wait_until(ended, timeout=STORED_TIMEOUT_SECS, msg=f"{flavor}: 4 sessions ended")
    rows = _sessions(flavor)
    by_role = {r["agent_role"]: r for r in rows if r["agent_role"]}
    # The root agents are the sensor's session: no child of their own.
    assert set(by_role) == {"expert_agent", "booking_agent", "failing_agent"}
    assert {r["parent_session_id"] for r in by_role.values()} == {root}
    assert [r["session_id"] for r in rows if not r["agent_role"]] == [root]

    def stored() -> bool:
        events = _events(flavor)
        return (
            any(e["event_type"] == "session_signal" for e in events)
            and sum(e["event_type"] == "post_call" for e in events) >= 7
        )

    wait_until(stored, timeout=STORED_TIMEOUT_SECS, msg="signal and model calls stored")
    events = _events(flavor)
    (handoff,) = [e for e in events if e["event_type"] == "session_signal"]
    assert handoff["session_id"] == root
    assert handoff["payload"]["signal"] == "agent_handoff"
    assert handoff["payload"]["signal_data"] == {"from": "triage_agent", "to": "booking_agent"}
    assert handoff["model"] is None and handoff["has_content"] is False
    failing_end = [
        e
        for e in events
        if e["session_id"] == by_role["failing_agent"]["session_id"]
        and e["event_type"] == "session_end"
    ]
    assert len(failing_end) == 1
    assert failing_end[0]["payload"].get("state") == "error"
    assert failing_end[0]["payload"]["error"]["type"] == "ValueError"
    booking_end = [
        e
        for e in events
        if e["session_id"] == by_role["booking_agent"]["session_id"]
        and e["event_type"] == "session_end"
    ]
    assert len(booking_end) == 1 and "state" not in booking_end[0]["payload"]
    # The model calls are LiteLlm's, metered on the sensor's session.
    posts = [e for e in events if e["event_type"] == "post_call"]
    assert {p["session_id"] for p in posts} == {root}
    assert all(p["tokens_total"] == PROMPT_TOKENS + COMPLETION_TOKENS for p in posts)
    # One tool_call per function call the model made, on the sensor's
    # session; the wrap adds none.
    tool_calls = [e for e in events if e["event_type"] == "tool_call"]
    assert sorted(e["tool_name"] for e in tool_calls) == [
        "broken_tool",
        "expert_agent",
        "failing_agent",
        "get_weather",
        "transfer_to_agent",
    ]
    assert {e["session_id"] for e in tool_calls} == {root}
