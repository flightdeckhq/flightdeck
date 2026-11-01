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

What reaches a fixture:
- Log records Flightdeck never maps and that describe the recording
  machine (managed settings, bundled plugins, the user's claude.ai
  connector connections) are dropped.
- Identity attributes (``user.email``, ``user.account_uuid``,
  ``user.account_id``, ``user.id``, ``organization.id``) are replaced by
  fixed placeholders, and machine paths by ``/home/user`` stand-ins.
- JSON requests stay JSON (OTLP's JSON writes trace and span ids as hex,
  which a protobuf round trip would turn into base64); protobuf requests
  are decoded, cleaned and re-encoded, and stored uncompressed, with the
  encoding they were sent in recorded in the manifest.
"""

from __future__ import annotations

import gzip
import http.server
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Any

from opentelemetry.proto.collector.logs.v1.logs_service_pb2 import (
    ExportLogsServiceRequest,
)
from opentelemetry.proto.collector.metrics.v1.metrics_service_pb2 import (
    ExportMetricsServiceRequest,
)
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import (
    ExportTraceServiceRequest,
)

REPO = Path(__file__).resolve().parents[2]
FIXTURES = REPO / "tests" / "fixtures" / "otlp"
FAKE_HOME = "/home/user"
FAKE_PROJECT = "/home/user/project"
MODEL = "claude-haiku-4-5"
# A scenario is a few model turns; this bounds a stuck one.
SCENARIO_TIMEOUT_SECS = 240
# The exporters flush every second (see BASE_ENV) and once more at exit;
# a recording is complete once no request has arrived for this long.
QUIET_SECS = 4.0
QUIET_DEADLINE_SECS = 30.0

# The checker owns the placeholders, so what the recorder writes and what
# the test accepts cannot drift apart.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from fixture_checks import (
    DROPPED_EVENTS,
    PLACEHOLDERS,
    directory_problems,
)

SIGNALS = {
    "/v1/logs": ("logs", ExportLogsServiceRequest),
    "/v1/traces": ("traces", ExportTraceServiceRequest),
    "/v1/metrics": ("metrics", ExportMetricsServiceRequest),
}

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


class Recorder(http.server.ThreadingHTTPServer):
    """An OTLP/HTTP endpoint that keeps every request it receives."""

    def __init__(self) -> None:
        super().__init__(("127.0.0.1", 0), _Handler)
        self.requests: list[dict[str, Any]] = []
        self.lock = threading.Lock()
        self.last = time.monotonic()


class _Handler(http.server.BaseHTTPRequestHandler):
    server: Recorder

    def do_POST(self) -> None:
        body = self.rfile.read(int(self.headers.get("content-length") or 0))
        encoding = (self.headers.get("content-encoding") or "").lower()
        if encoding == "gzip":
            body = gzip.decompress(body)
        with self.server.lock:
            self.server.requests.append(
                {
                    "path": self.path,
                    "content_type": (self.headers.get("content-type") or "").split(";")[
                        0
                    ],
                    "content_encoding": encoding or None,
                    "body": body,
                }
            )
            self.server.last = time.monotonic()
        self.send_response(200)
        self.send_header(
            "Content-Type", self.headers.get("content-type") or "application/json"
        )
        self.end_headers()
        self.wfile.write(
            b"{}" if "json" in (self.headers.get("content-type") or "") else b""
        )

    def log_message(self, *args: Any) -> None:
        pass


def _scrub_text(text: str, work: Path) -> str:
    pairs = sorted(
        [
            (re.sub(r"[^A-Za-z0-9]", "-", str(work)), "-home-user-project"),
            (re.sub(r"[^A-Za-z0-9]", "-", str(Path.home())), "-home-user"),
            (str(work), FAKE_PROJECT),
            (str(REPO), f"{FAKE_HOME}/flightdeck"),
            (str(Path.home()), FAKE_HOME),
            (sys.executable, "/usr/bin/python3"),
            (PYTHON, "/usr/bin/python3"),
        ],
        key=lambda p: -len(p[0]),
    )
    for old, new in pairs:
        text = text.replace(old, new)
    return text


def _dropped(name: Any, attrs: dict[str, Any]) -> bool:
    """A log record that describes the recording machine and maps to
    nothing: managed settings, bundled plugins, claude.ai connectors."""
    if name in DROPPED_EVENTS:
        return True
    return (
        name == "claude_code.mcp_server_connection"
        and attrs.get("server_scope") == "claudeai"
    )


# -- JSON requests -----------------------------------------------------------


def _json_value(v: Any) -> Any:
    return next(iter(v.values())) if isinstance(v, dict) and v else None


def _clean_json_tree(node: Any, work: Path) -> Any:
    """Every identity KeyValue to its placeholder and every string
    scrubbed, at any depth (attributes of records, resources, scopes,
    span events and links, exemplars, kvlist and array values)."""
    if isinstance(node, dict):
        key = node.get("key")
        if (
            isinstance(key, str)
            and key in PLACEHOLDERS
            and isinstance(node.get("value"), dict)
        ):
            return {**node, "value": {"stringValue": PLACEHOLDERS[key]}}
        return {k: _clean_json_tree(v, work) for k, v in node.items()}
    if isinstance(node, list):
        return [_clean_json_tree(v, work) for v in node]
    if isinstance(node, str):
        return _scrub_text(node, work)
    return node


def _clean_json(signal: str, doc: dict[str, Any], work: Path) -> dict[str, Any]:
    top, scopes, items = {
        "logs": ("resourceLogs", "scopeLogs", "logRecords"),
        "traces": ("resourceSpans", "scopeSpans", "spans"),
        "metrics": ("resourceMetrics", "scopeMetrics", "metrics"),
    }[signal]
    for res in doc.get(top, []):
        for scope in res.get(scopes, []):
            if signal == "logs":
                scope[items] = [
                    r
                    for r in scope.get(items, [])
                    if not _dropped(
                        _json_value(r.get("body")),
                        {
                            a["key"]: _json_value(a.get("value"))
                            for a in r.get("attributes", [])
                        },
                    )
                ]
        res[scopes] = [s for s in res.get(scopes, []) if s.get(items)]
    doc[top] = [r for r in doc.get(top, []) if r.get(scopes)]
    cleaned: dict[str, Any] = _clean_json_tree(doc, work)
    return cleaned


# -- protobuf requests -------------------------------------------------------


def _clean_pb_tree(msg: Any, work: Path) -> None:
    """Every identity KeyValue to its placeholder and every string field
    and string AnyValue scrubbed, at any depth."""
    from google.protobuf.descriptor import FieldDescriptor

    if (
        msg.DESCRIPTOR.full_name == "opentelemetry.proto.common.v1.KeyValue"
        and msg.key in PLACEHOLDERS
    ):
        msg.value.Clear()
        msg.value.string_value = PLACEHOLDERS[msg.key]
        return
    for field, value in msg.ListFields():
        repeated = field.label == FieldDescriptor.LABEL_REPEATED
        if field.type == FieldDescriptor.TYPE_STRING:
            if repeated:
                for i, item in enumerate(value):
                    value[i] = _scrub_text(item, work)
            else:
                setattr(msg, field.name, _scrub_text(value, work))
        elif field.type == FieldDescriptor.TYPE_MESSAGE:
            for item in value if repeated else [value]:
                _clean_pb_tree(item, work)


def _clean_pb(signal: str, msg: Any, work: Path) -> Any:
    top, scopes, items = {
        "logs": ("resource_logs", "scope_logs", "log_records"),
        "traces": ("resource_spans", "scope_spans", "spans"),
        "metrics": ("resource_metrics", "scope_metrics", "metrics"),
    }[signal]
    for res in getattr(msg, top):
        for scope in getattr(res, scopes):
            if signal == "logs":
                kept = [
                    r
                    for r in scope.log_records
                    if not _dropped(
                        r.body.string_value,
                        {a.key: a.value.string_value for a in r.attributes},
                    )
                ]
                del scope.log_records[:]
                scope.log_records.extend(kept)
        kept_scopes = [s for s in getattr(res, scopes) if len(getattr(s, items))]
        del getattr(res, scopes)[:]
        getattr(res, scopes).extend(kept_scopes)
    kept_res = [r for r in getattr(msg, top) if len(getattr(r, scopes))]
    del getattr(msg, top)[:]
    getattr(msg, top).extend(kept_res)
    _clean_pb_tree(msg, work)
    return msg


def _wait_quiet(rec: Recorder) -> None:
    deadline = time.monotonic() + QUIET_DEADLINE_SECS
    while time.monotonic() < deadline:
        with rec.lock:
            if time.monotonic() - rec.last >= QUIET_SECS:
                return
        time.sleep(0.2)


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
    thread = threading.Thread(target=rec.serve_forever, daemon=True)
    thread.start()
    work = Path(tempfile.mkdtemp(prefix="fd-otlp-record-"))
    try:
        env = {
            k: v
            for k, v in os.environ.items()
            if not (
                k.startswith(("FLIGHTDECK_", "OTEL_", "CLAUDE_CODE_"))
                or k == "CLAUDECODE"
            )
        }
        env.update(BASE_ENV)
        env.update(scenario["env"])
        env["OTEL_EXPORTER_OTLP_ENDPOINT"] = f"http://127.0.0.1:{rec.server_address[1]}"
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
        _wait_quiet(rec)
        out_dir.mkdir(parents=True)
        manifest = {
            "scenario": scenario["name"],
            "about": scenario["about"],
            "requests": [],
        }
        for req in rec.requests:
            signal, proto = SIGNALS[req["path"]]
            if req["content_type"] == "application/json":
                doc = _clean_json(signal, json.loads(req["body"]), work)
                if not any(doc.values()):
                    continue  # every record described the machine
                name = f"{len(manifest['requests']) + 1:03d}-{signal}.json"
                (out_dir / name).write_text(json.dumps(doc, indent=1) + "\n")
            else:
                msg = proto()
                msg.ParseFromString(req["body"])
                _clean_pb(signal, msg, work)
                if not msg.ByteSize():
                    continue  # every record described the machine
                name = f"{len(manifest['requests']) + 1:03d}-{signal}.pb"
                (out_dir / name).write_bytes(msg.SerializeToString())
            manifest["requests"].append(
                {
                    "file": name,
                    "path": req["path"],
                    "content_type": req["content_type"],
                    "sent_encoding": req["content_encoding"],
                }
            )
        (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=1) + "\n")
        leaks = directory_problems(out_dir)
        if leaks:
            shutil.rmtree(out_dir)
            raise SystemExit(
                f"scenario {scenario['name']} not written; its output fails the fixture checks: {leaks}"
            )
        return len(manifest["requests"])
    finally:
        rec.shutdown()
        shutil.rmtree(work, ignore_errors=True)


def main() -> None:
    version = _claude_version()
    root = FIXTURES / f"claude-code-{version}"
    shutil.rmtree(root, ignore_errors=True)
    for scenario in SCENARIOS:
        count = _record(scenario, root / scenario["name"])
        print(f"recorded {scenario['name']}: {count} requests")
    print(f"wrote {root}")


if __name__ == "__main__":
    main()
