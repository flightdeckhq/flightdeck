"""SIGTERM / SIGINT end the session off the interrupted thread.

The handler runs on top of whatever the signal interrupted, which may hold
the session's, the policy's or the event queue's lock. It takes none of
them: the drain thread sends session_end, within one overall deadline
counted from the signal (an event's POST already under way finishes
first, unretried), while the handler polls for a bounded time; then the
signal is passed on (or, for the default action, delivered again once
session_end is out). The drain thread waits for a lock the interrupted
code may hold only briefly, and does without it: on Python 3.13 that code
may never release it. The subprocess tests send real signals to a child;
the in-process ones pin the hand-off and the handler's decisions without
a signal.
"""

from __future__ import annotations

import json
import logging
import os
import signal
import socket
import subprocess
import threading
import time
from typing import TYPE_CHECKING, Any
from unittest.mock import MagicMock

import pytest

from flightdeck_sensor.core import session as session_module
from flightdeck_sensor.core.session import Session
from flightdeck_sensor.core.types import Directive, DirectiveAction, SensorConfig
from flightdeck_sensor.interceptor import base as interceptor_base
from flightdeck_sensor.transport import client as client_module
from flightdeck_sensor.transport.client import (
    SHUTDOWN_LIMIT_SECS,
    SHUTDOWN_TIMEOUT_SECS,
    ControlPlaneClient,
    DrainShutdown,
    EventQueue,
    _EventStore,
)
from tests.unit._child_process import CaptureServer, child_env, finish, read_until, start_child
from tests.unit._signal_child import INFLIGHT_EVENT_TYPE

if TYPE_CHECKING:
    from collections.abc import Callable

posix_only = pytest.mark.skipif(os.name == "nt", reason="sends POSIX signals to a child")

# A child that handles its signal correctly exits within a few seconds:
# the handler waits at most _SIGNAL_SHUTDOWN_WAIT_SECS (2 s) and the child
# holds a lock for at most a second. Before the fix it never exited
# (SIGTERM was swallowed, or the handler deadlocked), so the bound only
# has to separate seconds from forever, with room for a slow CI runner.
EXIT_BOUND_SECS = 15.0

# Room on top of SHUTDOWN_TIMEOUT_SECS for a child's exit to be noticed
# once its shutdown is over, on a slow CI runner.
SHUTDOWN_SLACK_SECS = 4.0

# Gap between a first and a second signal. Standard signals do not queue:
# a second one sent before the first handler has started would be merged
# into it. The child's handler starts within milliseconds; half a second
# is far inside the handler's 2 s wait.
SECOND_SIGNAL_GAP_SECS = 0.5

# How long the test watches a child after a first SIGTERM that must not
# end it on its own (its session_end is held by a hanging control plane):
# past the handler's 2 s wait, well inside the shutdown's deadline.
FIRST_SIGNAL_WATCH_SECS = 3.0

# A forced exit ends the child at once; anything near the shutdown's own
# deadline would mean the second signal was not forcing anything.
FORCED_EXIT_BOUND_SECS = 2.0

# Upper bound for in-process waits on the drain thread.
DRAIN_WAIT_SECS = 5.0

# How long the end() another thread runs takes, in the test where a signal
# waits for it.
OTHER_END_SECS = 0.3

# How long an event's POST is held up in process, in the test of the
# deadline: long enough that a deadline counted from the end of it would
# differ from one counted from the request.
IN_FLIGHT_SECS = 0.5

# How long a test waits for a child's event to reach the capture server,
# and how often it looks.
EVENT_ARRIVAL_SECS = 15.0
POLL_SECS = 0.01


def _start(capture: CaptureServer, mode: str, *args: str) -> tuple[subprocess.Popen[str], str]:
    proc = start_child("_signal_child.py", capture.url, mode, *args, env=child_env())
    session_id = ""
    for line in read_until(proc, "READY"):
        if line.startswith("SESSION "):
            session_id = line.split(" ", 1)[1]
    assert session_id, "the child printed no session id"
    return proc, session_id


def _poll(done: Callable[[], bool], timeout: float) -> bool:
    """Poll ``done`` until it is true or ``timeout`` seconds pass."""
    deadline = time.monotonic() + timeout
    while not done():
        if time.monotonic() >= deadline:
            return False
        time.sleep(POLL_SECS)
    return True


# ----------------------------------------------------------------------
# A real signal to a child process
# ----------------------------------------------------------------------


