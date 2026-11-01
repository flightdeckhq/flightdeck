"""Tests for ControlPlaneClient, retry logic, and EventQueue."""

from __future__ import annotations

import json
import logging
import threading
import time
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from flightdeck_sensor.core.exceptions import DirectiveError
from flightdeck_sensor.core.types import Directive, DirectiveAction
from flightdeck_sensor.transport.body_limit import MAX_EVENT_BODY_BYTES
from flightdeck_sensor.transport.client import (
    _MAX_QUEUE_SIZE,
    ControlPlaneClient,
    EventQueue,
)
from flightdeck_sensor.transport.retry import with_retry


def test_post_event_returns_none_on_null_directive(mock_control_plane: Any) -> None:
    mock_control_plane["set_response"]({"status": "ok", "directive": None})
    client = ControlPlaneClient(mock_control_plane["url"], "tok")
    directive, attached = client.post_event({"session_id": "123", "event_type": "post_call"})
    assert directive is None
    assert attached is False


def test_post_event_returns_directive_when_present(mock_control_plane: Any) -> None:
    mock_control_plane["set_response"](
        {
            "status": "ok",
            "directive": {"action": "shutdown", "reason": "kill_switch", "grace_period_ms": 3000},
        }
    )
    client = ControlPlaneClient(mock_control_plane["url"], "tok")
    directive, attached = client.post_event({"session_id": "123", "event_type": "post_call"})
    assert directive is not None
    assert isinstance(directive, Directive)
    assert directive.action == DirectiveAction.SHUTDOWN
    assert directive.reason == "kill_switch"
    assert attached is False


def test_post_event_returns_attached_true_when_backend_attaches(
    mock_control_plane: Any,
) -> None:
    """Ingestion sets attached=true on session_start envelopes
    whose session_id maps to an existing sessions row. The sensor
    surfaces the flag alongside the directive so Session._post_event
    can emit the INFO log."""
    mock_control_plane["set_response"](
        {
            "status": "ok",
            "directive": None,
            "attached": True,
        }
    )
    client = ControlPlaneClient(mock_control_plane["url"], "tok")
    directive, attached = client.post_event({"session_id": "abc", "event_type": "session_start"})
    assert directive is None
    assert attached is True


def test_post_event_keeps_an_oversized_event_within_the_body_limit(
    mock_control_plane: Any,
) -> None:
    client = ControlPlaneClient(mock_control_plane["url"], "tok")
    payload = {
        "session_id": "123",
        "event_type": "post_call",
        "tokens_input": 900_000,
        "has_content": True,
        "content": {"messages": [{"role": "user", "content": "x" * (2 * 1024 * 1024)}]},
    }
    client.post_event(payload)
    [request] = mock_control_plane["requests"]
    sent = request["body"]
    assert sent["tokens_input"] == 900_000
    assert len(json.dumps(sent)) <= MAX_EVENT_BODY_BYTES
    assert sent["content"]["messages"][0]["content"].endswith("bytes to fit the event size limit]")


def test_post_heartbeat_returns_the_sessions_directive(mock_control_plane: Any) -> None:
    mock_control_plane["set_response"](
        {
            "status": "ok",
            "directive": {"action": "shutdown", "reason": "manual", "grace_period_ms": 0},
        }
    )
    client = ControlPlaneClient(mock_control_plane["url"], "tok")
    directive = client.post_heartbeat("sdk-run")
    assert directive is not None
    assert directive.action == DirectiveAction.SHUTDOWN
    [request] = mock_control_plane["requests"]
    assert request["body"] == {"session_id": "sdk-run"}


def test_post_heartbeat_fails_open_whatever_the_unavailability_policy() -> None:
    client = ControlPlaneClient("http://127.0.0.1:1", "tok", unavailable_policy="halt")
    assert client.post_heartbeat("sdk-run") is None


