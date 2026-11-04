"""Ingestion validates the stream diagnostics before they reach the bus.

A post_call's ``streaming`` block and a failed stream's ``llm_error``
``error`` object are POSTed through the real ingestion API, processed by
the worker and read back from ``GET /v1/sessions/:id``:

* a value in the vocabulary is stored as sent;
* an outcome, abort reason or llm_error type the server does not know
  is stored as ``other`` and the event still counts (its tokens reach
  ``tokens_used``);
* a negative or malformed count, a value of the wrong type, or a block
  that is not an object is refused with 400 and stored nowhere;
* a key that differs from a field name only in case is refused with 400
  and stored nowhere, since the worker would read it as that field.

Wire-seeded, mock-free. Parallel-safe: a fresh session id and a unique
flavor per test.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
import uuid
from typing import Any

from .conftest import (
    INGESTION_URL,
    auth_headers,
    exec_sql,
    get_session_detail,
    get_session_event_count,
    make_event,
    post_event,
    session_exists_in_fleet,
    wait_until,
)

STREAMING: dict[str, Any] = {
    "ttft_ms": 142,
    "chunk_count": 38,
    "inter_chunk_ms": {"p50": 12, "p95": 47, "max": 109},
    "final_outcome": "aborted",
    "abort_reason": "client_aborted",
}

STREAM_ERROR: dict[str, Any] = {
    "error_type": "stream_error",
    "provider": "anthropic",
    "http_status": None,
    "provider_error_code": None,
    "error_message": "APIError",
    "request_id": None,
    "retry_after": None,
    "is_retryable": True,
    "abort_reason": "error_mid_stream",
    "partial_chunks": 12,
    "partial_tokens_input": 1500,
    "partial_tokens_output": 240,
}


def _start_session(sid: str, flavor: str) -> None:
    post_event(make_event(sid, flavor, "session_start"))
    wait_until(
        lambda: session_exists_in_fleet(sid),
        timeout=10,
        msg=f"session {sid} did not appear in fleet",
    )


def _streamed_post_call(sid: str, flavor: str, **streaming: Any) -> dict[str, Any]:
    return make_event(
        sid,
        flavor,
        "post_call",
        model="claude-sonnet-4-5",
        tokens_input=1200,
        tokens_output=90,
        tokens_total=1290,
        latency_ms=900,
        streaming={**STREAMING, **streaming},
    )


def _failed_stream(sid: str, flavor: str, **error: Any) -> dict[str, Any]:
    return make_event(
        sid,
        flavor,
        "llm_error",
        model="claude-sonnet-4-5",
        latency_ms=700,
        retry_attempt=1,
        terminal=False,
        error={**STREAM_ERROR, **error},
    )


def _events_once_stored(sid: str, count: int) -> list[dict[str, Any]]:
    wait_until(
        lambda: get_session_event_count(sid) >= count,
        timeout=10,
        msg=f"session {sid} did not reach {count} events",
    )
    events: list[dict[str, Any]] = get_session_detail(sid).get("events", [])
    return events


def _of_type(events: list[dict[str, Any]], event_type: str) -> dict[str, Any]:
    event = next((e for e in events if e["event_type"] == event_type), None)
    assert event is not None, f"no {event_type} in {events!r}"
    return event


def _post_expecting_status(
    payload: dict[str, Any], *, raw: bytes | None = None
) -> tuple[int, str]:
    req = urllib.request.Request(
        f"{INGESTION_URL}/v1/events",
        data=raw if raw is not None else json.dumps(payload).encode(),
        headers=auth_headers(json_body=True),
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, resp.read().decode()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode()


def test_replaced_value_keeps_captured_content_numbers_exact() -> None:
    """Ingestion rewrites an event whose outcome it replaces; the numbers
    in its captured content (an id of 19 digits, a decimal of 20, which a
    float64 cannot hold) still reach event_content as they were sent."""
    sid = str(uuid.uuid4())
    flavor = f"test-stream-literal-{uuid.uuid4().hex[:6]}"
    _start_session(sid, flavor)
    event_id = str(uuid.uuid4())
    payload = {
        **_streamed_post_call(sid, flavor, final_outcome="truncated"),
        "id": event_id,
        "has_content": True,
        "content": {
            "provider": "anthropic",
            "model": "claude-sonnet-4-5",
            "system": None,
            "messages": [
                {
                    "role": "user",
                    "content": "hi",
                    "metadata": {"channel_id": 1234567890123456789, "ratio": "RATIO"},
                }
            ],
            "tools": None,
            "response": {"content": [{"type": "text", "text": "ok"}]},
        },
    }
    # Python would write the decimal as the nearest float; send it raw.
    raw = json.dumps(payload).replace('"RATIO"', "0.30000000000000001665").encode()
    status, body = _post_expecting_status(payload, raw=raw)
    assert status == 200, f"post_call refused: {status} {body}"

    events = _events_once_stored(sid, 2)
    streaming = _of_type(events, "post_call")["payload"]["streaming"]
    assert streaming["final_outcome"] == "other"
    wait_until(
        lambda: (
            exec_sql(
                "SELECT count(*) FROM event_content WHERE event_id = :'eid'::uuid",
                eid=event_id,
            )
            == "1"
        ),
        timeout=10,
        msg=f"no event_content row for {event_id}",
    )
    stored = exec_sql(
        "SELECT messages::text FROM event_content WHERE event_id = :'eid'::uuid",
        eid=event_id,
    )
    assert "1234567890123456789" in stored, stored
    assert "0.30000000000000001665" in stored, stored


def test_known_stream_values_are_stored_as_sent() -> None:
    sid = str(uuid.uuid4())
    flavor = f"test-stream-known-{uuid.uuid4().hex[:6]}"
    _start_session(sid, flavor)
    post_event(_streamed_post_call(sid, flavor))
    post_event(_failed_stream(sid, flavor))

    events = _events_once_stored(sid, 3)
    streaming = _of_type(events, "post_call")["payload"]["streaming"]
    assert streaming == STREAMING, f"streaming block changed: {streaming!r}"
    error = _of_type(events, "llm_error")["payload"]["error"]
    for key in (
        "error_type",
        "abort_reason",
        "partial_chunks",
        "partial_tokens_input",
        "partial_tokens_output",
    ):
        assert error[key] == STREAM_ERROR[key], f"error.{key}: {error[key]!r}"


def test_unknown_stream_values_are_stored_as_other_and_the_event_counts() -> None:
    """A sensor newer than the server sends reasons the server does not
    know: the events are accepted with the values stored as ``other``,
    and the post_call's tokens reach the session total."""
    sid = str(uuid.uuid4())
    flavor = f"test-stream-unknown-{uuid.uuid4().hex[:6]}"
    _start_session(sid, flavor)
    status, body = _post_expecting_status(
        _streamed_post_call(
            sid, flavor, final_outcome="truncated", abort_reason="user_cancelled"
        )
    )
    assert status == 200, f"post_call refused: {status} {body}"
    status, body = _post_expecting_status(
        _failed_stream(
            sid, flavor, abort_reason="connection_reset", error_type="billing_hold"
        )
    )
    assert status == 200, f"llm_error refused: {status} {body}"

    events = _events_once_stored(sid, 3)
    streaming = _of_type(events, "post_call")["payload"]["streaming"]
    assert streaming["final_outcome"] == "other"
    assert streaming["abort_reason"] == "other"
    assert streaming["chunk_count"] == STREAMING["chunk_count"]
    error = _of_type(events, "llm_error")["payload"]["error"]
    assert error["abort_reason"] == "other"
    assert error["error_type"] == "other"
    assert error["partial_tokens_input"] == STREAM_ERROR["partial_tokens_input"]
    assert error["provider"] == STREAM_ERROR["provider"]
    wait_until(
        lambda: get_session_detail(sid)["session"]["tokens_used"] >= 1290,
        timeout=10,
        msg=f"session {sid} did not count the post_call's tokens",
    )


