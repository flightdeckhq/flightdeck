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


# ---------------------------------------------------------------------------
# GenAI framework exports (spans and Google ADK's log records).
#
# A recorded GenAI scenario cannot be replayed as it is either: its
# records carry the time they were recorded, and its trace ids, which
# with the token key name the staged trace and every session id derived
# from it, so a second replay would land on the first one's sessions.
# ``rewrite_genai`` moves every span and log record ``shift_ns`` later,
# replaces each trace id with its XOR against a per-replay key (so the
# files of one scenario keep sharing their traces), and adds resource
# attributes. Field numbers on the traces path:
# ExportTraceServiceRequest .resource_spans (1) -> ResourceSpans
# .resource (1) / .scope_spans (2) -> ScopeSpans .spans (2) -> Span
# .trace_id (1), .start_time_unix_nano (7, fixed64), .end_time_unix_nano
# (8, fixed64), .attributes (9), .events (11) -> Span.Event
# .time_unix_nano (1, fixed64). A LogRecord's trace_id is 9.

_REQ_RESOURCE_SPANS = 1
_RS_RESOURCE = 1
_RS_SCOPE_SPANS = 2
_SS_SPANS = 2
_SP_TRACE_ID = 1
_SP_START = 7
_SP_END = 8
_SP_ATTRIBUTES = 9
_SP_EVENTS = 11
_EV_TIME = 1
_LR_TRACE_ID = 9


def _xor(raw: bytes, key: bytes) -> bytes:
    return (
        bytes(a ^ b for a, b in zip(raw, key, strict=True))
        if len(raw) == len(key)
        else raw
    )


def _json_spans(doc: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        sp
        for rs in doc.get("resourceSpans", [])
        for ss in rs.get("scopeSpans", [])
        for sp in ss.get("spans", [])
    ]


def _pb_spans(body: bytes) -> list[bytes]:
    return [
        sp
        for _, _, rs in _sub(body, _REQ_RESOURCE_SPANS)
        for _, _, ss in _sub(rs, _RS_SCOPE_SPANS)
        for _, _, sp in _sub(ss, _SS_SPANS)
    ]


def _pb_string_attrs(buf: bytes, number: int) -> dict[str, str]:
    attrs: dict[str, str] = {}
    for _, _, kv in _sub(buf, number):
        key = _kv_key(kv)
        for n, w, any_value in _fields(kv):
            if n == 2 and w == 2:
                for n2, w2, s in _fields(any_value):
                    if n2 == 1 and w2 == 2 and key is not None:
                        attrs[key] = bytes(s).decode()
    return attrs


def genai_record_times(path: str, content_type: str, body: bytes) -> list[int]:
    """Every span end and log record time of one GenAI export, in ns."""
    times: list[int] = []
    if content_type == "application/json":
        doc = json.loads(body)
        if path == "/v1/traces":
            times += [int(sp.get("endTimeUnixNano", 0)) for sp in _json_spans(doc)]
        elif path == "/v1/logs":
            # A log record is dated by its time, else its observed time
            # (Google ADK sets only the latter), as ingestion reads it.
            times += [
                int(rec.get("timeUnixNano", 0))
                or int(rec.get("observedTimeUnixNano", 0))
                for rec in _json_records(doc)
            ]
        return [t for t in times if t]
    if path == "/v1/traces":
        for sp in _pb_spans(body):
            for n, w, v in _fields(sp):
                if n == _SP_END and w == 1:
                    times.append(struct.unpack("<Q", v)[0])
    elif path == "/v1/logs":
        for _, _, rl in _sub(body, _REQ_RESOURCE_LOGS):
            for _, _, sl in _sub(rl, _RL_SCOPE_LOGS):
                for _, _, lr in _sub(sl, _SL_LOG_RECORDS):
                    at = {
                        n: struct.unpack("<Q", v)[0]
                        for n, w, v in _fields(lr)
                        if w == 1 and n in (_LR_TIME, _LR_OBSERVED_TIME)
                    }
                    times.append(at.get(_LR_TIME) or at.get(_LR_OBSERVED_TIME, 0))
    return [t for t in times if t]


def genai_agent_spans(content_type: str, body: bytes) -> list[dict[str, Any]]:
    """The named invoke_agent spans of a trace export: their agent name,
    trace id (hex) and start and end in ns."""
    out: list[dict[str, Any]] = []
    if content_type == "application/json":
        for sp in _json_spans(json.loads(body)):
            attrs = {
                kv["key"]: kv.get("value", {}).get("stringValue")
                for kv in sp.get("attributes", [])
            }
            if (
                attrs.get("gen_ai.operation.name") == "invoke_agent"
                and (attrs.get("gen_ai.agent.name") or "").strip()
            ):
                out.append(
                    {
                        "agent": attrs["gen_ai.agent.name"],
                        "trace": sp["traceId"].lower(),
                        "start": int(sp["startTimeUnixNano"]),
                        "end": int(sp["endTimeUnixNano"]),
                    }
                )
        return out
    for sp in _pb_spans(body):
        attrs = _pb_string_attrs(sp, _SP_ATTRIBUTES)
        if (
            attrs.get("gen_ai.operation.name") != "invoke_agent"
            or not (attrs.get("gen_ai.agent.name") or "").strip()
        ):
            continue
        span: dict[str, Any] = {"agent": attrs["gen_ai.agent.name"]}
        for n, w, v in _fields(sp):
            if n == _SP_TRACE_ID and w == 2:
                span["trace"] = bytes(v).hex()
            elif n == _SP_START and w == 1:
                span["start"] = struct.unpack("<Q", v)[0]
            elif n == _SP_END and w == 1:
                span["end"] = struct.unpack("<Q", v)[0]
        out.append(span)
    return out


