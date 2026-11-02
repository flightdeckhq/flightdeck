"""Record Claude Code's OTLP export as test fixtures.

Runs a few ``claude -p`` scenarios with Claude Code's telemetry pointed
at a local OTLP/HTTP recorder, then writes each request, filtered and
scrubbed, to ``tests/fixtures/otlp/claude-code-<version>/<scenario>/``
with a ``manifest.json`` naming the files in the order they arrived.

Each scenario makes real model calls on whatever login the CLI picks, so
run it by hand when Claude Code changes, never in CI. Unset
ANTHROPIC_API_KEY first to record on a Claude login. User settings are
not loaded (``--setting-sources project``), so no plugin of yours runs.

Needs a Python with ``opentelemetry-proto`` (protobuf requests are
filtered through it) and, for the MCP scenario, the ``mcp`` package:

    python tests/otlp/record_claude_code.py

Name scenarios to record only those, replacing their directories and
leaving the others as they are:

    python tests/otlp/record_claude_code.py subagent-resume-json

A scenario that depends on what the model chooses to do (resuming a
sub-agent) states what its recording must show, and is not written when
the run did not do it; run it again.

What reaches a fixture (recorder.py does the cleaning):
- Log records Flightdeck never maps and that describe the recording
  machine (managed settings, bundled plugins, the user's claude.ai
  connector connections) are dropped.
- Identity attributes (``user.email``, ``user.account_uuid``,
  ``user.account_id``, ``user.id``, ``organization.id``) are replaced by
  fixed placeholders, and machine paths by ``/home/user`` stand-ins.
- JSON requests stay JSON; protobuf requests are stored uncompressed,
  with the encoding they were sent in recorded in the manifest.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

# The checker owns the placeholders, so what the recorder writes and what
# the test accepts cannot drift apart; both modules sit next to this one.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from fixture_checks import DROPPED_EVENTS  # noqa: E402
from recorder import REPO, Recorder, json_value, scrubber, write_scenario  # noqa: E402

FIXTURES = REPO / "tests" / "fixtures" / "otlp"
MODEL = "claude-haiku-4-5"
# A scenario is a few model turns; this bounds a stuck one.
SCENARIO_TIMEOUT_SECS = 240
# The exporters flush every second (see BASE_ENV) and once more at exit;
# a recording is complete once no request has arrived for this long.
QUIET_SECS = 4.0
QUIET_DEADLINE_SECS = 30.0

BASE_ENV = {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "OTEL_LOGS_EXPORTER": "otlp",
    "OTEL_METRICS_EXPORTER": "otlp",
    "OTEL_TRACES_EXPORTER": "otlp",
    "CLAUDE_CODE_ENHANCED_TELEMETRY_BETA": "1",
    "OTEL_LOGS_EXPORT_INTERVAL": "1000",
    "OTEL_METRIC_EXPORT_INTERVAL": "1000",
    "OTEL_TRACES_EXPORT_INTERVAL": "1000",
    "OTEL_LOG_TOOL_DETAILS": "1",
}

PYTHON = os.environ.get("FD_RECORD_PYTHON", sys.executable)


def _mcp_config(work: Path) -> list[str]:
    config = work / "mcp.json"
    config.write_text(
        json.dumps(
            {
                "mcpServers": {
                    "flightdeck-mcp-reference": {
                        "command": PYTHON,
                        "args": ["-m", "playground._mcp_reference_server"],
                        "env": {"PYTHONPATH": str(REPO)},
                    }
                }
            }
        )
    )
    return [
        "--mcp-config",
        str(config),
        "--allowedTools",
        "mcp__flightdeck-mcp-reference__echo",
    ]


def _log_records(docs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The attributes of every log record of a scenario's JSON log
    requests, in the order Claude Code emitted them (event.sequence)."""
    records = [
        {a["key"]: json_value(a.get("value")) for a in rec.get("attributes", [])}
        for doc in docs
        for rl in doc.get("resourceLogs", [])
        for sl in rl.get("scopeLogs", [])
        for rec in sl.get("logRecords", [])
    ]
    return sorted(records, key=lambda r: int(r.get("event.sequence") or 0))


def _subagent_resumed(records: list[dict[str, Any]]) -> str:
    """A sub-agent completed, then ran and completed again under the same
    agent_id; the problem when the recording does not show that."""
    for agent in {r["agent_id"] for r in records if r.get("agent_id")}:
        names = [r.get("event.name") for r in records if r.get("agent_id") == agent]
        if "subagent_completed" not in names:
            continue
        after = names[names.index("subagent_completed") + 1 :]
        if "api_request" in after and "subagent_completed" in after:
            return ""
    return "no sub-agent ran and completed again after its subagent_completed"


