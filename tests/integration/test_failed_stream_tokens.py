"""A failed stream's billed tokens count in every server-side total.

A sensor-shaped ``llm_error`` for a stream that failed after the provider
delivered usage carries ``error.partial_tokens_input`` /
``partial_tokens_output``. Posted through the real ingestion API and
processed by the worker, those tokens reach the session's
``tokens_used``, the agent's ``total_tokens``, the stored event's token
columns, the analytics ``tokens`` and ``estimated_cost`` metrics, the
sub-agent token sums and the per-agent summary, once, next to the
session's completed call.

Wire-seeded, mock-free. Parallel-safe: fresh session ids, unique flavors
and a unique user (so a unique agent) per test.
"""

from __future__ import annotations

import json
import urllib.parse
import urllib.request
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from .conftest import (
    API_URL,
    auth_headers,
    get_session_detail,
    get_session_event_count,
    make_event,
    post_event,
    session_exists_in_fleet,
    wait_until,
)

# A model the vendored catalogue prices, so estimated_cost has rates.
MODEL = "claude-sonnet-4-5"
CALL_IN, CALL_OUT = 1000, 100
PARTIAL_IN, PARTIAL_OUT = 1500, 240
CALL_TOKENS = CALL_IN + CALL_OUT
PARTIAL_TOKENS = PARTIAL_IN + PARTIAL_OUT
FAILED_STREAM_ERROR: dict[str, Any] = {
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
    "partial_tokens_input": PARTIAL_IN,
    "partial_tokens_output": PARTIAL_OUT,
}


def _get(path: str, params: dict[str, str]) -> dict[str, Any]:
    url = f"{API_URL}{path}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers=auth_headers())
    with urllib.request.urlopen(req, timeout=10) as resp:
        body: dict[str, Any] = json.loads(resp.read())
        return body


def _analytics(metric: str, flavor: str, group_by: str) -> float:
    now = datetime.now(UTC)
    resp = _get(
        "/v1/analytics",
        {
            "metric": metric,
            "group_by": group_by,
            "range": "custom",
            "from": (now - timedelta(hours=1)).isoformat(),
            "to": (now + timedelta(minutes=5)).isoformat(),
            "granularity": "day",
            "filter_flavor": flavor,
        },
    )
    total: float = resp["totals"]["grand_total"]
    return total


def _start(sid: str, flavor: str, user: str, **extra: Any) -> None:
    post_event(make_event(sid, flavor, "session_start", user=user, **extra))
    wait_until(
        lambda: session_exists_in_fleet(sid),
        timeout=10,
        msg=f"session {sid} did not appear",
    )


def _call(
    sid: str, flavor: str, user: str, tokens_in: int, tokens_out: int, **extra: Any
) -> None:
    post_event(
        make_event(
            sid,
            flavor,
            "post_call",
            user=user,
            model=MODEL,
            tokens_input=tokens_in,
            tokens_output=tokens_out,
            tokens_total=tokens_in + tokens_out,
            latency_ms=900,
            **extra,
        )
    )


def _failed_stream(sid: str, flavor: str, user: str, **extra: Any) -> None:
    post_event(
        make_event(
            sid,
            flavor,
            "llm_error",
            user=user,
            model=MODEL,
            latency_ms=700,
            retry_attempt=1,
            terminal=False,
            error=FAILED_STREAM_ERROR,
            **extra,
        )
    )


def _stored(sid: str, count: int) -> dict[str, Any]:
    wait_until(
        lambda: get_session_event_count(sid) >= count,
        timeout=10,
        msg=f"session {sid} did not store {count} events",
    )
    return get_session_detail(sid)


