"""HTTP transport to the Flightdeck control plane.

Uses only the Python standard library (``urllib.request``).
No ``requests``, no ``httpx`` -- zero required dependencies.
"""

from __future__ import annotations

import contextlib
import json
import logging
import os
import queue
import signal
import threading
import time
import urllib.request
from typing import TYPE_CHECKING, Any
from urllib.error import HTTPError, URLError

from pydantic import ValidationError

from flightdeck_sensor.core.exceptions import DirectiveError

# Imported with this module, not on first use: a signal's shutdown parses
# responses on the drain thread, where nothing may load a module (see the
# same note on the interceptor base in core/session.py).
from flightdeck_sensor.core.schemas import DirectiveResponseSchema, SyncResponseSchema
from flightdeck_sensor.core.types import Directive, DirectiveAction
from flightdeck_sensor.transport.body_limit import serialize_event
from flightdeck_sensor.transport.retry import with_retry

if TYPE_CHECKING:
    from collections.abc import Callable

_log = logging.getLogger("flightdeck_sensor.transport.client")

# Hot-path timeout: events and heartbeat POSTs.
_TIMEOUT_SECS = 10

# Startup timeout: directive sync and registration at init() time.
# Shorter than hot-path because these are fire-and-forget and fail
# open anyway -- a slow or unreachable control plane must not block
# the agent's boot path for 10s.
_STARTUP_TIMEOUT_SECS = 3

# Heartbeat timeout: a heartbeat is a directive poll made while an agent
# waits to run a tool, so it gets one attempt and a short bound; 2 s is
# well above a healthy round trip and keeps a dead server from holding
# the tool call for long (the poll then fails open).
_HEARTBEAT_TIMEOUT_SECS = 2


