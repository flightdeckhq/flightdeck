"""One Pydantic AI agent run with its OpenTelemetry instrumentation on.

    run_pydantic_ai.py tool|tool-error|subagent|cache|model-error [--no-content]

Pydantic AI records through the global providers otel_setup installs
(it sets no resource of its own); ``--no-content`` is its own switch,
``InstrumentationSettings(include_content=False)``. ``cache`` runs one
agent twice with long instructions marked for Anthropic's prompt cache
(``anthropic_cache_instructions``), so the second call reads what the
first wrote; ``model-error`` asks for a model that does not exist.
"""

from __future__ import annotations

import sys

import provider_tap
from otel_setup import cacheable_instructions, finish, install
from pydantic_ai import Agent, RunContext
from pydantic_ai.models.instrumented import InstrumentationSettings

MODEL = "anthropic:claude-haiku-4-5"
SETTINGS = {"max_tokens": 200}
# Over the 4096-token minimum Anthropic caches for Claude Haiku 4.5.
CACHE_LINES = 300
MISSING_MODEL = "anthropic:claude-fd-does-not-exist"


def get_weather(city: str) -> str:
    """The current weather in a city."""
    return f"{city}: sunny, 21 C"


def lookup_order(order_id: str) -> str:
    """Look up an order by its id."""
    raise ValueError(f"order {order_id} not found")


def main(kind: str, include_content: bool) -> None:
    provider_tap.install()
    flush = install()
    Agent.instrument_all(InstrumentationSettings(include_content=include_content))
    weather = Agent(
        MODEL,
        name="weather_agent",
        instructions="Answer weather questions with the get_weather tool.",
        tools=[get_weather],
        model_settings=SETTINGS,
    )
    runs = 1
    if kind == "cache":
        agent = Agent(
            MODEL,
            name="cached_agent",
            instructions=cacheable_instructions(CACHE_LINES),
            model_settings={"max_tokens": 20, "anthropic_cache_instructions": True},
        )
        prompt, runs = "Reply with the word ready.", 2
    elif kind == "model-error":
        agent = Agent(
            MISSING_MODEL, name="missing_model_agent", model_settings=SETTINGS
        )
        prompt = "Reply with one word."
    elif kind == "tool":
        agent, prompt = (
            weather,
            "What is the weather in Paris? Use the tool, then answer in one short sentence.",
        )
    elif kind == "tool-error":
        agent = Agent(
            MODEL,
            name="orders_agent",
            instructions="Answer order questions with the lookup_order tool.",
            tools=[lookup_order],
            model_settings=SETTINGS,
        )
        prompt = "Look up order 42 with the tool and report the result in one sentence."
    else:
        agent = Agent(
            MODEL,
            name="assistant",
            instructions="Delegate weather questions to the weather agent with the ask_weather_agent tool.",
            model_settings=SETTINGS,
        )

        @agent.tool
        async def ask_weather_agent(ctx: RunContext[None], question: str) -> str:
            """Ask the weather agent a question."""
            result = await weather.run(question, usage=ctx.usage)
            return result.output

        prompt = "Ask the weather agent for the weather in Paris, then answer in one short sentence."
    try:
        for _ in range(runs):
            result = agent.run_sync(prompt)
        outcome, detail = "completed", str(result.output)[:200]
    except Exception as exc:  # the tool error ends the run
        outcome, detail = type(exc).__name__, str(exc)[:200]
    flush()
    finish(outcome, detail=detail)


if __name__ == "__main__":
    main(sys.argv[1], "--no-content" not in sys.argv[2:])