@posix_only
@pytest.mark.parametrize("lock", ["session", "queue", "policy"])
def test_sigterm_with_a_sensor_lock_held_exits_after_session_end(lock: str) -> None:
    with CaptureServer() as capture:
        proc, session_id = _start(capture, "hold", lock)
        sent = time.monotonic()
        proc.send_signal(signal.SIGTERM)
        code, out, err = finish(proc)
        elapsed = time.monotonic() - sent
        events = capture.event_types(session_id)
    assert code == -signal.SIGTERM, (code, out, err)
    assert elapsed < EXIT_BOUND_SECS, elapsed
    assert events[-1] == "session_end", events
    assert "ALIVE" not in out


@posix_only
def test_sigterm_with_a_session_lock_that_is_never_released_still_sends_session_end() -> None:
    with CaptureServer() as capture:
        proc, session_id = _start(capture, "leak")
        sent = time.monotonic()
        proc.send_signal(signal.SIGTERM)
        code, out, err = finish(proc)
        elapsed = time.monotonic() - sent
        events = capture.event_types(session_id)
    # The lock stays held, as it does when Python 3.13 skips the cleanup
    # of the code a signal interrupted: session_end goes out without it.
    assert code == -signal.SIGTERM, (code, out, err)
    assert elapsed < EXIT_BOUND_SECS, elapsed
    assert events[-1] == "session_end", events


@posix_only
def test_sigterm_ends_the_process_after_session_end() -> None:
    with CaptureServer() as capture:
        proc, session_id = _start(capture, "idle")
        sent = time.monotonic()
        proc.send_signal(signal.SIGTERM)
        code, out, err = finish(proc)
        elapsed = time.monotonic() - sent
        events = capture.event_types(session_id)
    # The default action, as without the sensor: before the fix the
    # handler swallowed SIGTERM and the process kept running.
    assert code == -signal.SIGTERM, (code, out, err)
    assert elapsed < EXIT_BOUND_SECS, elapsed
    assert events == ["session_start", "session_end"], events


@posix_only
def test_sigterm_with_a_hanging_control_plane_ends_within_the_shutdown_deadline() -> None:
    with CaptureServer(hang_after_start=True) as capture:
        proc, session_id = _start(capture, "idle")
        sent = time.monotonic()
        proc.send_signal(signal.SIGTERM)
        code, out, err = finish(proc)
        elapsed = time.monotonic() - sent
        events = capture.event_types(session_id)
    # session_end reached a control plane that never answers: the signal
    # was held back until the shutdown's deadline, not the 20 s of two
    # full-timeout attempts, then the process ended by it.
    assert code == -signal.SIGTERM, (code, out, err)
    assert elapsed < SHUTDOWN_TIMEOUT_SECS + SHUTDOWN_SLACK_SECS, elapsed
    assert events[-1] == "session_end", events


@posix_only
def test_sigterm_with_an_event_post_under_way_ends_within_the_shutdown_limit() -> None:
    with CaptureServer(hang_after_start=True) as capture:
        proc, session_id = _start(capture, "inflight")
        # The capture server has the event and holds its response: the
        # drain thread is inside that POST, the usual state while events
        # flow.
        assert _poll(
            lambda: INFLIGHT_EVENT_TYPE in capture.event_types(session_id), EVENT_ARRIVAL_SECS
        )
        sent = time.monotonic()
        proc.send_signal(signal.SIGTERM)
        code, out, err = finish(proc)
        elapsed = time.monotonic() - sent
        events = capture.event_types(session_id)
    # The POST under way ran to its request timeout and was not retried;
    # session_end then still got its one short attempt. Before, the
    # deadline started only after that POST and its retry: 27 s.
    assert code == -signal.SIGTERM, (code, out, err)
    assert elapsed < SHUTDOWN_LIMIT_SECS + SHUTDOWN_SLACK_SECS, elapsed
    assert events.count(INFLIGHT_EVENT_TYPE) == 1, events
    assert events[-1] == "session_end", events


@posix_only
@pytest.mark.parametrize("mode", ["idle", "hold"])
def test_sigint_raises_keyboard_interrupt_and_session_end_is_sent(mode: str) -> None:
    with CaptureServer() as capture:
        proc, session_id = _start(capture, mode, "session")
        proc.send_signal(signal.SIGINT)
        code, out, err = finish(proc)
        events = capture.event_types(session_id)
    # Python's own SIGINT handler raises KeyboardInterrupt; uncaught, the
    # interpreter exits through SIGINT, after session_end.
    assert code == -signal.SIGINT, (code, out, err)
    assert "KeyboardInterrupt" in err
    assert events[-1] == "session_end", events


