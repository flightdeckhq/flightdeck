"""SIGTERM / SIGINT end the session off the interrupted thread.

The handler runs on top of whatever the signal interrupted, which may hold
the session's, the policy's or the event queue's lock. It takes none of
them: the drain thread sends session_end while the handler polls for a
bounded time, then the signal is passed on (or, for the default action,
delivered again once session_end is out). The subprocess tests send real
signals to a child holding each lock; the in-process ones pin the
hand-off and the handler's decisions without a signal.
"""

from __future__ import annotations

import os
import signal
import threading
import time
from typing import TYPE_CHECKING, Any
from unittest.mock import MagicMock

import pytest

from flightdeck_sensor.core import session as session_module
from flightdeck_sensor.core.session import Session
from flightdeck_sensor.core.types import Directive, DirectiveAction, SensorConfig
from flightdeck_sensor.transport import client as client_module
from flightdeck_sensor.transport.client import (
    SHUTDOWN_TIMEOUT_SECS,
    ControlPlaneClient,
    DrainShutdown,
    EventQueue,
    _EventStore,
)
from tests.unit._child_process import CaptureServer, child_env, finish, read_until, start_child

if TYPE_CHECKING:
    import subprocess

posix_only = pytest.mark.skipif(os.name == "nt", reason="sends POSIX signals to a child")

# A child that handles its signal correctly exits within a few seconds:
# the handler waits at most _SIGNAL_SHUTDOWN_WAIT_SECS (2 s) and the child
# holds a lock for at most a second. Before the fix it never exited
# (SIGTERM was swallowed, or the handler deadlocked), so the bound only
# has to separate seconds from forever, with room for a slow CI runner.
EXIT_BOUND_SECS = 15.0

# Gap between a first and a second signal. Standard signals do not queue:
# a second one sent before the first handler has started would be merged
# into it. The child is running bytecode, so its handler starts within
# milliseconds; half a second is far inside the handler's 2 s wait.
SECOND_SIGNAL_GAP_SECS = 0.5

# Upper bound for in-process waits on the drain thread.
DRAIN_WAIT_SECS = 5.0

# How long the end() another thread runs takes, in the test where a signal
# waits for it.
OTHER_END_SECS = 0.3


def _start(capture: CaptureServer, mode: str, *args: str) -> tuple[subprocess.Popen[str], str]:
    proc = start_child("_signal_child.py", capture.url, mode, *args, env=child_env())
    session_id = ""
    for line in read_until(proc, "READY"):
        if line.startswith("SESSION "):
            session_id = line.split(" ", 1)[1]
    assert session_id, "the child printed no session id"
    return proc, session_id


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
@pytest.mark.parametrize("mode", ["idle", "hold"])
def test_sigint_raises_keyboard_interrupt_and_session_end_is_sent(mode: str) -> None:
    with CaptureServer() as capture:
        proc, session_id = _start(capture, mode, "session")
        proc.send_signal(signal.SIGINT)
        code, out, err = finish(proc)
        events = capture.event_types(session_id)
    # Python's own SIGINT handler raises KeyboardInterrupt; uncaught, the
    # interpreter exits through SIGINT. With the session lock held, the
    # interrupt unwinds the frame holding it and the exit waits for the
    # drain thread's session_end.
    assert code == -signal.SIGINT, (code, out, err)
    assert "KeyboardInterrupt" in err
    assert events[-1] == "session_end", events


@posix_only
def test_a_second_sigterm_forces_the_exit() -> None:
    with CaptureServer() as capture:
        proc, session_id = _start(capture, "hold-long", "session")
        proc.send_signal(signal.SIGTERM)
        time.sleep(SECOND_SIGNAL_GAP_SECS)
        sent = time.monotonic()
        proc.send_signal(signal.SIGTERM)
        code, out, err = finish(proc)
        elapsed = time.monotonic() - sent
        events = capture.event_types(session_id)
    # The child holds the session lock for 30 s, so only a forced exit
    # ends it this early, and the drain thread never got the lock to send
    # session_end.
    assert code == -signal.SIGTERM, (code, out, err)
    assert elapsed < EXIT_BOUND_SECS, elapsed
    assert "session_end" not in events, events


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
    # The second SIGINT raises KeyboardInterrupt without waiting; it
    # unwinds the frame holding the lock, and the exit then waits for the
    # drain thread's session_end.
    assert code == -signal.SIGINT, (code, out, err)
    assert elapsed < EXIT_BOUND_SECS, elapsed
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
    client.post_event.side_effect = post_event or (lambda payload: (None, False))
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


