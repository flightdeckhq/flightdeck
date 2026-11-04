"""The recorded OTLP fixtures stay scrubbed and stay OTLP.

The recorders (tests/otlp/record_claude_code.py, record_genai.py) replace
identity, account and machine attributes with placeholders, drop the
records that describe the recording machine, and refuse to write a
scenario that fails tests/otlp/fixture_checks.py. This test runs the same
checks over the committed fixtures, protobuf files included, so a hand
edit or a recorder change cannot commit a real account's identifiers, the
user's connector names, an email address, a machine path or a provider
key. It also checks that every request file decodes as the OTLP export
its manifest says it is, so a fixture a normalizer test replays is one
an exporter could have sent.
"""

from __future__ import annotations

import base64
import json
import re
import shutil
from pathlib import Path
from typing import Any

import pytest

from ..otlp.fixture_checks import _as_text, _fields, directory_problems, problems

try:
    from google.protobuf.message import DecodeError
    from opentelemetry.proto.collector.logs.v1.logs_service_pb2 import (
        ExportLogsServiceRequest,
    )
    from opentelemetry.proto.collector.metrics.v1.metrics_service_pb2 import (
        ExportMetricsServiceRequest,
    )
    from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import (
        ExportTraceServiceRequest,
    )

    # Where opentelemetry-proto is installed, a protobuf file must also
    # parse as its route's export; the record checks below run either way.
    _EXPORTS: dict[str, Any] = {
        "/v1/traces": ExportTraceServiceRequest,
        "/v1/logs": ExportLogsServiceRequest,
        "/v1/metrics": ExportMetricsServiceRequest,
    }
except ImportError:
    _EXPORTS = {}

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "otlp"

# Per OTLP route: the JSON names of the resource, scope and record lists.
# The protobuf messages nest the same way, each list in field 1 (resource
# list) and field 2 (scope list, record list) of its parent.
_NESTING = {
    "/v1/traces": ("resourceSpans", "scopeSpans", "spans"),
    "/v1/logs": ("resourceLogs", "scopeLogs", "logRecords"),
    "/v1/metrics": ("resourceMetrics", "scopeMetrics", "metrics"),
}
_MEDIA_TYPES = {".json": "application/json", ".pb": "application/x-protobuf"}
_HEX_ID = {n: re.compile(f"[0-9a-fA-F]{{{n}}}") for n in (16, 32)}

# The wire type of each field of a record (Span, LogRecord, Metric) in the
# OTLP protobuf schema: 0 varint, 1 fixed64, 2 length-delimited, 5
# fixed32. The signals share field numbers with different types (a span's
# field 1 is its trace id, a log record's its time, a metric's its name),
# so a record read under the wrong signal breaks one of them.
_RECORD_WIRE_TYPES = {
    "/v1/traces": {
        **dict.fromkeys((1, 2, 3, 4, 5, 9, 11, 13, 15), 2),
        **dict.fromkeys((6, 10, 12, 14), 0),
        7: 1,
        8: 1,
        16: 5,
    },
    "/v1/logs": {
        **dict.fromkeys((1, 11), 1),
        **dict.fromkeys((2, 7), 0),
        **dict.fromkeys((3, 5, 6, 9, 10, 12), 2),
        8: 5,
    },
    "/v1/metrics": dict.fromkeys((1, 2, 3, 5, 7, 9, 10, 11, 12), 2),
}
# A metric's data: gauge, sum, histogram, exponential histogram, summary.
_METRIC_DATA = (5, 7, 9, 10, 11)
_METRIC_DATA_JSON = ("gauge", "sum", "histogram", "exponentialHistogram", "summary")


def _scenarios() -> list[Path]:
    return sorted(p.parent for p in FIXTURES.glob("*/*/manifest.json"))


def test_the_fixtures_exist() -> None:
    assert _scenarios(), f"no OTLP fixtures under {FIXTURES}"


def test_every_fixture_passes_the_privacy_checks() -> None:
    found = [p for scenario in _scenarios() for p in directory_problems(scenario)]
    assert found == []