@posix_only
def test_a_second_sigterm_forces_the_exit() -> None:
    with CaptureServer(hang_after_start=True) as capture:
        proc, _session_id = _start(capture, "idle")
        proc.send_signal(signal.SIGTERM)
        # session_end is held by the control plane, so the first signal's
        # default action waits for the shutdown's deadline.
        with pytest.raises(subprocess.TimeoutExpired):
            proc.wait(timeout=FIRST_SIGNAL_WATCH_SECS)
        sent = time.monotonic()
        proc.send_signal(signal.SIGTERM)
        code, out, err = finish(proc)
        elapsed = time.monotonic() - sent
    assert code == -signal.SIGTERM, (code, out, err)
    assert elapsed < FORCED_EXIT_BOUND_SECS, elapsed


@posix_only
def test_a_second_sigint_raises_at_once_and_session_end_is_still_sent() -> None:
    with CaptureServer() as capture:
        proc, session_id = _start(capture, "hold-long", "session")
        proc.send_signal(signal.SIGINT)
        time.sleep(SECOND_SIGNAL_GAP_SECS)
        sent = time.monotonic()
        proc.send_signal(signal.SIGINT)
        code, out, err = finish(proc)
        elapsed = time.monotonic() - sent
        events = capture.event_types(session_id)
    # KeyboardInterrupt ends the main thread; the exit waits for the drain
    # thread's session_end, which does not need the session's lock.
    assert code == -signal.SIGINT, (code, out, err)
    assert elapsed < EXIT_BOUND_SECS, elapsed
    assert events[-1] == "session_end", events


@posix_only
def test_a_signal_shutdown_loads_no_module() -> None:
    # The control plane is down until the signal, so session_end's
    # response is the first one the session parses; and no SDK was used,
    # so no stream was ever settled before the shutdown settles them.
    with CaptureServer(unavailable=True) as capture:
        proc, session_id = _start(capture, "imports")
        capture.unavailable = False
        proc.send_signal(signal.SIGINT)
        code, out, err = finish(proc)
        events = capture.event_types(session_id)
    loaded = [
        json.loads(line.split(" ", 1)[1]) for line in out.splitlines() if line.startswith("LOADED ")
    ]
    # A first import there can wait for one the interrupted code is in the
    # middle of, and runs module code that may call exec(), which on
    # CPython clears the flag that gives a process ended by an unhandled
    # KeyboardInterrupt its SIGINT exit status.
    assert code == 0, (code, out, err)
    assert loaded == [[]], (loaded, err)
    assert events[-1] == "session_end", events


@posix_only
def test_sigterm_is_passed_on_to_the_application_handler_after_session_end() -> None:
    with CaptureServer() as capture:
        proc, session_id = _start(capture, "chain")
        proc.send_signal(signal.SIGTERM)
        code, out, err = finish(proc)
        with capture._lock:
            order = [
                e["event_type"]
                for e in capture.events
                if e.get("session_id") == session_id or e["event_type"] == "app_handler"
            ]
    assert code == 7, (code, out, err)
    assert order[-2:] == ["session_end", "app_handler"], order


@posix_only
def test_an_ignored_sigterm_stays_ignored() -> None:
    with CaptureServer() as capture:
        proc, session_id = _start(capture, "ignore")
        proc.send_signal(signal.SIGTERM)
        code, out, err = finish(proc)
        events = capture.event_types(session_id)
    # The application ignores SIGTERM, so the process carries on and the
    # session with it, ending normally at exit.
    assert code == 0, (code, out, err)
    assert "ALIVE" in out
    assert events == ["session_start", "session_end"], events


# ----------------------------------------------------------------------
# The drain thread's shutdown, in process
# ----------------------------------------------------------------------


def _client(post_event: Any = None) -> MagicMock:
    client = MagicMock(spec=ControlPlaneClient)
    client.post_event.side_effect = post_event or (lambda payload, **_limits: (None, False))
    return client


def test_offer_never_waits_for_the_queue_lock() -> None:
    store = _EventStore(maxsize=1)
    store.put_nowait("event")
    assert store.mutex.acquire()
    try:
        # As a signal handler would find it: this thread holds the lock.
        assert store.offer("wake") is False
    finally:
        store.mutex.release()
    # Free, it is put even past maxsize: it is a marker, not an event.
    assert store.offer("wake") is True
    assert [store.get_nowait(), store.get_nowait()] == ["event", "wake"]


