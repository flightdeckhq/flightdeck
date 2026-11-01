"""The recorded OTLP fixtures stay scrubbed.

tests/otlp/record_claude_code.py replaces Claude Code's identity
attributes with placeholders and drops the records that describe the
recording machine. This test keeps a re-recording, or a hand edit, from
committing a real account's identifiers or connector names: every
identity attribute in a JSON fixture holds its placeholder, no dropped
record type is present, and no file (protobuf included) holds an email
address other than the placeholder.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "otlp"
PLACEHOLDERS = {
    "user.email": "user@example.com",
    "user.account_uuid": "00000000-0000-4000-8000-000000000001",
    "user.account_id": "user_000000000000000000000001",
    "user.id": "0" * 64,
    "organization.id": "00000000-0000-4000-8000-000000000002",
}
DROPPED_EVENTS = {"claude_code.managed_settings_resolved", "claude_code.plugin_loaded"}
EMAIL = re.compile(rb"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")


def _value(v: dict[str, Any]) -> Any:
    return next(iter(v.values())) if isinstance(v, dict) and v else None


def _attribute_lists(doc: Any) -> list[list[dict[str, Any]]]:
    out: list[list[dict[str, Any]]] = []
    if isinstance(doc, dict):
        if isinstance(doc.get("attributes"), list):
            out.append(doc["attributes"])
        for v in doc.values():
            out.extend(_attribute_lists(v))
    elif isinstance(doc, list):
        for v in doc:
            out.extend(_attribute_lists(v))
    return out


def _log_records(doc: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        r
        for rl in doc.get("resourceLogs", [])
        for sl in rl.get("scopeLogs", [])
        for r in sl.get("logRecords", [])
    ]


def test_the_fixtures_exist() -> None:
    manifests = list(FIXTURES.glob("*/*/manifest.json"))
    assert manifests, f"no OTLP fixtures under {FIXTURES}"
    for manifest in manifests:
        for request in json.loads(manifest.read_text())["requests"]:
            assert (manifest.parent / request["file"]).is_file(), request["file"]


def test_identity_attributes_hold_their_placeholders() -> None:
    for path in FIXTURES.glob("*/*/*.json"):
        if path.name == "manifest.json":
            continue
        doc = json.loads(path.read_text())
        for attrs in _attribute_lists(doc):
            for a in attrs:
                if a["key"] in PLACEHOLDERS:
                    assert _value(a["value"]) == PLACEHOLDERS[a["key"]], (
                        f"{path.name}: {a['key']}"
                    )
        for r in _log_records(doc):
            name = _value(r.get("body", {}))
            assert name not in DROPPED_EVENTS, f"{path.name}: {name}"
            scope = {a["key"]: _value(a["value"]) for a in r.get("attributes", [])}.get(
                "server_scope"
            )
            assert scope != "claudeai", f"{path.name}: a claude.ai connector record"


def test_no_file_holds_a_real_email_address() -> None:
    for path in FIXTURES.glob("*/*/*"):
        for match in EMAIL.findall(path.read_bytes()):
            # In a protobuf file the next field's tag byte can follow the
            # address and read as more of its domain.
            assert match.startswith(b"user@example.com"), f"{path.name}: {match!r}"
