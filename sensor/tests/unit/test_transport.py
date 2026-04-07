"""Tests for ControlPlaneClient and retry logic."""

from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from flightdeck_sensor.core.exceptions import DirectiveError
from flightdeck_sensor.core.types import Directive, DirectiveAction
from flightdeck_sensor.transport.client import ControlPlaneClient
from flightdeck_sensor.transport.retry import with_retry


def test_post_event_returns_none_on_null_directive(mock_control_plane: Any) -> None:
    mock_control_plane["set_response"]({"status": "ok", "directive": None})
    client = ControlPlaneClient(mock_control_plane["url"], "tok")
    result = client.post_event({"session_id": "123", "event_type": "post_call"})
    assert result is None


def test_post_event_returns_directive_when_present(mock_control_plane: Any) -> None:
    mock_control_plane["set_response"]({
        "status": "ok",
        "directive": {"action": "shutdown", "reason": "kill_switch", "grace_period_ms": 3000},
    })
    client = ControlPlaneClient(mock_control_plane["url"], "tok")
    result = client.post_event({"session_id": "123", "event_type": "post_call"})
    assert result is not None
    assert isinstance(result, Directive)
    assert result.action == DirectiveAction.SHUTDOWN
    assert result.reason == "kill_switch"


def test_connectivity_failure_continue_returns_none() -> None:
    client = ControlPlaneClient("http://127.0.0.1:1", "tok", unavailable_policy="continue")
    result = client.post_event({"session_id": "x", "event_type": "post_call"})
    assert result is None


def test_connectivity_failure_halt_raises() -> None:
    client = ControlPlaneClient("http://127.0.0.1:1", "tok", unavailable_policy="halt")
    with pytest.raises(DirectiveError):
        client.post_event({"session_id": "x", "event_type": "post_call"})


def test_heartbeat_fires_correct_payload(mock_control_plane: Any) -> None:
    client = ControlPlaneClient(mock_control_plane["url"], "tok")
    client.post_heartbeat("sess-123")
    assert len(mock_control_plane["requests"]) == 1
    req = mock_control_plane["requests"][0]
    assert req["path"] == "/v1/heartbeat"
    assert req["body"]["session_id"] == "sess-123"


def test_retry_fires_with_exponential_backoff() -> None:
    call_count = 0

    def failing_fn() -> str:
        nonlocal call_count
        call_count += 1
        if call_count < 3:
            raise ConnectionError("fail")
        return "ok"

    with patch("flightdeck_sensor.transport.retry.time.sleep"):
        result = with_retry(failing_fn, max_attempts=3, backoff_base=0.1)
    assert result == "ok"
    assert call_count == 3
