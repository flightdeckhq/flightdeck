"""A local OTLP/HTTP recorder and the scrubbing every recorded fixture gets.

Shared by the drivers that record real agents' OTLP exports
(record_claude_code.py, record_genai.py). ``Recorder`` keeps every request
it receives; ``write_scenario`` filters, scrubs and writes them to a
fixture directory with a ``manifest.json`` naming the files in the order
they arrived, and refuses to keep a directory that fails the fixture
checks (fixture_checks.py).

- JSON requests stay JSON (OTLP's JSON writes trace and span ids as hex,
  which a protobuf round trip would turn into base64); protobuf requests
  are decoded, cleaned and re-encoded, and stored uncompressed, with the
  encoding they were sent in recorded in the manifest.
- Identity attributes (fixture_checks.PLACEHOLDERS) are replaced by fixed
  placeholders and machine paths by ``/home/user`` stand-ins, at any
  depth: attributes of records, resources, scopes, span events and links,
  exemplars, kvlist and array values.
- A driver can drop log records that describe the recording machine and
  map to nothing (``drop``).
- A scenario is not written when it still holds the value of a
  credential in the environment, the host name or the user running the
  recorder.

Needs ``opentelemetry-proto`` for the protobuf requests, on any protobuf
release it allows (5.x included).
"""

from __future__ import annotations

import getpass
import gzip
import http.server
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
from collections.abc import Callable
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

try:
    from .fixture_checks import PLACEHOLDERS, directory_problems
except ImportError:
    # The drivers run as scripts from this directory, where the checker
    # is a top-level module.
    from fixture_checks import PLACEHOLDERS, directory_problems

REPO = Path(__file__).resolve().parents[2]
FAKE_HOME = "/home/user"
FAKE_PROJECT = "/home/user/project"
FAKE_REPO = f"{FAKE_HOME}/flightdeck"
# Values too generic to refuse as names of the recording machine: the
# stand-ins the scrubbing writes, and the loopback host name.
_GENERIC_NAMES = {"user", "host", "localhost"}
# The shortest host or user name refused: a shorter one would match too
# many ordinary words.
_MIN_NAME_LENGTH = 3

SIGNALS = {
    "/v1/logs": ("logs", ExportLogsServiceRequest),
    "/v1/traces": ("traces", ExportTraceServiceRequest),
    "/v1/metrics": ("metrics", ExportMetricsServiceRequest),
}

# A log record a driver drops: (its body when a string, its string
# attributes) -> True to drop it.
Drop = Callable[[Any, dict[str, Any]], bool]


def _keep_all(name: Any, attrs: dict[str, Any]) -> bool:
    return False


class Recorder(http.server.ThreadingHTTPServer):
    """An OTLP/HTTP endpoint on the loopback interface that keeps every
    request it receives."""

    def __init__(self) -> None:
        super().__init__(("127.0.0.1", 0), _Handler)
        self.requests: list[dict[str, Any]] = []
        self.lock = threading.Lock()
        self.last = time.monotonic()

    @property
    def endpoint(self) -> str:
        return f"http://127.0.0.1:{self.server_address[1]}"

    def start(self) -> None:
        threading.Thread(target=self.serve_forever, daemon=True).start()

    def wait_quiet(self, quiet_secs: float, deadline_secs: float) -> None:
        """Return once no request has arrived for ``quiet_secs``, or after
        ``deadline_secs`` in all."""
        deadline = time.monotonic() + deadline_secs
        while time.monotonic() < deadline:
            with self.lock:
                if time.monotonic() - self.last >= quiet_secs:
                    return
            time.sleep(0.2)


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


def dashed(path: Path | str) -> str:
    """A path in the form Claude Code names a project directory by
    (``/home/a/repo`` -> ``-home-a-repo``)."""
    return re.sub(r"[^A-Za-z0-9]", "-", str(path))