def test_take_gives_up_on_a_held_queue_lock() -> None:
    store = _EventStore()
    store.put_nowait("event")
    holder = threading.Thread(target=store.mutex.acquire)
    holder.start()
    holder.join(DRAIN_WAIT_SECS)
    started = time.monotonic()
    assert store.take(0.1) is client_module._NOTHING
    assert time.monotonic() - started < DRAIN_WAIT_SECS
    store.mutex.release()
    assert store.take(0.1) == "event"
    assert store.take(0.1) is client_module._NOTHING


def test_the_drain_thread_posts_queued_events_before_the_final_step() -> None:
    order: list[Any] = []
    first_post = threading.Event()
    release = threading.Event()

    def post(payload: dict[str, Any], **_limits: Any) -> tuple[None, bool]:
        if payload["n"] == 0:
            first_post.set()
            release.wait(DRAIN_WAIT_SECS)
        order.append(payload["n"])
        return None, False

    queue = EventQueue(_client(post))
    for n in range(3):
        queue.enqueue({"n": n, "event_type": "post_call"})
    assert first_post.wait(DRAIN_WAIT_SECS)
    shutdown = queue.shutdown_on_drain_thread(lambda _deadline: order.append("final"))
    assert shutdown is not None
    release.set()
    assert shutdown.wait(DRAIN_WAIT_SECS)
    assert order == [0, 1, 2, "final"]
    queue._drain_thread.join(DRAIN_WAIT_SECS)
    assert not queue._drain_thread.is_alive()


def test_queued_events_are_posted_in_one_attempt_within_the_budget() -> None:
    limits: list[dict[str, Any]] = []
    first_post = threading.Event()
    release = threading.Event()

    def post(payload: dict[str, Any], **kwargs: Any) -> tuple[None, bool]:
        if payload["n"] == 0:
            first_post.set()
            release.wait(DRAIN_WAIT_SECS)
            return None, False
        limits.append(kwargs)
        return None, False

    queue = EventQueue(_client(post))
    queue.enqueue({"n": 0, "event_type": "post_call"})
    assert first_post.wait(DRAIN_WAIT_SECS)
    for n in (1, 2):
        queue.enqueue({"n": n, "event_type": "post_call"})
    deadlines: list[float] = []
    started = time.monotonic()
    shutdown = queue.shutdown_on_drain_thread(deadlines.append)
    assert shutdown is not None
    release.set()
    assert shutdown.wait(DRAIN_WAIT_SECS)
    assert [lim["max_attempts"] for lim in limits] == [1, 1]
    assert all(0 < lim["timeout"] <= client_module._FLUSH_TIMEOUT_SECS for lim in limits)
    # The final step got the whole shutdown's deadline.
    assert deadlines and deadlines[0] - started <= SHUTDOWN_TIMEOUT_SECS + 0.5


def test_the_hand_off_never_waits_for_a_held_queue_lock() -> None:
    queue = EventQueue(_client())
    assert queue._queue.mutex.acquire()
    try:
        # A signal that interrupted this thread inside a queue call: the
        # hand-off returns at once, and the drain thread, which needs the
        # lock, waits for this frame to let it go.
        started = time.monotonic()
        shutdown = queue.shutdown_on_drain_thread(lambda _deadline: None)
        assert time.monotonic() - started < 1.0
        assert shutdown is not None
        assert not shutdown.wait(0.2)
    finally:
        queue._queue.mutex.release()
    assert shutdown.wait(DRAIN_WAIT_SECS)


