"""Tests for Session lifecycle: start, end, heartbeat, signal handlers."""

from __future__ import annotations

import atexit
import signal
from unittest.mock import MagicMock, patch

import pytest

from flightdeck_sensor.core.exceptions import ConfigurationError
from flightdeck_sensor.core.session import Session
from flightdeck_sensor.core.types import SensorConfig
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
    client.post_heartbeat.return_value = None
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


def test_heartbeat_thread_starts_on_session_start() -> None:
    session, _ = _make_session()
    session.start()
    assert session._heartbeat_thread is not None
    assert session._heartbeat_thread.is_alive()
    session.end()


def test_heartbeat_thread_stops_on_teardown() -> None:
    session, _ = _make_session()
    session.start()
    thread = session._heartbeat_thread
    session.end()
    assert thread is not None
    assert not thread.is_alive()


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


def test_configuration_error_on_empty_server() -> None:
    import flightdeck_sensor

    with pytest.raises(ConfigurationError):
        flightdeck_sensor.init(server="", token="tok", quiet=True)
        flightdeck_sensor.teardown()
