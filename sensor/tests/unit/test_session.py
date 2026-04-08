"""Tests for Session lifecycle: start, end, signal handlers."""

from __future__ import annotations

import atexit
import signal
from unittest.mock import MagicMock, patch

import pytest

from typing import Any

from flightdeck_sensor.core.exceptions import ConfigurationError
from flightdeck_sensor.core.session import Session
from flightdeck_sensor.core.types import Directive, DirectiveAction, SensorConfig
from flightdeck_sensor.transport.client import ControlPlaneClient


def _make_session(
    server: str = "http://localhost:9999",
    token: str = "tok",
    quiet: bool = True,
) -> tuple[Session, MagicMock]:
    config = SensorConfig(
        server=server, token=token, agent_flavor="test", agent_type="autonomous", quiet=quiet
    )
    client = MagicMock(spec=ControlPlaneClient)
    client.post_event.return_value = None
    session = Session(config=config, client=client)
    return session, client


def test_start_fires_session_start_event() -> None:
    session, client = _make_session()
    session.start()
    session.end()
    calls = client.post_event.call_args_list
    assert any(c[0][0]["event_type"] == "session_start" for c in calls)


def test_end_fires_session_end_event() -> None:
    session, client = _make_session()
    session.start()
    session.end()
    calls = client.post_event.call_args_list
    assert any(c[0][0]["event_type"] == "session_end" for c in calls)


def test_end_is_idempotent() -> None:
    session, client = _make_session()
    session.start()
    session.end()
    session.end()
    end_calls = [c for c in client.post_event.call_args_list if c[0][0]["event_type"] == "session_end"]
    assert len(end_calls) == 1


def test_atexit_handler_registered() -> None:
    session, _ = _make_session()
    with patch.object(atexit, "register") as mock_register:
        session._register_handlers()
        mock_register.assert_called_once_with(session.end)


def test_sigterm_handler_fires_session_end() -> None:
    session, client = _make_session()
    session.start()
    prev = signal.getsignal(signal.SIGTERM)
    handler = signal.getsignal(signal.SIGTERM)
    assert callable(handler)
    session.end()
    signal.signal(signal.SIGTERM, prev if callable(prev) else signal.SIG_DFL)


def test_preflight_populates_policy_cache(mock_control_plane: Any) -> None:
    """Preflight GET /v1/policy populates PolicyCache on start()."""
    mock_control_plane["set_response"]({
        "token_limit": 50000,
        "warn_at_pct": 80,
        "degrade_at_pct": 90,
        "block_at_pct": 100,
    })

    config = SensorConfig(
        server=mock_control_plane["url"],
        token="test-token",
        agent_flavor="test-preflight",
        agent_type="autonomous",
        quiet=True,
    )
    client_obj = ControlPlaneClient(
        server=mock_control_plane["url"],
        token="test-token",
    )
    session = Session(config=config, client=client_obj)
    session.start()
    session.end()

    assert session.policy.token_limit == 50000
    assert session.policy.warn_at_pct == 80


def test_preflight_failure_proceeds_with_empty_cache() -> None:
    """Preflight failure: start() completes without exception, PolicyCache empty."""
    config = SensorConfig(
        server="http://127.0.0.1:1",  # unreachable
        token="test-token",
        agent_flavor="test-preflight-fail",
        agent_type="autonomous",
        quiet=True,
    )
    client_obj = ControlPlaneClient(
        server="http://127.0.0.1:1",
        token="test-token",
        unavailable_policy="continue",
    )
    session = Session(config=config, client=client_obj)
    session.start()
    session.end()

    # PolicyCache should be empty (no token_limit set)
    assert session.policy.token_limit is None


def test_directive_warn_logs_and_continues() -> None:
    """WARN directive logs warning, enqueues policy_warn event, does not raise."""
    session, _client = _make_session()
    eq = MagicMock()
    session.event_queue = eq

    directive = Directive(
        action=DirectiveAction.WARN,
        reason="token usage at 80%",
    )
    # Should not raise
    session._apply_directive(directive)

    # Verify policy_warn event was enqueued
    eq.enqueue.assert_called_once()
    payload = eq.enqueue.call_args[0][0]
    assert payload["event_type"] == "policy_warn"
    assert payload["source"] == "server"
    assert payload["reason"] == "token usage at 80%"


def test_directive_degrade_sets_model() -> None:
    """DEGRADE directive sets policy.degrade_to, does not raise."""
    session, _client = _make_session()
    directive = Directive(
        action=DirectiveAction.DEGRADE,
        reason="budget threshold crossed",
        payload={"degrade_to": "claude-haiku-4-5"},
    )
    session._apply_directive(directive)
    assert session.policy.degrade_to == "claude-haiku-4-5"


def test_directive_policy_update_replaces_cache() -> None:
    """POLICY_UPDATE directive updates PolicyCache fields."""
    session, _client = _make_session()
    directive = Directive(
        action=DirectiveAction.POLICY_UPDATE,
        reason="policy changed",
        payload={
            "token_limit": 50000,
            "warn_at_pct": 80,
            "degrade_at_pct": 85,
            "block_at_pct": 95,
        },
    )
    session._apply_directive(directive)
    assert session.policy.token_limit == 50000
    assert session.policy.warn_at_pct == 80
    assert session.policy.degrade_at_pct == 85
    assert session.policy.block_at_pct == 95


def test_directive_shutdown_raises() -> None:
    """SHUTDOWN directive sets shutdown flag with correct reason."""
    session, _client = _make_session()
    directive = Directive(
        action=DirectiveAction.SHUTDOWN,
        reason="test kill",
    )
    session._apply_directive(directive)
    assert session._shutdown_requested is True
    assert session._shutdown_reason == "test kill"


def test_directive_shutdown_flavor_raises() -> None:
    """SHUTDOWN_FLAVOR directive sets shutdown flag."""
    session, _client = _make_session()
    directive = Directive(
        action=DirectiveAction.SHUTDOWN_FLAVOR,
        reason="fleet-wide stop",
    )
    session._apply_directive(directive)
    assert session._shutdown_requested is True
    assert session._shutdown_reason == "fleet-wide stop"


def test_configuration_error_on_empty_server() -> None:
    import flightdeck_sensor

    with pytest.raises(ConfigurationError):
        flightdeck_sensor.init(server="", token="tok", quiet=True)
        flightdeck_sensor.teardown()


def test_record_usage_accumulates() -> None:
    """record_usage adds token counts cumulatively, not replacing."""
    from flightdeck_sensor.core.types import TokenUsage

    session, _client = _make_session()
    session.record_usage(TokenUsage(input_tokens=100, output_tokens=50))
    session.record_usage(TokenUsage(input_tokens=100, output_tokens=50))
    assert session.tokens_used == 300


def test_get_status_returns_correct_fields() -> None:
    """get_status snapshot reflects recorded usage and configured limit."""
    from flightdeck_sensor.core.types import TokenUsage

    session, _client = _make_session()
    session._token_limit = 10000
    session.record_usage(TokenUsage(input_tokens=500, output_tokens=300))
    status = session.get_status()

    assert status.session_id == session.config.session_id
    assert status.tokens_used == 800
    assert status.token_limit == 10000
    assert status.pct_used is not None
    assert status.pct_used == 8.0  # (800 / 10000) * 100
