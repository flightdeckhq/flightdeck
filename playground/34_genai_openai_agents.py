"""OpenAI Agents SDK over OpenTelemetry: an agent that runs a sub-agent
as a tool lands as a root and a child ``otlp`` session, no sensor
involved.

The SDK has no OpenTelemetry instrumentation of its own; OpenTelemetry's
``opentelemetry-instrumentation-openai-agents-v2`` traces it onto a
tracer provider that exports to the dev stack's ``/ingest/v1/traces``.
The SDK's own trace exporter (to OpenAI's tracing backend) is removed
first, so the run is reported to Flightdeck only. Content capture is the
instrumentation's ``OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT``,
which ``configure_exporter`` turns on. ``assistant`` calls
``ask_weather_agent`` (``weather_agent.as_tool``), which calls
``get_weather``: four calls to OpenAI's ``gpt-4o-mini``. The script then
checks the assembled sessions: flavor ``playground-genai-openai-agents``,
``client_type=otlp``, the parent/child link, tokens, both tool calls and
the stored content of every call.

Runs from the GenAI venv (playground/README.md); exits 2 without the
SDK and its instrumentation, or without ``OPENAI_API_KEY``.
"""

from __future__ import annotations

import sys

from _genai import (
    SubagentRun,
    configure_exporter,
    install_tracer_provider,
    run_started,
    verify_subagent_run,
)
from _helpers import print_result, require_env, wait_for_dev_stack

FLAVOR = configure_exporter("openai-agents")

try:
    from agents import (
        Agent,
        ModelSettings,
        Runner,
        function_tool,
        set_trace_processors,
    )
    from opentelemetry import trace
    from opentelemetry.instrumentation.openai_agents import OpenAIAgentsInstrumentor
except ImportError:
    print(
        "SKIP: the OpenAI Agents SDK and its OpenTelemetry instrumentation are "
        "not installed in this interpreter; run with the GenAI venv "
        "(playground/README.md, OpenTelemetry GenAI frameworks)"
    )
    sys.exit(2)

MODEL = "gpt-4o-mini"
SETTINGS = ModelSettings(max_tokens=200)


@function_tool
def get_weather(city: str) -> str:
    """The current weather in a city."""
    return f"{city}: sunny, 21 C"


def main() -> None:
    require_env("OPENAI_API_KEY")
    wait_for_dev_stack()
    flush = install_tracer_provider()
    set_trace_processors([])
    OpenAIAgentsInstrumentor().instrument(tracer_provider=trace.get_tracer_provider())

    weather = Agent(
        name="weather_agent",
        instructions="Answer weather questions with the get_weather tool.",
        tools=[get_weather],
        model=MODEL,
        model_settings=SETTINGS,
    )
    assistant = Agent(
        name="assistant",
        instructions=(
            "Delegate weather questions to the weather agent with the "
            "ask_weather_agent tool."
        ),
        tools=[
            weather.as_tool(
                tool_name="ask_weather_agent",
                tool_description="Ask the weather agent a question.",
            )
        ],
        model=MODEL,
        model_settings=SETTINGS,
    )

    since = run_started()
    result = Runner.run_sync(
        assistant,
        "Ask the weather agent for the weather in Paris, then answer in one "
        "short sentence.",
    )
    flush()
    print_result("agent run", True, 0, repr(str(result.final_output)[:80]))

    verify_subagent_run(
        SubagentRun(
            flavor=FLAVOR,
            framework="openai_agents",
            root="assistant",
            root_tool="ask_weather_agent",
            child="weather_agent",
            child_tool="get_weather",
        ),
        since,
    )


if __name__ == "__main__":
    main()
