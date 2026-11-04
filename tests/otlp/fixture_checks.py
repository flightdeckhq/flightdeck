"""Checks that a recorded OTLP fixture holds nothing of the recording machine
or of the accounts and keys it ran with.

Shared by the recorders (tests/otlp/recorder.py, used by
record_claude_code.py and record_genai.py), which refuse to write a
scenario that fails them, and by tests/integration/test_otlp_fixtures.py.
Dependency-free: protobuf files are read with a minimal wire-format
walker, so the checks run where opentelemetry-proto is not installed.
"""

from __future__ import annotations

import base64
import binascii
import json
import re
from collections.abc import Iterator, Mapping
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
    # The account a provider SDK records on its own spans (the Anthropic
    # Python SDK's anthropic.messages.create).
    "anthropic.organization.id": "00000000-0000-4000-8000-000000000003",
    "anthropic.workspace.id": "wrkspc_000000000000000000000001",
}
DROPPED_EVENTS = {"claude_code.managed_settings_resolved", "claude_code.plugin_loaded"}
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
# Credentials and account ids, by their published shapes: an Anthropic or
# OpenAI API key (sk-...), a Google API key, an OpenAI organization or
# project id, an AWS access key id, a Google OAuth access token, a GitHub
# token, a Flightdeck token.
CREDENTIAL = re.compile(
    r"\b(?:sk-[A-Za-z0-9_-]{20,}"
    r"|AIza[0-9A-Za-z_-]{30,}"
    r"|org-[A-Za-z0-9]{20,}"
    r"|proj_[A-Za-z0-9]{20,}"
    r"|(?:AKIA|ASIA)[0-9A-Z]{16}"
    r"|ya29\.[0-9A-Za-z_-]{20,}"
    r"|gh[pousr]_[A-Za-z0-9]{30,}"
    r"|github_pat_[A-Za-z0-9_]{20,}"
    r"|ftd_\w{16,})"
)
HOME = re.compile(r"/home/([^/\s\"']+)")
# A home directory in the dashed form Claude Code names a project
# directory by (/home/alice/repo -> -home-alice-repo), as a path component.
DASHED_HOME = re.compile(r"(?:^|/)-(?:home|Users|mnt-[a-z]-Users)-([^-/\s\"']+)")
# A home directory written ~name/.
TILDE_HOME = re.compile(r"(?<![\w~])~([A-Za-z][A-Za-z0-9._-]*)/")
# Paths that only a real machine has: WSL drives, Windows and macOS home
# directories, root's home, macOS per-user temporary directories.
FORBIDDEN = ("/mnt/", "C:\\", "/Users/", "/root/", "/var/folders/")
# Control characters a string value may hold and still be text.
_TEXT_CONTROLS = ("\n", "\r", "\t")
# What the protobuf walker reports as the value of a KeyValue whose value
# is not a string, so a placeholder key holding a number is still caught.
NOT_A_STRING = "<not a string>"


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
    if text.isprintable() or any(c in text for c in _TEXT_CONTROLS):
        return text
    return None


def _pb_walk(buf: bytes) -> Iterator[tuple[str, Any]]:
    """("text", s) for every string-looking value (bytes values included)
    and ("kv", (key, value)) for every OTLP KeyValue: its string value, or
    NOT_A_STRING for any other value."""
    fields = _as_message(buf)
    if fields is None:
        return
    # KeyValue: field 1 = key (string), field 2 = AnyValue whose field 1
    # is string_value (an empty AnyValue is an empty field 2).
    if len(fields) == 2 and fields[0][:2] == (1, 2) and fields[1][:2] == (2, 2):
        key = _as_text(fields[0][2])
        inner = _as_message(fields[1][2]) or []
        if key is not None:
            value = (
                _as_text(inner[0][2])
                if len(inner) == 1 and inner[0][:2] == (1, 2)
                else None
            )
            yield "kv", (key, NOT_A_STRING if value is None else value)
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
        if isinstance(doc.get("bytesValue"), str):
            # OTLP JSON writes a bytes AnyValue as base64; what it encodes
            # is checked like any other string.
            try:
                raw = base64.b64decode(doc["bytesValue"], validate=True)
            except (binascii.Error, ValueError):
                raw = b""
            text = _as_text(raw) if raw else None
            if text is not None:
                yield "text", text
        for v in doc.values():
            yield from _json_walk(v)
    elif isinstance(doc, list):
        for v in doc:
            yield from _json_walk(v)
    elif isinstance(doc, str):
        yield "text", doc


def _whole_word(value: str) -> re.Pattern[str]:
    return re.compile(
        r"(?<![A-Za-z0-9])" + re.escape(value) + r"(?![A-Za-z0-9])", re.IGNORECASE
    )


def problems(path: Path, machine: Mapping[str, str] | None = None) -> list[str]:
    """What in one fixture file would leak the recording machine.

    ``machine`` maps a description to a value that names the machine doing
    the recording (its host name, the user running the recorder); the
    recorder passes it, so a value no pattern can recognise is still
    caught. It is matched as a whole word, ignoring case."""
    out: list[str] = []
    data = path.read_bytes()
    if path.suffix == ".pb":
        if not data:
            return [f"{path.name}: empty protobuf"]
        items = list(_pb_walk(data))
    else:
        items = list(_json_walk(json.loads(data)))
    named = [(label, _whole_word(v)) for label, v in (machine or {}).items() if v]
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
        if CREDENTIAL.search(text):
            # The match itself is not repeated: it may be a live key.
            out.append(f"{path.name}: a provider API key, token or account id")
        for user in HOME.findall(text):
            if user != "user":
                out.append(f"{path.name}: home directory /home/{user}")
        for user in DASHED_HOME.findall(text) + TILDE_HOME.findall(text):
            if user != "user":
                out.append(f"{path.name}: home directory of {user!r}")
        for needle in FORBIDDEN:
            if needle in text:
                out.append(f"{path.name}: machine path {needle!r}")
        for label, pattern in named:
            if pattern.search(text):
                out.append(f"{path.name}: {label}")
    return sorted(set(out))


def directory_problems(
    scenario: Path, machine: Mapping[str, str] | None = None
) -> list[str]:
    """problems() for every file of a scenario, the manifest included (it
    can hold what the provider answered), and that the manifest lists
    exactly the request files present."""
    out: list[str] = []
    manifest = json.loads((scenario / "manifest.json").read_text())
    listed = {r["file"] for r in manifest["requests"]}
    present = {p.name for p in scenario.iterdir() if p.name != "manifest.json"}
    if listed != present:
        out.append(
            f"{scenario.name}: manifest lists {sorted(listed ^ present)} differently from the files"
        )
    for name in [*sorted(present), "manifest.json"]:
        out.extend(problems(scenario / name, machine))
    return out