class ControlPlaneClient:
    """Fire-and-forget HTTP client for sensor → control plane communication.

    On connectivity failure the behaviour depends on *unavailable_policy*:

    * ``"continue"`` -- log a warning, return ``None``, agent proceeds.
    * ``"halt"`` -- raise :class:`DirectiveError`, agent must stop.
    """

    def __init__(
        self,
        server: str,
        token: str,
        api_url: str = "",
        unavailable_policy: str = "continue",
    ) -> None:
        self._base_url = server.rstrip("/")
        self._api_url = api_url.rstrip("/") if api_url else self._base_url
        self._token = token
        self._unavailable_policy = unavailable_policy

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def post_event(
        self,
        payload: dict[str, Any],
        *,
        timeout: float | None = None,
        max_attempts: int | None = None,
        shutting_down: Callable[[], bool] | None = None,
    ) -> tuple[Directive | None, bool]:
        """POST an event to ``/v1/events``.

        ``timeout`` (seconds, per request) and ``max_attempts`` default to
        the transport's own (``_TIMEOUT_SECS``, the retry policy's
        attempts); a shutdown with a deadline passes smaller ones.

        ``shutting_down`` tells a post on the event queue's drain thread
        whether a shutdown has been requested, which can happen while the
        post is under way. Once it has, a failed attempt is not retried,
        and a failure raises instead of being logged and handled by the
        unavailability policy (the queue reports it once the shutdown is
        over, since logging takes locks the code a signal interrupted may
        hold); a directive in the response is not parsed.

        Returns ``(directive, attached)``:

        * ``directive`` -- any directive embedded in the response
          envelope, or ``None``.
        * ``attached`` -- the ingestion response's ``attached`` flag.
          ``True`` when the backend matched this sensor's
          ``session_id`` to a pre-existing row in ``sessions``. Only
          ever ``True`` on the ``session_start`` response envelope
          (later events hit an already-active row and the flag is
          reset to ``False`` there) -- callers must therefore treat
          the first ``True`` as the attachment confirmation. Missing
          field defaults to ``False`` for backward compatibility with
          older ingestion deployments.
        """
        return self._post(
            "/v1/events",
            payload,
            data=serialize_event(payload),
            timeout=timeout,
            max_attempts=max_attempts,
            shutting_down=shutting_down,
        )

    def post_heartbeat(self, session_id: str) -> Directive | None:
        """POST ``/v1/heartbeat`` for ``session_id`` and return the
        session's pending directive, if any. One attempt; any failure
        returns None, whatever the unavailability policy, since a
        heartbeat is only a poll."""
        req = urllib.request.Request(
            f"{self._base_url}/v1/heartbeat",
            data=json.dumps({"session_id": session_id}).encode(),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self._token}",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=_HEARTBEAT_TIMEOUT_SECS) as resp:
                body = json.loads(resp.read().decode())
        except Exception as exc:
            _log.debug("heartbeat for %s failed: %s", session_id, exc)
            return None
        return self._parse_directive(body) if isinstance(body, dict) else None

    def sync_directives(
        self,
        flavor: str,
        directives: list[dict[str, Any]],
    ) -> list[str]:
        """POST fingerprints to /v1/directives/sync, return unknown fingerprints.

        Each entry in *directives* must have ``name`` and ``fingerprint`` keys.
        Returns a list of fingerprints the server does not recognise.
        On any error, returns an empty list (fail open).
        """
        url = f"{self._api_url}/v1/directives/sync"
        body = json.dumps({"flavor": flavor, "directives": directives}).encode()
        req = urllib.request.Request(
            url,
            data=body,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self._token}",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=_STARTUP_TIMEOUT_SECS) as resp:
                data = json.loads(resp.read().decode())
                try:
                    parsed = SyncResponseSchema.model_validate(data)
                    return parsed.unknown_fingerprints
                except ValidationError:
                    _log.warning("sync response validation failed, returning empty")
                    return []
        except Exception:
            _log.debug("directives sync failed, proceeding without sync", exc_info=True)
            return []

    def register_directives(
        self,
        flavor: str,
        directives: list[dict[str, Any]],
    ) -> None:
        """POST full directive schemas to /v1/directives/register.

        Fire-and-forget: ignores all errors (fail open).
        """
        url = f"{self._api_url}/v1/directives/register"
        body = json.dumps({"flavor": flavor, "directives": directives}).encode()
        req = urllib.request.Request(
            url,
            data=body,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self._token}",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=_STARTUP_TIMEOUT_SECS) as resp:
                resp.read()
        except Exception:
            _log.debug("directives register failed, ignoring", exc_info=True)

    def close(self) -> None:
        """No-op -- stdlib ``urllib`` has no persistent connection to close."""

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _post(
        self,
        path: str,
        body: dict[str, Any],
        data: bytes | None = None,
        *,
        timeout: float | None = None,
        max_attempts: int | None = None,
        shutting_down: Callable[[], bool] | None = None,
    ) -> tuple[Directive | None, bool]:
        """POST JSON and parse the response envelope for directive + attached.

        ``data`` is the already-encoded body when the caller has one
        (an event, kept within the size limit by ``serialize_event``).
        ``timeout``, ``max_attempts`` and ``shutting_down`` are as in
        :meth:`post_event`.
        """
        url = f"{self._base_url}{path}"
        if data is None:
            data = json.dumps(body).encode()
        req = urllib.request.Request(
            url,
            data=data,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self._token}",
            },
            method="POST",
        )

        def ending() -> bool:
            return shutting_down is not None and shutting_down()

        retry_args: dict[str, Any] = {"should_retry": lambda: not ending()}
        if max_attempts is not None:
            retry_args["max_attempts"] = max_attempts
        try:
            raw = with_retry(lambda: self._do_request(req, timeout, ending), **retry_args)
        except (URLError, OSError, TimeoutError, ConnectionError) as exc:
            if ending():
                raise
            return self._handle_unavailable(exc), False

        attached = bool(raw.get("attached", False))
        if ending():
            return None, attached  # the session a directive would act on is ending
        return self._parse_directive(raw), attached

    def _do_request(
        self,
        req: urllib.request.Request,
        timeout: float | None = None,
        ending: Callable[[], bool] | None = None,
    ) -> dict[str, Any]:
        """Execute a single HTTP request and return the parsed JSON body.

        Raises on HTTP 5xx so that :func:`with_retry` can retry.
        HTTP 4xx is a caller bug -- log and return a neutral response;
        once ``ending`` says a shutdown is under way, raise it instead (the
        caller reports it after the shutdown).
        """
        try:
            with urllib.request.urlopen(
                req, timeout=_TIMEOUT_SECS if timeout is None else timeout
            ) as resp:
                body: dict[str, Any] = json.loads(resp.read().decode())
                return body
        except HTTPError as exc:
            if exc.code >= 500:
                raise  # let retry handle it
            if ending is not None and ending():
                raise
            # 4xx -- caller bug, not retryable
            _log.warning("Control plane returned HTTP %d: %s", exc.code, exc.reason)
            return {"status": "ok", "directive": None}

    def _handle_unavailable(self, exc: BaseException) -> Directive | None:
        """Apply the unavailability policy after exhausting retries."""
        if self._unavailable_policy == "halt":
            raise DirectiveError(
                action="halt",
                reason=f"Control plane unreachable: {exc}",
            )
        _log.warning("Control plane unreachable (policy=continue): %s", exc)
        return None

    @staticmethod
    def _parse_directive(body: dict[str, Any]) -> Directive | None:
        """Extract a :class:`Directive` from the response envelope, if present.

        Uses Pydantic DirectiveResponseSchema for structured validation.
        On ValidationError: log warning and return None (fail open).
        """
        raw = body.get("directive")
        if raw is None:
            return None
        try:
            try:
                parsed = DirectiveResponseSchema.model_validate(raw)
            except ValidationError as ve:
                _log.warning("Directive validation failed: %s", ve)
                return None

            payload: dict[str, Any] = parsed.payload or {}
            if parsed.degrade_to and "degrade_to" not in payload:
                payload["degrade_to"] = parsed.degrade_to

            return Directive(
                action=DirectiveAction(parsed.action),
                reason=parsed.reason or "",
                grace_period_ms=parsed.grace_period_ms,
                payload=payload,
            )
        except (KeyError, ValueError) as exc:
            _log.warning("Malformed directive in response: %s (%s)", raw, exc)
            return None


