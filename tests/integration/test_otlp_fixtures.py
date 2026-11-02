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

import json
import re
from pathlib import Path
from typing import Any

import pytest

from ..otlp.fixture_checks import _fields, directory_problems, problems

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


def _scenarios() -> list[Path]:
    return sorted(p.parent for p in FIXTURES.glob("*/*/manifest.json"))


def test_the_fixtures_exist() -> None:
    assert _scenarios(), f"no OTLP fixtures under {FIXTURES}"


def test_every_fixture_passes_the_privacy_checks() -> None:
    found = [p for scenario in _scenarios() for p in directory_problems(scenario)]
    assert found == []


def _json_records(route: str, doc: Any) -> int:
    resources, scopes, records = _NESTING[route]
    assert isinstance(doc, dict) and set(doc) == {resources}, sorted(doc)
    count = 0
    for resource in doc[resources]:
        for scope in resource[scopes]:
            assert isinstance(scope[records], list)
            count += len(scope[records])
            if route == "/v1/traces":
                for span in scope[records]:
                    # OTLP JSON writes ids as hex, never base64.
                    assert _HEX_ID[32].fullmatch(span["traceId"]), span["traceId"]
                    assert _HEX_ID[16].fullmatch(span["spanId"]), span["spanId"]
    return count


def _protobuf_records(raw: bytes) -> int:
    def sub(buf: bytes, number: int) -> list[bytes]:
        fields = _fields(buf)
        assert all(n == number and wire == 2 for n, wire, _ in fields if n == number)
        return [value for n, wire, value in fields if n == number and wire == 2]

    top = _fields(raw)
    assert top and all(n == 1 and wire == 2 for n, wire, _ in top), top[:3]
    return sum(
        len(sub(scope, 2)) for _, _, resource in top for scope in sub(resource, 2)
    )


@pytest.mark.parametrize(
    "scenario", _scenarios(), ids=lambda p: f"{p.parent.name}/{p.name}"
)
def test_every_fixture_decodes_as_the_export_its_manifest_names(
    scenario: Path,
) -> None:
    """Each request file is an OTLP export of its route's signal in the
    encoding its file name and manifest give, holding at least one record:
    JSON with that signal's lists and hex ids, or protobuf that the
    dependency-free wire reader walks from resources to records."""
    manifest = json.loads((scenario / "manifest.json").read_text())
    assert manifest["requests"], "a scenario records at least one request"
    for request in manifest["requests"]:
        path = scenario / request["file"]
        assert request["path"] in _NESTING, request
        assert request["content_type"] == _MEDIA_TYPES[path.suffix], request
        assert request["file"].endswith(
            f"-{request['path'].rsplit('/', 1)[1]}{path.suffix}"
        )
        if path.suffix == ".json":
            count = _json_records(request["path"], json.loads(path.read_text()))
        else:
            count = _protobuf_records(path.read_bytes())
        assert count > 0, f"{request['file']} holds no records"


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

    def field(number: int, payload: bytes) -> bytes:
        return bytes([number << 3 | 2, len(payload)]) + payload

    any_value = field(1, b"00000000-1111-2222-3333-444444444444")
    key_value = field(1, b"organization.id") + field(2, any_value)
    pb = tmp_path / "002-logs.pb"
    pb.write_bytes(field(1, field(2, field(2, field(6, key_value)))))
    assert any("organization.id" in p for p in problems(pb)), problems(pb)