def test_the_drain_thread_posts_queued_events_before_the_final_step() -> None:
    order: list[Any] = []
    first_post = threading.Event()
    release = threading.Event()

    def post(payload: dict[str, Any]) -> tuple[None, bool]:
        if payload["n"] == 0:
            first_post.set()
            release.wait(DRAIN_WAIT_SECS)
        order.append(payload["n"])
        return None, False

    queue = EventQueue(_client(post))
    for n in range(3):
        queue.enqueue({"n": n, "event_type": "post_call"})
    assert first_post.wait(DRAIN_WAIT_SECS)
    shutdown = queue.shutdown_on_drain_thread(lambda: order.append("final"))
    assert shutdown is not None
    release.set()
    assert shutdown.wait(DRAIN_WAIT_SECS)
    assert order == [0, 1, 2, "final"]
    queue._drain_thread.join(DRAIN_WAIT_SECS)
    assert not queue._drain_thread.is_alive()


def test_the_hand_off_never_waits_for_a_held_queue_lock() -> None:
    queue = EventQueue(_client())
    assert queue._queue.mutex.acquire()
    try:
        # A signal that interrupted this thread inside a queue call: the
        # hand-off returns at once, and the drain thread, which needs the
        # lock, waits for this frame to let it go.
        started = time.monotonic()
        shutdown = queue.shutdown_on_drain_thread(lambda: None)
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

    def post(payload: dict[str, Any]) -> tuple[None, bool]:
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
    shutdown = queue.shutdown_on_drain_thread(final.set)
    assert shutdown is not None
    release.set()
    assert shutdown.wait(DRAIN_WAIT_SECS)
    assert posted == [0]
    assert final.is_set()
    assert "3 queued events were not sent" in caplog.text


def test_directives_that_arrive_during_the_shutdown_are_dropped() -> None:
    handled: list[Directive] = []
    in_post = threading.Event()
    release = threading.Event()

    def post(payload: dict[str, Any]) -> tuple[Directive, bool]:
        in_post.set()
        release.wait(DRAIN_WAIT_SECS)
        return Directive(action=DirectiveAction.SHUTDOWN, reason="late"), False

    queue = EventQueue(_client(post), directive_handler=handled.append)
    queue.enqueue({"event_type": "post_call"})
    assert in_post.wait(DRAIN_WAIT_SECS)
    shutdown = queue.shutdown_on_drain_thread(lambda: None)
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
    shutdown = queue.shutdown_on_drain_thread(lambda: release.wait(DRAIN_WAIT_SECS) and None)
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
    assert queue.shutdown_on_drain_thread(lambda: None) is None


def test_post_queued_is_a_no_op_off_the_drain_thread() -> None:
    client = _client()
    queue = EventQueue(client)
    queue.post_queued()
    queue.close()
    client.post_event.assert_not_called()


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


def test_the_handler_does_not_deadlock_on_the_held_session_lock(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(session_module, "_SIGNAL_SHUTDOWN_WAIT_SECS", 0.2)
    session, client = _session()
    passed_on: list[int] = []
    with session._lock:
        started = time.monotonic()
        session._on_signal(signal.SIGTERM, None, lambda s, _f: passed_on.append(s))
        # Before the fix this call never returned: end() ran here and
        # waited for the lock this frame holds.
        assert time.monotonic() - started < DRAIN_WAIT_SECS
        assert passed_on == [signal.SIGTERM]
        assert not session._ended.is_set()
    shutdown = session._signal_shutdown
    assert shutdown is not None
    assert shutdown.wait(DRAIN_WAIT_SECS)
    assert session._ended.is_set()
    assert _event_types(client) == ["session_end"]


def test_end_waits_for_the_shutdown_a_signal_started(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(session_module, "_SIGNAL_SHUTDOWN_WAIT_SECS", 0.1)
    session, client = _session()
    with session._lock:
        session._on_signal(signal.SIGTERM, None, lambda _s, _f: None)
    # As at exit right after the signal: end() returns once session_end
    # is out, and sends no second one.
    session.end()
    assert session._ended.is_set()
    assert _event_types(client) == ["session_end"]


def test_a_second_signal_is_passed_on_without_waiting(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(session_module, "_SIGNAL_SHUTDOWN_WAIT_SECS", 0.1)
    waits: list[float] = []
    original_wait = DrainShutdown.wait

    def recording_wait(self: DrainShutdown, timeout: float = SHUTDOWN_TIMEOUT_SECS) -> bool:
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
