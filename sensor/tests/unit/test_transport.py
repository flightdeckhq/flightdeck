"""Tests for ControlPlaneClient, retry logic, and EventQueue."""

from __future__ import annotations

import logging
import time
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from flightdeck_sensor.core.exceptions import DirectiveError
from flightdeck_sensor.core.types import Directive, DirectiveAction
from flightdeck_sensor.transport.client import (
    ControlPlaneClient,
    EventQueue,
    _MAX_QUEUE_SIZE,
)
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


# ------------------------------------------------------------------
# EventQueue tests
# ------------------------------------------------------------------


class TestEventQueue:
    """Tests for the non-blocking EventQueue."""

    def test_enqueue_does_not_block(self) -> None:
        mock_client = MagicMock(spec=ControlPlaneClient)
        eq = EventQueue(mock_client)
        try:
            t0 = time.monotonic()
            for i in range(5):
                eq.enqueue({"i": i})
            elapsed = time.monotonic() - t0
            # enqueue should return near-instantly (well under 1 s)
            assert elapsed < 1.0
        finally:
            eq.close()

    def test_queue_full_drops_oldest(self, caplog: pytest.LogCaptureFixture) -> None:
        mock_client = MagicMock(spec=ControlPlaneClient)
        # Slow client so drain thread doesn't empty the queue
        mock_client.post_event.side_effect = lambda _: time.sleep(10)
        eq = EventQueue(mock_client)
        try:
            # Fill to capacity (drain thread may consume one, so overshoot)
            for i in range(_MAX_QUEUE_SIZE + 5):
                eq.enqueue({"i": i})
            with caplog.at_level(logging.WARNING, logger="flightdeck_sensor.transport.client"):
                eq.enqueue({"overflow": True})
            # Should have logged the overflow warning at least once
            assert any("Event queue full" in r.message for r in caplog.records)
        finally:
            eq.close()

    def test_flush_waits_for_drain(self) -> None:
        """flush() must block until every queued item has been processed
        by the background drain thread. With the Queue.join() pattern,
        flush() relies on the drain loop calling task_done() after every
        item, so when flush() returns, mock_client.post_event must have
        been called for every enqueued item.
        """
        mock_client = MagicMock(spec=ControlPlaneClient)
        mock_client.post_event.return_value = None
        eq = EventQueue(mock_client)
        try:
            for i in range(3):
                eq.enqueue({"i": i})
            eq.flush(timeout=5.0)
            assert mock_client.post_event.call_count == 3
        finally:
            eq.close()

    def test_flush_completes_even_when_post_raises(self) -> None:
        """A failing POST must still call task_done() so flush() can
        return rather than blocking until the timeout. This is the
        guarantee that makes shutdown ack delivery reliable: even if
        the control plane is unreachable, flush() returns promptly so
        the agent can exit cleanly.
        """
        mock_client = MagicMock(spec=ControlPlaneClient)
        mock_client.post_event.side_effect = ConnectionError("boom")
        eq = EventQueue(mock_client)
        try:
            for i in range(3):
                eq.enqueue({"i": i})
            start = time.monotonic()
            eq.flush(timeout=5.0)
            elapsed = time.monotonic() - start
            # All three POSTs were attempted
            assert mock_client.post_event.call_count == 3
            # And flush returned long before the 5s timeout (drain
            # thread cleared the queue immediately on each failure)
            assert elapsed < 2.0
        finally:
            eq.close()


def test_parse_directive_malformed_missing_action() -> None:
    """_parse_directive returns None for a dict missing the 'action' key."""
    body = {"directive": {"id": "x", "reason": "r"}}
    result = ControlPlaneClient._parse_directive(body)
    assert result is None


def test_parse_directive_unknown_action() -> None:
    """_parse_directive returns None for an unrecognised action value."""
    body = {"directive": {"action": "unknown_future_action", "id": "x", "reason": "r"}}
    result = ControlPlaneClient._parse_directive(body)
    # DirectiveAction("unknown_future_action") raises ValueError,
    # caught internally → returns None
    assert result is None
