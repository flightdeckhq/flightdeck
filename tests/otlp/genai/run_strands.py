"""One Strands Agents run with its OpenTelemetry tracing on.

    run_strands.py tool|tool-error|subagent|cache|model-error

``cache`` runs two agents with the same long system prompt, whose prefix
OpenAI caches by itself; ``model-error`` asks for a model that does not
exist.

Tracing is set up as Strands documents it, ``StrandsTelemetry()``, whose
tracer provider carries Strands' resource (``service.name`` from
``OTEL_SERVICE_NAME``, else ``strands-agents``); otel_setup adds the
OTLP exporter in the recorder's encoding, which is what
``setup_otlp_exporter()`` adds for http/protobuf. Strands' conventions
and content come from ``OTEL_SEMCONV_STABILITY_OPT_IN``
(``gen_ai_latest_experimental`` for the latest GenAI conventions,
``gen_ai_unredacted_attributes=`` to redact every content attribute),
which the driver sets.
"""

from __future__ import annotations

import sys

import provider_tap
from otel_setup import cacheable_instructions, finish, install
from strands import Agent, tool
from strands.models.openai import OpenAIModel
from strands.telemetry import StrandsTelemetry

MODEL = {"model_id": "gpt-4o-mini", "params": {"max_tokens": 200}}
# Over the 1024-token prefix OpenAI caches automatically.
CACHE_LINES = 100
MISSING_MODEL = "gpt-fd-does-not-exist"


@tool
def get_weather(city: str) -> str:
    """The current weather in a city.

    Args:
        city: The city to look up.
    """
    return f"{city}: sunny, 21 C"


@tool
def lookup_order(order_id: str) -> str:
    """Look up an order by its id.

    Args:
        order_id: The order id.
    """
    raise ValueError(f"order {order_id} not found")


def main(kind: str) -> None:
    provider_tap.install()
    telemetry = StrandsTelemetry()
    flush = install(
        resource=telemetry.resource, tracer_provider=telemetry.tracer_provider
    )
    model = OpenAIModel(**MODEL)
    weather = Agent(
        model=model,
        name="weather_agent",
        description="Answers weather questions.",
        system_prompt="Answer weather questions with the get_weather tool.",
        tools=[get_weather],
        callback_handler=None,
    )
    agents: list[Agent] = []
    if kind == "cache":
        # Two fresh agents, so both calls send the same prefix and nothing
        # of the first conversation.
        agents = [
            Agent(
                model=OpenAIModel(
                    model_id=MODEL["model_id"], params={"max_tokens": 20}
                ),
                name="cached_agent",
                system_prompt=cacheable_instructions(CACHE_LINES),
                callback_handler=None,
            )
            for _ in range(2)
        ]
        prompt = "Reply with the word ready."
    elif kind == "model-error":
        agent = Agent(
            model=OpenAIModel(model_id=MISSING_MODEL, params={"max_tokens": 20}),
            name="missing_model_agent",
            callback_handler=None,
        )
        prompt = "Reply with one word."
    elif kind == "tool":
        agent, prompt = (
            weather,
            "What is the weather in Paris? Use the tool, then answer in one short sentence.",
        )
    elif kind == "tool-error":
        agent = Agent(
            model=model,
            name="orders_agent",
            system_prompt="Answer order questions with the lookup_order tool.",
            tools=[lookup_order],
            callback_handler=None,
        )
        prompt = "Look up order 42 with the tool and report the result in one sentence."
    else:
        agent = Agent(
            model=model,
            name="assistant",
            system_prompt="Delegate weather questions to the weather agent with the ask_weather_agent tool.",
            tools=[
                weather.as_tool(
                    name="ask_weather_agent",
                    description="Ask the weather agent a question.",
                )
            ],
            callback_handler=None,
        )
        prompt = "Ask the weather agent for the weather in Paris, then answer in one short sentence."
    try:
        for each in agents or [agent]:
            result = each(prompt)
        outcome, detail = "completed", str(result)[:200]
    except Exception as exc:
        outcome, detail = type(exc).__name__, str(exc)[:200]
    flush()
    finish(outcome, detail=detail)


if __name__ == "__main__":
    main(sys.argv[1])
