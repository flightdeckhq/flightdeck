"""One OpenAI Agents SDK run, traced by OpenTelemetry's OpenAI Agents
instrumentation (opentelemetry-instrumentation-openai-agents-v2).

    run_openai_agents.py tool|tool-error|subagent|handoff|cache|model-error

``cache`` runs one agent twice with long instructions, whose prefix
OpenAI caches by itself; ``model-error`` asks for a model that does not
exist.

The SDK's own trace exporter (to OpenAI's tracing backend) is removed
first, so the run's spans reach only the OTel processor the
instrumentation adds. Content capture is the instrumentation's reading
of ``OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT``, which the
driver sets.
"""

from __future__ import annotations

import sys

from agents import Agent, ModelSettings, Runner, function_tool, set_trace_processors
from opentelemetry import trace
from opentelemetry.instrumentation.openai_agents import OpenAIAgentsInstrumentor
import provider_tap
from otel_setup import cacheable_instructions, finish, install

MODEL = "gpt-4o-mini"
SETTINGS = ModelSettings(max_tokens=200)
# Over the 1024-token prefix OpenAI caches automatically.
CACHE_LINES = 100
MISSING_MODEL = "gpt-fd-does-not-exist"


@function_tool
def get_weather(city: str) -> str:
    """The current weather in a city."""
    return f"{city}: sunny, 21 C"


@function_tool
def lookup_order(order_id: str) -> str:
    """Look up an order by its id."""
    raise ValueError(f"order {order_id} not found")


def main(kind: str) -> None:
    provider_tap.install()
    flush = install()
    set_trace_processors([])
    OpenAIAgentsInstrumentor().instrument(tracer_provider=trace.get_tracer_provider())
    weather = Agent(
        name="weather_agent",
        handoff_description="Answers weather questions.",
        instructions="Answer weather questions with the get_weather tool.",
        tools=[get_weather],
        model=MODEL,
        model_settings=SETTINGS,
    )
    runs = 1
    if kind == "cache":
        agent = Agent(
            name="cached_agent",
            instructions=cacheable_instructions(CACHE_LINES),
            model=MODEL,
            # Without a cache key the Responses API served neither of two
            # back-to-back calls from its cache in four tries; with one it
            # routes both to the same cache.
            model_settings=ModelSettings(
                max_tokens=20, extra_args={"prompt_cache_key": "fd-genai-capture"}
            ),
        )
        prompt, runs = "Reply with the word ready.", 2
    elif kind == "model-error":
        agent = Agent(
            name="missing_model_agent", model=MISSING_MODEL, model_settings=SETTINGS
        )
        prompt = "Reply with one word."
    elif kind == "tool":
        agent, prompt = (
            weather,
            "What is the weather in Paris? Use the tool, then answer in one short sentence.",
        )
    elif kind == "tool-error":
        agent = Agent(
            name="orders_agent",
            instructions="Answer order questions with the lookup_order tool.",
            tools=[lookup_order],
            model=MODEL,
            model_settings=SETTINGS,
        )
        prompt = "Look up order 42 with the tool and report the result in one sentence."
    elif kind == "subagent":
        agent = Agent(
            name="assistant",
            instructions="Delegate weather questions to the weather agent with the ask_weather_agent tool.",
            tools=[
                weather.as_tool(
                    tool_name="ask_weather_agent",
                    tool_description="Ask the weather agent a question.",
                )
            ],
            model=MODEL,
            model_settings=SETTINGS,
        )
        prompt = "Ask the weather agent for the weather in Paris, then answer in one short sentence."
    else:
        agent = Agent(
            name="triage_agent",
            instructions="Hand weather questions off to the weather agent.",
            handoffs=[weather],
            model=MODEL,
            model_settings=SETTINGS,
        )
        prompt = "What is the weather in Paris? Answer in one short sentence."
    try:
        for _ in range(runs):
            result = Runner.run_sync(agent, prompt)
        outcome, detail = "completed", str(result.final_output)[:200]
    except Exception as exc:
        outcome, detail = type(exc).__name__, str(exc)[:200]
    flush()
    finish(outcome, detail=detail)


if __name__ == "__main__":
    main(sys.argv[1])
