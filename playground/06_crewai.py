"""CrewAI native providers + MCP tools via ``mcpadapt``.

CrewAI 1.14.1's LLM factory routes `anthropic/` and `openai/` model
prefixes to native provider classes that construct
`anthropic.Anthropic()` and `openai.OpenAI()` directly.
`flightdeck_sensor.patch()` hooks those SDK classes, so CrewAI calls
land on the same interception path as direct SDK usage. Both chat
blocks below prove this end-to-end.

The MCP section uses ``mcpadapt`` directly. ``mcpadapt`` is the
production path for CrewAI tools and is what ``crewai-tools[mcp]``
installs under the hood; importing ``mcpadapt`` directly here gives
us a version canary that fires when a future ``crewai-tools`` upgrade
silently bumps to an incompatible mcpadapt release. The sensor pins
mcpadapt in its optional extras for the same reason.

The Gemini section uses CrewAI's native Gemini provider
(``gemini/...``, ``GeminiCompletion``), which builds a ``google.genai``
client the sensor's google-genai patch reaches, on a session of its own:
``call``, ``acall``, a ``call`` on a model given a thinking budget, and a
``call`` with a tool (CrewAI runs the function the model asks for and
returns its result: one request). CrewAI asks Gemini 2.5 and later for
their thoughts, but this model thinks only when given a budget. It
checks one event pair per request the API billed, ``provider=google``,
the model that answered, the tokens each response reported (thoughts as
reasoning), each call's stored request and reply, and a ``tool_call`` per
function the model asked for. It skips without ``GEMINI_API_KEY`` (or
``GOOGLE_API_KEY``); with the key set, a missing google-genai (which the
provider needs) fails the run.
"""

from __future__ import annotations

import asyncio
import os
import sys
import time
import uuid

try:
    from crewai import LLM
except ImportError:
    print("SKIP: pip install crewai")
    sys.exit(2)

import flightdeck_sensor
from flightdeck_sensor import Provider

from _helpers import (
    assert_event_landed,
    assert_gemini_calls,
    fetch_events_for_session,
    init_sensor,
    mcp_server_params,
    print_result,
)

# A current, cheap model the Gemini API serves to a new key, through
# CrewAI's native Gemini provider; it thinks when given a thinking budget.
GEMINI_MODEL = "gemini/gemini-3.1-flash-lite"
# Room for a short answer, and for the thinking call's thoughts.
GEMINI_MAX_TOKENS = 600
# The thinking call's budget: enough thoughts for a small sum.
GEMINI_THINKING_BUDGET = 256
# The plain calls' prompts, each a call's one user turn: call, acall, and
# the thinking call.
GEMINI_PROMPTS = ("Name a colour. Answer in one word.", "Name a fruit. Answer in one word.")
THINKING_PROMPT = "What is 17 * 23? Answer with the number only."
WEATHER_PROMPT = "What is the weather in Paris? Use the get_weather tool."
# The tool, in the function-schema form CrewAI's LLM.call takes.
WEATHER_TOOL = {
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "Returns the current weather in a city.",
        "parameters": {
            "type": "object",
            "properties": {"city": {"type": "string"}},
            "required": ["city"],
        },
    },
}
# The requests the section makes, one each whatever the model answers:
# call, acall, the thinking call, and the call with the tool (CrewAI runs
# the function from the first response and returns its result, with no
# second request).
GEMINI_REQUESTS = 4
# The calls asked to think: the thinking call.
GEMINI_THINKING_CALLS = 1
# The class CrewAI's LLM factory returns for a native Gemini model.
GEMINI_PROVIDER_CLASS = "GeminiCompletion"
MS_PER_S = 1000

# The functions the model asked CrewAI to run, by name, in order.
asked: list[str] = []


def get_weather(city: str) -> str:
    """Returns the current weather in a city."""
    asked.append("get_weather")
    return f"sunny, 21 C in {city}"


def _ms(t0: float) -> int:
    return int((time.monotonic() - t0) * MS_PER_S)


def _run_chat(label: str, provider: Provider, model: str, contains: str) -> None:
    # Fresh session_id per block -- assertion queries filter by
    # session_id, so distinct ids keep the two blocks independent.
    session_id = str(uuid.uuid4())
    init_sensor(session_id, flavor="playground-crewai")
    flightdeck_sensor.patch(providers=[provider], quiet=True)
    print(f"[playground:06_crewai] {label} session_id={session_id}")
    t0 = time.monotonic()
    LLM(model=model).call("hi")
    print_result(
        f"crewai.LLM.call ({label})",
        True,
        int((time.monotonic() - t0) * 1000),
    )
    assert_event_landed(
        session_id,
        "post_call",
        timeout=8,
        model_contains=contains,
    )
    flightdeck_sensor.teardown()


