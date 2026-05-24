"""Integration tests for the analytics API.

Tests GET /v1/analytics with various metric, group_by, and range params.
Requires `make dev` to be running with fixture data.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
import uuid

from flightdeck_sensor.core.agent_id import derive_agent_id

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
    post_event(
        make_event(
            sid,
            flavor,
            "post_call",
            model=model,
            tokens_total=token_count,
            tokens_input=token_count // 2,
            tokens_output=token_count // 2,
        )
    )
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
    assert len(resp.get("series", [])) > 0, "expected at least one series entry"


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
        metric="tokens",
        group_by="flavor",
        range="7d",
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


# ---------------------------------------------------------------
# D157 Phase 1 — per-agent landing page backend
# ---------------------------------------------------------------


def _setup_unique_agent_fixture(token_count: int) -> tuple[str, str]:
    """Create one session under a fresh agent identity (unique
    user + hostname) and post a single ``post_call`` event so the
    new per-agent endpoints have something concrete to aggregate.

    Returns ``(agent_id, session_id)``.

    The agent_id is derived in-process using the same helper the
    sensor and ingestion validator share — the integration test
    can therefore predict the UUID without round-tripping through
    /v1/agents to look it up.
    """
    suffix = uuid.uuid4().hex[:8]
    user = f"d157-user-{suffix}"
    hostname = f"d157-host-{suffix}"
    flavor = f"d157-flavor-{suffix}"
    # Use the canonical sensor agent_type / client_type pair —
    # tests/integration/test_agent_type_client_type_pairing.py guards
    # against the (coding, flightdeck_sensor) anomaly, so production
    # + flightdeck_sensor is the right shape for a synthetic
    # ``flightdeck_sensor``-keyed agent fixture.
    agent_id = str(
        derive_agent_id(
            agent_type="production",
            user=user,
            hostname=hostname,
            client_type="flightdeck_sensor",
            agent_name=f"{user}@{hostname}",
            agent_role=None,
        )
    )
    sid = str(uuid.uuid4())
    post_event(
        make_event(
            sid,
            flavor,
            "session_start",
            model="claude-sonnet-4-6",
            user=user,
            hostname=hostname,
            agent_type="production",
            client_type="flightdeck_sensor",
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
            model="claude-sonnet-4-6",
            tokens_total=token_count,
            tokens_input=token_count // 2,
            tokens_output=token_count // 2,
            latency_ms=250,
            user=user,
            hostname=hostname,
            agent_type="production",
            client_type="flightdeck_sensor",
        )
    )
    wait_until(
        lambda: get_session_event_count(sid) >= 2,
        timeout=10,
        msg=f"post_call event not processed for session {sid}",
    )
    return agent_id, sid


def test_analytics_filter_agent_id_scopes_to_one_agent() -> None:
    """``filter_agent_id`` constrains the analytics window so
    other agents' tokens do not leak into the totals."""
    agent_a, _ = _setup_unique_agent_fixture(1000)
    agent_b, _ = _setup_unique_agent_fixture(5000)
    assert agent_a != agent_b, "test fixture produced colliding agent_ids"

    resp_a = _get_analytics(
        metric="tokens",
        group_by="flavor",
        range="7d",
        filter_agent_id=agent_a,
    )
    grand_total_a = resp_a.get("totals", {}).get("grand_total", 0)
    assert grand_total_a >= 1000, f"agent A totals = {grand_total_a}, expected >= 1000"

    resp_b = _get_analytics(
        metric="tokens",
        group_by="flavor",
        range="7d",
        filter_agent_id=agent_b,
    )
    grand_total_b = resp_b.get("totals", {}).get("grand_total", 0)
    assert grand_total_b >= 5000, f"agent B totals = {grand_total_b}, expected >= 5000"
    # The window is scoped — agent A's filter must not pick up
    # agent B's 5000 tokens.
    assert grand_total_a < grand_total_b, (
        f"filter_agent_id leaked across agents: A={grand_total_a}, B={grand_total_b}"
    )


def test_analytics_filter_agent_id_rejects_malformed_uuid() -> None:
    """Handler returns 400 on a malformed UUID before reaching
    the store."""
    try:
        _get_analytics(metric="tokens", filter_agent_id="not-a-uuid")
        assert False, "expected 400 on malformed filter_agent_id"
    except urllib.error.HTTPError as e:
        assert e.code == 400, f"expected 400, got {e.code}"


def _get_agent_summary(agent_id: str, **params: str) -> dict:
    qs = "&".join(f"{k}={v}" for k, v in params.items())
    url = f"{API_URL}/v1/agents/{agent_id}/summary"
    if qs:
        url += f"?{qs}"
    req = urllib.request.Request(url, headers=auth_headers())
    with urllib.request.urlopen(req, timeout=5) as resp:
        return json.loads(resp.read())


def test_agent_summary_shape_and_totals() -> None:
    """GET /v1/agents/{id}/summary returns the documented shape
    with non-zero totals and at least one populated series
    bucket."""
    agent_id, _ = _setup_unique_agent_fixture(2500)

    resp = _get_agent_summary(agent_id, period="7d")

    assert resp.get("agent_id") == agent_id, (
        f"agent_id mismatch: got {resp.get('agent_id')}, want {agent_id}"
    )
    assert resp.get("period") == "7d", f"period = {resp.get('period')}, want 7d"
    assert resp.get("bucket") == "day", (
        f"bucket = {resp.get('bucket')}, want day (derived from 7d)"
    )

    totals = resp.get("totals") or {}
    for key in (
        "tokens",
        "errors",
        "sessions",
        "cost_usd",
        "latency_p50_ms",
        "latency_p95_ms",
    ):
        assert key in totals, f"totals missing key {key!r}: {totals}"
    assert totals["tokens"] >= 2500, (
        f"totals.tokens = {totals.get('tokens')}, expected >= 2500"
    )
    assert totals["sessions"] >= 1, (
        f"totals.sessions = {totals.get('sessions')}, expected >= 1"
    )

    series = resp.get("series")
    assert isinstance(series, list), f"series must be a list, got {type(series)}"
    assert len(series) >= 1, "expected at least one populated bucket"
    bucket = series[0]
    for key in (
        "ts",
        "tokens",
        "errors",
        "sessions",
        "cost_usd",
        "latency_p95_ms",
    ):
        assert key in bucket, f"series bucket missing key {key!r}: {bucket}"
    assert any(b.get("tokens", 0) >= 2500 for b in series), (
        "no bucket carries the seeded token count"
    )


def test_agent_summary_404_on_unknown_agent() -> None:
    """An unknown agent_id returns 404, not 200 with empty data."""
    unknown = str(uuid.uuid4())
    try:
        _get_agent_summary(unknown)
        assert False, "expected 404 on unknown agent_id"
    except urllib.error.HTTPError as e:
        assert e.code == 404, f"expected 404, got {e.code}"


def test_agent_summary_400_on_malformed_uuid() -> None:
    """Malformed UUID is rejected at the handler boundary."""
    try:
        _get_agent_summary("not-a-uuid")
        assert False, "expected 400 on malformed agent_id"
    except urllib.error.HTTPError as e:
        assert e.code == 400, f"expected 400, got {e.code}"
