"""Phase 7 Step 4 (D152) — session lifecycle + MCP server attach
operator-actionable enrichment contract tests."""

from __future__ import annotations

import uuid
from unittest.mock import MagicMock

from flightdeck_sensor.core.session import (
    Session,
    _collect_interceptor_versions,
    _sensor_version,
)
from flightdeck_sensor.core.types import EventType, SensorConfig


def _make_session(*, shutdown_requested: bool = False) -> Session:
    config = SensorConfig(
        server="http://localhost/ingest",
        token="tok_dev",
        agent_id=str(uuid.uuid4()),
        agent_name="test-agent",
        user_name="test",
        hostname="test-host",
        client_type="flightdeck_sensor",
        api_url="http://localhost/api",
        agent_flavor="e2e-test",
        agent_type="coding",
        session_id=str(uuid.uuid4()),
        quiet=True,
    )
    s = Session(config, client=MagicMock())
    s.event_queue = MagicMock()
    if shutdown_requested:
        s._shutdown_requested = True
        s._shutdown_reason = "test"
    return s


def test_session_start_stamps_sensor_version() -> None:
    s = _make_session()
    payload = s._build_payload(EventType.SESSION_START)
    assert "sensor_version" in payload
    # Sensor version is the package's __version__; format is
    # PEP-440 ("0.6.0" / "0.6.0.dev1"). Empty string is acceptable
    # (editable install in some pip versions returns empty).
    assert isinstance(payload["sensor_version"], str)


def test_session_start_stamps_interceptor_versions() -> None:
    """At least the sensor's own deps installed in the test venv
    should surface — anthropic, openai, mcp are pinned by the
    sensor's pyproject.toml."""
    s = _make_session()
    payload = s._build_payload(EventType.SESSION_START)
    iv = payload.get("interceptor_versions") or {}
    # mcp is a hard dep per pyproject.toml; assert it lands.
    assert "mcp" in iv, f"interceptor_versions missing 'mcp': {iv}"
    # Each version is a non-empty string.
    for dep, ver in iv.items():
        assert isinstance(ver, str) and ver, f"{dep} version empty"


def test_session_start_omits_policy_snapshot_when_caches_empty() -> None:
    """Pre-policy-fetch session_start (preflight hasn't run yet)
    should omit the snapshot block rather than ship empty values."""
    s = _make_session()
    payload = s._build_payload(EventType.SESSION_START)
    # No populate_from_control_plane call → both caches empty.
    assert "policy_snapshot" not in payload


def test_session_start_includes_policy_snapshot_when_token_policy_populated() -> None:
    s = _make_session()
    s.policy.update(
        {
            "token_limit": 10000,
            "warn_at_pct": 80,
            "policy_id": "policy-uuid",
            "matched_policy_scope": "flavor:e2e-test",
        }
    )
    payload = s._build_payload(EventType.SESSION_START)
    snap = payload.get("policy_snapshot")
    assert snap is not None
    assert snap["token_budget"]["policy_id"] == "policy-uuid"
    assert snap["token_budget"]["scope"] == "flavor:e2e-test"


def test_session_end_stamps_close_reason_normal_exit_by_default() -> None:
    s = _make_session()
    payload = s._build_payload(EventType.SESSION_END)
    assert payload["close_reason"] == "normal_exit"


def test_session_end_stamps_close_reason_directive_shutdown_when_flag_set() -> None:
    s = _make_session(shutdown_requested=True)
    payload = s._build_payload(EventType.SESSION_END)
    assert payload["close_reason"] == "directive_shutdown"


def test_collect_interceptor_versions_is_best_effort() -> None:
    """Helper is fail-open per Rule 28 — never raises, always
    returns a dict (possibly empty)."""
    result = _collect_interceptor_versions()
    assert isinstance(result, dict)


def test_sensor_version_is_best_effort() -> None:
    """Helper is fail-open — returns string (possibly empty) on
    any metadata read failure."""
    result = _sensor_version()
    assert isinstance(result, str)


def test_other_event_types_skip_session_start_enrichment() -> None:
    """sensor_version / interceptor_versions / policy_snapshot
    only fire on session_start. post_call etc. stay lean."""
    s = _make_session()
    payload = s._build_payload(EventType.POST_CALL)
    assert "sensor_version" not in payload
    assert "interceptor_versions" not in payload
    assert "policy_snapshot" not in payload


def test_other_event_types_skip_session_end_close_reason() -> None:
    """close_reason only fires on session_end."""
    s = _make_session()
    payload = s._build_payload(EventType.POST_CALL)
    assert "close_reason" not in payload