# ------------------------------------------------------------------
# Non-blocking event queue + dedicated directive handler queue
# ------------------------------------------------------------------

# Both queues are sized identically by design: they share the
# same drop-on-full backpressure semantics, and an asymmetric size
# would mean directive bursts could starve event throughput (or vice
# versa). 1000 is generous for the event queue (typical agent emits
# 1-10 events/sec; 1000 is ~2 minutes of buffering at 10/sec) and
# loose for the directive queue (custom-directive bursts are bounded
# by operator action, not LLM call volume). If these need to differ,
# fork the constants and add a regression test for the asymmetry.
_MAX_QUEUE_SIZE = 1000
_MAX_DIRECTIVE_QUEUE_SIZE = 1000
_SENTINEL = object()
# Put on the event queue only to wake the drain thread for a shutdown
# request; carries nothing to post.
_WAKE = object()
# What _EventStore.take returns when it has no item to give.
_NOTHING = object()

# How long the drain thread waits for an event before it looks for a
# shutdown request again. It is woken for one at once when the queue's
# lock is free; this bounds how late it notices one it could not be woken
# for (the signal interrupted a thread holding that lock).
_DRAIN_WAIT_SECS = 1.0

# How long flush() waits for the queue to drain, and the part of a
# shutdown on the drain thread spent posting the events still queued before
# session_end: ample for a reachable control plane to take a backlog,
# short enough that an unreachable one holds the process's exit only
# briefly.
_FLUSH_TIMEOUT_SECS = 3.0

# The rest of that shutdown, for session_end: one attempt, which a
# reachable control plane answers in milliseconds.
_SESSION_END_TIMEOUT_SECS = 5.0

# The deadline of a shutdown on the drain thread, counted from its request:
# every POST the shutdown makes is a single attempt whose timeout is capped
# by the time left, and every lock in it is waited for only briefly (see
# SHUTDOWN_LOCK_WAIT_SECS), so not even a control plane that accepts and
# never answers holds the shutdown's own work past it.
SHUTDOWN_TIMEOUT_SECS = _FLUSH_TIMEOUT_SECS + _SESSION_END_TIMEOUT_SECS

# The least time session_end's single POST gets, even once the deadline
# has passed: enough for a control plane on the same network to answer.
SESSION_END_MIN_POST_SECS = 0.5

# The longest a shutdown on the drain thread takes, from its request to its
# end. An event's POST already under way when the shutdown is requested
# cannot be cut short: its attempt runs to the request timeout (its retry
# is skipped), and session_end still gets its one short attempt after it,
# 10.5 s in all. Well inside Kubernetes' default 30 s termination grace
# period. A request timeout bounds each socket operation, not name
# resolution, so a slow DNS lookup for the control plane is not covered.
SHUTDOWN_LIMIT_SECS = max(SHUTDOWN_TIMEOUT_SECS, _TIMEOUT_SECS + SESSION_END_MIN_POST_SECS)

# Room on top of SHUTDOWN_LIMIT_SECS for a waiter to see the shutdown
# finish: the work between and after the POSTs (serialising, closing the
# client) takes milliseconds, so half a second covers a loaded machine.
_SHUTDOWN_FINISH_SLACK_SECS = 0.5

# How long that shutdown waits for a lock the code a signal interrupted may
# hold (the session's, the stream guards', the policy's, the event queue's)
# before doing without it. Sensor code holds these for microseconds; one
# the interrupted code holds is released only once the signal handler
# returns, or never: on Python 3.13 an exception a signal handler raises
# while the interrupted code is at a loop's back-edge can skip that code's
# ``with`` / ``finally`` cleanup, leaving its lock held. So waiting any
# longer buys nothing, and session_end goes out without the lock.
SHUTDOWN_LOCK_WAIT_SECS = 0.5


def shutdown_lock_wait(deadline: float) -> float:
    """How long a shutdown with ``deadline`` (a ``time.monotonic()``
    value) may wait for a lock now: ``SHUTDOWN_LOCK_WAIT_SECS``, or what is
    left before the deadline, or nothing once it has passed."""
    return min(SHUTDOWN_LOCK_WAIT_SECS, max(deadline - time.monotonic(), 0.0))


# How long close() waits for each queue thread to exit.
_THREAD_EXIT_TIMEOUT_SECS = 5.0

