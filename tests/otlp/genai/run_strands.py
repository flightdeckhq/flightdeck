"""One Strands Agents run with its OpenTelemetry tracing on.

    run_strands.py tool|tool-error|subagent

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

from otel_setup import finish, install
from strands import Agent, tool
from strands.models.openai import OpenAIModel
from strands.telemetry import StrandsTelemetry

MODEL = {"model_id": "gpt-4o-mini", "params": {"max_tokens": 200}}


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
    if kind == "tool":
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
        result = agent(prompt)
        outcome, detail = "completed", str(result)[:200]
    except Exception as exc:
        outcome, detail = type(exc).__name__, str(exc)[:200]
    flush()
    finish(outcome, detail=detail)


if __name__ == "__main__":
    main(sys.argv[1])
