"""One Google ADK run with ADK's OpenTelemetry tracing on.

    run_adk.py tool|tool-error|subagent|handoff|cache|model-error

``cache`` runs one agent in two sessions with a long instruction, whose
prefix OpenAI caches by itself; ``model-error`` asks for a model that
does not exist.

The providers are set up the way ``adk web`` and ``adk api_server`` set
them up, ``maybe_set_otel_providers()``: OTLP/HTTP protobuf exporters
for traces, metrics and logs from ``OTEL_EXPORTER_OTLP_ENDPOINT``, under
a resource holding only what ``OTEL_SERVICE_NAME`` and
``OTEL_RESOURCE_ATTRIBUTES`` set. The model is OpenAI's, through ADK's
LiteLLM wrapper. Content capture is ADK's reading of
``OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`` (and of
``ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS``), which the driver sets.
"""

from __future__ import annotations

import asyncio
import sys

from google.adk.agents import LlmAgent
from google.adk.models.lite_llm import LiteLlm
from google.adk.runners import InMemoryRunner
from google.adk.telemetry.setup import maybe_set_otel_providers
from google.adk.tools.agent_tool import AgentTool
from google.genai import types
import provider_tap
from otel_setup import cacheable_instructions, finish, flush_globals

APP = "fd_capture"
USER = "user"
# Over the 1024-token prefix OpenAI caches automatically.
CACHE_LINES = 100
MISSING_MODEL = "gpt-fd-does-not-exist"


def get_weather(city: str) -> str:
    """The current weather in a city."""
    return f"{city}: sunny, 21 C"


def lookup_order(order_id: str) -> str:
    """Look up an order by its id."""
    raise ValueError(f"order {order_id} not found")


async def run(agent: LlmAgent, prompt: str) -> str:
    runner = InMemoryRunner(agent=agent, app_name=APP)
    session = await runner.session_service.create_session(app_name=APP, user_id=USER)
    message = types.Content(role="user", parts=[types.Part(text=prompt)])
    final = ""
    async for event in runner.run_async(
        user_id=USER, session_id=session.id, new_message=message
    ):
        if event.is_final_response() and event.content and event.content.parts:
            final = "".join(p.text or "" for p in event.content.parts)
    return final


def main(kind: str) -> None:
    import litellm

    # LiteLLM sends over aiohttp unless told otherwise; over httpx,
    # provider_tap sees what the provider answered. Telemetry is the same.
    litellm.disable_aiohttp_transport = True
    provider_tap.install()
    maybe_set_otel_providers()
    model = LiteLlm(model="openai/gpt-4o-mini", max_tokens=200)
    weather = LlmAgent(
        name="weather_agent",
        model=model,
        description="Answers weather questions.",
        instruction="Answer weather questions with the get_weather tool.",
        tools=[get_weather],
    )
    runs = 1
    if kind == "cache":
        # Each run is a session of its own, so both calls send the same
        # prefix and nothing of the first conversation.
        agent = LlmAgent(
            name="cached_agent",
            model=LiteLlm(model="openai/gpt-4o-mini", max_tokens=20),
            instruction=cacheable_instructions(CACHE_LINES),
        )
        prompt, runs = "Reply with the word ready.", 2
    elif kind == "model-error":
        agent = LlmAgent(
            name="missing_model_agent",
            model=LiteLlm(model=f"openai/{MISSING_MODEL}", max_tokens=20),
        )
        prompt = "Reply with one word."
    elif kind == "tool":
        agent, prompt = (
            weather,
            "What is the weather in Paris? Use the tool, then answer in one short sentence.",
        )
    elif kind == "tool-error":
        agent = LlmAgent(
            name="orders_agent",
            model=model,
            instruction="Answer order questions with the lookup_order tool.",
            tools=[lookup_order],
        )
        prompt = "Look up order 42 with the tool and report the result in one sentence."
    elif kind == "subagent":
        agent = LlmAgent(
            name="assistant",
            model=model,
            instruction="Delegate weather questions to the weather_agent tool.",
            tools=[AgentTool(agent=weather)],
        )
        prompt = "Ask the weather agent for the weather in Paris, then answer in one short sentence."
    else:
        agent = LlmAgent(
            name="triage_agent",
            model=model,
            instruction="Transfer weather questions to weather_agent.",
            sub_agents=[weather],
        )
        prompt = "What is the weather in Paris? Answer in one short sentence."

    async def run_all() -> str:
        # One event loop for every run: LiteLLM keeps its clients per loop.
        reply = ""
        for _ in range(runs):
            reply = await run(agent, prompt)
        return reply

    try:
        outcome, detail = "completed", asyncio.run(run_all())[:200]
    except Exception as exc:
        outcome, detail = type(exc).__name__, str(exc)[:200]
    flush_globals()
    finish(outcome, detail=detail)


if __name__ == "__main__":
    main(sys.argv[1])
