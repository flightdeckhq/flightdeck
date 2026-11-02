"""Rewrite recorded OTLP log exports for replay into a live stack.

A recorded scenario cannot be replayed as it is: its records carry the
time they were recorded, which the ingestion API's clock-skew window
refuses after two days, and one Claude Code session id, so a second
replay would land on the first one's sessions. ``rewrite_logs`` gives
every record of a replay a fresh session id and moves its timestamps so
the last record is the moment of the replay, keeping the intervals
between records, and can add resource attributes the way an operator
sets ``OTEL_RESOURCE_ATTRIBUTES``.

Dependency-free like fixture_checks: protobuf requests are rewritten
through the minimal wire-format walker, so CI needs no protobuf package.
"""

from __future__ import annotations

import json
import struct
from typing import Any

from .fixture_checks import _fields

# Protobuf field numbers on the logs path: ExportLogsServiceRequest
# .resource_logs (1) -> ResourceLogs .resource (1) / .scope_logs (2) ->
# ScopeLogs .log_records (2) -> LogRecord .time_unix_nano (1, fixed64),
# .observed_time_unix_nano (11, fixed64), .attributes (6). Resource
# .attributes is 1; KeyValue is key (1) and value (2), AnyValue's
# string_value is 1.
_REQ_RESOURCE_LOGS = 1
_RL_RESOURCE = 1
_RL_SCOPE_LOGS = 2
_SL_LOG_RECORDS = 2
_LR_TIME = 1
_LR_OBSERVED_TIME = 11
_LR_ATTRIBUTES = 6
_RES_ATTRIBUTES = 1

SESSION_ATTR = "session.id"


def _varint(n: int) -> bytes:
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def _encode(fields: list[tuple[int, int, Any]]) -> bytes:
    out = bytearray()
    for number, wire, value in fields:
        out += _varint(number << 3 | wire)
        if wire == 0:
            out += _varint(value)
        elif wire == 2:
            out += _varint(len(value)) + value
        else:  # fixed64 (1) or fixed32 (5): kept as their raw bytes
            out += value
    return bytes(out)


def _len(number: int, payload: bytes) -> tuple[int, int, bytes]:
    return (number, 2, payload)


def _string_kv(key: str, value: str) -> bytes:
    any_value = _encode([_len(1, value.encode())])
    return _encode([_len(1, key.encode()), _len(2, any_value)])


def _kv_key(buf: bytes) -> str | None:
    for number, wire, value in _fields(buf):
        if number == 1 and wire == 2:
            return bytes(value).decode()
    return None


def _shift_fixed64(raw: bytes, shift_ns: int) -> bytes:
    (t,) = struct.unpack("<Q", raw)
    return raw if t == 0 else struct.pack("<Q", t + shift_ns)


def latest_time_ns(requests: list[tuple[str, bytes]]) -> int:
    """The latest record time across a scenario's log requests."""
    latest = 0
    for content_type, body in requests:
        if content_type == "application/json":
            for rec in _json_records(json.loads(body)):
                latest = max(latest, int(rec.get("timeUnixNano", 0)))
            continue
        for _, _, rl in _sub(body, _REQ_RESOURCE_LOGS):
            for _, _, sl in _sub(rl, _RL_SCOPE_LOGS):
                for _, _, lr in _sub(sl, _SL_LOG_RECORDS):
                    for number, wire, value in _fields(lr):
                        if number == _LR_TIME and wire == 1:
                            latest = max(latest, struct.unpack("<Q", value)[0])
    return latest


def _sub(buf: bytes, number: int) -> list[tuple[int, int, Any]]:
    return [f for f in _fields(buf) if f[0] == number and f[1] == 2]


def _json_records(doc: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        rec
        for rl in doc.get("resourceLogs", [])
        for sl in rl.get("scopeLogs", [])
        for rec in sl.get("logRecords", [])
    ]


