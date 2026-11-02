"""Record OpenTelemetry GenAI exports of agent frameworks as test fixtures.

Runs each scenario's framework runner (tests/otlp/genai/run_*.py) with
its OTLP exporters pointed at a local recorder (recorder.py), then
writes the requests, scrubbed, to
``tests/fixtures/otlp/<framework>-<version>/<scenario>/`` with a
``manifest.json`` naming the files in the order they arrived and what
the run was recorded with.

The runners make real model calls (OpenAI's gpt-4o-mini, Anthropic's
claude-haiku-4-5, a few short calls each) with the provider keys in the
environment, so this is run by hand, never in CI. Each framework needs
its own venv, from requirements-genai.txt (Pydantic AI, Strands Agents,
the OpenAI Agents SDK) and requirements-genai-adk.txt (Google ADK), and
this driver runs in the first:

    python tests/otlp/record_genai.py [scenario-or-framework ...]

``FD_GENAI_PYTHON`` and ``FD_GENAI_ADK_PYTHON`` name the two venvs'
interpreters (default: ``~/.cache/fd-genai-capture-venv`` and
``~/.cache/fd-genai-capture-adk-venv``). Named scenarios (``pydantic-ai/
tool-protobuf``) or frameworks (``strands``) are recorded alone, replacing
their directories; with no names every scenario is recorded.

A scenario states what its spans must name (its tools, its agents); a
run whose model did not do that is not written, run it again.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from recorder import REPO, Recorder, json_value, scrubber, write_scenario  # noqa: E402

FIXTURES = REPO / "tests" / "fixtures" / "otlp"
RUNNERS = Path(__file__).resolve().parent / "genai"
RESULT_MARKER = "FD_GENAI_CAPTURE_RESULT "
# A scenario is a few model calls; this bounds a stuck one.
SCENARIO_TIMEOUT_SECS = 240
# The runners flush every provider before they exit; a recording is
# complete once no request has arrived for this long.
QUIET_SECS = 2.0
QUIET_DEADLINE_SECS = 20.0

_HOME = Path.home()
PYTHON = os.environ.get(
    "FD_GENAI_PYTHON", str(_HOME / ".cache/fd-genai-capture-venv/bin/python")
)
ADK_PYTHON = os.environ.get(
    "FD_GENAI_ADK_PYTHON", str(_HOME / ".cache/fd-genai-capture-adk-venv/bin/python")
)

CONTENT_ON = {"OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT": "true"}
CONTENT_OFF = {"OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT": "false"}
STRANDS_LATEST = {"OTEL_SEMCONV_STABILITY_OPT_IN": "gen_ai_latest_experimental"}
# Strands redacts every content attribute when the opt-in names an empty
# list of attributes to leave unredacted.
STRANDS_REDACTED = {
    "OTEL_SEMCONV_STABILITY_OPT_IN": "gen_ai_latest_experimental,gen_ai_unredacted_attributes="
}
# ADK's content off sets the OTel switch and ADK's own switch for its
# legacy spans (on by default) together: its recording does not isolate
# what the OTel switch does alone.
ADK_CONTENT_OFF = {
    **CONTENT_OFF,
    "ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS": "false",
}

FRAMEWORKS: dict[str, dict[str, Any]] = {
    "pydantic-ai": {
        "package": "pydantic-ai-slim",
        "runner": "run_pydantic_ai.py",
        "python": PYTHON,
        "instrumentation": "built in (Agent.instrument_all, InstrumentationSettings version 5)",
        "model": "anthropic claude-haiku-4-5",
    },
    "strands-agents": {
        "package": "strands-agents",
        "runner": "run_strands.py",
        "python": PYTHON,
        "instrumentation": "built in (StrandsTelemetry)",
        "model": "openai gpt-4o-mini",
    },
    "openai-agents": {
        "package": "openai-agents",
        "runner": "run_openai_agents.py",
        "python": PYTHON,
        "instrumentation": "opentelemetry-instrumentation-openai-agents-v2 (OpenTelemetry contrib)",
        "model": "openai gpt-4o-mini",
    },
    "google-adk": {
        "package": "google-adk",
        "runner": "run_adk.py",
        "python": ADK_PYTHON,
        "instrumentation": "built in (maybe_set_otel_providers, telemetry schema 2)",
        "model": "openai gpt-4o-mini through LiteLLM",
    },
}

# What a scenario's spans must show: an execute_tool span for each tool
# and an invoke_agent span for each agent.
TOOL = ["get_weather"]
ERROR = ["lookup_order"]
SUBAGENTS = ["assistant", "weather_agent"]
HANDOFF = ["triage_agent", "weather_agent"]

SCENARIOS: list[dict[str, Any]] = [
    # Pydantic AI: content is its own InstrumentationSettings switch.
    {
        "framework": "pydantic-ai",
        "name": "tool-protobuf",
        "about": "one agent run: a model call, a get_weather tool call, a final model call; content on",
        "args": ["tool"],
        "expect": {"tools": TOOL},
    },
    {
        "framework": "pydantic-ai",
        "name": "tool-json",
        "about": "the same run over http/json",
        "args": ["tool"],
        "protocol": "http/json",
        "expect": {"tools": TOOL},
    },
    {
        "framework": "pydantic-ai",
        "name": "tool-no-content-protobuf",
        "about": "the same run with InstrumentationSettings(include_content=False)",
        "args": ["tool", "--no-content"],
        "expect": {"tools": TOOL},
    },
    {
        "framework": "pydantic-ai",
        "name": "tool-error-protobuf",
        "about": "a tool that raises ValueError, which ends the run",
        "args": ["tool-error"],
        "expect": {"tools": ERROR},
        "outcome": "ValueError",
    },
    {
        "framework": "pydantic-ai",
        "name": "subagent-protobuf",
        "about": "an agent whose tool runs a second agent (agent delegation), which calls get_weather",
        "args": ["subagent"],
        "expect": {"tools": ["ask_weather_agent", *TOOL], "agents": SUBAGENTS},
    },
    # Strands: conventions and content from OTEL_SEMCONV_STABILITY_OPT_IN.
    {
        "framework": "strands-agents",
        "name": "tool-protobuf",
        "about": "one agent run with a get_weather tool call, default conventions (content in span events)",
        "args": ["tool"],
        "expect": {"tools": TOOL},
    },
    {
        "framework": "strands-agents",
        "name": "tool-latest-json",
        "about": "the same run under gen_ai_latest_experimental, over http/json",
        "args": ["tool"],
        "env": STRANDS_LATEST,
        "protocol": "http/json",
        "expect": {"tools": TOOL},
    },
    {
        "framework": "strands-agents",
        "name": "tool-redacted-protobuf",
        "about": "the same run under gen_ai_latest_experimental with every content attribute redacted",
        "args": ["tool"],
        "env": STRANDS_REDACTED,
        "expect": {"tools": TOOL},
    },
    {
        "framework": "strands-agents",
        "name": "tool-error-protobuf",
        "about": "a tool that raises ValueError; Strands returns the error to the model",
        "args": ["tool-error"],
        "expect": {"tools": ERROR},
    },
    {
        "framework": "strands-agents",
        "name": "subagent-protobuf",
        "about": "an agent whose tool is a second agent (Agent.as_tool), which calls get_weather",
        "args": ["subagent"],
        "expect": {"tools": ["ask_weather_agent", *TOOL], "agents": SUBAGENTS},
    },
    # OpenAI Agents SDK: content from OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT.
    {
        "framework": "openai-agents",
        "name": "tool-protobuf",
        "about": "one agent run with a get_weather tool call; content on",
        "args": ["tool"],
        "env": CONTENT_ON,
        "expect": {"tools": TOOL},
    },
    {
        "framework": "openai-agents",
        "name": "tool-json",
        "about": "the same run over http/json",
        "args": ["tool"],
        "env": CONTENT_ON,
        "protocol": "http/json",
        "expect": {"tools": TOOL},
    },
    {
        "framework": "openai-agents",
        "name": "tool-no-content-protobuf",
        "about": "the same run with OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=false",
        "args": ["tool"],
        "env": CONTENT_OFF,
        "expect": {"tools": TOOL},
    },
    {
        "framework": "openai-agents",
        "name": "tool-error-protobuf",
        "about": "a tool that raises ValueError; the SDK returns the error to the model",
        "args": ["tool-error"],
        "env": CONTENT_ON,
        "expect": {"tools": ERROR},
    },
    {
        "framework": "openai-agents",
        "name": "subagent-protobuf",
        "about": "an agent whose tool is a second agent (Agent.as_tool), which calls get_weather",
        "args": ["subagent"],
        "env": CONTENT_ON,
        "expect": {"tools": ["ask_weather_agent", *TOOL], "agents": SUBAGENTS},
    },
    {
        "framework": "openai-agents",
        "name": "handoff-protobuf",
        "about": "a triage agent that hands off to the weather agent, which calls get_weather",
        "args": ["handoff"],
        "env": CONTENT_ON,
        "expect": {"tools": TOOL, "agents": HANDOFF},
    },
    # Google ADK: content from OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT.
    {
        "framework": "google-adk",
        "name": "tool-protobuf",
        "about": "one agent run with a get_weather tool call; content on (=true)",
        "args": ["tool"],
        "env": CONTENT_ON,
        "expect": {"tools": TOOL},
    },
    {
        "framework": "google-adk",
        "name": "tool-no-content-protobuf",
        "about": "the same run with content capture off",
        "args": ["tool"],
        "env": ADK_CONTENT_OFF,
        "expect": {"tools": TOOL},
    },
    {
        "framework": "google-adk",
        "name": "tool-error-protobuf",
        "about": "a tool that raises ValueError, which ends the run",
        "args": ["tool-error"],
        "env": CONTENT_ON,
        "expect": {"tools": ERROR},
        "outcome": "ValueError",
    },
    {
        "framework": "google-adk",
        "name": "subagent-protobuf",
        "about": "an agent whose tool is a second agent (AgentTool), which calls get_weather",
        "args": ["subagent"],
        "env": CONTENT_ON,
        "expect": {"tools": ["weather_agent", *TOOL], "agents": SUBAGENTS},
    },
    {
        "framework": "google-adk",
        "name": "handoff-protobuf",
        "about": "a triage agent that transfers to its sub-agent (transfer_to_agent), which calls get_weather",
        "args": ["handoff"],
        "env": CONTENT_ON,
        "expect": {"tools": ["transfer_to_agent", *TOOL], "agents": HANDOFF},
    },
]


def trace_spans(requests: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Every span of a recording's trace exports, as OTLP JSON objects."""
    from google.protobuf.json_format import MessageToDict
    from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import (
        ExportTraceServiceRequest,
    )

    out = []
    for req in requests:
        if req["path"] != "/v1/traces":
            continue
        if req["content_type"] == "application/json":
            doc = json.loads(req["body"])
        else:
            msg = ExportTraceServiceRequest()
            msg.ParseFromString(req["body"])
            doc = MessageToDict(msg)
        out.extend(
            span
            for rs in doc.get("resourceSpans", [])
            for ss in rs.get("scopeSpans", [])
            for span in ss.get("spans", [])
        )
    return out