def _subagent_woken(records: list[dict[str, Any]]) -> str:
    """The parent was told a sub-agent had stopped, sent it no message, and
    the sub-agent then ran again; the problem when the recording does not
    show that."""
    if any(r.get("tool_name") == "SendMessage" for r in records):
        return "the parent sent the sub-agent a message"
    agents = {r["agent_id"] for r in records if r.get("agent_id")}
    for i, r in enumerate(records):
        prompt = str(r.get("prompt") or "")
        if r.get("event.name") != "user_prompt" or "<task-notification>" not in prompt:
            continue
        for agent in agents:
            if f"<task-id>{agent}</task-id>" in prompt and any(
                x.get("agent_id") == agent and x.get("event.name") == "api_request"
                for x in records[i + 1 :]
            ):
                return ""
    return "no sub-agent ran again after the parent was told it had stopped"


SCENARIOS: list[dict[str, Any]] = [
    {
        "name": "bash-json-prompts",
        "about": "Bash calls (one fails) over http/json with prompts and responses logged",
        "env": {
            "OTEL_EXPORTER_OTLP_PROTOCOL": "http/json",
            "OTEL_LOG_USER_PROMPTS": "1",
        },
        "prompt": "Run `ls /fd-otlp-missing` with the Bash tool (it fails), then run `echo recorded` with Bash. Reply with one word.",
        "args": lambda work: ["--allowedTools", "Bash(ls:*)", "Bash(echo:*)"],
    },
    {
        "name": "bash-protobuf-gzip",
        "about": "the same calls over http/protobuf with gzip, prompts not logged",
        "env": {
            "OTEL_EXPORTER_OTLP_PROTOCOL": "http/protobuf",
            "OTEL_EXPORTER_OTLP_COMPRESSION": "gzip",
        },
        "prompt": "Run `ls /fd-otlp-missing` with the Bash tool (it fails), then run `echo recorded` with Bash. Reply with one word.",
        "args": lambda work: ["--allowedTools", "Bash(ls:*)", "Bash(echo:*)"],
    },
    {
        "name": "subagent-json",
        "about": "a general-purpose sub-agent that runs a Bash call",
        "env": {
            "OTEL_EXPORTER_OTLP_PROTOCOL": "http/json",
            "OTEL_LOG_USER_PROMPTS": "1",
        },
        "prompt": "Use the Agent tool to start a general-purpose sub-agent whose only job is to run `echo from-child` with the Bash tool and report the output. Then reply with one word.",
        "args": lambda work: ["--allowedTools", "Agent", "Bash(echo:*)"],
    },
    {
        "name": "subagent-resume-json",
        "about": "a sub-agent that completes and is resumed with SendMessage",
        "env": {
            "OTEL_EXPORTER_OTLP_PROTOCOL": "http/json",
            "OTEL_LOG_USER_PROMPTS": "1",
        },
        "prompt": "Use the Agent tool to start a general-purpose sub-agent whose only job is to run `echo first-run` with the Bash tool and report the output. Wait until it has finished. Then use the SendMessage tool to send that same sub-agent (address it by the agent id the Agent tool returned) this message: Run `echo second-run` with the Bash tool and report the output. Wait until it has finished again, then reply with one word.",
        "args": lambda work: [
            "--allowedTools",
            "Agent",
            "SendMessage",
            "Bash(echo:*)",
        ],
        "expect": _subagent_resumed,
    },
    {
        "name": "subagent-wake-json",
        "about": "a sub-agent that stops with its background Bash task running and is woken when the task finishes",
        "env": {
            "OTEL_EXPORTER_OTLP_PROTOCOL": "http/json",
            "OTEL_LOG_USER_PROMPTS": "1",
        },
        "prompt": "Use the Agent tool to start a general-purpose sub-agent with exactly these instructions: 'Start the command `sleep 8 && echo bg-done` with the Bash tool, with run_in_background set to true. Do not wait for it and do not check on it: end your turn right away by replying only the word started. Later, when you are notified that the background command finished, reply with its output.' Then wait for the sub-agent's final result and reply with one word.",
        "args": lambda work: [
            "--allowedTools",
            "Agent",
            "Bash(sleep:*)",
            "Bash(echo:*)",
        ],
        "expect": _subagent_woken,
    },
    {
        "name": "mcp-json",
        "about": "an MCP tool call to the in-tree reference server",
        "env": {
            "OTEL_EXPORTER_OTLP_PROTOCOL": "http/json",
            "OTEL_LOG_USER_PROMPTS": "1",
        },
        "prompt": "Call the echo tool of the flightdeck-mcp-reference MCP server with the text hi. Reply with one word.",
        "args": _mcp_config,
    },
    {
        "name": "api-error-json",
        "about": "a request for a model that does not exist",
        "env": {"OTEL_EXPORTER_OTLP_PROTOCOL": "http/json"},
        "prompt": "Reply with one word.",
        "args": lambda work: [],
        "model": "claude-fd-does-not-exist",
        "may_fail": True,
    },
]