def record_attributes(content_type: str, body: bytes) -> list[dict[str, str]]:
    """The string attributes of every log record of an export, in order
    (non-string values are left out)."""
    if content_type == "application/json":
        out = []
        for rec in _json_records(json.loads(body)):
            attrs = {}
            for kv in rec.get("attributes", []):
                value = kv.get("value", {})
                if "stringValue" in value:
                    attrs[kv["key"]] = value["stringValue"]
            out.append(attrs)
        return out
    out = []
    for _, _, rl in _sub(body, _REQ_RESOURCE_LOGS):
        for _, _, sl in _sub(rl, _RL_SCOPE_LOGS):
            for _, _, lr in _sub(sl, _SL_LOG_RECORDS):
                attrs = {}
                for _, _, kv in _sub(lr, _LR_ATTRIBUTES):
                    key = _kv_key(kv)
                    for n, w, any_value in _fields(kv):
                        if n == 2 and w == 2:
                            for n2, w2, s in _fields(any_value):
                                if n2 == 1 and w2 == 2 and key is not None:
                                    attrs[key] = bytes(s).decode()
                out.append(attrs)
    return out


# The Claude Code records the ingestion API maps to events (event.name);
# a tool_decision only when it is a reject. Every other record is
# counted as rejected.
MAPPED_RECORDS = {
    "user_prompt",
    "api_request",
    "api_error",
    "tool_result",
    "subagent_completed",
}


def is_mapped(attrs: dict[str, str]) -> bool:
    name = attrs.get("event.name", "")
    if name == "tool_decision":
        return attrs.get("decision") == "reject"
    return name in MAPPED_RECORDS


def rewrite_logs(
    content_type: str,
    body: bytes,
    *,
    session_id: str,
    shift_ns: int,
    resource_attrs: dict[str, str] | None = None,
) -> bytes:
    """One log export with its records moved to ``session_id`` and
    ``shift_ns`` later, and ``resource_attrs`` added to each resource."""
    extra = resource_attrs or {}
    if content_type == "application/json":
        doc = json.loads(body)
        for rl in doc.get("resourceLogs", []):
            attrs = rl.setdefault("resource", {}).setdefault("attributes", [])
            attrs.extend(
                {"key": k, "value": {"stringValue": v}} for k, v in extra.items()
            )
            for sl in rl.get("scopeLogs", []):
                for rec in sl.get("logRecords", []):
                    for key in ("timeUnixNano", "observedTimeUnixNano"):
                        if int(rec.get(key, 0)):
                            rec[key] = str(int(rec[key]) + shift_ns)
                    for kv in rec.get("attributes", []):
                        if kv["key"] == SESSION_ATTR:
                            kv["value"] = {"stringValue": session_id}
        return json.dumps(doc).encode()

    def record(lr: bytes) -> bytes:
        out = []
        for number, wire, value in _fields(lr):
            if number in (_LR_TIME, _LR_OBSERVED_TIME) and wire == 1:
                value = _shift_fixed64(value, shift_ns)
            elif (
                number == _LR_ATTRIBUTES
                and wire == 2
                and _kv_key(value) == SESSION_ATTR
            ):
                value = _string_kv(SESSION_ATTR, session_id)
            out.append((number, wire, value))
        return _encode(out)

    def scope_logs(sl: bytes) -> bytes:
        return _encode(
            [
                (n, w, record(v) if n == _SL_LOG_RECORDS and w == 2 else v)
                for n, w, v in _fields(sl)
            ]
        )

    def resource(res: bytes) -> bytes:
        added = [_len(_RES_ATTRIBUTES, _string_kv(k, v)) for k, v in extra.items()]
        return _encode(list(_fields(res)) + added)

    def resource_logs(rl: bytes) -> bytes:
        out = []
        for n, w, v in _fields(rl):
            if n == _RL_RESOURCE and w == 2:
                v = resource(v)
            elif n == _RL_SCOPE_LOGS and w == 2:
                v = scope_logs(v)
            out.append((n, w, v))
        return _encode(out)

    return _encode(
        [
            (n, w, resource_logs(v) if n == _REQ_RESOURCE_LOGS and w == 2 else v)
            for n, w, v in _fields(body)
        ]
    )