def test_malformed_stream_fields_are_refused_and_stored_nowhere() -> None:
    sid = str(uuid.uuid4())
    flavor = f"test-stream-reject-{uuid.uuid4().hex[:6]}"
    _start_session(sid, flavor)
    refused: list[tuple[dict[str, Any], str]] = [
        (
            _failed_stream(sid, flavor, partial_tokens_input=-1),
            "error.partial_tokens_input",
        ),
        (
            _failed_stream(sid, flavor, partial_tokens_output=2.5),
            "error.partial_tokens_output",
        ),
        (_failed_stream(sid, flavor, partial_chunks=-3), "error.partial_chunks"),
        (_failed_stream(sid, flavor, abort_reason=7), "error.abort_reason"),
        (_failed_stream(sid, flavor, error_type=429), "error.error_type"),
        (
            _streamed_post_call(sid, flavor, final_outcome=False),
            "streaming.final_outcome",
        ),
        (
            _streamed_post_call(sid, flavor, abort_reason=["timeout"]),
            "streaming.abort_reason",
        ),
        (_streamed_post_call(sid, flavor, chunk_count=-1), "streaming.chunk_count"),
        (_streamed_post_call(sid, flavor, ttft_ms=-5), "streaming.ttft_ms"),
        (
            _streamed_post_call(
                sid, flavor, inter_chunk_ms={"p50": -1, "p95": 2, "max": 3}
            ),
            "streaming.inter_chunk_ms.p50",
        ),
        (
            {**_streamed_post_call(sid, flavor), "streaming": "completed"},
            "streaming must be an object",
        ),
        (
            {**_failed_stream(sid, flavor), "error": "stream broke"},
            "error must be an object",
        ),
    ]
    for payload, message in refused:
        status, body = _post_expecting_status(payload)
        assert status == 400, f"{message}: expected 400, got {status} ({body})"
        assert message in body, f"expected {message!r} in {body!r}"

    # The worker stores a session's events in the order they were
    # published, so once a valid event posted after the refusals is
    # stored, any refused one that had reached the bus is stored too.
    marker = str(uuid.uuid4())
    post_event({**_failed_stream(sid, flavor), "id": marker})
    wait_until(
        lambda: any(
            e.get("id") == marker for e in get_session_detail(sid).get("events", [])
        ),
        timeout=10,
        msg=f"session {sid} did not store the valid llm_error",
    )
    events = get_session_detail(sid).get("events", [])
    assert sorted(e["event_type"] for e in events) == ["llm_error", "session_start"], (
        events
    )


