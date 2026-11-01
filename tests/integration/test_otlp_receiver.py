"""The OTLP/HTTP receiver answers recorded Claude Code exports.

Every request under tests/fixtures/otlp/claude-code-2.1.316 is replayed
through the edge proxy as Claude Code sent it (protobuf gzipped, or OTLP
JSON), and the answer must be a 200 export response in the request's
encoding whose partial_success counts every record: no source is mapped
to events yet, so each record is accepted and counted as rejected. The
record count is taken from the fixture itself, independently of the
receiver.
"""

from __future__ import annotations

import gzip
import json
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

import pytest

from ..otlp.fixture_checks import _fields
from .conftest import INGESTION_URL, TOKEN

FIXTURES = (
    Path(__file__).resolve().parents[1] / "fixtures" / "otlp" / "claude-code-2.1.316"
)

PROTOBUF = "application/x-protobuf"
JSON = "application/json"

# The partial_success field each signal counts its rejections in.
REJECTED_FIELD = {
    "/v1/logs": "rejectedLogRecords",
    "/v1/traces": "rejectedSpans",
    "/v1/metrics": "rejectedDataPoints",
}

# Protobuf field numbers: ExportMetricsServiceRequest.resource_metrics
# -> ResourceMetrics.scope_metrics -> ScopeMetrics.metrics, whose data
# is one of gauge (5), sum (7), histogram (9), exponential_histogram
# (10) or summary (11), each holding data_points as field 1. Logs and
# traces nest the same way (1 -> 2 -> 2) down to their records.
_METRIC_DATA_FIELDS = {5, 7, 9, 10, 11}
_METRIC_DATA_JSON = ("gauge", "sum", "histogram", "exponentialHistogram", "summary")

# The receiver's request cap as sent, which the edge proxy must admit.
_COMPRESSED_CAP = 4 << 20


def _requests() -> list[tuple[str, dict[str, Any]]]:
    out = []
    for manifest in sorted(FIXTURES.glob("*/manifest.json")):
        doc = json.loads(manifest.read_text())
        out.extend((manifest.parent.name, r) for r in doc["requests"])
    return out


def _sub(buf: bytes, number: int) -> list[bytes]:
    return [v for n, wire, v in _fields(buf) if n == number and wire == 2]


def _count_protobuf(path: str, buf: bytes) -> int:
    if path == "/v1/metrics":
        return sum(
            len(_sub(data, 1))
            for rm in _sub(buf, 1)
            for sm in _sub(rm, 2)
            for metric in _sub(sm, 2)
            for n, wire, data in _fields(metric)
            if n in _METRIC_DATA_FIELDS and wire == 2
        )
    return sum(len(_sub(scope, 2)) for res in _sub(buf, 1) for scope in _sub(res, 2))


def _count_json(path: str, doc: dict[str, Any]) -> int:
    if path == "/v1/logs":
        return sum(
            len(sl.get("logRecords", []))
            for rl in doc.get("resourceLogs", [])
            for sl in rl.get("scopeLogs", [])
        )
    if path == "/v1/traces":
        return sum(
            len(ss.get("spans", []))
            for rs in doc.get("resourceSpans", [])
            for ss in rs.get("scopeSpans", [])
        )
    return sum(
        len(m[kind].get("dataPoints", []))
        for rm in doc.get("resourceMetrics", [])
        for sm in rm.get("scopeMetrics", [])
        for m in sm.get("metrics", [])
        for kind in _METRIC_DATA_JSON
        if kind in m
    )


def _post(
    path: str,
    body: bytes,
    content_type: str,
    *,
    encoding: str | None = None,
    token: str | None = TOKEN,
) -> tuple[int, dict[str, str], bytes]:
    headers = {"Content-Type": content_type}
    if encoding:
        headers["Content-Encoding"] = encoding
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(
        f"{INGESTION_URL}{path}", data=body, headers=headers, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, dict(resp.headers), resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, dict(exc.headers), exc.read()


def _partial_success(path: str, content_type: str, body: bytes) -> tuple[int, str]:
    """The (rejected count, message) of an export response."""
    if content_type == JSON:
        ps = json.loads(body).get("partialSuccess", {})
        # protojson writes int64 as a string; OTLP JSON allows either.
        return int(ps.get(REJECTED_FIELD[path], 0)), ps.get("errorMessage", "")
    rejected, message = 0, ""
    for partial in _sub(body, 1):
        for n, _wire, value in _fields(partial):
            if n == 1:
                rejected = value
            elif n == 2:
                message = value.decode()
    return rejected, message


@pytest.mark.parametrize(
    ("scenario", "request_"),
    _requests(),
    ids=[f"{s}/{r['file']}" for s, r in _requests()],
)
def test_recorded_export_is_answered_with_every_record_rejected(
    scenario: str, request_: dict[str, Any]
) -> None:
    raw = (FIXTURES / scenario / request_["file"]).read_bytes()
    path, content_type = request_["path"], request_["content_type"]
    if content_type == PROTOBUF:
        records = _count_protobuf(path, raw)
    else:
        records = _count_json(path, json.loads(raw))
    assert records > 0, f"fixture {request_['file']} carries no records"

    gzipped = request_.get("sent_encoding") == "gzip"
    status, headers, body = _post(
        path,
        gzip.compress(raw) if gzipped else raw,
        content_type,
        encoding="gzip" if gzipped else None,
    )

    assert status == 200, body
    assert headers.get("Content-Type") == content_type
    rejected, message = _partial_success(path, content_type, body)
    assert rejected == records
    assert '"claude-code" is not mapped' in message, message


@pytest.mark.parametrize("content_type", [PROTOBUF, JSON])
def test_same_logs_in_both_encodings_and_compressions(content_type: str) -> None:
    """One log export, sent as protobuf and as JSON, each plain and
    gzipped: the encoding and the compression are independent."""
    if content_type == PROTOBUF:
        raw = (FIXTURES / "bash-protobuf-gzip" / "006-logs.pb").read_bytes()
        records = _count_protobuf("/v1/logs", raw)
    else:
        raw = (FIXTURES / "bash-json-prompts" / "008-logs.json").read_bytes()
        records = _count_json("/v1/logs", json.loads(raw))
    for body, encoding in ((raw, None), (gzip.compress(raw), "gzip")):
        status, _headers, resp = _post(
            "/v1/logs", body, content_type, encoding=encoding
        )
        assert status == 200, resp
        assert _partial_success("/v1/logs", content_type, resp)[0] == records


def test_refusals_carry_a_status_in_the_request_encoding() -> None:
    status, headers, body = _post("/v1/logs", b"{}", JSON, token=None)
    assert status == 401
    assert json.loads(body)["code"] == 16  # UNAUTHENTICATED

    status, headers, body = _post("/v1/traces", b"\xff\xff\xff", PROTOBUF)
    assert status == 400
    assert headers.get("Content-Type") == PROTOBUF
    assert dict((n, v) for n, _w, v in _fields(body))[1] == 3  # INVALID_ARGUMENT

    status, _headers, body = _post("/v1/metrics", b"{}", "text/plain")
    assert status == 415
    assert json.loads(body)["code"] == 3


def test_edge_proxy_admits_the_request_cap() -> None:
    """A body between nginx's 1m default and the receiver's 4 MiB cap
    reaches ingestion; a body over the cap is refused with 413."""
    padded = b"{}" + b" " * (_COMPRESSED_CAP - 2)
    status, _headers, body = _post("/v1/logs", padded, JSON)
    assert status == 200, body

    status, _headers, _body = _post("/v1/logs", padded + b" " * (1 << 20), JSON)
    assert status == 413
