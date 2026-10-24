"""The token, model and cost fields survive the pipeline.

A post_call carrying every field of the token and cost contract is
POSTed through the real ingestion API, processed by the worker and read
back from ``GET /v1/sessions/:id``: the column fields come back as
top-level event fields, the rest inside ``payload``. An event without
them comes back without them, and ingestion rejects a malformed value
with 400 before it reaches the bus.

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
    get_session_detail,
    get_session_event_count,
    make_event,
    post_event,
    session_exists_in_fleet,
    wait_until,
)

FULL_FIELDS: dict[str, Any] = {
    "model": "claude-sonnet-4-5",
    "model_requested": "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    "model_served": "claude-sonnet-4-5-20250929",
    "provider": "anthropic",
    "billing_mode": "metered",
    "tokens_input": 5200,
    "tokens_output": 900,
    "tokens_total": 6100,
    "tokens_cache_read": 3000,
    "tokens_cache_creation": 1200,
    "tokens_cache_creation_1h": 400,
    "tokens_reasoning": 350,
    "cost_reported": 0.0421,
    "cost_source": "agent",
    "service_tier": "standard",
    "speed": "fast",
    "inference_geo": "us",
    "inference_scope": "regional",
    "server_tool_use": {"web_search_requests": 2},
    "stop_reason": "end_turn",
    "latency_ms": 2100,
    "provider_metadata": {"platform": "bedrock", "request_id": "req_tc_1"},
}


def _start_session(sid: str, flavor: str) -> None:
    post_event(make_event(sid, flavor, "session_start"))
    wait_until(
        lambda: session_exists_in_fleet(sid),
        timeout=10,
        msg=f"session {sid} did not appear in fleet",
    )


def _post_call(sid: str) -> dict[str, Any]:
    wait_until(
        lambda: get_session_event_count(sid) >= 2,
        timeout=10,
        msg=f"post_call not processed for session {sid}",
    )
    events = get_session_detail(sid).get("events", [])
    post_call = next((e for e in events if e["event_type"] == "post_call"), None)
    assert post_call is not None
    return post_call


def _post_expecting_status(payload: dict[str, Any]) -> tuple[int, str]:
    req = urllib.request.Request(
        f"{INGESTION_URL}/v1/events",
        data=json.dumps(payload).encode(),
        headers=auth_headers(json_body=True),
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, resp.read().decode()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode()


def test_every_token_cost_field_round_trips() -> None:
    sid = str(uuid.uuid4())
    flavor = f"test-token-cost-{uuid.uuid4().hex[:6]}"
    _start_session(sid, flavor)
    post_event(make_event(sid, flavor, "post_call", **FULL_FIELDS))

    event = _post_call(sid)
    columns = {
        "tokens_reasoning": 350,
        "model_requested": "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
        "model_served": "claude-sonnet-4-5-20250929",
        "provider": "anthropic",
        "billing_mode": "metered",
        "platform": "bedrock",
        "cost_reported": 0.0421,
        "cost_source": "agent",
        "tokens_cache_read": 3000,
        "tokens_cache_creation": 1200,
    }
    for key, want in columns.items():
        assert event.get(key) == want, f"{key}: got {event.get(key)!r}, want {want!r}"

    payload = event["payload"]
    for key in (
        "tokens_cache_creation_1h",
        "service_tier",
        "speed",
        "inference_geo",
        "inference_scope",
        "server_tool_use",
        "stop_reason",
    ):
        assert payload.get(key) == FULL_FIELDS[key], (
            f"payload.{key}: got {payload.get(key)!r}"
        )
    assert payload["provider_metadata"]["platform"] == "bedrock"
    for column_only in (
        "tokens_reasoning",
        "billing_mode",
        "cost_reported",
        "model_served",
    ):
        assert column_only not in payload, (
            f"{column_only} must not be duplicated into payload"
        )


def test_event_without_the_fields_gets_only_the_worker_defaults() -> None:
    """An older client's post_call names only ``model``: the worker fills
    ``model_requested``, ``provider`` and ``billing_mode`` and leaves the
    fields only a client can know absent."""
    sid = str(uuid.uuid4())
    flavor = f"test-token-cost-absent-{uuid.uuid4().hex[:6]}"
    _start_session(sid, flavor)
    post_event(
        make_event(
            sid,
            flavor,
            "post_call",
            model="gpt-4o-mini",
            tokens_input=10,
            tokens_output=5,
            tokens_total=15,
        )
    )

    event = _post_call(sid)
    assert event["model_requested"] == "gpt-4o-mini"
    assert event["provider"] == "openai"
    assert event["billing_mode"] == "metered"
    for key in (
        "tokens_reasoning",
        "model_served",
        "platform",
        "cost_reported",
        "cost_source",
    ):
        assert key not in event, f"{key} should be absent, got {event.get(key)!r}"


def test_malformed_token_cost_fields_are_rejected_at_ingestion() -> None:
    sid = str(uuid.uuid4())
    flavor = f"test-token-cost-reject-{uuid.uuid4().hex[:6]}"
    bad_values: list[tuple[dict[str, Any], str]] = [
        ({"billing_mode": "free"}, "billing_mode"),
        ({"provider": "litellm"}, "provider"),
        ({"cost_reported": 0.1}, "sent together"),
        ({"tokens_reasoning": 901}, "must not exceed tokens_output"),
        ({"tokens_cache_creation_1h": 1201}, "must not exceed tokens_cache_creation"),
        ({"inference_scope": "local"}, "inference_scope"),
    ]
    for override, message in bad_values:
        fields = {**FULL_FIELDS, **override}
        if "cost_reported" in override:
            fields.pop("cost_source")
        status, body = _post_expecting_status(
            make_event(sid, flavor, "post_call", **fields)
        )
        assert status == 400, f"{override}: expected 400, got {status} ({body})"
        assert message in body, f"{override}: expected {message!r} in {body!r}"


def test_worker_canonicalises_the_model_and_fills_defaults() -> None:
    """A sensor-style post_call that sends only ``model`` comes back with
    the canonical id, the raw id as ``model_requested``, the provider
    derived from it and the metered default; a Bedrock profile's region
    lands as ``inference_scope``."""
    sid = str(uuid.uuid4())
    flavor = f"test-model-canonical-{uuid.uuid4().hex[:6]}"
    _start_session(sid, flavor)
    raw = "us.anthropic.claude-sonnet-4-5-20250929-v1:0"
    post_event(
        make_event(
            sid,
            flavor,
            "post_call",
            model=raw,
            tokens_input=10,
            tokens_output=5,
            tokens_total=15,
        )
    )

    event = _post_call(sid)
    assert event["model"] == "claude-sonnet-4-5-20250929"
    assert event["model_requested"] == raw
    assert event["provider"] == "anthropic"
    assert event["billing_mode"] == "metered"
    assert event["payload"]["inference_scope"] == "regional"
    assert get_session_detail(sid)["session"]["model"] == "claude-sonnet-4-5-20250929"


def test_claude_code_calls_default_to_subscription() -> None:
    sid = str(uuid.uuid4())
    flavor = f"test-model-subscription-{uuid.uuid4().hex[:6]}"
    post_event(
        make_event(
            sid,
            flavor,
            "session_start",
            client_type="claude_code",
            sensor_version="flightdeck-plugin/test",
        )
    )
    wait_until(
        lambda: session_exists_in_fleet(sid),
        timeout=10,
        msg=f"session {sid} did not appear in fleet",
    )
    post_event(
        make_event(
            sid,
            flavor,
            "post_call",
            client_type="claude_code",
            model="claude-opus-4.6",
            tokens_input=10,
            tokens_output=5,
            tokens_total=15,
        )
    )

    event = _post_call(sid)
    assert event["model"] == "claude-opus-4-6"
    assert event["model_requested"] == "claude-opus-4.6"
    assert event["billing_mode"] == "subscription"