def _json_record_problem(route: str, record: dict[str, Any]) -> str | None:
    if route == "/v1/traces":
        # OTLP JSON writes ids as hex, never base64.
        if not (
            _HEX_ID[32].fullmatch(record.get("traceId", ""))
            and _HEX_ID[16].fullmatch(record.get("spanId", ""))
        ):
            return "a span without hex trace and span ids"
        if not (record.get("startTimeUnixNano") and record.get("endTimeUnixNano")):
            return "a span without start and end times"
    elif route == "/v1/logs":
        if not (record.get("timeUnixNano") or record.get("observedTimeUnixNano")):
            return "a log record without a time"
    elif not record.get("name") or not any(k in record for k in _METRIC_DATA_JSON):
        return "a metric without a name or data"
    return None


def _protobuf_record_problem(route: str, record: bytes) -> str | None:
    fields: dict[int, list[tuple[int, Any]]] = {}
    for number, wire, value in _fields(record):
        fields.setdefault(number, []).append((wire, value))
    expected = _RECORD_WIRE_TYPES[route]
    for number, values in fields.items():
        if number in expected and any(wire != expected[number] for wire, _ in values):
            return f"field {number} has the wrong wire type for a {route} record"

    def one(number: int) -> Any:
        return fields[number][0][1] if number in fields else None

    if route == "/v1/traces":
        if len(one(1) or b"") != 16 or len(one(2) or b"") != 8:
            return "a span without a 16-byte trace id and an 8-byte span id"
        if one(7) is None or one(8) is None:
            return "a span without start and end times"
    elif route == "/v1/logs":
        if one(1) is None and one(11) is None:
            return "a log record without a time"
    elif one(1) is None or _as_text(one(1)) is None:
        return "a metric without a name"
    elif sum(number in fields for number in _METRIC_DATA) != 1:
        return "a metric without exactly one kind of data"
    return None


def _records(route: str, path: Path) -> tuple[int, list[str]]:
    """How many records a request file holds, and what is wrong with it as
    an export of ``route``'s signal."""
    found: list[str] = []
    if path.suffix == ".json":
        doc = json.loads(path.read_text())
        resources, scopes, records = _NESTING[route]
        if not isinstance(doc, dict) or set(doc) != {resources}:
            return 0, [f"{path.name}: not a {route} export (top-level {sorted(doc)})"]
        items = [
            record
            for resource in doc[resources]
            for scope in resource.get(scopes, [])
            for record in scope.get(records, [])
        ]
        found += [
            f"{path.name}: {problem}"
            for record in items
            if (problem := _json_record_problem(route, record))
        ]
        return len(items), found
    raw = path.read_bytes()
    if route in _EXPORTS:
        try:
            _EXPORTS[route].FromString(raw)
        except DecodeError as exc:
            found.append(f"{path.name}: does not parse as a {route} export: {exc}")
    try:
        top = _fields(raw)
        if not top or any(n != 1 or wire != 2 for n, wire, _ in top):
            return 0, [*found, f"{path.name}: not an export request"]
        items = [
            value
            for _, _, resource in top
            for n, wire, scope in _fields(resource)
            if n == 2 and wire == 2
            for m, kind, value in _fields(scope)
            if m == 2 and kind == 2
        ]
        found += [
            f"{path.name}: {problem}"
            for record in items
            if (problem := _protobuf_record_problem(route, record))
        ]
    except ValueError as exc:
        return 0, [*found, f"{path.name}: not protobuf ({exc})"]
    return len(items), found


def _decode_problems(scenario: Path) -> list[str]:
    """What keeps a scenario's request files from being the OTLP exports
    its manifest names."""
    manifest = json.loads((scenario / "manifest.json").read_text())
    if not manifest["requests"]:
        return ["a scenario records at least one request"]
    found: list[str] = []
    for request in manifest["requests"]:
        path = scenario / request["file"]
        route = request["path"]
        if route not in _NESTING:
            found.append(f"{request['file']}: unknown route {route}")
            continue
        if request["content_type"] != _MEDIA_TYPES.get(path.suffix):
            found.append(f"{request['file']}: content type {request['content_type']}")
        if not request["file"].endswith(f"-{route.rsplit('/', 1)[1]}{path.suffix}"):
            found.append(f"{request['file']}: named for another signal than {route}")
        count, problems_here = _records(route, path)
        found += problems_here
        if count == 0:
            found.append(f"{request['file']}: holds no records")
    return found


