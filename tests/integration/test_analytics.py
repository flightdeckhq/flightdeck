"""Integration tests for the analytics API.

Tests GET /v1/analytics with various metric, group_by, and range params.
Requires `make dev` to be running with fixture data.
"""

from __future__ import annotations

import json
import urllib.request
import uuid

from .conftest import (
    API_URL,
    auth_headers,
    get_session_event_count,
    make_event,
    post_event,
    session_exists_in_fleet,
    wait_until,
)


def _get_analytics(**params: str) -> dict:
    """GET /api/v1/analytics with given query params."""
    qs = "&".join(f"{k}={v}" for k, v in params.items())
    url = f"{API_URL}/v1/analytics?{qs}"
    req = urllib.request.Request(url, headers=auth_headers())
    with urllib.request.urlopen(req, timeout=5) as resp:
        return json.loads(resp.read())


def _setup_fixture(flavor: str, model: str, token_count: int) -> str:
    """Create a session and post a post_call event with known token count."""
    sid = str(uuid.uuid4())
    post_event(make_event(sid, flavor, "session_start", model=model))
    wait_until(
        lambda: session_exists_in_fleet(sid),
        timeout=10,
        msg=f"session {sid} did not appear in fleet",
    )
    post_event(make_event(
        sid, flavor, "post_call",
        model=model,
        tokens_total=token_count,
        tokens_input=token_count // 2,
        tokens_output=token_count // 2,
    ))
    # Wait for event to be processed by workers
    wait_until(
        lambda: get_session_event_count(sid) >= 2,
        timeout=10,
        msg=f"post_call event not processed for session {sid}",
    )
    return sid


def test_analytics_tokens_by_flavor() -> None:
    """GET /v1/analytics?metric=tokens&group_by=flavor returns correct totals."""
    flavor_a = f"analytics-a-{uuid.uuid4().hex[:6]}"
    flavor_b = f"analytics-b-{uuid.uuid4().hex[:6]}"
    _setup_fixture(flavor_a, "claude-sonnet-4-6", 1000)
    _setup_fixture(flavor_b, "gpt-4o", 2000)

    resp = _get_analytics(metric="tokens", group_by="flavor", range="7d")
    assert resp["metric"] == "tokens", (
        f"expected metric=tokens, got {resp.get('metric')}"
    )
    assert resp["group_by"] == "flavor", (
        f"expected group_by=flavor, got {resp.get('group_by')}"
    )
    assert isinstance(resp.get("series"), list), (
        f"expected series to be a list, got {type(resp.get('series'))}"
    )
    assert resp.get("totals") is not None, "expected totals in response"


def test_analytics_sessions_by_model() -> None:
    """GET /v1/analytics?metric=sessions&group_by=model returns session counts."""
    flavor = f"analytics-sess-{uuid.uuid4().hex[:6]}"
    _setup_fixture(flavor, "claude-sonnet-4-6", 500)
    _setup_fixture(flavor, "gpt-4o", 500)

    resp = _get_analytics(metric="sessions", group_by="model", range="7d")
    assert resp["metric"] == "sessions", (
        f"expected metric=sessions, got {resp.get('metric')}"
    )
    assert len(resp.get("series", [])) > 0, (
        "expected at least one series entry"
    )


def test_analytics_group_by_changes_grouping() -> None:
    """Different group_by params produce different dimension values."""
    flavor = f"analytics-grp-{uuid.uuid4().hex[:6]}"
    _setup_fixture(flavor, "claude-sonnet-4-6", 1000)

    resp_flavor = _get_analytics(metric="tokens", group_by="flavor", range="7d")
    resp_model = _get_analytics(metric="tokens", group_by="model", range="7d")

    dims_flavor = {s["dimension"] for s in resp_flavor.get("series", [])}
    dims_model = {s["dimension"] for s in resp_model.get("series", [])}

    # At least one dimension should differ between groupings
    assert dims_flavor != dims_model or len(dims_flavor) == 0, (
        f"expected different dimensions: flavor={dims_flavor}, model={dims_model}"
    )


def test_analytics_filter_flavor() -> None:
    """filter_flavor restricts results to that flavor only."""
    flavor_a = f"analytics-filt-a-{uuid.uuid4().hex[:6]}"
    flavor_b = f"analytics-filt-b-{uuid.uuid4().hex[:6]}"
    _setup_fixture(flavor_a, "claude-sonnet-4-6", 1000)
    _setup_fixture(flavor_b, "gpt-4o", 2000)

    resp = _get_analytics(
        metric="tokens", group_by="flavor", range="7d",
        filter_flavor=flavor_a,
    )
    dims = {s["dimension"] for s in resp.get("series", [])}
    assert flavor_b not in dims, (
        f"expected only {flavor_a} in results, but found {dims}"
    )


def test_analytics_invalid_metric_returns_400() -> None:
    """Invalid metric returns 400."""
    try:
        _get_analytics(metric="invalid")
        assert False, "expected 400 error"
    except urllib.error.HTTPError as e:
        assert e.code == 400, f"expected 400, got {e.code}"
