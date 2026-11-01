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

DROPPED_EVENTS = {
    "claude_code.managed_settings_resolved",
    "claude_code.plugin_loaded",
}
IDENTITY = {
    "user.email": "user@example.com",
    "user.account_uuid": "00000000-0000-4000-8000-000000000001",
    "user.account_id": "user_000000000000000000000001",
    "user.id": "0" * 64,
    "organization.id": "00000000-0000-4000-8000-000000000002",
}
RESOURCE_SCRUB = {"os.version": "6.6.0", "wsl.version": "2", "host.name": "host"}

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


# -- JSON requests -----------------------------------------------------------


def _json_value(v: dict[str, Any]) -> Any:
    return next(iter(v.values())) if isinstance(v, dict) and v else None


def _clean_json_attrs(attrs: list[dict[str, Any]], replace: dict[str, str]) -> None:
    for a in attrs:
        if a.get("key") in replace and isinstance(a.get("value"), dict):
            a["value"] = {"stringValue": replace[a["key"]]}


def _keep_json_record(r: dict[str, Any]) -> bool:
    name = _json_value(r.get("body", {}))
    attrs = {a["key"]: _json_value(a.get("value", {})) for a in r.get("attributes", [])}
    if name in DROPPED_EVENTS:
        return False
    return not (
        name == "claude_code.mcp_server_connection"
        and attrs.get("server_scope") == "claudeai"
    )


def _clean_json(signal: str, doc: dict[str, Any]) -> dict[str, Any]:
    top = {
        "logs": "resourceLogs",
        "traces": "resourceSpans",
        "metrics": "resourceMetrics",
    }[signal]
    inner = {
        "logs": ("scopeLogs", "logRecords"),
        "traces": ("scopeSpans", "spans"),
        "metrics": ("scopeMetrics", "metrics"),
    }[signal]
    for res in doc.get(top, []):
        _clean_json_attrs(
            res.get("resource", {}).get("attributes", []),
            {**IDENTITY, **RESOURCE_SCRUB},
        )
        for scope in res.get(inner[0], []):
            items = scope.get(inner[1], [])
            if signal == "logs":
                items[:] = [r for r in items if _keep_json_record(r)]
            for item in items:
                _clean_json_attrs(item.get("attributes", []), IDENTITY)
                if signal == "metrics":
                    for kind in ("sum", "gauge", "histogram"):
                        for point in (item.get(kind) or {}).get("dataPoints", []):
                            _clean_json_attrs(point.get("attributes", []), IDENTITY)
        res[inner[0]] = [s for s in res.get(inner[0], []) if s.get(inner[1])]
    doc[top] = [r for r in doc.get(top, []) if r.get(inner[0])]
    return doc


# -- protobuf requests -------------------------------------------------------


def _clean_pb_attrs(attrs: Any, replace: dict[str, str]) -> None:
    for a in attrs:
        if a.key in replace:
            a.value.Clear()
            a.value.string_value = replace[a.key]


def _keep_pb_record(r: Any) -> bool:
    name = r.body.string_value
    attrs = {a.key: a.value.string_value for a in r.attributes}
    if name in DROPPED_EVENTS:
        return False
    return not (
        name == "claude_code.mcp_server_connection"
        and attrs.get("server_scope") == "claudeai"
    )


def _clean_pb(signal: str, msg: Any) -> Any:
    top, inner = {
        "logs": ("resource_logs", "scope_logs"),
        "traces": ("resource_spans", "scope_spans"),
        "metrics": ("resource_metrics", "scope_metrics"),
    }[signal]
    for res in getattr(msg, top):
        _clean_pb_attrs(res.resource.attributes, {**IDENTITY, **RESOURCE_SCRUB})
        for scope in getattr(res, inner):
            if signal == "logs":
                kept = [r for r in scope.log_records if _keep_pb_record(r)]
                del scope.log_records[:]
                scope.log_records.extend(kept)
                for r in scope.log_records:
                    _clean_pb_attrs(r.attributes, IDENTITY)
            elif signal == "traces":
                for sp in scope.spans:
                    _clean_pb_attrs(sp.attributes, IDENTITY)
            else:
                for m in scope.metrics:
                    for kind in ("sum", "gauge", "histogram"):
                        if m.HasField(kind):
                            for point in getattr(m, kind).data_points:
                                _clean_pb_attrs(point.attributes, IDENTITY)
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
        for i, req in enumerate(rec.requests, start=1):
            signal, proto = SIGNALS[req["path"]]
            if req["content_type"] == "application/json":
                doc = _clean_json(signal, json.loads(req["body"]))
                name = f"{i:03d}-{signal}.json"
                (out_dir / name).write_text(
                    _scrub_text(json.dumps(doc, indent=1), work) + "\n"
                )
            else:
                msg = proto()
                msg.ParseFromString(req["body"])
                _clean_pb(signal, msg)
                # Paths are scrubbed on the decoded text values, then the
                # message is encoded again (a byte-level replace would
                # break length prefixes).
                for field_text in _string_fields(msg):
                    field_text(lambda s: _scrub_text(s, work))
                name = f"{i:03d}-{signal}.pb"
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
        return len(rec.requests)
    finally:
        rec.shutdown()
        shutil.rmtree(work, ignore_errors=True)


def _string_fields(msg: Any) -> list[Any]:
    """Setters for every string ``AnyValue`` in ``msg``: each takes a
    function from the old text to the new one."""
    from opentelemetry.proto.common.v1.common_pb2 import AnyValue

    found: list[Any] = []

    def walk(m: Any) -> None:
        if isinstance(m, AnyValue) and m.WhichOneof("value") == "string_value":
            found.append(lambda f, m=m: setattr(m, "string_value", f(m.string_value)))
            return
        for field, value in m.ListFields():
            if field.message_type is None:
                continue
            if field.label == field.LABEL_REPEATED:
                for item in value:
                    walk(item)
            else:
                walk(value)

    walk(msg)
    return found


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
