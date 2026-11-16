"""The sensor's Google ADK wrap against real models and the dev stack.

One run per provider whose key is set, each its own sensor session,
through ``flightdeck_sensor``'s native wrap (``Provider.GOOGLE_ADK``):

* OpenAI ``gpt-4o-mini`` through ADK's ``LiteLlm`` (the litellm patch
  meters it), when ``OPENAI_API_KEY`` is set;
* Anthropic ``claude-haiku-4-5`` through ADK's ``AnthropicLlm`` (the
  Anthropic patch meters it), when ``ANTHROPIC_API_KEY`` is set;
* Gemini, ADK's default, when ``GOOGLE_API_KEY`` is set: its child
  sessions land but its model calls are not metered (the sensor has no
  google-genai interceptor), so only the structure is checked. Skipped
  without the key.

In each session ``concierge_agent`` (the root, with a function tool
``get_weather``, ``expert_agent`` as an ``AgentTool`` and a sub-agent
``booking_agent``) gets two requests, two runs of one ADK conversation:
the first makes it call the tool and ask the expert, the second makes it
transfer to the booking agent. Checked through the API:
the expert's and the booking agent's child sessions under the sensor's
session and none for the root agent, the ``agent_handoff`` signal from
the concierge to the booking agent on the sensor's session with no
content, and, for the metered providers, the model calls and one
``tool_call`` per function call on the sensor's session.

Runs from the sensor ADK venv (playground/README.md). Exits 2 when ADK
is not installed or no provider key is set. Prints every session id so
the runs can be found on the dashboard and deleted by id.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid
from typing import Any

from _helpers import (
    API_TOKEN,
    API_URL,
    fetch_events_for_session,
    init_sensor,
    print_result,
    wait_for_dev_stack,
)

FLAVOR = "playground-google-adk"
APP = "playground_google_adk"
USER = "playground"
OPENAI_MODEL = "openai/gpt-4o-mini"
ANTHROPIC_MODEL = "claude-haiku-4-5"
GEMINI_MODEL = "gemini-2.5-flash"
# Enough for a tool call or a one-sentence answer, and cheap.
MAX_TOKENS = 300
# The bound on a run's model calls (ADK's RunConfig.max_llm_calls): the
# three steps take about eight, and a model that loops stops here.
MAX_LLM_CALLS = 20
# Each model request's client timeout: the calls answer in seconds, and
# without a cap a stalled request waits the SDK default.
MODEL_TIMEOUT_S = 60
# Time for a run's child sessions and events to land: the worker writes
# within a second or two on an idle stack.
LANDED_S = 25.0
POLL_S = 0.5
API_TIMEOUT_S = 5.0
MS_PER_S = 1000
# How much of a payload a failure message quotes.
FAILURE_DUMP_CHARS = 2000
# The exit code run_all.py reads as SKIP.
SKIP_RC = 2

ROOT_NAME = "concierge_agent"
EXPERT_NAME = "expert_agent"
BOOKING_NAME = "booking_agent"
ROOT_INSTRUCTION = (
    "You are a concierge. For the weather, call get_weather. For anything "
    f"about museums, call {EXPERT_NAME}. Only when the user asks to book "
    f"something, transfer to {BOOKING_NAME}. Otherwise answer in one sentence."
)
# The run's two requests: the first needs the function tool and the
# AgentTool, the second the transfer.
REQUESTS = (
    "What is the weather in Paris? And ask the expert to name one museum there.",
    "Please book me a table for two tonight.",
)

session_ids: list[str] = []


def get_weather(city: str) -> dict[str, str]:
    """The weather in a city."""
    return {"city": city, "weather": "sunny, 21 C"}


def _get(path: str) -> dict[str, Any]:
    req = urllib.request.Request(
        f"{API_URL}{path}", headers={"Authorization": f"Bearer {API_TOKEN}"}
    )
    with urllib.request.urlopen(req, timeout=API_TIMEOUT_S) as r:
        return json.loads(r.read())  # type: ignore[no-any-return]


def _children(parent: str, expected: int) -> list[dict[str, Any]]:
    """The child sessions of ``parent`` once ``expected`` have ended, or
    what is there at the deadline."""
    deadline = time.monotonic() + LANDED_S
    children: list[dict[str, Any]] = []
    while time.monotonic() < deadline:
        try:
            children = _get(f"/v1/sessions?parent_session_id={parent}&limit=50")["sessions"]
        except (urllib.error.URLError, OSError, json.JSONDecodeError, KeyError):
            # Transient while the stack catches up; poll again.
            children = []
        if len(children) >= expected and all(c.get("ended_at") for c in children):
            break
        time.sleep(POLL_S)
    session_ids.extend(c["session_id"] for c in children)
    return children


def _events(session_id: str, event_type: str, count: int) -> list[dict[str, Any]]:
    """The session's events of ``event_type`` once ``count`` have landed,
    or those there at the deadline."""
    deadline = time.monotonic() + LANDED_S
    while True:
        events = fetch_events_for_session(
            session_id, expect_event_types=[event_type], timeout_s=LANDED_S
        )
        found = [e for e in events if e.get("event_type") == event_type]
        if len(found) >= count or time.monotonic() > deadline:
            return found
        time.sleep(POLL_S)


def _check(label: str, ok: bool, detail: Any = "") -> None:
    print_result(label, ok, 0, str(detail)[:FAILURE_DUMP_CHARS] if not ok else "")
    if not ok:
        raise AssertionError(f"{label}: {str(detail)[:FAILURE_DUMP_CHARS]}")


def _agents(model: Any) -> Any:
    from google.adk.agents import LlmAgent
    from google.adk.tools.agent_tool import AgentTool
    from google.genai import types

    config = types.GenerateContentConfig(max_output_tokens=MAX_TOKENS)
    expert = LlmAgent(
        name=EXPERT_NAME,
        model=model,
        description="Answers questions about Paris in one sentence.",
        instruction="Answer in one short sentence.",
        generate_content_config=config,
    )
    booking = LlmAgent(
        name=BOOKING_NAME,
        model=model,
        description="Confirms bookings.",
        instruction="Say in one short sentence that the booking is confirmed.",
        generate_content_config=config,
        # It answers and the run ends: no transfer back to the concierge.
        disallow_transfer_to_parent=True,
        disallow_transfer_to_peers=True,
    )
    return LlmAgent(
        name=ROOT_NAME,
        model=model,
        instruction=ROOT_INSTRUCTION,
        tools=[get_weather, AgentTool(expert)],
        sub_agents=[booking],
        generate_content_config=config,
    )


async def _run(root: Any) -> list[Any]:
    """Both requests, one ADK conversation; every event of the two runs."""
    from google.adk.agents.run_config import RunConfig
    from google.adk.runners import InMemoryRunner
    from google.genai import types

    runner = InMemoryRunner(agent=root, app_name=APP)
    adk_session = await runner.session_service.create_session(app_name=APP, user_id=USER)
    events = []
    for request in REQUESTS:
        message = types.Content(role="user", parts=[types.Part.from_text(text=request)])
        async for event in runner.run_async(
            user_id=USER,
            session_id=adk_session.id,
            new_message=message,
            run_config=RunConfig(max_llm_calls=MAX_LLM_CALLS),
        ):
            events.append(event)
    await runner.close()
    return events


def section(label: str, make_model: Any, *, metered: bool) -> None:
    import flightdeck_sensor
    from flightdeck_sensor import Provider

    root = str(uuid.uuid4())
    session_ids.append(root)
    init_sensor(root, flavor=FLAVOR)
    # Before the runner is built and before the first LiteLlm call: a
    # runner built earlier has no plugin, and LiteLlm keeps the litellm
    # function it finds on its first call.
    flightdeck_sensor.patch(
        providers=[Provider.LITELLM, Provider.ANTHROPIC, Provider.GOOGLE_ADK], quiet=True
    )
    print(f"[playground:38_google_adk] {label}: session_id={root}")
    t0 = time.monotonic()
    try:
        events = asyncio.run(_run(_agents(make_model())))
    finally:
        flightdeck_sensor.teardown()
    authors = [e.author for e in events]
    # The function calls the run's model responses made, by name: a model
    # may call a tool more than once.
    calls = sorted(c.name for e in events for c in e.get_function_calls())
    print_result(
        f"{label}: run ({len(events)} events)", True, int((time.monotonic() - t0) * MS_PER_S)
    )
    _check(f"{label}: the run reached {BOOKING_NAME}", BOOKING_NAME in authors, authors)

    found = _children(root, 2)
    roles = {c["agent_role"] for c in found}
    _check(
        f"{label}: {EXPERT_NAME} and {BOOKING_NAME} are child sessions, the root agent none",
        roles == {EXPERT_NAME, BOOKING_NAME},
        [(c["agent_role"], c["state"]) for c in found],
    )
    _check(
        f"{label}: every child is under the sensor's session and closed",
        all(c.get("parent_session_id") == root and c.get("ended_at") for c in found),
        found,
    )
    signals = [
        e
        for e in _events(root, "session_signal", 1)
        if (e.get("payload") or {}).get("signal") == "agent_handoff"
    ]
    transfers = calls_named(events, "transfer_to_agent")
    _check(
        f"{label}: one agent_handoff on the sensor's session per transfer",
        len(signals) == transfers >= 1,
        (transfers, signals),
    )
    _check(
        f"{label}: agent_handoff names from and to, with no content",
        all(
            h["payload"].get("signal_data") == {"from": ROOT_NAME, "to": BOOKING_NAME}
            and not h.get("has_content")
            for h in signals
        ),
        signals,
    )
    if not metered:
        return
    posts = _events(root, "post_call", 4)
    _check(
        f"{label}: the model calls are on the sensor's session with tokens",
        len(posts) >= 4 and all((p.get("tokens_total") or 0) > 0 for p in posts),
        [(p.get("model"), p.get("tokens_total")) for p in posts],
    )
    tools = sorted(e.get("tool_name") or "" for e in _events(root, "tool_call", len(calls)))
    _check(
        f"{label}: one tool_call per function call, none from the wrap",
        tools == calls and {"get_weather", EXPERT_NAME, "transfer_to_agent"} <= set(calls),
        (tools, calls),
    )


def calls_named(events: list[Any], name: str) -> int:
    """How many function calls named ``name`` the run's events made."""
    return sum(c.name == name for e in events for c in e.get_function_calls())