@pytest.mark.parametrize(
    "scenario", _scenarios(), ids=lambda p: f"{p.parent.name}/{p.name}"
)
def test_every_fixture_decodes_as_the_export_its_manifest_names(
    scenario: Path,
) -> None:
    """Each request file is an OTLP export of its route's signal in the
    encoding its file name and manifest give, holding at least one record
    whose fields are that signal's: JSON with that signal's lists, hex ids
    and times, or protobuf whose records have the signal's wire types,
    and parse as its export where opentelemetry-proto is installed."""
    assert _decode_problems(scenario) == []


@pytest.mark.parametrize(
    ("source", "route"),
    [
        ("001-metrics.pb", "/v1/traces"),
        ("005-traces.pb", "/v1/logs"),
        ("002-logs.pb", "/v1/metrics"),
    ],
)
def test_the_decode_check_tells_the_signals_apart(
    tmp_path: Path, source: str, route: str
) -> None:
    """A real export filed under another signal's route fails: the
    signals' records share field numbers but not their types."""
    recorded = FIXTURES / "claude-code-2.1.316" / "bash-protobuf-gzip" / source
    name = f"001-{route.rsplit('/', 1)[1]}.pb"
    shutil.copy(recorded, tmp_path / name)
    (tmp_path / "manifest.json").write_text(
        json.dumps(
            {
                "requests": [
                    {
                        "file": name,
                        "path": route,
                        "content_type": "application/x-protobuf",
                        "sent_encoding": None,
                    }
                ]
            }
        )
    )
    assert _decode_problems(tmp_path), f"{source} passed as {route}"


# Credentials and account ids of the shapes the checks know, built here so
# that no complete one is written in this file.
_CREDENTIALS = [
    "sk-ant-api03-" + "Zz9" * 12,
    "sk-proj-" + "Ab3" * 10,
    "AIza" + "Sy" * 17,
    "org-" + "Ab1" * 8,
    "proj" + "_" + "Ab1" * 8,
    "AKIA" + "Q7" * 8,
    "ya29." + "a0" * 20,
    "gh" + "p_" + "a1" * 18,
    "github" + "_pat_" + "a1" * 11,
    "ftd_" + "c3" * 10,
]
_MACHINE_PATHS = [
    "/home/alice/repo",
    "/root/.config/key",
    "/var/folders/xy/abc/T/tmp1",
    "/mnt/c/Users/alice",
    "path:\t/home/alice/repo",
    "path:\r/home/alice/repo",
    "/tmp/claude-1000/-mnt-c-Users-alice-dev-repo/session.jsonl",
    "-home-alice-repo",
    "~alice/.netrc",
]


def _field(number: int, payload: bytes) -> bytes:
    """A length-delimited protobuf field."""
    size, length = len(payload), b""
    while True:
        byte = size & 0x7F
        size >>= 7
        length += bytes([byte | (0x80 if size else 0)])
        if not size:
            break
    return bytes([number << 3 | 2]) + length + payload


def _protobuf_log(attributes: list[tuple[str, int, bytes]]) -> bytes:
    """An ExportLogsServiceRequest with one log record holding these
    attributes, each (key, AnyValue field: 1 string or 7 bytes, value)."""
    record = b"".join(
        _field(6, _field(1, key.encode()) + _field(2, _field(kind, value)))
        for key, kind, value in attributes
    )
    return _field(1, _field(2, _field(2, record)))