def _operations(spans: list[dict[str, Any]], operation: str, key: str) -> set[str]:
    """What the spans of one GenAI operation name, by their attribute
    (``gen_ai.tool.name``, ``gen_ai.agent.name``) or the ``<operation>
    <name>`` span name the conventions give them."""
    out = set()
    for span in spans:
        attrs = {
            a["key"]: json_value(a.get("value")) for a in span.get("attributes", [])
        }
        name = span.get("name", "")
        if attrs.get("gen_ai.operation.name") == operation or name.startswith(
            f"{operation} "
        ):
            if attrs.get(key):
                out.add(str(attrs[key]))
            if name.startswith(f"{operation} "):
                out.add(name[len(operation) + 1 :])
    return out


def _missing(spans: list[dict[str, Any]], expect: dict[str, list[str]]) -> list[str]:
    """The tools with no execute_tool span and the agents with no
    invoke_agent span."""
    tools = _operations(spans, "execute_tool", "gen_ai.tool.name")
    agents = _operations(spans, "invoke_agent", "gen_ai.agent.name")
    return [f"tool {t}" for t in expect.get("tools", []) if t not in tools] + [
        f"agent {a}" for a in expect.get("agents", []) if a not in agents
    ]


def _redact(text: str, secrets: list[str]) -> str:
    for secret in secrets:
        text = text.replace(secret, "<secret>")
    return text