def checkout_roots() -> list[Path]:
    """This repository's working tree and, when it is a linked worktree,
    the main checkout it belongs to: either can appear in a recording."""
    roots = [REPO]
    try:
        common = subprocess.run(
            [
                "git",
                "-C",
                str(REPO),
                "rev-parse",
                "--path-format=absolute",
                "--git-common-dir",
            ],
            capture_output=True,
            text=True,
            check=True,
            timeout=10,
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return roots
    main = Path(common).parent
    if common and main != REPO:
        roots.append(main)
    return roots


def scrubber(work: Path, *interpreters: str) -> Callable[[str], str]:
    """A function that replaces the recording machine's paths in a string:
    the scenario's working directory, this repository's checkouts, the
    home directory (each also in the dashed form Claude Code names a
    project by) and the Python interpreters that ran."""
    roots = checkout_roots()
    pairs = sorted(
        [
            (dashed(work), "-home-user-project"),
            *((dashed(root), dashed(FAKE_REPO)) for root in roots),
            (dashed(Path.home()), "-home-user"),
            (str(work), FAKE_PROJECT),
            *((str(root), FAKE_REPO) for root in roots),
            (str(Path.home()), FAKE_HOME),
            *((p, "/usr/bin/python3") for p in (sys.executable, *interpreters)),
        ],
        key=lambda p: -len(p[0]),
    )

    def scrub(text: str) -> str:
        for old, new in pairs:
            text = text.replace(old, new)
        return text

    return scrub


def secret_values() -> list[str]:
    """The values of this process's environment variables that hold
    credentials (``*_API_KEY``, ``*_TOKEN``, ``*_SECRET``...), which a
    fixture must never contain."""
    return [
        value
        for name, value in os.environ.items()
        if re.search(r"(KEY|TOKEN|SECRET|PASSWORD)", name) and len(value) >= 12
    ]


def machine_values() -> dict[str, str]:
    """What names the recording machine and that no pattern recognises,
    by description: its host name (and that name's first label), the user
    running the recorder, and this repository's checkouts in the dashed
    form a Claude Code project directory takes (which the scrubbing
    replaces, so finding one means a form it missed). A fixture holding
    any of them, as a whole word in any case, is not written."""
    names: dict[str, str] = {}
    host = socket.gethostname()
    for value in (host, host.split(".")[0]):
        names[f"the host name {value!r}"] = value
    try:
        user = getpass.getuser()
    except (KeyError, OSError):
        user = ""
    names[f"the user name {user!r}"] = user
    for root in checkout_roots():
        names[f"the checkout path {dashed(root)!r}"] = dashed(root)
    return {
        label: value
        for label, value in names.items()
        if len(value) >= _MIN_NAME_LENGTH and value.lower() not in _GENERIC_NAMES
    }


# -- JSON requests -----------------------------------------------------------


def json_value(v: Any) -> Any:
    """The value an OTLP JSON AnyValue holds."""
    return next(iter(v.values())) if isinstance(v, dict) and v else None


def _clean_json_tree(node: Any, scrub: Callable[[str], str]) -> Any:
    if isinstance(node, dict):
        key = node.get("key")
        if (
            isinstance(key, str)
            and key in PLACEHOLDERS
            and isinstance(node.get("value"), dict)
        ):
            return {**node, "value": {"stringValue": PLACEHOLDERS[key]}}
        return {k: _clean_json_tree(v, scrub) for k, v in node.items()}
    if isinstance(node, list):
        return [_clean_json_tree(v, scrub) for v in node]
    if isinstance(node, str):
        return scrub(node)
    return node


def clean_json(
    signal: str, doc: dict[str, Any], scrub: Callable[[str], str], drop: Drop
) -> dict[str, Any]:
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
                    if not drop(
                        (r.get("body") or {}).get("stringValue"),
                        {
                            a["key"]: json_value(a.get("value"))
                            for a in r.get("attributes", [])
                        },
                    )
                ]
        res[scopes] = [s for s in res.get(scopes, []) if s.get(items)]
    doc[top] = [r for r in doc.get(top, []) if r.get(scopes)]
    cleaned: dict[str, Any] = _clean_json_tree(doc, scrub)
    return cleaned


# -- protobuf requests -------------------------------------------------------


def _is_repeated(field: Any) -> bool:
    """Whether a protobuf field descriptor is a repeated field, on every
    protobuf release opentelemetry-proto allows: 7 removed ``label`` in
    favour of ``is_repeated``, which 5.x does not have."""
    flag = getattr(field, "is_repeated", None)
    if flag is not None:
        return bool(flag)
    from google.protobuf.descriptor import FieldDescriptor

    return bool(field.label == FieldDescriptor.LABEL_REPEATED)


def _clean_pb_tree(msg: Any, scrub: Callable[[str], str]) -> None:
    from google.protobuf.descriptor import FieldDescriptor

    if (
        msg.DESCRIPTOR.full_name == "opentelemetry.proto.common.v1.KeyValue"
        and msg.key in PLACEHOLDERS
    ):
        msg.value.Clear()
        msg.value.string_value = PLACEHOLDERS[msg.key]
        return
    for field, value in msg.ListFields():
        repeated = _is_repeated(field)
        if field.type == FieldDescriptor.TYPE_STRING:
            if repeated:
                for i, item in enumerate(value):
                    value[i] = scrub(item)
            else:
                setattr(msg, field.name, scrub(value))
        elif field.type == FieldDescriptor.TYPE_MESSAGE:
            for item in value if repeated else [value]:
                _clean_pb_tree(item, scrub)


def clean_pb(signal: str, msg: Any, scrub: Callable[[str], str], drop: Drop) -> Any:
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
                    if not drop(
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
    _clean_pb_tree(msg, scrub)
    return msg


# -- writing a scenario --------------------------------------------------------


def write_scenario(
    requests: list[dict[str, Any]],
    out_dir: Path,
    manifest: dict[str, Any],
    scrub: Callable[[str], str],
    drop: Drop = _keep_all,
) -> list[dict[str, Any]]:
    """Write the recorded requests, cleaned, to ``out_dir`` with a
    ``manifest.json`` (``manifest`` plus the list of requests), and return
    the scenario's JSON log documents. Nothing is kept when the result
    fails the fixture checks, names this machine (``machine_values``) or
    holds a credential of this environment."""
    out_dir.mkdir(parents=True)
    manifest = {**manifest, "requests": []}
    log_docs: list[dict[str, Any]] = []
    for req in requests:
        signal, proto = SIGNALS[req["path"]]
        if req["content_type"] == "application/json":
            doc = clean_json(signal, json.loads(req["body"]), scrub, drop)
            if not any(doc.values()):
                continue  # every record was dropped
            if signal == "logs":
                log_docs.append(doc)
            name = f"{len(manifest['requests']) + 1:03d}-{signal}.json"
            (out_dir / name).write_text(json.dumps(doc, indent=1) + "\n")
        else:
            msg = proto()
            msg.ParseFromString(req["body"])
            clean_pb(signal, msg, scrub, drop)
            if not msg.ByteSize():
                continue  # every record was dropped
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
    leaks = directory_problems(out_dir, machine_values())
    written = b"".join(p.read_bytes() for p in sorted(out_dir.iterdir()))
    if any(secret.encode() in written for secret in secret_values()):
        leaks.append("a credential from this environment")
    if leaks:
        shutil.rmtree(out_dir)
        raise SystemExit(
            f"{out_dir.name} not written; its output fails the fixture checks: {leaks}"
        )
    return log_docs