def _openai_model() -> Any:
    from google.adk.models.lite_llm import LiteLlm

    return LiteLlm(model=OPENAI_MODEL, timeout=MODEL_TIMEOUT_S)


def _anthropic_model() -> Any:
    from google.adk.models.anthropic_llm import AnthropicLlm

    return AnthropicLlm(model=ANTHROPIC_MODEL)


def main() -> None:
    try:
        import google.adk  # noqa: F401
    except ImportError:
        print("SKIP: google-adk is not installed (playground/README.md, Sensor ADK venv)")
        sys.exit(SKIP_RC)
    sections = []
    if os.environ.get("OPENAI_API_KEY"):
        sections.append(("OpenAI through LiteLlm", _openai_model, True))
    if os.environ.get("ANTHROPIC_API_KEY"):
        sections.append(("Anthropic through AnthropicLlm", _anthropic_model, True))
    if not sections:
        print("SKIP: this script requires OPENAI_API_KEY or ANTHROPIC_API_KEY", file=sys.stderr)
        sys.exit(SKIP_RC)
    if os.environ.get("GOOGLE_API_KEY"):
        sections.append(("Gemini (not metered)", lambda: GEMINI_MODEL, False))
    else:
        print("  SKIP  Gemini section: GOOGLE_API_KEY is not set")
    wait_for_dev_stack()
    try:
        for label, make_model, metered in sections:
            section(label, make_model, metered=metered)
    finally:
        print(f"[playground:38_google_adk] sessions: {' '.join(session_ids)}")


if __name__ == "__main__":
    main()