def _record(scenario: dict[str, Any]) -> Path:
    from recorder import secret_values

    framework = FRAMEWORKS[scenario["framework"]]
    protocol = scenario.get("protocol", "http/protobuf")
    rec = Recorder()
    rec.start()
    work = Path(tempfile.mkdtemp(prefix="fd-otlp-genai-"))
    try:
        # Nothing of Flightdeck, of an OTel setup, or of a Claude Code
        # session the recorder runs inside reaches the run.
        env = {
            k: v
            for k, v in os.environ.items()
            if not k.startswith(("FLIGHTDECK_", "OTEL_", "CLAUDE_CODE_"))
        }
        env.update(
            {
                "OTEL_EXPORTER_OTLP_ENDPOINT": rec.endpoint,
                "OTEL_EXPORTER_OTLP_PROTOCOL": protocol,
                "PYTHONDONTWRITEBYTECODE": "1",
                # LiteLLM (ADK's model wrapper): the bundled price map, no
                # fetch, no telemetry of its own.
                "LITELLM_LOCAL_MODEL_COST_MAP": "True",
                "LITELLM_TELEMETRY": "False",
            }
        )
        env.update(scenario.get("env", {}))
        run = subprocess.run(
            [
                framework["python"],
                str(RUNNERS / framework["runner"]),
                *scenario["args"],
            ],
            cwd=work,
            env=env,
            capture_output=True,
            text=True,
            timeout=SCENARIO_TIMEOUT_SECS,
            stdin=subprocess.DEVNULL,
            check=False,
        )
        secrets = secret_values()
        results = [
            json.loads(line[len(RESULT_MARKER) :])
            for line in run.stdout.splitlines()
            if line.startswith(RESULT_MARKER)
        ]
        if run.returncode != 0 or not results:
            tail = _redact((run.stderr or run.stdout)[-3000:], secrets)
            raise SystemExit(
                f"{scenario['framework']}/{scenario['name']} failed ({run.returncode}): {tail}"
            )
        result = results[-1]
        if result["outcome"] != scenario.get("outcome", "completed"):
            raise SystemExit(
                f"{scenario['framework']}/{scenario['name']} not written: the run ended with {result['outcome']}: {_redact(result.get('detail', ''), secrets)}"
            )
        rec.wait_quiet(QUIET_SECS, QUIET_DEADLINE_SECS)
        missing = _missing(trace_spans(rec.requests), scenario["expect"])
        if missing:
            raise SystemExit(
                f"{scenario['framework']}/{scenario['name']} not written: no span for {missing}; the model did not do what the scenario needs, run it again"
            )
        version = result["versions"][framework["package"]]
        out_dir = FIXTURES / f"{scenario['framework']}-{version}" / scenario["name"]
        shutil.rmtree(out_dir, ignore_errors=True)
        write_scenario(
            rec.requests,
            out_dir,
            {
                "scenario": scenario["name"],
                "about": scenario["about"],
                "framework": scenario["framework"],
                "instrumentation": framework["instrumentation"],
                "model": framework["model"],
                "protocol": protocol,
                "env": scenario.get("env", {}),
                "runner_args": scenario["args"],
                "outcome": result["outcome"],
                "versions": result["versions"],
            },
            scrubber(work, framework["python"]),
        )
        return out_dir
    finally:
        rec.shutdown()
        shutil.rmtree(work, ignore_errors=True)


def main(names: list[str]) -> None:
    """Record the named scenarios or frameworks, or every scenario."""
    chosen = [
        s
        for s in SCENARIOS
        if not names
        or s["framework"] in names
        or f"{s['framework']}/{s['name']}" in names
    ]
    known = set(FRAMEWORKS) | {f"{s['framework']}/{s['name']}" for s in SCENARIOS}
    unknown = sorted(set(names) - known)
    if unknown:
        raise SystemExit(f"unknown scenarios {unknown}; known: {sorted(known)}")
    for scenario in chosen:
        out_dir = _record(scenario)
        count = len(json.loads((out_dir / "manifest.json").read_text())["requests"])
        print(f"recorded {out_dir.relative_to(FIXTURES)}: {count} requests")


if __name__ == "__main__":
    main(sys.argv[1:])
