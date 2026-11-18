"""The sensor's Google ADK wrap against real models and the dev stack.

One run per provider whose key is set, each its own sensor session,
through ``flightdeck_sensor``'s native wrap (``Provider.GOOGLE_ADK``):

* OpenAI ``gpt-4o-mini`` through ADK's ``LiteLlm`` (the litellm patch
  meters it), when ``OPENAI_API_KEY`` is set;
* Anthropic ``claude-haiku-4-5`` through ADK's ``AnthropicLlm`` (the
  Anthropic patch meters it), when ``ANTHROPIC_API_KEY`` is set;
* Gemini ``gemini-3.1-flash-lite`` through ADK's default model class,
  when ``GEMINI_API_KEY`` or ``GOOGLE_API_KEY`` is set (the google-genai
  patch meters it).

In each session ``concierge_agent`` (the root, with a function tool
``get_weather``, ``expert_agent`` as an ``AgentTool`` and a sub-agent
``booking_agent``) gets two requests, two runs of one ADK conversation:
the first makes it call the tool and ask the expert, the second makes it
transfer to the booking agent. Checked through the API:
the expert's and the booking agent's child sessions under the sensor's
session and none for the root agent, the ``agent_handoff`` signal from
the concierge to the booking agent on the sensor's session with no
content, and the model calls (each once, with its provider: ADK's Gemini
model makes one google-genai request per model turn) and one
``tool_call`` per function call on the sensor's session. How many model
calls, tool calls, expert questions and transfers the run takes is the
models' choice: each count is read from what the run did (the agents'
after-model callbacks see every model response, the events every
function call), never fixed in the script; every model call the sensor
saw is paired (one ``pre_call``, one outcome), and the tokens the
``post_call``s carry are the tokens the model responses reported.

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
from collections import Counter
from typing import Any

from _helpers import (
    API_TOKEN,
    API_URL,
    MS_PER_S,
    fetch_event_content,
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
# A current, cheap model the Gemini API serves to a new key.
GEMINI_MODEL = "gemini-3.1-flash-lite"
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
# How much of a payload a failure message quotes.
FAILURE_DUMP_CHARS = 2000
# The exit code run_all.py reads as SKIP.
SKIP_RC = 2
# The least the two requests take, whatever the models choose: the
# root's turn that calls the tool and the expert and its answer (2), the
# expert's answer (1), the root's transfer (1) and the booking agent's
# answer (1).
MIN_MODEL_REQUESTS = 5

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


class _ModelResponses:
    """The model responses a run's agents received, one per model request,
    as their after-model callbacks see them: the root's, the booking
    agent's and the expert's (which an ``AgentTool`` runs in a runner of
    its own, so its events are not the run's)."""

    def __init__(self) -> None:
        self.responses: list[Any] = []

    def after_model(self, callback_context: Any, llm_response: Any) -> None:
        del callback_context
        self.responses.append(llm_response)

    def tokens(self) -> tuple[int, int]:
        """The input and output tokens the responses that report usage
        reported, as the sensor counts a call's: the prompt with the
        tool-use prompt, the candidates with the thoughts."""
        tokens_in = tokens_out = 0
        for response in self.responses:
            usage = response.usage_metadata
            if usage is None:
                continue
            tokens_in += (usage.prompt_token_count or 0) + (usage.tool_use_prompt_token_count or 0)
            tokens_out += (usage.candidates_token_count or 0) + (usage.thoughts_token_count or 0)
        return tokens_in, tokens_out

    def without_usage(self) -> int:
        """How many responses reported no usage."""
        return sum(response.usage_metadata is None for response in self.responses)


def _agents(model: Any, seen: _ModelResponses) -> Any:
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
        after_model_callback=seen.after_model,
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
        after_model_callback=seen.after_model,
    )
    return LlmAgent(
        name=ROOT_NAME,
        model=model,
        instruction=ROOT_INSTRUCTION,
        tools=[get_weather, AgentTool(expert)],
        sub_agents=[booking],
        generate_content_config=config,
        after_model_callback=seen.after_model,
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


def section(label: str, make_model: Any, *, provider: str) -> None:
    import flightdeck_sensor
    from flightdeck_sensor import Provider

    root = str(uuid.uuid4())
    session_ids.append(root)
    init_sensor(root, flavor=FLAVOR)
    # Before the runner is built and before the first LiteLlm call: a
    # runner built earlier has no plugin, and LiteLlm keeps the litellm
    # function it finds on its first call.
    flightdeck_sensor.patch(
        providers=[
            Provider.LITELLM,
            Provider.ANTHROPIC,
            Provider.GOOGLE_GENAI,
            Provider.GOOGLE_ADK,
        ],
        quiet=True,
    )
    print(f"[playground:38_google_adk] {label}: session_id={root}")
    t0 = time.monotonic()
    seen = _ModelResponses()
    try:
        events = asyncio.run(_run(_agents(make_model(), seen)))
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

    # A child session per run of a sub-agent: one per question the root
    # put to the expert, one per transfer to the booking agent.
    transfers = calls_named(events, "transfer_to_agent")
    children = calls_named(events, EXPERT_NAME) + transfers
    found = _children(root, children)
    roles = {c["agent_role"] for c in found}
    _check(
        f"{label}: {EXPERT_NAME} and {BOOKING_NAME} are child sessions, one per run, "
        "the root agent none",
        roles == {EXPERT_NAME, BOOKING_NAME} and len(found) == children,
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
    # One post_call per model request the agents made, at least the round
    # trip each of the first request's tool and expert calls takes, the
    # expert's answer, the transfer and the booking agent's answer.
    requests = len(seen.responses)
    posts = _events(root, "post_call", requests)
    _check(
        f"{label}: one post_call per model request ({requests}), "
        "on the sensor's session with tokens",
        len(posts) == requests >= MIN_MODEL_REQUESTS
        and all((p.get("tokens_total") or 0) > 0 for p in posts),
        [(p.get("model"), p.get("tokens_total")) for p in posts],
    )
    kinds = [
        e.get("event_type")
        for e in fetch_events_for_session(
            root, expect_event_types=["post_call", "session_end"], timeout_s=LANDED_S
        )
    ]
    _check(
        f"{label}: one pre_call per model call, each closed by a post_call or an llm_error",
        kinds.count("pre_call") == kinds.count("post_call") + kinds.count("llm_error"),
        {k: kinds.count(k) for k in sorted({str(k) for k in kinds})},
    )
    tokens = (
        sum(p.get("tokens_input") or 0 for p in posts),
        sum(p.get("tokens_output") or 0 for p in posts),
    )
    reported = seen.tokens()
    missing = seen.without_usage()
    # A check over no reported usage would pass whatever the post_calls
    # carry.
    _check(
        f"{label}: at least one model response reported usage",
        missing < requests,
        f"{missing} of {requests} reported none",
    )
    if missing:
        # The sensor records a call whose response reports no usage with
        # its pre-call estimate as the input tokens and no output tokens.
        # Those post_calls are the ones whose stored response holds no
        # usage; each one's input must be a pre_call's estimate.
        print(
            f"  note: {missing} of {requests} model responses reported no usage; "
            "their post_calls must carry a pre-call estimate as input tokens and no "
            "output tokens"
        )
        unreported = [
            p for p in posts if not _reports_usage(fetch_event_content(p["id"]).get("response"))
        ]
        estimates = Counter(e.get("tokens_input") for e in _events(root, "pre_call", requests))
        estimated = sum(p.get("tokens_input") or 0 for p in unreported)
        _check(
            f"{label}: the post_calls' tokens are the ones the model responses reported, "
            "plus the pre-call estimates of the calls that reported none",
            len(unreported) == missing
            and all(p.get("tokens_output") == 0 for p in unreported)
            and not Counter(p.get("tokens_input") for p in unreported) - estimates
            and tokens == (reported[0] + estimated, reported[1]),
            (
                tokens,
                reported,
                [(p.get("tokens_input"), p.get("tokens_output")) for p in unreported],
            ),
        )
    else:
        _check(
            f"{label}: the post_calls' tokens are the tokens the model responses reported",
            tokens == reported,
            (tokens, reported),
        )
    _check(
        f"{label}: every model call's provider is {provider}",
        {p.get("provider") for p in posts} == {provider},
        [p.get("provider") for p in posts],
    )
    tools = sorted(e.get("tool_name") or "" for e in _events(root, "tool_call", len(calls)))
    _check(
        f"{label}: one tool_call per function call, none from the wrap",
        tools == calls and {"get_weather", EXPERT_NAME, "transfer_to_agent"} <= set(calls),
        (tools, calls),
    )


def _reports_usage(response: Any) -> bool:
    """Whether a stored model response reports usage: Gemini's
    ``usageMetadata``, or the ``usage`` of an OpenAI (litellm) or Anthropic
    response."""
    return isinstance(response, dict) and any(
        isinstance(response.get(key), dict) for key in ("usageMetadata", "usage")
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
        sections.append(("OpenAI through LiteLlm", _openai_model, "openai"))
    else:
        print("  SKIP  OpenAI section: OPENAI_API_KEY is not set")
    if os.environ.get("ANTHROPIC_API_KEY"):
        sections.append(("Anthropic through AnthropicLlm", _anthropic_model, "anthropic"))
    else:
        print("  SKIP  Anthropic section: ANTHROPIC_API_KEY is not set")
    if os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY"):
        sections.append(("Gemini through ADK's Gemini model", lambda: GEMINI_MODEL, "google"))
    else:
        print("  SKIP  Gemini section: GEMINI_API_KEY / GOOGLE_API_KEY is not set")
    if not sections:
        print(
            "SKIP: this script requires OPENAI_API_KEY, ANTHROPIC_API_KEY or GEMINI_API_KEY",
            file=sys.stderr,
        )
        sys.exit(SKIP_RC)
    wait_for_dev_stack()
    try:
        for label, make_model, provider in sections:
            section(label, make_model, provider=provider)
    finally:
        print(f"[playground:38_google_adk] sessions: {' '.join(session_ids)}")


if __name__ == "__main__":
    main()