def test_queued_events_past_the_budget_are_dropped(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setattr(client_module, "_FLUSH_TIMEOUT_SECS", 0.0)
    posted: list[int] = []
    first_post = threading.Event()
    release = threading.Event()

    def post(payload: dict[str, Any], **_limits: Any) -> tuple[None, bool]:
        first_post.set()
        release.wait(DRAIN_WAIT_SECS)
        posted.append(payload["n"])
        return None, False

    queue = EventQueue(_client(post))
    queue.enqueue({"n": 0, "event_type": "post_call"})
    assert first_post.wait(DRAIN_WAIT_SECS)
    for n in range(1, 4):
        queue.enqueue({"n": n, "event_type": "post_call"})
    final = threading.Event()
    shutdown = queue.shutdown_on_drain_thread(lambda _deadline: final.set())
    assert shutdown is not None
    release.set()
    assert shutdown.wait(DRAIN_WAIT_SECS)
    # Reported once the shutdown is over, after it is marked finished.
    queue._drain_thread.join(DRAIN_WAIT_SECS)
    assert posted == [0]
    assert final.is_set()
    assert "3 queued events were not sent" in caplog.text


def test_directives_that_arrive_during_the_shutdown_are_dropped() -> None:
    handled: list[Directive] = []
    in_post = threading.Event()
    release = threading.Event()

    def post(payload: dict[str, Any], **_limits: Any) -> tuple[Directive, bool]:
        in_post.set()
        release.wait(DRAIN_WAIT_SECS)
        return Directive(action=DirectiveAction.SHUTDOWN, reason="late"), False

    queue = EventQueue(_client(post), directive_handler=handled.append)
    queue.enqueue({"event_type": "post_call"})
    assert in_post.wait(DRAIN_WAIT_SECS)
    shutdown = queue.shutdown_on_drain_thread(lambda _deadline: None)
    assert shutdown is not None
    release.set()
    assert shutdown.wait(DRAIN_WAIT_SECS)
    assert queue._directive_thread is not None
    queue._directive_thread.join(DRAIN_WAIT_SECS)
    assert handled == []


def test_a_deferred_signal_is_delivered_again_once_finished(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    delivered: list[int] = []
    monkeypatch.setattr(client_module, "_redeliver", delivered.append)
    release = threading.Event()
    queue = EventQueue(_client())
    shutdown = queue.shutdown_on_drain_thread(
        lambda _deadline: release.wait(DRAIN_WAIT_SECS) and None
    )
    assert shutdown is not None
    assert shutdown.redeliver_when_finished(signal.SIGTERM) is False
    release.set()
    assert shutdown.wait(DRAIN_WAIT_SECS)
    # The drain thread marks the shutdown finished before it delivers (so
    # a caller asking in the same instant cannot be missed); it has
    # delivered once it has exited.
    queue._drain_thread.join(DRAIN_WAIT_SECS)
    assert delivered == [signal.SIGTERM]
    # Asked once it has finished: the caller acts on the signal itself.
    assert shutdown.redeliver_when_finished(signal.SIGTERM) is True
    assert delivered == [signal.SIGTERM]


def test_no_drain_thread_no_hand_off() -> None:
    queue = EventQueue(_client())
    queue.close()
    assert queue.shutdown_on_drain_thread(lambda _deadline: None) is None


def test_post_queued_is_a_no_op_off_the_drain_thread() -> None:
    client = _client()
    queue = EventQueue(client)
    queue.post_queued()
    queue.close()
    client.post_event.assert_not_called()


def _silent_server() -> tuple[socket.socket, list[socket.socket], str]:
    """A control plane that accepts connections and never answers: its
    listener, the connections it has accepted, and its URL."""
    listener = socket.create_server(("127.0.0.1", 0))
    accepted: list[socket.socket] = []

    def accept_forever() -> None:
        while True:
            try:
                conn, _ = listener.accept()
            except OSError:
                return
            accepted.append(conn)

    threading.Thread(target=accept_forever, daemon=True).start()
    host, port = listener.getsockname()[:2]
    return listener, accepted, f"http://{host}:{port}"


def _close(listener: socket.socket, accepted: list[socket.socket]) -> None:
    listener.close()
    for conn in accepted:
        conn.close()


def test_post_event_honours_a_timeout_and_a_single_attempt() -> None:
    listener, accepted, url = _silent_server()
    client = ControlPlaneClient(server=url, token="tok")
    try:
        started = time.monotonic()
        result = client.post_event({"event_type": "session_end"}, timeout=0.3, max_attempts=1)
        elapsed = time.monotonic() - started
    finally:
        _close(listener, accepted)
    assert result == (None, False)
    # One attempt of 0.3 s; the defaults would take two of 10 s.
    assert elapsed < 2.0, elapsed
    assert len(accepted) == 1


def test_a_post_under_way_when_a_shutdown_is_requested_is_neither_retried_nor_logged(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.DEBUG, logger="flightdeck_sensor")
    listener, accepted, url = _silent_server()
    client = ControlPlaneClient(server=url, token="tok")
    try:
        # The shutdown is requested once the first attempt is under way.
        with pytest.raises(OSError):
            client.post_event(
                {"event_type": "post_call"}, timeout=0.3, shutting_down=lambda: bool(accepted)
            )
    finally:
        _close(listener, accepted)
    assert len(accepted) == 1
    # The failure is the queue's to report, once the shutdown is over.
    assert [r.getMessage() for r in caplog.records if r.levelno >= logging.WARNING] == []


def test_waiting_for_a_shutdown_lasts_until_its_limit_from_the_request() -> None:
    # A shutdown no drain thread finishes, requested almost
    # SHUTDOWN_LIMIT_SECS ago: what end() waits is the rest of the limit
    # (and the slack), not a fresh SHUTDOWN_TIMEOUT_SECS from its call.
    shutdown = DrainShutdown(lambda _deadline: None, lambda: True, threading.Thread())
    shutdown.requested_at = time.monotonic() - SHUTDOWN_LIMIT_SECS + IN_FLIGHT_SECS
    started = time.monotonic()
    assert shutdown.wait() is False
    elapsed = time.monotonic() - started
    assert IN_FLIGHT_SECS <= elapsed < DRAIN_WAIT_SECS, elapsed


def test_the_deadline_counts_from_the_request_not_from_a_post_under_way() -> None:
    in_post = threading.Event()
    release = threading.Event()

    def post(payload: dict[str, Any], **_kwargs: Any) -> tuple[None, bool]:
        in_post.set()
        release.wait(DRAIN_WAIT_SECS)
        return None, False

    queue = EventQueue(_client(post))
    queue.enqueue({"event_type": "post_call"})
    assert in_post.wait(DRAIN_WAIT_SECS)
    deadlines: list[float] = []
    shutdown = queue.shutdown_on_drain_thread(deadlines.append)
    assert shutdown is not None
    # The post under way holds the drain thread past the request.
    threading.Timer(IN_FLIGHT_SECS, release.set).start()
    assert shutdown.wait(DRAIN_WAIT_SECS)
    assert deadlines == [shutdown.requested_at + SHUTDOWN_TIMEOUT_SECS]


def test_a_failed_session_end_is_counted_and_reported_once_the_shutdown_is_over(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setattr(session_module, "_SIGNAL_SHUTDOWN_WAIT_SECS", DRAIN_WAIT_SECS)
    caplog.set_level(logging.DEBUG, logger="flightdeck_sensor")
    with socket.create_server(("127.0.0.1", 0)) as probe:
        port = probe.getsockname()[1]
    # Nothing listens there any more: every POST is refused.
    config = SensorConfig(
        server=f"http://127.0.0.1:{port}",
        token="tok",
        agent_flavor="test",
        agent_type="production",
        quiet=True,
    )
    session = Session(config=config, client=ControlPlaneClient(server=config.server, token="tok"))
    passed_on: list[int] = []
    session._on_signal(signal.SIGTERM, None, lambda s, _f: passed_on.append(s))
    session.event_queue._drain_thread.join(DRAIN_WAIT_SECS)
    messages = [r.getMessage() for r in caplog.records]
    assert passed_on == [signal.SIGTERM]
    assert session._ended.is_set()
    # Not logged while the shutdown ran (logging takes locks the code the
    # signal interrupted may hold), and counted for the report after it.
    assert not [m for m in messages if "unreachable" in m or "Transient failure" in m], messages
    assert [m for m in messages if "1 posts failed" in m], messages


# ----------------------------------------------------------------------
# The handler's decisions, in process (no signal is sent)
# ----------------------------------------------------------------------


def _session() -> tuple[Session, MagicMock]:
    config = SensorConfig(
        server="http://localhost:9999",
        token="tok",
        agent_flavor="test",
        agent_type="production",
        quiet=True,
    )
    client = _client()
    return Session(config=config, client=client), client


def _event_types(client: MagicMock) -> list[str]:
    return [c.args[0]["event_type"] for c in client.post_event.call_args_list]


def test_session_end_goes_out_while_the_interrupted_code_holds_the_session_lock(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(session_module, "_SIGNAL_SHUTDOWN_WAIT_SECS", DRAIN_WAIT_SECS)
    session, client = _session()
    lock_waits: list[float | None] = []
    real_counters = session._counters
    real_close_reason = session._sensor_close_reason

    def counters(lock_wait: float | None = None) -> tuple[int, str | None, str | None]:
        lock_waits.append(lock_wait)
        return real_counters(lock_wait)

    def close_reason(lock_wait: float | None = None) -> str | None:
        lock_waits.append(lock_wait)
        return real_close_reason(lock_wait)

    monkeypatch.setattr(session, "_counters", counters)
    monkeypatch.setattr(session, "_sensor_close_reason", close_reason)
    passed_on: list[int] = []
    with session._lock:
        started = time.monotonic()
        session._on_signal(signal.SIGTERM, None, lambda s, _f: passed_on.append(s))
        # Before the fix this call never returned: end() ran here and
        # waited for the lock this frame holds. Now session_end goes out
        # without it, while this frame still holds it.
        assert time.monotonic() - started < DRAIN_WAIT_SECS
        assert passed_on == [signal.SIGTERM]
        assert session._ended.is_set()
    assert _event_types(client) == ["session_end"]
    (call,) = client.post_event.call_args_list
    assert call.kwargs["max_attempts"] == 1
    assert 0 < call.kwargs["timeout"] <= SHUTDOWN_TIMEOUT_SECS
    # Found held before the settle, the lock was not waited for again.
    assert lock_waits == [0.0, 0.0]


def test_session_end_goes_out_when_a_thread_never_releases_the_session_lock(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(session_module, "_SIGNAL_SHUTDOWN_WAIT_SECS", DRAIN_WAIT_SECS)
    session, client = _session()
    session._tokens_used = 42
    held = threading.Event()
    done = threading.Event()

    def hold_for_good() -> None:
        with session._lock:
            held.set()
            done.wait(DRAIN_WAIT_SECS * 4)

    holder = threading.Thread(target=hold_for_good, daemon=True)
    holder.start()
    try:
        assert held.wait(DRAIN_WAIT_SECS)
        passed_on: list[int] = []
        started = time.monotonic()
        session._on_signal(signal.SIGTERM, None, lambda s, _f: passed_on.append(s))
        elapsed = time.monotonic() - started
        # Ended while the lock is still held, not once the holder lets go.
        ended_while_held = session._ended.is_set()
    finally:
        done.set()
        holder.join(DRAIN_WAIT_SECS)
    assert ended_while_held
    assert passed_on == [signal.SIGTERM]
    assert elapsed < SHUTDOWN_TIMEOUT_SECS, elapsed
    assert _event_types(client) == ["session_end"]
    (call,) = client.post_event.call_args_list
    assert call.args[0]["tokens_used_session"] == 42
    assert call.args[0]["close_reason"] == "normal_exit"


def test_open_streams_are_not_settled_while_a_lock_they_need_is_held(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(session_module, "_SIGNAL_SHUTDOWN_WAIT_SECS", DRAIN_WAIT_SECS)
    session, client = _session()
    settled: list[str] = []
    monkeypatch.setattr(session, "_settle_open_streams", lambda **_kw: settled.append("settled"))
    with session.policy._lock:
        session._on_signal(signal.SIGTERM, None, lambda _s, _f: None)
    assert settled == []
    assert _event_types(client) == ["session_end"]


class _OpenStream:
    """Stands in for an open stream guard: what settle_open_guards reads."""

    def __init__(self, session: Session) -> None:
        self._session = session
        self._entered = True
        self._finalized = False
        self.settled = False

    def _settle_now(self) -> None:
        self.settled = True


def test_settling_open_streams_gives_up_on_a_held_guard_lock() -> None:
    session, _client = _session()
    stream = _OpenStream(session)
    session.open_stream_guards.add(stream)
    held = threading.Event()
    release = threading.Event()

    def hold() -> None:
        with session.open_stream_guards_lock:
            held.set()
            release.wait(DRAIN_WAIT_SECS)

    holder = threading.Thread(target=hold, daemon=True)
    holder.start()
    try:
        assert held.wait(DRAIN_WAIT_SECS)
        # Taken after the shutdown found it free: the settle still waits
        # for it only briefly, and leaves the stream as it is.
        interceptor_base.settle_open_guards(session, lock_wait=0.05)
        settled_while_held = stream.settled
    finally:
        release.set()
        holder.join(DRAIN_WAIT_SECS)
    assert not settled_while_held
    interceptor_base.settle_open_guards(session, lock_wait=0.05)
    assert stream.settled


def test_end_waits_for_the_shutdown_a_signal_started(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(session_module, "_SIGNAL_SHUTDOWN_WAIT_SECS", 0.1)
    session, client = _session()
    release = threading.Event()
    real_post = client.post_event.side_effect

    def slow_post(payload: dict[str, Any], **limits: Any) -> tuple[None, bool]:
        release.wait(DRAIN_WAIT_SECS)
        result: tuple[None, bool] = real_post(payload, **limits)
        return result

    client.post_event.side_effect = slow_post
    session._on_signal(signal.SIGTERM, None, lambda _s, _f: None)
    assert not session._ended.is_set()
    threading.Timer(OTHER_END_SECS, release.set).start()
    # As at exit right after the signal: end() returns once session_end
    # is out, and sends no second one.
    session.end()
    assert session._ended.is_set()
    assert _event_types(client) == ["session_end"]


def test_a_second_signal_is_passed_on_without_waiting(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(session_module, "_SIGNAL_SHUTDOWN_WAIT_SECS", 0.1)
    waits: list[float | None] = []
    original_wait = DrainShutdown.wait

    def recording_wait(self: DrainShutdown, timeout: float | None = None) -> bool:
        waits.append(timeout)
        return original_wait(self, timeout)

    monkeypatch.setattr(DrainShutdown, "wait", recording_wait)
    session, _client_mock = _session()
    passed_on: list[int] = []
    with session._lock:
        session._on_signal(signal.SIGTERM, None, lambda s, _f: passed_on.append(s))
        session._on_signal(signal.SIGTERM, None, lambda s, _f: passed_on.append(s))
    # Only the first signal waited for the drain thread; the second was
    # passed on at once.
    assert waits == [0.1]
    assert passed_on == [signal.SIGTERM, signal.SIGTERM]
    session.end()


def test_a_signal_that_interrupts_end_is_passed_on_at_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    waited: list[float] = []

    def recording_wait_until(done: Any, timeout: float) -> bool:
        waited.append(timeout)
        return bool(done())

    monkeypatch.setattr(session_module, "_wait_until", recording_wait_until)
    session, _client_mock = _session()
    # end() claimed the session on this thread and has not finished: the
    # signal interrupted it, so waiting for it would wait for itself.
    assert session._end_claim.acquire(blocking=False)
    session._ending_thread = threading.get_ident()
    passed_on: list[int] = []
    session._on_signal(signal.SIGINT, None, lambda s, _f: passed_on.append(s))
    assert waited == []
    assert passed_on == [signal.SIGINT]
    session.event_queue.close()


def test_a_signal_waits_for_end_running_on_another_thread(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A bound far above the end's own duration, so returning well before
    # it means the handler stopped waiting because end() finished.
    monkeypatch.setattr(session_module, "_SIGNAL_SHUTDOWN_WAIT_SECS", DRAIN_WAIT_SECS * 6)
    session, _client_mock = _session()
    assert session._end_claim.acquire(blocking=False)
    session._ending_thread = threading.get_ident() + 1
    passed_on: list[int] = []
    end_finishes = threading.Timer(OTHER_END_SECS, session._ended.set)
    started = time.monotonic()
    end_finishes.start()
    session._on_signal(signal.SIGTERM, None, lambda s, _f: passed_on.append(s))
    elapsed = time.monotonic() - started
    assert OTHER_END_SECS <= elapsed < DRAIN_WAIT_SECS
    assert passed_on == [signal.SIGTERM]
    session.event_queue.close()


def test_a_signal_stops_waiting_for_an_end_that_never_finishes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(session_module, "_SIGNAL_SHUTDOWN_WAIT_SECS", 0.2)
    session, _client_mock = _session()
    assert session._end_claim.acquire(blocking=False)
    session._ending_thread = threading.get_ident() + 1
    passed_on: list[int] = []
    started = time.monotonic()
    session._on_signal(signal.SIGTERM, None, lambda s, _f: passed_on.append(s))
    # end() on the other thread never finished, so the handler waited its
    # full bound, then passed the signal on.
    assert time.monotonic() - started >= 0.2
    assert passed_on == [signal.SIGTERM]
    session.event_queue.close()


def test_an_ignored_signal_is_left_alone() -> None:
    session, _client_mock = _session()
    previous = signal.getsignal(signal.SIGTERM)
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    try:
        session._register_signal(signal.SIGTERM)
        assert signal.getsignal(signal.SIGTERM) == signal.SIG_IGN
    finally:
        signal.signal(signal.SIGTERM, previous)
        session.end()


def test_the_handler_replaces_and_chains_a_python_handler() -> None:
    session, _client_mock = _session()
    previous = signal.getsignal(signal.SIGTERM)
    seen: list[int] = []
    signal.signal(signal.SIGTERM, lambda s, _f: seen.append(s))
    try:
        session._register_signal(signal.SIGTERM)
        handler = signal.getsignal(signal.SIGTERM)
        assert callable(handler)
        handler(signal.SIGTERM, None)
        assert seen == [signal.SIGTERM]
    finally:
        signal.signal(signal.SIGTERM, previous)
        session.end()