def test_connectivity_failure_continue_returns_none() -> None:
    client = ControlPlaneClient("http://127.0.0.1:1", "tok", unavailable_policy="continue")
    directive, attached = client.post_event({"session_id": "x", "event_type": "post_call"})
    assert directive is None
    assert attached is False


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
        mock_client.post_event.side_effect = lambda _: (time.sleep(10), None, False)[1:]
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

    def test_drop_warning_fires_once_per_drop(self, caplog: pytest.LogCaptureFixture) -> None:
        """Each forced drop emits its own warning -- no rate-limiting.

        Regression guard: an earlier iteration of this code added a
        rate-limited warning that summarized N drops in a single line.
        That hid the real cardinality of dropped events from operators
        and was reverted -- the production design intent is
        that the queue cannot fill in normal operation because real
        LLM provider latency throttles the producer naturally, so a
        drop is supposed to be loud and rare. This test asserts the
        1:1 correspondence between drops and warnings so any future
        attempt to silence them lands as a failed test.
        """
        # The drain thread takes one event and then blocks in post_event.
        # `draining` is set once it is blocked there, so the queue is
        # static from then on except for the test's own enqueues.
        draining = threading.Event()

        def blocking_post(_: object) -> tuple[None, bool]:
            draining.set()
            time.sleep(10)
            return None, False

        mock_client = MagicMock(spec=ControlPlaneClient)
        mock_client.post_event.side_effect = blocking_post
        eq = EventQueue(mock_client)
        try:
            for i in range(_MAX_QUEUE_SIZE + 50):
                eq.enqueue({"i": i})
            assert draining.wait(timeout=5), "drain thread never took an event"
            # The drain thread's pop may have landed after the pre-fill;
            # top the queue back up to exactly full so every enqueue in
            # the measurement loop below has to drop one.
            while eq._queue.qsize() < _MAX_QUEUE_SIZE:
                eq.enqueue({"top_up": True})
            caplog.clear()
            with caplog.at_level(logging.WARNING, logger="flightdeck_sensor.transport.client"):
                # 10 forced drops -> expect 10 warning lines, no
                # summarization, no rate-limiting.
                for i in range(10):
                    eq.enqueue({"overflow": i})
            warn_lines = [r for r in caplog.records if "Event queue full" in r.message]
            assert len(warn_lines) == 10, (
                f"expected one warning per drop (10 total), got "
                f"{len(warn_lines)}: {[r.message for r in warn_lines]}"
            )
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
        mock_client.post_event.return_value = (None, False)
        eq = EventQueue(mock_client)
        try:
            for i in range(3):
                eq.enqueue({"i": i})
            eq.flush(timeout=5.0)
            assert mock_client.post_event.call_count == 3
        finally:
            eq.close()

    def test_directives_reach_the_handler_only_for_the_session_and_its_children(self) -> None:
        """The queue also carries the events of Agent SDK runs, separate
        agents' sessions: a directive in the response to one of those is
        not this session's to apply."""
        mock_client = MagicMock(spec=ControlPlaneClient)
        mock_client.post_event.side_effect = lambda item: (
            Directive(
                action=DirectiveAction.SHUTDOWN, reason=item["session_id"], grace_period_ms=0
            ),
            False,
        )
        handled: list[str] = []
        last = threading.Event()

        def handler(d: Directive) -> None:
            handled.append(d.reason)
            if d.reason == "own-last":
                last.set()

        eq = EventQueue(mock_client, directive_handler=handler, directive_session_id="own")
        try:
            eq.enqueue({"session_id": "sdk-run", "event_type": "post_call"})
            eq.enqueue({"session_id": "own", "event_type": "post_call"})
            eq.enqueue(
                {"session_id": "child", "parent_session_id": "own", "event_type": "session_start"}
            )
            # The directive queue is FIFO with one consumer: once the
            # last directive is handled, every earlier one has been.
            eq.enqueue(
                {"session_id": "own-last", "parent_session_id": "own", "event_type": "post_call"}
            )
            assert last.wait(5.0)
            assert handled == ["own", "child", "own-last"]
        finally:
            eq.close()

    def test_another_sessions_directive_goes_to_the_router(self) -> None:
        """A directive for an Agent SDK run's event goes to the router
        (the run's reporter), never to the sensor's own handler."""
        mock_client = MagicMock(spec=ControlPlaneClient)
        mock_client.post_event.side_effect = lambda item: (
            Directive(
                action=DirectiveAction.SHUTDOWN, reason=item["session_id"], grace_period_ms=0
            ),
            False,
        )
        handled: list[str] = []
        routed: list[tuple[str, str]] = []

        def router(session_id: str, d: Directive) -> bool:
            routed.append((session_id, d.reason))
            return session_id == "sdk-run"

        eq = EventQueue(
            mock_client,
            directive_handler=lambda d: handled.append(d.reason),
            directive_session_id="own",
            directive_router=router,
        )
        try:
            eq.enqueue({"session_id": "sdk-run", "event_type": "post_call"})
            eq.enqueue({"session_id": "unknown-run", "event_type": "post_call"})
            eq.flush(timeout=5.0)
            assert routed == [("sdk-run", "sdk-run"), ("unknown-run", "unknown-run")]
            assert handled == []
        finally:
            eq.close()

    def test_a_failing_router_does_not_stop_the_drain(self) -> None:
        mock_client = MagicMock(spec=ControlPlaneClient)
        mock_client.post_event.return_value = (
            Directive(action=DirectiveAction.SHUTDOWN, reason="x", grace_period_ms=0),
            False,
        )

        def router(session_id: str, d: Directive) -> bool:
            raise RuntimeError("router broke")

        eq = EventQueue(mock_client, directive_session_id="own", directive_router=router)
        try:
            eq.enqueue({"session_id": "sdk-run", "event_type": "post_call"})
            eq.enqueue({"session_id": "sdk-run", "event_type": "post_call"})
            eq.flush(timeout=5.0)
            assert mock_client.post_event.call_count == 2
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
