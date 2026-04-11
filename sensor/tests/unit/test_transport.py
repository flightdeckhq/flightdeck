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

    def test_critical_events_survive_queue_pressure(self) -> None:
        """B-L proof: a critical event delivered while the data-plane
        queue is at capacity must still reach the wire.

        This is the regression guard for the production bug Phase 4.5
        audit B-L exposed: pre-B-L, the directive_result(acknowledged)
        event for a SHUTDOWN went through the same enqueue path as a
        routine post_call, so under producer pressure the drop-oldest
        policy could discard it -- the dashboard then saw "agent
        stopped responding" instead of "agent shut down cleanly".

        Setup:
        1. Build an EventQueue with a slow client so the drain thread
           is stuck on the very first item it pops -- everything we
           enqueue afterwards stays buffered.
        2. Fill the data-plane queue past capacity to verify the
           drop-oldest path is hot.
        3. Enqueue a critical event via enqueue_critical.
        4. Replace the slow client side-effect with a recorder so the
           drain thread can finally make progress.
        5. Wait for the recorder to see the critical event payload --
           it must arrive even though the data-plane queue had 1000+
           items in front of it.
        """
        from flightdeck_sensor.transport.client import _MAX_CRITICAL_QUEUE_SIZE

        mock_client = MagicMock(spec=ControlPlaneClient)

        # Phase 1: drain thread blocks on the very first event so the
        # queue can saturate behind it. We use a threading.Event the
        # test can flip to release the drain thread later.
        release = __import__("threading").Event()

        def _blocked_post(_: Any) -> None:
            release.wait(timeout=10)
            return None

        mock_client.post_event.side_effect = _blocked_post

        eq = EventQueue(mock_client)
        try:
            # Push enough events to overflow the data-plane queue. The
            # drain thread is currently parked inside the first
            # _blocked_post call, so put_nowait will fill the rest and
            # then start dropping the oldest items.
            for i in range(_MAX_QUEUE_SIZE + _MAX_CRITICAL_QUEUE_SIZE + 50):
                eq.enqueue({"event_type": "post_call", "i": i})

            # The critical ack must survive even though the data-plane
            # queue is currently saturated. enqueue_critical never
            # blocks and never raises -- it puts onto the priority
            # queue which the drain thread checks BEFORE pulling each
            # data-plane item.
            eq.enqueue_critical({
                "event_type": "directive_result",
                "directive_name": "shutdown",
                "directive_status": "acknowledged",
            })

            # Phase 2: swap in a recorder side-effect so we can observe
            # what the drain thread actually delivers, then release
            # the parked first call so the drain thread can make
            # progress.
            posted: list[dict[str, Any]] = []

            def _recorder(item: dict[str, Any]) -> None:
                posted.append(dict(item))
                return None

            mock_client.post_event.side_effect = _recorder
            release.set()

            # Wait until we see the critical event in the recorder.
            # If the priority queue path is broken, the drain thread
            # will burn through ~1000 dropped post_calls first and
            # this loop will time out.
            deadline = time.monotonic() + 5.0
            seen_critical = False
            while time.monotonic() < deadline:
                if any(
                    p.get("event_type") == "directive_result"
                    and p.get("directive_name") == "shutdown"
                    and p.get("directive_status") == "acknowledged"
                    for p in posted
                ):
                    seen_critical = True
                    break
                time.sleep(0.05)

            assert seen_critical, (
                "critical directive_result(shutdown) was never "
                "delivered by the drain thread despite "
                "enqueue_critical -- the priority queue is not "
                "actually being drained before the data-plane queue. "
                f"Drain thread saw {len(posted)} events; first 5: "
                f"{posted[:5]}"
            )
        finally:
            release.set()  # in case the assertion failed before the swap
            eq.close()

    def test_queue_full_warning_is_rate_limited(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        """Burst of drops produces a bounded number of warnings.

        The previous implementation logged ``Event queue full`` on
        every overflow which produced 12k+ identical lines under a
        Pattern-B stress test in CI. We now log the first drop loudly
        and summarize subsequent drops every 100 events. This test
        checks that 250 drops produce at most a handful of log lines
        (vs 250 under the old behavior) so a runaway producer cannot
        flood the agent log stream.
        """
        from flightdeck_sensor.transport.client import _DROP_LOG_INTERVAL

        mock_client = MagicMock(spec=ControlPlaneClient)
        mock_client.post_event.side_effect = lambda _: time.sleep(10)
        eq = EventQueue(mock_client)
        try:
            # Pre-fill the queue so every subsequent enqueue triggers
            # the drop-oldest path. Use _MAX_QUEUE_SIZE+5 to overshoot
            # any items the drain thread may have consumed in flight.
            for i in range(_MAX_QUEUE_SIZE + 5):
                eq.enqueue({"i": i})

            with caplog.at_level(
                logging.WARNING, logger="flightdeck_sensor.transport.client"
            ):
                # 250 forced drops -- under _DROP_LOG_INTERVAL=100 this
                # should emit the FIRST drop line + 2 summary lines.
                # The exact count must be <= 5 with comfortable margin
                # for any drain-thread interleaving.
                for i in range(250):
                    eq.enqueue({"overflow": i})

            warn_lines = [
                r for r in caplog.records if "Event queue full" in r.message
            ]
            assert len(warn_lines) <= 5, (
                f"expected <= 5 rate-limited warnings, got {len(warn_lines)}: "
                f"{[r.message for r in warn_lines]}"
            )
            # First warning explains the rate-limit cadence so future
            # operators know what the summary lines mean.
            assert "summarized every" in warn_lines[0].message
            assert str(_DROP_LOG_INTERVAL) in warn_lines[0].message
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