def test_case_variant_field_names_are_refused_and_stored_nowhere() -> None:
    """The worker matches field names ignoring case, so ``Streaming``
    holding a string and ``TOKENS_INPUT`` holding a negative count would
    reach it as ``streaming`` and ``tokens_input`` past every check.
    Ingestion refuses such keys, at the top level and inside the blocks
    it checks."""
    sid = str(uuid.uuid4())
    flavor = f"test-field-case-{uuid.uuid4().hex[:6]}"
    _start_session(sid, flavor)
    no_block = {
        k: v for k, v in _streamed_post_call(sid, flavor).items() if k != "streaming"
    }
    refused: list[tuple[dict[str, Any], str]] = [
        ({**no_block, "Streaming": "garbage"}, '"Streaming"'),
        ({**_streamed_post_call(sid, flavor), "TOKENS_INPUT": -5}, '"TOKENS_INPUT"'),
        (
            _streamed_post_call(sid, flavor, Final_Outcome="x"),
            '"streaming.Final_Outcome"',
        ),
        (
            _failed_stream(sid, flavor, Partial_Tokens_Input=-1),
            '"error.Partial_Tokens_Input"',
        ),
    ]
    for payload, key in refused:
        status, body = _post_expecting_status(payload)
        assert status == 400, f"{key}: expected 400, got {status} ({body})"
        message = json.loads(body)["error"]
        assert f"{key} is not a field name" in message, message

    # As above: once a valid event posted after the refusals is stored,
    # any refused one that had reached the bus is stored too.
    marker = str(uuid.uuid4())
    post_event({**_streamed_post_call(sid, flavor), "id": marker})
    wait_until(
        lambda: any(
            e.get("id") == marker for e in get_session_detail(sid).get("events", [])
        ),
        timeout=10,
        msg=f"session {sid} did not store the valid post_call",
    )
    detail = get_session_detail(sid)
    events = detail.get("events", [])
    assert sorted(e["event_type"] for e in events) == ["post_call", "session_start"], (
        events
    )
    assert detail["session"]["tokens_used"] == 1290, detail["session"]
