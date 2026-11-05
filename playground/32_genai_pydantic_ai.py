"""Pydantic AI over OpenTelemetry: an agent that runs a sub-agent as a
tool lands as a root and a child ``otlp`` session, no sensor involved.

Pydantic AI's own instrumentation (``Agent.instrument_all``) records the
run as GenAI spans on the global tracer provider, which exports them to
the dev stack's ``/ingest/v1/traces``. ``assistant`` calls
``ask_weather_agent``, which runs ``weather_agent``, which calls
``get_weather``: four Anthropic calls on Claude Haiku 4.5. The script
then checks the assembled sessions: flavor ``playground-genai-pydantic-ai``,
``client_type=otlp``, the parent/child link, tokens, both tool calls and
the stored content of every call.

Runs from the GenAI venv (playground/README.md); exits 2 without
Pydantic AI or ``ANTHROPIC_API_KEY``.
"""

from __future__ import annotations

from _genai import (
    SubagentRun,
    configure_exporter,
    install_tracer_provider,
    run_started,
    skip_if_not_installed,
    verify_subagent_run,
)
from _helpers import print_result, require_env, wait_for_dev_stack

FLAVOR = configure_exporter("pydantic-ai")

try:
    from pydantic_ai import Agent, RunContext
    from pydantic_ai.models.instrumented import InstrumentationSettings
except ImportError as exc:
    skip_if_not_installed(exc, ("pydantic_ai",))

MODEL = "anthropic:claude-haiku-4-5"
SETTINGS = {"max_tokens": 200}


def get_weather(city: str) -> str:
    """The current weather in a city."""
    return f"{city}: sunny, 21 C"


def main() -> None:
    require_env("ANTHROPIC_API_KEY")
    wait_for_dev_stack()
    flush = install_tracer_provider()
    Agent.instrument_all(InstrumentationSettings(include_content=True))

    weather = Agent(
        MODEL,
        name="weather_agent",
        instructions="Answer weather questions with the get_weather tool.",
        tools=[get_weather],
        model_settings=SETTINGS,
    )
    assistant = Agent(
        MODEL,
        name="assistant",
        instructions=(
            "Delegate weather questions to the weather agent with the "
            "ask_weather_agent tool."
        ),
        model_settings=SETTINGS,
    )

    @assistant.tool
    async def ask_weather_agent(ctx: RunContext[None], question: str) -> str:
        """Ask the weather agent a question."""
        result = await weather.run(question, usage=ctx.usage)
        return result.output

    since = run_started()
    result = assistant.run_sync(
        "Ask the weather agent for the weather in Paris, then answer in one "
        "short sentence."
    )
    flush()
    print_result("agent run", True, 0, repr(str(result.output)[:80]))

    verify_subagent_run(
        SubagentRun(
            flavor=FLAVOR,
            framework="pydantic_ai",
            root="assistant",
            root_tool="ask_weather_agent",
            child="weather_agent",
            child_tool="get_weather",
            root_calls=2,
            child_calls=2,
        ),
        since,
    )


if __name__ == "__main__":
    main()