def test_failed_stream_tokens_reach_session_agent_analytics_and_summary() -> None:
    user = f"failed-stream-{uuid.uuid4().hex[:8]}"
    sid = str(uuid.uuid4())
    flavor = f"test-failed-stream-{uuid.uuid4().hex[:6]}"
    _start(sid, flavor, user)
    _call(sid, flavor, user, CALL_IN, CALL_OUT)
    _failed_stream(sid, flavor, user)
    detail = _stored(sid, 3)
    want = CALL_TOKENS + PARTIAL_TOKENS

    assert detail["session"]["tokens_used"] == want, detail["session"]
    error = next(e for e in detail["events"] if e["event_type"] == "llm_error")
    assert (error["tokens_input"], error["tokens_output"], error["tokens_total"]) == (
        PARTIAL_IN,
        PARTIAL_OUT,
        PARTIAL_TOKENS,
    ), error
    assert error["billing_mode"] == "metered", error
    assert error["payload"]["error"]["partial_tokens_input"] == PARTIAL_IN

    agent_id = str(detail["session"]["agent_id"])
    agents = _get("/v1/agents", {"user": user}).get("agents", [])
    agent = next((a for a in agents if a["agent_id"] == agent_id), None)
    assert agent is not None, f"agent {agent_id} not listed: {agents!r}"
    assert agent["total_tokens"] == want, agent

    for group_by in ("model", "flavor", "host", "provider", "agent_type"):
        assert _analytics("tokens", flavor, group_by) == want, group_by

    summary = _get(
        f"/v1/agents/{agent_id}/summary", {"period": "24h", "bucket": "hour"}
    )
    assert summary["totals"]["tokens"] == want, summary["totals"]
    assert summary["totals"]["errors"] == 1, summary["totals"]
    cost = _analytics("estimated_cost", flavor, "model")
    assert cost > 0
    assert abs(summary["totals"]["cost_usd"] - cost) < 1e-9, (summary["totals"], cost)


def test_failed_stream_is_priced_like_a_call_of_its_tokens() -> None:
    """A session with a call and a failed stream costs exactly what a
    session with two calls of the same token counts costs."""
    user = f"failed-stream-cost-{uuid.uuid4().hex[:8]}"
    failed_sid, failed_flavor = (
        str(uuid.uuid4()),
        f"test-failed-stream-{uuid.uuid4().hex[:6]}",
    )
    _start(failed_sid, failed_flavor, user)
    _call(failed_sid, failed_flavor, user, CALL_IN, CALL_OUT)
    _failed_stream(failed_sid, failed_flavor, user)
    _stored(failed_sid, 3)

    calls_sid, calls_flavor = (
        str(uuid.uuid4()),
        f"test-failed-stream-{uuid.uuid4().hex[:6]}",
    )
    _start(calls_sid, calls_flavor, user)
    _call(calls_sid, calls_flavor, user, CALL_IN, CALL_OUT)
    _call(calls_sid, calls_flavor, user, PARTIAL_IN, PARTIAL_OUT)
    _stored(calls_sid, 3)

    with_failure = _analytics("estimated_cost", failed_flavor, "model")
    two_calls = _analytics("estimated_cost", calls_flavor, "model")
    assert with_failure > 0
    assert abs(with_failure - two_calls) < 1e-9, (with_failure, two_calls)


def test_failed_stream_tokens_reach_the_parents_sub_agent_sums() -> None:
    user = f"failed-stream-tree-{uuid.uuid4().hex[:8]}"
    parent_sid = str(uuid.uuid4())
    parent_flavor = f"test-failed-stream-parent-{uuid.uuid4().hex[:6]}"
    _start(parent_sid, parent_flavor, user)

    child_sid = str(uuid.uuid4())
    child_flavor = f"test-failed-stream-child-{uuid.uuid4().hex[:6]}"
    role = "researcher"
    _start(child_sid, child_flavor, user, agent_role=role, parent_session_id=parent_sid)
    _call(child_sid, child_flavor, user, CALL_IN, CALL_OUT, agent_role=role)
    _failed_stream(child_sid, child_flavor, user, agent_role=role)
    child = _stored(child_sid, 3)
    want = CALL_TOKENS + PARTIAL_TOKENS

    assert child["session"]["tokens_used"] == want, child["session"]
    assert _analytics("child_token_sum", parent_flavor, "parent_session_id") == want
    assert _analytics("parent_token_sum", parent_flavor, "parent_session_id") == want