def test_the_checks_catch_a_planted_leak(tmp_path: Path) -> None:
    """The checks themselves: a real-looking identity or account value, a
    connector record, a machine path and a provider key are each reported,
    in JSON and protobuf."""
    leaky = tmp_path / "001-logs.json"
    leaky.write_text(
        '{"resourceLogs":[{"scopeLogs":[{"logRecords":[{"attributes":['
        '{"key":"user.email","value":{"stringValue":"someone@corp.example.org"}},'
        '{"key":"server_scope","value":{"stringValue":"claudeai"}},'
        '{"key":"cwd","value":{"stringValue":"/home/alice/repo"}},'
        '{"key":"anthropic.workspace.id","value":{"stringValue":"wrkspc_01AbCdEf"}},'
        '{"key":"note","value":{"stringValue":"Bearer sk-proj-'
        + "Ab3" * 10
        + '"}}]}]}]}]}'
    )
    found = problems(leaky)
    assert any("user.email" in p for p in found), found
    assert any("claude.ai connector" in p for p in found), found
    assert any("/home/alice" in p for p in found), found
    assert any("anthropic.workspace.id" in p for p in found), found
    assert any("API key" in p for p in found), found
    # The key itself is never echoed into a test report.
    assert not any("Ab3Ab3" in p for p in found), found

    pb = tmp_path / "002-logs.pb"
    pb.write_bytes(
        _protobuf_log(
            [
                ("organization.id", 1, b"00000000-1111-2222-3333-444444444444"),
                ("anthropic.workspace.id", 1, b"wrkspc_01AbCdEf"),
                ("note", 1, ("Bearer sk-proj-" + "Ab3" * 10).encode()),
            ]
        )
    )
    found = problems(pb)
    assert any("organization.id" in p for p in found), found
    assert any("anthropic.workspace.id" in p for p in found), found
    assert any("API key" in p for p in found), found
    assert not any("Ab3Ab3" in p for p in found), found

    # A placeholder key holding a number (AnyValue int_value, field 3) is
    # not its placeholder either.
    int_value = bytes([3 << 3, 0xB9, 0x60])  # 12345 as a varint
    key_value = _field(1, b"host.name") + _field(2, int_value)
    pb.write_bytes(_field(1, _field(2, _field(2, _field(6, key_value)))))
    assert any("host.name" in p for p in problems(pb)), problems(pb)


@pytest.mark.parametrize("value", _CREDENTIALS + _MACHINE_PATHS)
def test_each_credential_shape_and_machine_path_is_caught(
    tmp_path: Path, value: str
) -> None:
    """Every credential shape and machine path is reported wherever it
    sits: a JSON string, a JSON bytes value (base64), a protobuf string
    or bytes value."""
    encoded = base64.b64encode(value.encode()).decode()
    places = {
        "json-string": {"stringValue": value},
        "json-bytes": {"bytesValue": encoded},
    }
    for place, any_value in places.items():
        path = tmp_path / f"{place}.json"
        path.write_text(
            json.dumps(
                {
                    "resourceLogs": [
                        {
                            "scopeLogs": [
                                {
                                    "logRecords": [
                                        {
                                            "attributes": [
                                                {"key": "note", "value": any_value}
                                            ]
                                        }
                                    ]
                                }
                            ]
                        }
                    ]
                }
            )
        )
        assert problems(path), f"{place} missed {value!r}"
    for place, kind in (("pb-string", 1), ("pb-bytes", 7)):
        path = tmp_path / f"{place}.pb"
        path.write_bytes(_protobuf_log([("note", kind, value.encode())]))
        assert problems(path), f"{place} missed {value!r}"


def test_the_recorder_s_machine_names_are_caught_as_whole_words(
    tmp_path: Path,
) -> None:
    """The names a recorder passes (its host and user) are reported as
    whole words in any case, and not inside a longer word."""
    machine = {"the host name": "Build-Box-7", "the user name": "alice"}
    path = tmp_path / "001-logs.pb"
    path.write_bytes(_protobuf_log([("note", 1, b"ran on build-box-7.local as Alice")]))
    found = problems(path, machine)
    assert any("host name" in p for p in found), found
    assert any("user name" in p for p in found), found
    path.write_bytes(_protobuf_log([("note", 1, b"malice aforethought")]))
    assert problems(path, machine) == []


def test_a_planted_value_in_a_manifest_is_caught(tmp_path: Path) -> None:
    """The manifest is checked like the request files: what a recorder
    writes there (provider_calls) can leak a home directory, an account id
    or the recording machine's name."""
    recorded = FIXTURES / "claude-code-2.1.316" / "api-error-json"
    for source in recorded.iterdir():
        shutil.copy(source, tmp_path / source.name)
    assert directory_problems(tmp_path) == []
    manifest = json.loads((tmp_path / "manifest.json").read_text())
    manifest["provider_calls"] = [
        {"path": "/home/alice/repo", "error": {"code": "org-" + "Ab1" * 8}},
        {"path": "/v1/build-box-7"},
    ]
    (tmp_path / "manifest.json").write_text(json.dumps(manifest))
    found = directory_problems(tmp_path, {"the host name": "build-box-7"})
    assert any("manifest.json: home directory /home/alice" in p for p in found), found
    assert any("manifest.json: a provider API key" in p for p in found), found
    assert any("manifest.json: the host name" in p for p in found), found