def _run_mcp() -> None:
    """Demonstrate CrewAI MCP via ``mcpadapt`` directly. Skipped cleanly
    when the optional dep isn't installed.

    Using ``mcpadapt.core.MCPAdapt + mcpadapt.crewai_adapter.CrewAIAdapter``
    rather than the user-facing ``crewai_tools.MCPServerAdapter`` makes
    this script a *version-drift canary*: a future ``crewai-tools``
    upgrade that silently bumps to an incompatible ``mcpadapt`` release
    breaks the demo loudly here, even when the user-facing API still
    appears to work.
    """
    try:
        import mcp  # noqa: F401
        from mcpadapt.core import MCPAdapt  # type: ignore[import-untyped]
        from mcpadapt.crewai_adapter import CrewAIAdapter  # type: ignore[import-untyped]
    except ImportError:
        print("SKIP MCP section: pip install mcp mcpadapt")
        return

    session_id = str(uuid.uuid4())
    init_sensor(session_id, flavor="playground-crewai-mcp")
    flightdeck_sensor.patch(quiet=True)
    print(f"[playground:06_crewai] mcp session_id={session_id}")

    params = mcp_server_params("playground._mcp_reference_server")
    with MCPAdapt(params, CrewAIAdapter()) as tools:
        echo = next((t for t in tools if t.name == "echo"), None)
        if echo is None:
            raise AssertionError(
                f"mcpadapt CrewAIAdapter did not expose 'echo'; got {[t.name for t in tools]!r}",
            )
        t0 = time.monotonic()
        echo.run(text="hello from crewai playground")
        print_result(
            "echo.run",
            True,
            int((time.monotonic() - t0) * 1000),
        )

    events = fetch_events_for_session(
        session_id,
        expect_event_types=["mcp_tool_call"],
        timeout_s=20.0,
    )
    tcs = [e for e in events if e["event_type"] == "mcp_tool_call"]
    if not tcs:
        raise AssertionError(f"no mcp_tool_call observed; events={events!r}")
    payload = tcs[-1].get("payload") or {}
    server_ok = payload.get("server_name") == "flightdeck-mcp-reference"
    # MCP tool args are captured to event_content.tool_input (fetched via
    # /v1/events/:id/content), not inline in the event payload; the event
    # carries has_content=true to signal operators to fetch.
    args_ok = tcs[-1].get("has_content") is True and "arguments" not in payload
    tool_ok = tcs[-1].get("tool_name") == "echo"
    print_result("mcp payload.server_name", server_ok, 0)
    print_result("mcp args captured to event_content (not inline)", args_ok, 0)
    print_result("mcp tool_name=echo", tool_ok, 0)
    if not (server_ok and args_ok and tool_ok):
        raise AssertionError(f"mcp_tool_call payload mismatch: {tcs[-1]!r}")
    flightdeck_sensor.teardown()


def _run_gemini() -> None:
    """CrewAI's native Gemini provider on a session of its own: ``call``,
    ``acall``, a thinking call and a ``call`` with a tool, each request one
    event pair with Gemini's stored body (see the module docstring)."""
    if not (os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")):
        print("  SKIP  Gemini section: GEMINI_API_KEY / GOOGLE_API_KEY is not set")
        return
    try:
        from google.genai import types  # the native provider's client
    except ImportError as exc:
        # With the key set, a missing package is a broken venv, not a
        # section to skip.
        raise AssertionError(
            f"GEMINI_API_KEY is set but the Gemini section cannot run: {exc}"
        ) from exc

    session_id = str(uuid.uuid4())
    init_sensor(session_id, flavor="playground-crewai")
    flightdeck_sensor.patch(providers=[Provider.GOOGLE_GENAI], quiet=True)
    print(f"[playground:06_crewai] gemini session_id={session_id}")
    llm = LLM(model=GEMINI_MODEL, max_tokens=GEMINI_MAX_TOKENS)
    native = type(llm).__name__
    print_result(
        f"LLM({GEMINI_MODEL!r}) is CrewAI's native provider",
        native == GEMINI_PROVIDER_CLASS,
        0,
        native,
    )
    if native != GEMINI_PROVIDER_CLASS:
        flightdeck_sensor.teardown()
        raise AssertionError(f"CrewAI built {native} for {GEMINI_MODEL}")
    try:
        t0 = time.monotonic()
        sync = llm.call(GEMINI_PROMPTS[0])
        print_result("crewai.LLM.call (gemini)", bool(sync), _ms(t0), repr(sync))

        t0 = time.monotonic()
        asynced = asyncio.run(llm.acall(GEMINI_PROMPTS[1]))
        print_result("crewai.LLM.acall (gemini)", bool(asynced), _ms(t0), repr(asynced))

        t0 = time.monotonic()
        thinker = LLM(
            model=GEMINI_MODEL,
            max_tokens=GEMINI_MAX_TOKENS,
            thinking_config=types.ThinkingConfig(
                thinking_budget=GEMINI_THINKING_BUDGET, include_thoughts=True
            ),
        )
        thought = thinker.call(THINKING_PROMPT)
        print_result(
            "crewai.LLM.call with a thinking budget (gemini)", bool(thought), _ms(t0), repr(thought)
        )

        t0 = time.monotonic()
        result = llm.call(
            WEATHER_PROMPT,
            tools=[WEATHER_TOOL],
            available_functions={"get_weather": get_weather},
        )
        print_result(
            "crewai.LLM.call with a tool (gemini): CrewAI runs the function",
            asked == ["get_weather"] and "sunny" in str(result),
            _ms(t0),
            f"asked for {asked}: {result!r}",
        )
    finally:
        flightdeck_sensor.teardown()
    if not (sync and asynced and thought and asked == ["get_weather"]):
        raise AssertionError(
            f"a Gemini call returned no answer or no call: {sync!r} {asynced!r} {thought!r} {asked}"
        )

    assert_gemini_calls(
        session_id,
        "crewai.LLM (gemini)",
        requests=GEMINI_REQUESTS,
        replies={
            GEMINI_PROMPTS[0]: str(sync),
            GEMINI_PROMPTS[1]: str(asynced),
            THINKING_PROMPT: str(thought),
        },
        asked=asked,
        thinking_calls=GEMINI_THINKING_CALLS,
    )


def main() -> None:
    _run_chat(
        "anthropic",
        Provider.ANTHROPIC,
        "anthropic/claude-haiku-4-5-20251001",
        "claude-haiku-4-5",
    )
    _run_chat("openai", Provider.OPENAI, "openai/gpt-4o-mini", "gpt-4o-mini")
    _run_gemini()
    _run_mcp()


if __name__ == "__main__":
    main()
