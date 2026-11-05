"""Strands Agents over OpenTelemetry: an agent that runs a sub-agent as
a tool lands as a root and a child ``otlp`` session, no sensor involved.

Tracing is set up the way Strands documents it: ``StrandsTelemetry()``
and its ``setup_otlp_exporter()``, which exports to the dev stack's
``/ingest/v1/traces`` under Strands' resource (``OTEL_RESOURCE_ATTRIBUTES``
adds the ``flightdeck.*`` attributes). Strands' default provider is
Amazon Bedrock; this script uses its OpenAI provider with
``gpt-4o-mini``, since the playground has an OpenAI key and no AWS
credentials. ``assistant`` calls ``ask_weather_agent``
(``weather_agent.as_tool``), which calls ``get_weather``: four model
calls. The script then checks the assembled sessions: flavor
``playground-genai-strands``, ``client_type=otlp``, the parent/child
link, tokens, both tool calls and the stored content of every call.

Runs from the GenAI venv (playground/README.md); exits 2 without Strands
or ``OPENAI_API_KEY``.
"""

from __future__ import annotations

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

FLAVOR = configure_exporter("strands")

try:
    from strands import Agent, tool
    from strands.models.openai import OpenAIModel
    from strands.telemetry import StrandsTelemetry
except ImportError as exc:
    skip_if_not_installed(exc, ("strands",))

MODEL_ID = "gpt-4o-mini"
PARAMS = {"max_tokens": 200}


@tool
def get_weather(city: str) -> str:
    """The current weather in a city.

    Args:
        city: The city to look up.
    """
    return f"{city}: sunny, 21 C"


def main() -> None:
    require_env("OPENAI_API_KEY")
    wait_for_dev_stack()
    telemetry = StrandsTelemetry()
    telemetry.setup_otlp_exporter()

    model = OpenAIModel(
        client_args={"timeout": MODEL_TIMEOUT_S, "max_retries": MODEL_MAX_RETRIES},
        model_id=MODEL_ID,
        params=PARAMS,
    )
    weather = Agent(
        model=model,
        name="weather_agent",
        description="Answers weather questions.",
        system_prompt="Answer weather questions with the get_weather tool.",
        tools=[get_weather],
        callback_handler=None,
    )
    assistant = Agent(
        model=model,
        name="assistant",
        system_prompt=(
            "Delegate weather questions to the weather agent with the "
            "ask_weather_agent tool."
        ),
        tools=[
            weather.as_tool(
                name="ask_weather_agent",
                description="Ask the weather agent a question.",
            )
        ],
        callback_handler=None,
    )

    since = run_started()
    result = assistant(
        "Ask the weather agent for the weather in Paris, then answer in one "
        "short sentence."
    )
    telemetry.tracer_provider.force_flush()
    telemetry.tracer_provider.shutdown()
    print_result("agent run", True, 0, repr(str(result)[:80]))

    verify_subagent_run(
        SubagentRun(
            flavor=FLAVOR,
            framework="strands",
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