# How often a wait for a shutdown on the drain thread checks whether it
# has finished and, until the drain thread has been woken, tries the
# wake-up again (it goes on the queue only while the queue's lock is
# free). Polling also keeps the signal handler that waits from ever
# blocking on a lock; 10 ms is well under the time the shutdown's HTTP
# POSTs take.
_SHUTDOWN_POLL_SECS = 0.01


class _EventStore(queue.Queue[Any]):
    """The event queue's store: a ``queue.Queue`` that can also take an
    item without ever waiting for its lock."""

    def offer(self, item: object) -> bool:
        """Put ``item`` unless that means waiting for the queue's lock;
        return whether it was put. For a signal handler, which may have
        interrupted this thread inside a queue call that holds the lock
        (a ``threading.Lock``, not re-entrant). Ignores ``maxsize``: the
        item is a control marker, not an event."""
        if not self.mutex.acquire(blocking=False):
            return False
        try:
            self._put(item)
            self.unfinished_tasks += 1
            self.not_empty.notify()
        finally:
            self.mutex.release()
        return True

    def take(self, lock_wait: float) -> object:
        """``get_nowait`` that waits at most ``lock_wait`` seconds for the
        queue's lock; returns ``_NOTHING`` when the queue is empty or the
        lock stays held (by code a signal interrupted, see
        SHUTDOWN_LOCK_WAIT_SECS). The caller calls ``task_done``."""
        if not self.mutex.acquire(timeout=lock_wait):
            return _NOTHING
        try:
            if not self._qsize():
                return _NOTHING
            item = self._get()
            self.not_full.notify()
            return item
        finally:
            self.mutex.release()

    def lock_is_free(self, lock_wait: float) -> bool:
        """Whether the queue's lock can be taken within ``lock_wait``
        seconds (it is released again at once)."""
        if not self.mutex.acquire(timeout=lock_wait):
            return False
        self.mutex.release()
        return True


def _redeliver(signum: int) -> None:
    """Deliver ``signum`` to the main thread, where Python runs signal
    handlers; to the process where threads cannot be signalled (Windows,
    where only the default action, ending the process, is left to do)."""
    pthread_kill = getattr(signal, "pthread_kill", None)
    main_ident = threading.main_thread().ident
    if pthread_kill is not None and main_ident is not None:
        try:
            pthread_kill(main_ident, signum)
            return
        except OSError:
            pass
    os.kill(os.getpid(), signum)


class DrainShutdown:
    """A shutdown handed to the drain thread by
    :meth:`EventQueue.shutdown_on_drain_thread`.

    Nothing a signal handler calls here waits for a lock (the wake-up
    takes the queue's lock only when it is free), so the handler can use
    it whatever the thread it interrupted holds.
    """

    def __init__(
        self,
        final_step: Callable[[float], None],
        wake: Callable[[], bool],
        drain_thread: threading.Thread,
        report: Callable[[], None] | None = None,
    ) -> None:
        # When the shutdown was requested: its deadline counts from here,
        # not from when the drain thread gets to it, which an event's POST
        # under way can hold up.
        self.requested_at = time.monotonic()
        # Called on the drain thread with the shutdown's deadline (a
        # time.monotonic() value).
        self.final_step = final_step
        # Called on the drain thread once the shutdown is over, for what
        # its caller logs: logging takes locks the code a signal
        # interrupted may hold.
        self.report = report
        self._wake = wake
        self._woken = False
        self._drain_thread = drain_thread
        # Set by the drain thread only and read through is_set(): a wait
        # polls it (see _SHUTDOWN_POLL_SECS).
        self._finished = threading.Event()
        self._redeliver: int | None = None

    @property
    def finished(self) -> bool:
        """Whether the drain thread has finished the shutdown."""
        return self._finished.is_set()

    def wake(self) -> None:
        """Wake the drain thread for the shutdown, once; a try that would
        have waited for the queue's lock is repeated on the next call."""
        if not self._woken:
            self._woken = self._wake()

    def wait(self, timeout: float | None = None) -> bool:
        """Wait up to ``timeout`` seconds for the shutdown to finish,
        waking the drain thread meanwhile; return whether it finished.
        Without a timeout, wait as long as a shutdown can take
        (``SHUTDOWN_LIMIT_SECS`` from its request). On the drain thread
        itself it returns at once: that thread is the one that finishes
        it."""
        if threading.current_thread() is self._drain_thread:
            return self._finished.is_set()
        if timeout is None:
            deadline = self.requested_at + SHUTDOWN_LIMIT_SECS + _SHUTDOWN_FINISH_SLACK_SECS
        else:
            deadline = time.monotonic() + timeout
        while not self._finished.is_set():
            self.wake()
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return False
            time.sleep(min(_SHUTDOWN_POLL_SECS, remaining))
        return True

    def redeliver_when_finished(self, signum: int) -> bool:
        """Have the drain thread deliver ``signum`` to the main thread once
        the shutdown has finished. Returns True when it has finished
        already: the caller then acts on the signal itself, and a delivery
        the drain thread made in the same instant ends in that same
        action."""
        self._redeliver = signum
        return self._finished.is_set()

    def finish(self) -> None:
        """Called by the drain thread when the shutdown is done."""
        self._finished.set()
        signum = self._redeliver
        if signum is not None:
            try:
                _redeliver(signum)
            except Exception:
                _log.warning("shutdown: could not deliver signal %d again", signum, exc_info=True)