def genai_trace_ids(path: str, content_type: str, body: bytes) -> set[str]:
    """The trace ids (hex) the records of one GenAI export belong to."""
    if content_type == "application/json":
        doc = json.loads(body)
        recs = _json_spans(doc) if path == "/v1/traces" else _json_records(doc)
        return {r["traceId"].lower() for r in recs if r.get("traceId")}
    ids: set[str] = set()
    if path == "/v1/traces":
        for sp in _pb_spans(body):
            ids |= {
                bytes(v).hex()
                for n, w, v in _fields(sp)
                if n == _SP_TRACE_ID and w == 2
            }
    else:
        for _, _, rl in _sub(body, _REQ_RESOURCE_LOGS):
            for _, _, sl in _sub(rl, _RL_SCOPE_LOGS):
                for _, _, lr in _sub(sl, _SL_LOG_RECORDS):
                    ids |= {
                        bytes(v).hex()
                        for n, w, v in _fields(lr)
                        if n == _LR_TRACE_ID and w == 2
                    }
    return ids


def rewrite_genai(
    path: str,
    content_type: str,
    body: bytes,
    *,
    trace_key: bytes,
    shift_ns: int,
    resource_attrs: dict[str, str],
) -> bytes:
    """One GenAI export (traces or logs) with its records ``shift_ns``
    later, its trace ids XORed with ``trace_key`` (16 bytes) and
    ``resource_attrs`` added to each resource, one created where the
    exporter sent none (Google ADK's is empty). Metrics are returned as
    they are: they are rejected whatever they hold."""
    if path == "/v1/metrics":
        return body
    if content_type == "application/json":
        doc = json.loads(body)
        resources = doc.get(
            "resourceSpans" if path == "/v1/traces" else "resourceLogs", []
        )
        for res in resources:
            attrs = res.setdefault("resource", {}).setdefault("attributes", [])
            attrs.extend(
                {"key": k, "value": {"stringValue": v}}
                for k, v in resource_attrs.items()
            )
        recs = _json_spans(doc) if path == "/v1/traces" else _json_records(doc)
        for rec in recs:
            if rec.get("traceId"):
                rec["traceId"] = _xor(bytes.fromhex(rec["traceId"]), trace_key).hex()
            for key in (
                "startTimeUnixNano",
                "endTimeUnixNano",
                "timeUnixNano",
                "observedTimeUnixNano",
            ):
                if int(rec.get(key, 0)):
                    rec[key] = str(int(rec[key]) + shift_ns)
            for ev in rec.get("events", []):
                if int(ev.get("timeUnixNano", 0)):
                    ev["timeUnixNano"] = str(int(ev["timeUnixNano"]) + shift_ns)
        return json.dumps(doc).encode()

    added = [_len(_RES_ATTRIBUTES, _string_kv(k, v)) for k, v in resource_attrs.items()]

    def event(ev: bytes) -> bytes:
        return _encode(
            [
                (n, w, _shift_fixed64(v, shift_ns) if n == _EV_TIME and w == 1 else v)
                for n, w, v in _fields(ev)
            ]
        )

    def span(sp: bytes) -> bytes:
        out = []
        for n, w, v in _fields(sp):
            if n == _SP_TRACE_ID and w == 2:
                v = _xor(bytes(v), trace_key)
            elif n in (_SP_START, _SP_END) and w == 1:
                v = _shift_fixed64(v, shift_ns)
            elif n == _SP_EVENTS and w == 2:
                v = event(v)
            out.append((n, w, v))
        return _encode(out)

    def log_record(lr: bytes) -> bytes:
        out = []
        for n, w, v in _fields(lr):
            if n == _LR_TRACE_ID and w == 2:
                v = _xor(bytes(v), trace_key)
            elif n in (_LR_TIME, _LR_OBSERVED_TIME) and w == 1:
                v = _shift_fixed64(v, shift_ns)
            out.append((n, w, v))
        return _encode(out)

    records_field, record = (
        (_SS_SPANS, span) if path == "/v1/traces" else (_SL_LOG_RECORDS, log_record)
    )
    scope_field = _RS_SCOPE_SPANS if path == "/v1/traces" else _RL_SCOPE_LOGS
    top_field = _REQ_RESOURCE_SPANS if path == "/v1/traces" else _REQ_RESOURCE_LOGS

    def scope(sc: bytes) -> bytes:
        return _encode(
            [
                (n, w, record(v) if n == records_field and w == 2 else v)
                for n, w, v in _fields(sc)
            ]
        )

    def resource_block(rb: bytes) -> bytes:
        out = []
        has_resource = False
        for n, w, v in _fields(rb):
            if n == _RS_RESOURCE and w == 2:
                has_resource = True
                v = _encode(list(_fields(v)) + added)
            elif n == scope_field and w == 2:
                v = scope(v)
            out.append((n, w, v))
        if not has_resource:
            out.insert(0, _len(_RS_RESOURCE, _encode(added)))
        return _encode(out)

    return _encode(
        [
            (n, w, resource_block(v) if n == top_field and w == 2 else v)
            for n, w, v in _fields(body)
        ]
    )
