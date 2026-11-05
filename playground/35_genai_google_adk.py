"""Google ADK over OpenTelemetry: an agent that runs a sub-agent as a
tool lands as a root and a child ``otlp`` session, no sensor involved.

The providers are set up the way ``adk web`` and ``adk api_server`` set
them up, ``maybe_set_otel_providers()``: OTLP/HTTP exporters for the
dev stack's ``/ingest/v1/traces`` and ``/ingest/v1/logs`` from
``OTEL_EXPORTER_OTLP_ENDPOINT``, under a resource holding what
``OTEL_SERVICE_NAME`` and ``OTEL_RESOURCE_ATTRIBUTES`` set. ADK sends
each model call's content as a log record of its own, which the
receiver joins to the call's span. (It exports metrics too, which the
receiver rejects as repeating the spans' usage.)

ADK's default model is Gemini; this script uses OpenAI's
``gpt-4o-mini`` through ADK's LiteLLM wrapper, since the playground has
an OpenAI key and no Google one. ``assistant`` runs ``weather_agent``
through an ``AgentTool``, and ``weather_agent`` calls ``get_weather``:
four model calls. The script then checks the assembled sessions: flavor
``playground-genai-google-adk``, ``client_type=otlp``, the parent/child
link, tokens, both tool calls and the stored content of every call.
ADK records a tool's arguments and result only inside the next model
call's messages, so its tool calls carry no content of their own.

Runs from the Google ADK venv (playground/README.md); exits 2 without
ADK or without ``OPENAI_API_KEY``, and fails when ADK is installed but
does not import (LiteLLM missing, for one).
"""

from __future__ import annotations

import asyncio

from _genai import (
    MODEL_MAX_RETRIES,
    MODEL_TIMEOUT_S,
    SubagentRun,
    configure_exporter,
    run_started,
    skip_if_not_installed,
    verify_subagent_run,
)
from _helpers import print_result, require_env, wait_for_dev_stack

FLAVOR = configure_exporter("google-adk")

try:
    from google.adk.agents import LlmAgent
    from google.adk.models.lite_llm import LiteLlm
    from google.adk.runners import InMemoryRunner
    from google.adk.telemetry.setup import maybe_set_otel_providers
    from google.adk.tools.agent_tool import AgentTool
    from google.genai import types
except ImportError as exc:
    skip_if_not_installed(exc, ("google.adk", "google.genai"))

APP = "playground_genai"
USER = "playground"
MODEL = "openai/gpt-4o-mini"
MAX_TOKENS = 200


def get_weather(city: str) -> str:
    """The current weather in a city."""
    return f"{city}: sunny, 21 C"


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


def flush_providers() -> None:
    """Flush and shut down the global providers ADK set."""
    from opentelemetry import metrics, trace
    from opentelemetry._logs import get_logger_provider

    for provider in (
        trace.get_tracer_provider(),
        get_logger_provider(),
        metrics.get_meter_provider(),
    ):
        for name in ("force_flush", "shutdown"):
            method = getattr(provider, name, None)
            if callable(method):
                method()


def main() -> None:
    require_env("OPENAI_API_KEY")
    wait_for_dev_stack()
    maybe_set_otel_providers()

    # LiteLlm passes these to litellm, which hands them to the OpenAI client.
    model = LiteLlm(
        model=MODEL,
        max_tokens=MAX_TOKENS,
        timeout=MODEL_TIMEOUT_S,
        max_retries=MODEL_MAX_RETRIES,
    )
    weather = LlmAgent(
        name="weather_agent",
        model=model,
        description="Answers weather questions.",
        instruction="Answer weather questions with the get_weather tool.",
        tools=[get_weather],
    )
    assistant = LlmAgent(
        name="assistant",
        model=model,
        instruction="Delegate weather questions to the weather_agent tool.",
        tools=[AgentTool(agent=weather)],
    )

    since = run_started()
    reply = asyncio.run(
        run(
            assistant,
            "Ask the weather agent for the weather in Paris, then answer in one "
            "short sentence.",
        )
    )
    flush_providers()
    print_result("agent run", True, 0, repr(reply[:80]))

    verify_subagent_run(
        SubagentRun(
            flavor=FLAVOR,
            framework="google_adk",
            root="assistant",
            # An AgentTool is named after the agent it runs.
            root_tool="weather_agent",
            child="weather_agent",
            child_tool="get_weather",
            root_calls=2,
            child_calls=2,
            tool_content=False,
        ),
        since,
    )


if __name__ == "__main__":
    main()