class EventQueue:
    """Non-blocking event queue with two background threads.

    Two queues, two threads:

    * **Event queue + drain thread.** ``enqueue()`` puts events here
      (non-blocking). ``_drain_loop`` pulls events one at a time and
      calls :meth:`ControlPlaneClient.post_event`. Whenever the
      response envelope contains a non-None ``Directive``, the drain
      thread hands it off to the directive queue and **immediately
      continues draining events**. The drain thread NEVER executes
      directive logic itself, so a slow custom handler cannot back up
      the event queue.
    * **Directive queue + directive handler thread.** When a
      ``directive_handler`` callback is supplied, ``__init__`` starts
      a second daemon thread (``flightdeck-directive-queue``) that
      reads from the directive queue and invokes the handler one
      directive at a time. Single-consumer means at-most-once
      execution for free -- no dedup state needed.

    This is the two-queue pattern.
    The previous design called the directive callback inline on the
    drain thread, which let a slow handler stall the entire event
    pipeline (silent event loss after 1000 backed-up events) and
    forced an ``is_drain_thread()`` workaround on ``flush()`` that
    introduced its own ack-loss race during shutdown.

    If no ``directive_handler`` is supplied, the directive queue and
    its thread are not created. Returned directives are silently
    discarded. This matches the unit-test fixtures that construct an
    ``EventQueue`` directly without a ``Session``.

    A signal handler ends the session through the drain thread
    (:meth:`shutdown_on_drain_thread`) rather than on the thread the
    signal interrupted, which may hold the queue's, the session's or the
    policy's lock.
    """

    def __init__(
        self,
        client: ControlPlaneClient,
        directive_handler: Callable[[Directive], None] | None = None,
        directive_session_id: str | None = None,
        directive_router: Callable[[str, Directive], bool] | None = None,
    ) -> None:
        self._client = client
        self._directive_handler = directive_handler
        # Called with a directive for another session's event (an Agent
        # SDK run the sensor reports): returns True when that session's
        # reporter took it.
        self._directive_router = directive_router
        # When set, a directive goes to the handler only when the event
        # whose response carried it belongs to this session or to one of
        # its sub-agent children: the queue also carries the events of
        # sessions the sensor reports for other agents (Agent SDK runs),
        # whose directives are not this session's to act on.
        self._directive_session_id = directive_session_id
        self._queue = _EventStore(maxsize=_MAX_QUEUE_SIZE)
        # Set, with a plain attribute write, by shutdown_on_drain_thread;
        # the drain loop checks it before each wait for an event.
        self._shutdown: DrainShutdown | None = None
        # When the shutdown stops posting queued events (see post_queued),
        # and its deadline as a whole.
        self._queued_deadline = 0.0
        self._shutdown_deadline = 0.0
        # What the shutdown could not send, reported once it is over:
        # logging takes locks the code a signal interrupted may hold.
        self._dropped = 0
        self._failed_posts = 0
        self._drain_thread = threading.Thread(
            target=self._drain_loop,
            daemon=True,
            name="flightdeck-event-queue",
        )

        # Directive queue + handler thread are only spun up when there
        # is a handler to invoke. Tests that build EventQueue directly
        # (no Session) get the legacy "discard directives" behaviour.
        self._directive_queue: queue.Queue[Directive | object] | None = None
        self._directive_thread: threading.Thread | None = None
        if directive_handler is not None:
            self._directive_queue = queue.Queue(
                maxsize=_MAX_DIRECTIVE_QUEUE_SIZE,
            )
            self._directive_thread = threading.Thread(
                target=self._directive_loop,
                daemon=True,
                name="flightdeck-directive-queue",
            )

        self._drain_thread.start()
        if self._directive_thread is not None:
            self._directive_thread.start()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def enqueue(self, payload: dict[str, Any]) -> None:
        """Put *payload* on queue.  Never blocks.  Never raises.

        The drop-oldest fallback below is the v1 behaviour: real
        LLM provider latency (hundreds of ms per call) throttles
        event generation naturally, so the 1000-slot queue only
        fills under pathological synthetic load. Micro-batching
        was considered and rejected for v1.
        """
        try:
            self._queue.put_nowait(payload)
        except queue.Full:
            # Drop oldest, enqueue new. The dropped item must have
            # task_done() called for it so flush()'s Queue.join()
            # accounting stays correct.
            try:
                self._queue.get_nowait()
                self._queue.task_done()
            except queue.Empty:
                pass
            with contextlib.suppress(queue.Full):
                self._queue.put_nowait(payload)
            _log.warning(
                "Event queue full (%d), dropped oldest event",
                _MAX_QUEUE_SIZE,
            )

    def flush(self, timeout: float = _FLUSH_TIMEOUT_SECS) -> None:
        """Block until every currently-queued event has been processed.

        Waits on the EVENT queue only -- the directive queue is
        internal control flow and waiting on it from inside a directive
        handler would self-deadlock by exactly the same mechanism the
        old ``is_drain_thread`` guard was working around. Under the
        two-queue design, this method is safe to call from
        anywhere except the drain thread itself; in particular, it
        works correctly from inside ``Session._apply_directive``
        because that method now runs on the directive handler thread,
        which is independent of the drain thread, so ``Queue.join()``
        on the event queue can make progress.

        A timeout is enforced via a helper thread + Event so this
        never blocks the caller (typically the shutdown path)
        indefinitely. On timeout we log a warning and return so the
        agent can continue exiting.
        """
        done = threading.Event()

        def _waiter() -> None:
            try:
                self._queue.join()
            finally:
                done.set()

        threading.Thread(
            target=_waiter,
            daemon=True,
            name="flightdeck-event-queue-flush",
        ).start()
        if not done.wait(timeout=timeout):
            _log.warning(
                "flush: timed out after %.1fs waiting for queue drain",
                timeout,
            )

    def close(self) -> None:
        """Stop the drain thread and (if running) the directive handler.

        Each thread is given 5 seconds to drain its sentinel and exit.
        If a thread does not exit within the timeout the join returns
        anyway and we log at error level so operators have an explicit
        signal that the daemon thread will be killed by process
        teardown rather than exiting cleanly. The most likely cause is
        a custom directive handler that is still running when the
        agent calls teardown() (handlers run with no timeout on the
        directive thread).
        """
        if self._drain_thread.is_alive():
            # Skipped once the drain thread has exited (a shutdown on it
            # ran): nothing would consume the sentinel, and a full queue
            # would block this put for good.
            self._queue.put(_SENTINEL)
        self._drain_thread.join(timeout=_THREAD_EXIT_TIMEOUT_SECS)
        if self._drain_thread.is_alive():
            _log.error(
                "close: drain thread did not exit within %.0fs; "
                "process teardown will kill it as a daemon",
                _THREAD_EXIT_TIMEOUT_SECS,
            )
        if self._directive_queue is not None and self._directive_thread is not None:
            self._directive_queue.put(_SENTINEL)
            self._directive_thread.join(timeout=_THREAD_EXIT_TIMEOUT_SECS)
            if self._directive_thread.is_alive():
                _log.error(
                    "close: directive handler thread did not exit "
                    "within %.0fs -- a custom handler is likely still "
                    "running. The thread will be killed by process "
                    "teardown.",
                    _THREAD_EXIT_TIMEOUT_SECS,
                )

    def shutdown_on_drain_thread(
        self,
        final_step: Callable[[float], None],
        report: Callable[[], None] | None = None,
    ) -> DrainShutdown | None:
        """Have the drain thread end the queue: post the events already
        queued, run ``final_step`` with the shutdown's deadline (it may
        call :meth:`post_queued` and :meth:`post_now`), stop the directive
        thread, then run ``report`` and exit. The deadline is
        ``SHUTDOWN_TIMEOUT_SECS`` from now; an event's POST already under
        way is not retried, and finishes first (see SHUTDOWN_LIMIT_SECS).
        The caller waits on the returned handle; None means no drain
        thread is running to do it.

        Takes no lock that a frame below the caller could hold, so a
        signal handler can call it: the request is a plain attribute the
        drain loop reads, and the wake-up is put on the queue only when
        its lock is free (the handle retries it, and the drain loop
        notices the request within ``_DRAIN_WAIT_SECS`` regardless).
        Directives that arrive from then on are dropped: the session they
        would act on is ending.
        """
        if not self._drain_thread.is_alive():
            return None
        shutdown = self._shutdown
        if shutdown is None:
            shutdown = DrainShutdown(
                final_step, lambda: self._queue.offer(_WAKE), self._drain_thread, report
            )
            self._shutdown = shutdown
        shutdown.wake()
        return shutdown

    def post_queued(self) -> None:
        """Post the events queued so far, in order, during a shutdown on
        the drain thread; anything else calling it is a no-op.

        Bounded by the shutdown's budget for queued events
        (``_FLUSH_TIMEOUT_SECS``): each event gets one attempt whose
        timeout is capped by the time left, and an event still queued when
        the budget runs out is dropped (counted, and reported once the
        shutdown is over) rather than posted, so a control plane that is
        down or slow holds the process's exit no longer than the budget,
        and session_end, posted after this, stays the session's last
        event. The queue's lock is waited for only briefly (see
        SHUTDOWN_LOCK_WAIT_SECS), and not at all past the shutdown's
        deadline; while it stays held, the events left are not sent.
        """
        if threading.current_thread() is not self._drain_thread or self._shutdown is None:
            return
        while True:
            item = self._queue.take(shutdown_lock_wait(self._shutdown_deadline))
            if item is _NOTHING:
                break
            try:
                if item is _SENTINEL or item is _WAKE:
                    continue
                remaining = self._queued_deadline - time.monotonic()
                if remaining <= 0:
                    self._dropped += 1
                    continue
                self._post(item, timeout=min(_TIMEOUT_SECS, remaining), max_attempts=1)
            finally:
                self._queue.task_done()

    def post_now(self, payload: dict[str, Any], *, timeout: float) -> None:
        """Post ``payload`` at once, in one attempt within ``timeout``
        seconds, during a shutdown on the drain thread (session_end, after
        the queued events); anything else calling it is a no-op. A failure
        is counted and reported once the shutdown is over, and a directive
        in the response is dropped."""
        if threading.current_thread() is not self._drain_thread or self._shutdown is None:
            return
        self._post(payload, timeout=timeout, max_attempts=1)

    def lock_is_free(self, lock_wait: float) -> bool:
        """Whether the event queue's lock can be taken within
        ``lock_wait`` seconds (see SHUTDOWN_LOCK_WAIT_SECS)."""
        return self._queue.lock_is_free(lock_wait)

    def _shutting_down(self) -> bool:
        """Whether a shutdown has been requested (a plain attribute read,
        so the transport can ask it between the attempts of a post)."""
        return self._shutdown is not None

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _directive_is_ours(self, item: object) -> bool:
        """Whether a directive in the response to ``item`` is for this
        queue's session: always when no session is set; otherwise when the
        event is the session's own or one of its sub-agent children's."""
        if self._directive_session_id is None or not isinstance(item, dict):
            return True
        return self._directive_session_id in (item.get("session_id"), item.get("parent_session_id"))

    def _route_directive(self, item: object, directive: Directive) -> None:
        """Hand a directive for another session's event to that
        session's reporter; drop it when none takes it."""
        session_id = item.get("session_id") if isinstance(item, dict) else None
        taken = False
        if self._directive_router is not None and isinstance(session_id, str):
            try:
                taken = self._directive_router(session_id, directive)
            except Exception:
                _log.debug("drain: routing a directive failed", exc_info=True)
        if not taken:
            _log.debug(
                "drain: directive %s for another session's event ignored",
                directive.action.value,
            )

    def _drain_loop(self) -> None:
        """Background thread: drain queue, post events, hand off directives.

        For each item drained:

        1. Call ``ControlPlaneClient.post_event``.
        2. If a non-None directive is returned AND a directive handler
           is configured, ``put_nowait`` the directive onto the
           directive queue and continue. The handler runs on a
           separate thread; the drain thread is back at the top of
           the loop within microseconds, ready to drain the next
           event.

        Calls ``task_done()`` after every item -- success, failure,
        and the sentinel -- so ``Queue.join()`` (used by ``flush()``)
        always reflects the true number of unprocessed events.

        Before each wait for an event it looks for a shutdown request
        (see :meth:`shutdown_on_drain_thread`) and, finding one, runs it
        and exits.
        """
        while True:
            shutdown = self._shutdown
            if shutdown is not None:
                self._run_shutdown(shutdown)
                return
            try:
                item = self._queue.get(timeout=_DRAIN_WAIT_SECS)
            except queue.Empty:
                continue
            try:
                if item is _SENTINEL:
                    return
                if item is not _WAKE:
                    self._post(item)
            finally:
                self._queue.task_done()

    def _post(
        self,
        item: object,
        *,
        timeout: float | None = None,
        max_attempts: int | None = None,
    ) -> None:
        """Post one event and hand any directive in the response on.
        ``timeout`` / ``max_attempts`` are a shutdown's limits for the
        request; normal draining leaves the transport's defaults. Once a
        shutdown is requested, even while this post is under way, a failed
        attempt is not retried and the failure is counted, not logged."""
        directive: Directive | None = None
        limits: dict[str, Any] = {}
        if timeout is not None:
            limits["timeout"] = timeout
        if max_attempts is not None:
            limits["max_attempts"] = max_attempts
        try:
            # The drain thread processes async events only
            # (not the synchronous session_start POST issued
            # by Session._post_event). The ``attached`` flag
            # therefore only ever arrives on the drain path
            # if the backend protocol is extended, and the
            # async path has no session handle to log it on.
            # Discard here; Session._post_event is the sole
            # consumer of the attach confirmation.
            directive, _ = self._client.post_event(
                item,  # type: ignore[arg-type]
                shutting_down=self._shutting_down,
                **limits,
            )
        except Exception as exc:
            if self._shutdown is not None:
                # Reported once the shutdown is over (see _run_shutdown).
                self._failed_posts += 1
            else:
                event_type = "unknown"
                if isinstance(item, dict):
                    event_type = str(item.get("event_type", "unknown"))
                _log.warning(
                    "drain: failed to post %s event: %s",
                    event_type,
                    exc,
                )
        if directive is not None and self._shutdown is not None:
            return  # the session it would act on is ending
        if directive is not None and not self._directive_is_ours(item):
            self._route_directive(item, directive)
            directive = None
        if directive is not None and self._directive_queue is not None:
            try:
                self._directive_queue.put_nowait(directive)
            except queue.Full:
                # Pathological case: a hung handler is blocking
                # the directive thread for so long that 1000
                # directives have backed up. Log loudly and
                # drop the new directive -- the alternative is
                # to drop the oldest, which could lose a
                # shutdown directive that has been waiting in
                # line for the handler to clear. Either choice
                # implies the agent is in serious trouble.
                _log.error(
                    "drain: directive queue full (%d), dropping incoming directive: action=%s",
                    _MAX_DIRECTIVE_QUEUE_SIZE,
                    directive.action.value,
                )

    def _run_shutdown(self, shutdown: DrainShutdown) -> None:
        """Run a shutdown on the drain thread, by its deadline
        (``SHUTDOWN_TIMEOUT_SECS`` from its request): post the events
        queued before it, run its final step with the deadline, stop the
        directive thread, then mark it finished (which also delivers a
        signal its caller asked to have delivered again). What went wrong,
        and the caller's report, are logged only after that, since logging
        takes locks the code a signal interrupted may hold."""
        self._queued_deadline = shutdown.requested_at + _FLUSH_TIMEOUT_SECS
        self._shutdown_deadline = shutdown.requested_at + SHUTDOWN_TIMEOUT_SECS
        failure: Exception | None = None
        try:
            self.post_queued()
            shutdown.final_step(self._shutdown_deadline)
        except Exception as exc:
            failure = exc
        finally:
            if self._directive_queue is not None:
                # No join: a custom handler still running must not hold
                # the shutdown up, and the thread is a daemon.
                with contextlib.suppress(queue.Full):
                    self._directive_queue.put_nowait(_SENTINEL)
            shutdown.finish()
        if failure is not None:
            _log.warning("shutdown on the drain thread failed", exc_info=failure)
        if self._dropped or self._failed_posts:
            _log.warning(
                "shutdown: %d queued events were not sent within %.1fs, and %d posts failed",
                self._dropped,
                _FLUSH_TIMEOUT_SECS,
                self._failed_posts,
            )
        if shutdown.report is not None:
            try:
                shutdown.report()
            except Exception:
                _log.debug("shutdown: the report failed", exc_info=True)

    def _directive_loop(self) -> None:
        """Background thread: drain the directive queue.

        Single-consumer, sequential processing. Each call to
        ``self._directive_handler`` runs to completion before the next
        directive is pulled.

        The handler invocation is wrapped in ``except BaseException``
        rather than the usual ``except Exception``. The handler is
        user-supplied code (a function decorated with
        ``@flightdeck_sensor.directive``) that may misbehave -- a
        defensive ``sys.exit()`` or any other ``BaseException``
        subclass would silently kill this daemon thread under
        ``except Exception`` and the directive queue would back up
        with no recovery. The wider
        clause is safe in this daemon-thread context because Python
        signals are delivered to the main thread, not background
        threads, so the usual concern about catching
        ``KeyboardInterrupt`` does not apply here. Exceptions are
        logged and the loop continues.
        """
        # Assertions are stripped under ``python -O`` so a
        # bug that lets the loop start without a queue or handler
        # would silently AttributeError downstream. Explicit narrow
        # + RuntimeError surfaces the contract violation.
        if self._directive_queue is None or self._directive_handler is None:
            raise RuntimeError(
                "_directive_loop started without a queue/handler — constructor invariant violated",
            )
        while True:
            try:
                item = self._directive_queue.get(timeout=1.0)
            except queue.Empty:
                continue
            try:
                if item is _SENTINEL:
                    return
                try:
                    self._directive_handler(item)  # type: ignore[arg-type]
                except BaseException as exc:  # noqa: BLE001
                    _log.warning(
                        "directive handler raised %s, ignoring: %s",
                        type(exc).__name__,
                        exc,
                    )
            finally:
                self._directive_queue.task_done()