def _dropped(name: Any, attrs: dict[str, Any]) -> bool:
    """A log record that describes the recording machine and maps to
    nothing: managed settings, bundled plugins, claude.ai connectors."""
    if name in DROPPED_EVENTS:
        return True
    return (
        name == "claude_code.mcp_server_connection"
        and attrs.get("server_scope") == "claudeai"
    )


def _claude_version() -> str:
    out = subprocess.run(
        ["claude", "--version"], capture_output=True, text=True, check=True
    ).stdout
    match = re.match(r"(\d+\.\d+\.\d+)", out)
    if not match:
        raise SystemExit(f"cannot read the claude version from {out!r}")
    return match.group(1)


def _record(scenario: dict[str, Any], out_dir: Path) -> int:
    rec = Recorder()
    rec.start()
    work = Path(tempfile.mkdtemp(prefix="fd-otlp-record-"))
    try:
        # Nothing of a Claude Code session the recorder runs inside (its
        # session, effort, telemetry) or of Flightdeck reaches the run.
        env = {
            k: v
            for k, v in os.environ.items()
            if not (
                k.startswith(("FLIGHTDECK_", "OTEL_", "CLAUDE_CODE_"))
                or k in ("CLAUDECODE", "CLAUDE_EFFORT", "CLAUDE_PID")
            )
        }
        env.update(BASE_ENV)
        env.update(scenario["env"])
        env["OTEL_EXPORTER_OTLP_ENDPOINT"] = rec.endpoint
        cmd = [
            "claude",
            "-p",
            scenario["prompt"],
            "--model",
            scenario.get("model", MODEL),
            "--setting-sources",
            "project",
            *scenario["args"](work),
        ]
        run = subprocess.run(
            cmd,
            cwd=work,
            env=env,
            capture_output=True,
            text=True,
            timeout=SCENARIO_TIMEOUT_SECS,
            stdin=subprocess.DEVNULL,
            check=False,
        )
        if run.returncode != 0 and not scenario.get("may_fail"):
            raise SystemExit(
                f"scenario {scenario['name']} failed ({run.returncode}): {run.stderr or run.stdout}"
            )
        rec.wait_quiet(QUIET_SECS, QUIET_DEADLINE_SECS)
        log_docs = write_scenario(
            rec.requests,
            out_dir,
            {"scenario": scenario["name"], "about": scenario["about"]},
            scrubber(work, PYTHON),
            _dropped,
        )
        missing = (
            scenario["expect"](_log_records(log_docs)) if "expect" in scenario else ""
        )
        if missing:
            shutil.rmtree(out_dir)
            raise SystemExit(
                f"scenario {scenario['name']} not written: {missing}; the model did not do what the scenario needs, run it again"
            )
        manifest = json.loads((out_dir / "manifest.json").read_text())
        return len(manifest["requests"])
    finally:
        rec.shutdown()
        shutil.rmtree(work, ignore_errors=True)


def main(names: list[str]) -> None:
    """Record the named scenarios, or every scenario (replacing the
    version's whole directory) when none is named."""
    known = [s["name"] for s in SCENARIOS]
    unknown = sorted(set(names) - set(known))
    if unknown:
        raise SystemExit(f"unknown scenarios {unknown}; known: {known}")
    version = _claude_version()
    root = FIXTURES / f"claude-code-{version}"
    if not names:
        shutil.rmtree(root, ignore_errors=True)
    for scenario in SCENARIOS:
        if names and scenario["name"] not in names:
            continue
        shutil.rmtree(root / scenario["name"], ignore_errors=True)
        count = _record(scenario, root / scenario["name"])
        print(f"recorded {scenario['name']}: {count} requests")
    print(f"wrote {root}")


if __name__ == "__main__":
    main(sys.argv[1:])
