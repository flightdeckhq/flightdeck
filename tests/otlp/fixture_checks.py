"""Checks that a recorded OTLP fixture holds nothing of the recording machine.

Shared by the recorder (tests/otlp/record_claude_code.py), which refuses
to write a scenario that fails them, and by
tests/integration/test_otlp_fixtures.py. Dependency-free: protobuf files
are read with a minimal wire-format walker, so the checks run where
opentelemetry-proto is not installed.
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterator
from pathlib import Path
from typing import Any

# The values the recorder puts in place of identity and machine
# attributes; any other value under these keys is a leak.
PLACEHOLDERS = {
    "user.email": "user@example.com",
    "user.account_uuid": "00000000-0000-4000-8000-000000000001",
    "user.account_id": "user_000000000000000000000001",
    "user.id": "0" * 64,
    "organization.id": "00000000-0000-4000-8000-000000000002",
    "os.version": "6.6.0",
    "wsl.version": "2",
    "host.name": "host",
}
DROPPED_EVENTS = {"claude_code.managed_settings_resolved", "claude_code.plugin_loaded"}
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
HOME = re.compile(r"/home/([^/\s\"']+)")
FORBIDDEN = ("/mnt/", "C:\\", "/Users/")


# -- protobuf wire format ------------------------------------------------------


def _varint(buf: bytes, i: int) -> tuple[int, int]:
    shift = result = 0
    while True:
        if i >= len(buf) or shift > 63:
            raise ValueError("bad varint")
        b = buf[i]
        i += 1
        result |= (b & 0x7F) << shift
        if not b & 0x80:
            return result, i
        shift += 7


def _fields(buf: bytes) -> list[tuple[int, int, Any]]:
    """The fields of a message, or ValueError when buf is not one."""
    out: list[tuple[int, int, Any]] = []
    i = 0
    while i < len(buf):
        key, i = _varint(buf, i)
        number, wire = key >> 3, key & 7
        if number == 0:
            raise ValueError("field 0")
        if wire == 0:
            value, i = _varint(buf, i)
        elif wire == 1:
            value, i = buf[i : i + 8], i + 8
        elif wire == 5:
            value, i = buf[i : i + 4], i + 4
        elif wire == 2:
            size, i = _varint(buf, i)
            if i + size > len(buf):
                raise ValueError("bad length")
            value, i = buf[i : i + size], i + size
        else:
            raise ValueError(f"wire type {wire}")
        out.append((number, wire, value))
    if i != len(buf):
        raise ValueError("trailing bytes")
    return out


def _as_message(buf: bytes) -> list[tuple[int, int, Any]] | None:
    try:
        return _fields(buf) if buf else None
    except ValueError:
        return None


def _as_text(buf: bytes) -> str | None:
    try:
        text = buf.decode("utf-8")
    except UnicodeDecodeError:
        return None
    return text if text.isprintable() or "\n" in text else None


def _pb_walk(buf: bytes) -> Iterator[tuple[str, Any]]:
    """("text", s) for every string-looking value and ("kv", (key, value))
    for every OTLP KeyValue whose value is a string AnyValue."""
    fields = _as_message(buf)
    if fields is None:
        return
    # KeyValue: field 1 = key (string), field 2 = AnyValue whose field 1
    # is string_value.
    if len(fields) == 2 and fields[0][:2] == (1, 2) and fields[1][:2] == (2, 2):
        key = _as_text(fields[0][2])
        inner = _as_message(fields[1][2])
        if key is not None and inner and inner[0][:2] == (1, 2):
            value = _as_text(inner[0][2])
            if value is not None:
                yield "kv", (key, value)
    for _, wire, value in fields:
        if wire != 2:
            continue
        text = _as_text(value)
        if text is not None:
            yield "text", text
        yield from _pb_walk(value)


# -- JSON ---------------------------------------------------------------------------


def _json_walk(doc: Any) -> Iterator[tuple[str, Any]]:
    if isinstance(doc, dict):
        if isinstance(doc.get("key"), str) and isinstance(doc.get("value"), dict):
            value = next(iter(doc["value"].values()), None) if doc["value"] else None
            if isinstance(value, str):
                yield "kv", (doc["key"], value)
        for v in doc.values():
            yield from _json_walk(v)
    elif isinstance(doc, list):
        for v in doc:
            yield from _json_walk(v)
    elif isinstance(doc, str):
        yield "text", doc


def problems(path: Path) -> list[str]:
    """What in one fixture file would leak the recording machine."""
    out: list[str] = []
    data = path.read_bytes()
    if path.suffix == ".pb":
        if not data:
            return [f"{path.name}: empty protobuf"]
        items = list(_pb_walk(data))
    else:
        items = list(_json_walk(json.loads(data)))
    for kind, item in items:
        if kind == "kv":
            key, value = item
            if key in PLACEHOLDERS and value != PLACEHOLDERS[key]:
                out.append(f"{path.name}: {key} is not its placeholder")
            if value in DROPPED_EVENTS:
                out.append(f"{path.name}: dropped record type {value}")
            if key == "server_scope" and value == "claudeai":
                out.append(f"{path.name}: a claude.ai connector record")
            continue
        text = item
        if text in DROPPED_EVENTS:
            out.append(f"{path.name}: dropped record type {text}")
        for email in EMAIL.findall(text):
            if email != PLACEHOLDERS["user.email"]:
                out.append(f"{path.name}: email address {email!r}")
        for user in HOME.findall(text):
            if user != "user":
                out.append(f"{path.name}: home directory /home/{user}")
        for needle in FORBIDDEN:
            if needle in text:
                out.append(f"{path.name}: machine path {needle!r}")
    return sorted(set(out))


def directory_problems(scenario: Path) -> list[str]:
    """problems() for every file of a scenario, and that the manifest
    lists exactly the request files present."""
    out: list[str] = []
    manifest = json.loads((scenario / "manifest.json").read_text())
    listed = {r["file"] for r in manifest["requests"]}
    present = {p.name for p in scenario.iterdir() if p.name != "manifest.json"}
    if listed != present:
        out.append(
            f"{scenario.name}: manifest lists {sorted(listed ^ present)} differently from the files"
        )
    for name in sorted(present):
        out.extend(problems(scenario / name))
    return out
