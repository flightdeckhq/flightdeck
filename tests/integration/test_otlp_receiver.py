"""The OTLP/HTTP receiver answers recorded Claude Code exports.

Every request under tests/fixtures/otlp/claude-code-2.1.316 is replayed
through the edge proxy as Claude Code sent it (protobuf gzipped, or OTLP
JSON), and the answer must be a 200 export response in the request's
encoding whose partial_success counts the records Flightdeck does not
use. Claude Code's spans and metrics are never used, so every one is
counted. Its log records are mapped to events, so a log export is
replayed under a fresh session id, at the current time and under a test
flavor (tests/otlp/replay.py) and only the records the contract does not
map are counted. The counts are taken from the fixture itself,
independently of the receiver; test_otlp_claude_code.py checks what the
mapped records become.
"""

from __future__ import annotations

import gzip
import json
import time
import urllib.error
import urllib.request
import uuid
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from ..otlp.fixture_checks import _fields
from ..otlp.replay import is_mapped, latest_time_ns, record_attributes, rewrite_logs
from .conftest import INGESTION_URL, TOKEN, delete_flavor_data

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


def _requests(*, logs: bool) -> list[tuple[str, dict[str, Any]]]:
    """The recorded requests of one kind: the log exports, or the span
    and metric exports."""
    out = []
    for manifest in sorted(FIXTURES.glob("*/manifest.json")):
        doc = json.loads(manifest.read_text())
        out.extend(
            (manifest.parent.name, r)
            for r in doc["requests"]
            if (r["path"] == "/v1/logs") == logs
        )
    return out


@pytest.fixture
def flavor() -> Iterator[str]:
    name = f"otlp-rx-{uuid.uuid4().hex[:10]}"
    yield name
    delete_flavor_data(name)


def _replayable(content_type: str, raw: bytes, flavor: str) -> bytes:
    """A recorded log export under a fresh session id, at the current
    time, under the test's flavor."""
    shift = time.time_ns() - latest_time_ns([(content_type, raw)]) - 1_000_000_000
    return rewrite_logs(
        content_type,
        raw,
        session_id=str(uuid.uuid4()),
        shift_ns=shift,
        resource_attrs={"flightdeck.flavor": flavor},
    )


def _unmapped(content_type: str, raw: bytes) -> int:
    return sum(1 for a in record_attributes(content_type, raw) if not is_mapped(a))


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
    _requests(logs=False),
    ids=[f"{s}/{r['file']}" for s, r in _requests(logs=False)],
)
def test_recorded_spans_and_metrics_are_answered_all_rejected(
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


@pytest.mark.parametrize(
    ("scenario", "request_"),
    _requests(logs=True),
    ids=[f"{s}/{r['file']}" for s, r in _requests(logs=True)],
)
def test_recorded_log_export_counts_the_records_not_mapped(
    scenario: str, request_: dict[str, Any], flavor: str
) -> None:
    raw = (FIXTURES / scenario / request_["file"]).read_bytes()
    content_type = request_["content_type"]
    body = _replayable(content_type, raw, flavor)
    gzipped = request_.get("sent_encoding") == "gzip"
    status, headers, resp = _post(
        "/v1/logs",
        gzip.compress(body) if gzipped else body,
        content_type,
        encoding="gzip" if gzipped else None,
    )

    assert status == 200, resp
    assert headers.get("Content-Type") == content_type
    rejected, message = _partial_success("/v1/logs", content_type, resp)
    assert rejected == _unmapped(content_type, raw), message


@pytest.mark.parametrize("content_type", [PROTOBUF, JSON])
def test_same_logs_in_both_encodings_and_compressions(
    content_type: str, flavor: str
) -> None:
    """One log export, sent as protobuf and as JSON, each plain and
    gzipped: the encoding and the compression are independent."""
    if content_type == PROTOBUF:
        raw = (FIXTURES / "bash-protobuf-gzip" / "006-logs.pb").read_bytes()
    else:
        raw = (FIXTURES / "bash-json-prompts" / "008-logs.json").read_bytes()
    unmapped = _unmapped(content_type, raw)
    assert unmapped < len(record_attributes(content_type, raw))
    for gz in (False, True):
        body = _replayable(content_type, raw, flavor)
        status, _headers, resp = _post(
            "/v1/logs",
            gzip.compress(body) if gz else body,
            content_type,
            encoding="gzip" if gz else None,
        )
        assert status == 200, resp
        assert _partial_success("/v1/logs", content_type, resp)[0] == unmapped


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


def test_wide_body_refused_before_decoding() -> None:
    """Nearly 16 MiB of empty objects, gzipped to a few KiB, would decode
    into gigabytes: the receiver estimates the cost first and answers
    413 with a Status naming the memory limit."""
    count = (16 << 20) // 3 - 20
    wide = b'{"resourceLogs":[' + b",".join([b"{}"] * count) + b"]}"
    status, _headers, body = _post(
        "/v1/logs", gzip.compress(wide), JSON, encoding="gzip"
    )
    assert status == 413, body
    status_body = json.loads(body)
    assert status_body["code"] == 8  # RESOURCE_EXHAUSTED
    assert "memory limit" in status_body["message"]
