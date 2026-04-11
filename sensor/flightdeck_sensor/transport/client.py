"""HTTP transport to the Flightdeck control plane.

Uses only the Python standard library (``urllib.request``).
No ``requests``, no ``httpx`` -- zero required dependencies.
"""

from __future__ import annotations

import contextlib
import json
import logging
import queue
import threading
import urllib.request
from typing import Any, Callable
from urllib.error import HTTPError, URLError

from flightdeck_sensor.core.exceptions import DirectiveError
from flightdeck_sensor.core.types import Directive, DirectiveAction
from flightdeck_sensor.transport.retry import with_retry

_log = logging.getLogger("flightdeck_sensor.transport.client")

_TIMEOUT_SECS = 10


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
        unavailable_policy: str = "continue",
    ) -> None:
        self._base_url = server.rstrip("/")
        self._token = token
        self._unavailable_policy = unavailable_policy

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def post_event(self, payload: dict[str, Any]) -> Directive | None:
        """POST an event to ``/v1/events`` and return any embedded directive."""
        return self._post("/v1/events", payload)

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
        # TODO(KI14)[Phase 5]: This URL is built against the ingestion
        # base URL but /v1/directives/sync lives on the api service.
        # In dev nginx routes /ingest/* to ingestion (which 404s) and
        # the broad except below swallows the failure. Needs an
        # architectural decision: separate api_url config, or nginx
        # forwarding for /ingest/v1/directives/*, or a single /v1/*
        # root. Same applies to register_directives below and to
        # core/session.py:_preflight_policy.
        url = f"{self._base_url}/v1/directives/sync"
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
            from pydantic import ValidationError

            from flightdeck_sensor.core.schemas import SyncResponseSchema

            with urllib.request.urlopen(req, timeout=1) as resp:
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
        url = f"{self._base_url}/v1/directives/register"
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
            with urllib.request.urlopen(req, timeout=1) as resp:
                resp.read()
        except Exception:
            _log.debug("directives register failed, ignoring", exc_info=True)

    def close(self) -> None:
        """No-op -- stdlib ``urllib`` has no persistent connection to close."""

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _post(self, path: str, body: dict[str, Any]) -> Directive | None:
        """POST JSON and parse the response envelope for a directive."""
        url = f"{self._base_url}{path}"
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

        try:
            raw = with_retry(lambda: self._do_request(req))
        except (URLError, OSError, TimeoutError, ConnectionError) as exc:
            return self._handle_unavailable(exc)

        return self._parse_directive(raw)

    def _do_request(self, req: urllib.request.Request) -> dict[str, Any]:
        """Execute a single HTTP request and return the parsed JSON body.

        Raises on HTTP 5xx so that :func:`with_retry` can retry.
        HTTP 4xx is a caller bug -- log and return a neutral response.
        """
        try:
            with urllib.request.urlopen(req, timeout=_TIMEOUT_SECS) as resp:
                body: dict[str, Any] = json.loads(resp.read().decode())
                return body
        except HTTPError as exc:
            if exc.code >= 500:
                raise  # let retry handle it
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
        from flightdeck_sensor.core.schemas import DirectiveResponseSchema

        raw = body.get("directive")
        if raw is None:
            return None
        try:
            from pydantic import ValidationError

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

_MAX_QUEUE_SIZE = 1000

# Cadence for the rate-limited drop-oldest warning emitted by
# ``EventQueue.enqueue``. The first drop is logged immediately;
# subsequent drops are summarized every ``_DROP_LOG_INTERVAL`` events.
# A burst of 10000 drops therefore produces ~100 log lines instead of
# 10000. Production agents that overrun their queue still get told,
# but a stress test or a runaway producer cannot flood the log stream.
_DROP_LOG_INTERVAL = 100
_MAX_DIRECTIVE_QUEUE_SIZE = 1000

# Capacity of the priority queue carrying control-plane events
# (directive_result acks today; heartbeats in the future). Sized small
# on purpose: a healthy agent emits at most a handful of acks per
# second, so 100 in flight indicates a serious backlog (hung handler,
# directive storm) and the operator should hear about it loudly via
# the ERROR log on overflow rather than masking the situation with
# silent drops or unbounded growth.
_MAX_CRITICAL_QUEUE_SIZE = 100

_SENTINEL = object()


class EventQueue:
    """Non-blocking event queue with two background threads.

    Three queues, two threads:

    * **Critical event queue.** ``enqueue_critical()`` puts
      control-plane events (directive_result acks today; heartbeats
      in the future) here. The drain thread checks this queue first
      on every iteration and drains it completely before touching
      the data-plane queue, so a flood of routine ``post_call``
      events can NEVER starve a directive_result. The queue is
      bounded at ``_MAX_CRITICAL_QUEUE_SIZE`` (100) and on overflow
      logs at ERROR level and drops the new event -- this case
      indicates a hung directive handler or a directive storm and
      should never happen in healthy operation.
    * **Data-plane event queue + drain thread.** ``enqueue()`` puts
      events here (non-blocking). ``_drain_loop`` first drains every
      pending critical event, then pulls one data-plane event and
      calls :meth:`ControlPlaneClient.post_event`. Whenever the
      response envelope contains a non-None ``Directive``, the drain
      thread hands it off to the directive queue and **immediately
      continues draining events**. The drain thread NEVER executes
      directive logic itself, so a slow custom handler cannot back up
      the event queue. The data-plane queue is bounded at
      ``_MAX_QUEUE_SIZE`` (1000) and on overflow uses drop-oldest
      with rate-limited warning logs.
    * **Directive queue + directive handler thread.** When a
      ``directive_handler`` callback is supplied, ``__init__`` starts
      a second daemon thread (``flightdeck-directive-queue``) that
      reads from the directive queue and invokes the handler one
      directive at a time. Single-consumer means at-most-once
      execution for free -- no dedup state needed.

    This is the two-queue pattern mandated by Phase 4.5 audit B-H,
    extended in Phase 4.5 audit B-L with the priority critical queue
    so directive_result acks cannot be lost to drop-oldest pressure
    on the data-plane queue. Pre-B-L, an unthrottled producer (4
    threads under a respx-mocked client in CI) could fill the
    1000-event data-plane queue faster than the drain thread could
    POST events, and the directive_result(acknowledged) event for
    a SHUTDOWN was dropped along with a routine ``post_call`` --
    making it impossible for the dashboard to distinguish "agent
    shut down cleanly" from "agent stopped responding".

    If no ``directive_handler`` is supplied, the directive queue and
    its thread are not created. Returned directives are silently
    discarded. This matches the unit-test fixtures that construct an
    ``EventQueue`` directly without a ``Session``.
    """

    def __init__(
        self,
        client: ControlPlaneClient,
        directive_handler: Callable[[Directive], None] | None = None,
    ) -> None:
        self._client = client
        self._directive_handler = directive_handler
        self._queue: queue.Queue[dict[str, Any] | object] = queue.Queue(
            maxsize=_MAX_QUEUE_SIZE,
        )
        # Priority queue for control-plane events. The drain thread
        # checks this queue first on every iteration; routine
        # data-plane events cannot starve the items here. Drop-newest
        # on overflow (see ``enqueue_critical``) so an existing
        # backlog of acks is preserved over a brand-new one that
        # is competing for room.
        self._critical_queue: queue.Queue[dict[str, Any]] = queue.Queue(
            maxsize=_MAX_CRITICAL_QUEUE_SIZE,
        )
        self._drain_thread = threading.Thread(
            target=self._drain_loop,
            daemon=True,
            name="flightdeck-event-queue",
        )

        # Counters for the rate-limited drop-oldest warning. The
        # warning was previously emitted on every overflow which, in
        # a hot test loop or a high-traffic agent, can produce tens
        # of thousands of identical log lines. We now emit the FIRST
        # drop loudly and then summarize every _DROP_LOG_INTERVAL
        # subsequent drops with a single line that reports the count
        # since the last summary. The drop semantics themselves are
        # unchanged.
        self._drop_count = 0
        self._drop_last_logged = 0

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
        """Put *payload* on queue.  Never blocks.  Never raises."""
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

            # Rate-limited warning. The first drop is logged
            # immediately so the operator hears about it; subsequent
            # drops are summarized every _DROP_LOG_INTERVAL events.
            # The previous unconditional warn produced 10000+ identical
            # log lines under stress (CI integration suite, runaway
            # producers) and drowned the rest of the agent log stream.
            self._drop_count += 1
            if self._drop_count == 1:
                _log.warning(
                    "Event queue full (%d), dropped oldest event "
                    "(further drops will be summarized every %d)",
                    _MAX_QUEUE_SIZE,
                    _DROP_LOG_INTERVAL,
                )
                self._drop_last_logged = 1
            elif self._drop_count - self._drop_last_logged >= _DROP_LOG_INTERVAL:
                dropped_since = self._drop_count - self._drop_last_logged
                _log.warning(
                    "Event queue full (%d), dropped %d more events "
                    "(total dropped: %d)",
                    _MAX_QUEUE_SIZE,
                    dropped_since,
                    self._drop_count,
                )
                self._drop_last_logged = self._drop_count

    def enqueue_critical(self, payload: dict[str, Any]) -> None:
        """Put *payload* on the priority critical queue. Never blocks.

        Use this for control-plane events that MUST NOT be lost to
        drop-oldest pressure on the data-plane queue:

        * directive_result(acknowledged) for SHUTDOWN, SHUTDOWN_FLAVOR,
          and DEGRADE acks -- the dashboard relies on these to
          distinguish "agent shut down cleanly" from "agent stopped
          responding".
        * directive_result(success/error) for custom directive
          executions -- the operator-facing dashboard surfaces the
          handler's return value or error.
        * Future heartbeat events emitted by ``/v1/heartbeat`` --
          when this code lands it MUST go through this method, not
          ``enqueue``, so a long burst of LLM call events cannot mute
          a heartbeat.

        On overflow (queue at ``_MAX_CRITICAL_QUEUE_SIZE``) the new
        event is dropped and an ERROR is logged. Drop-newest is used
        rather than drop-oldest because an existing backlog of acks
        is operationally more valuable than a brand-new one that
        would push them out -- the older acks have been waiting for
        delivery longer and may already be tied to operator-visible
        timeouts on the dashboard. The error log line names the
        dropped event's type and directive name so an operator can
        recover from the audit log if it ever fires.

        This method NEVER blocks the agent hot path (rule 27) and
        NEVER raises -- it is called from ``Session._apply_directive``
        and from custom directive handlers, both of which must
        remain side-effect-only.
        """
        try:
            self._critical_queue.put_nowait(payload)
        except queue.Full:
            event_type = str(payload.get("event_type", "unknown"))
            directive_name = str(payload.get("directive_name", ""))
            directive_status = str(payload.get("directive_status", ""))
            _log.error(
                "Critical event queue full (%d), dropping NEW event: "
                "type=%s directive_name=%s status=%s. This indicates a "
                "hung directive handler or a directive storm; the "
                "operator dashboard will be missing this ack.",
                _MAX_CRITICAL_QUEUE_SIZE,
                event_type,
                directive_name,
                directive_status,
            )

    def flush(self, timeout: float = 3.0) -> None:
        """Block until every currently-queued event has been processed.

        Waits on BOTH the data-plane event queue AND the critical
        event queue. The directive queue is internal control flow
        and waiting on it from inside a directive handler would
        self-deadlock by exactly the same mechanism the old
        ``is_drain_thread`` guard was working around. After the
        B-H two-queue refactor, this method is safe to call from
        anywhere except the drain thread itself; in particular, it
        works correctly from inside ``Session._apply_directive``
        because that method now runs on the directive handler thread,
        which is independent of the drain thread, so ``Queue.join()``
        on both event queues can make progress.

        Why join the critical queue too: ``Session._apply_directive``
        for SHUTDOWN now does ``enqueue_critical(ack)`` followed by
        ``flush()``. The flush must wait until the drain thread has
        actually delivered the ack, otherwise the SHUTDOWN flag flips
        and the agent exits before the ack POST has happened.
        Pre-B-L this was safe by accident (the ack was on the
        same queue as everything else); the priority queue split
        makes the join explicit.

        A timeout is enforced via a helper thread + Event so this
        never blocks the caller (typically the shutdown path)
        indefinitely. On timeout we log a warning and return so the
        agent can continue exiting.
        """
        done = threading.Event()

        def _waiter() -> None:
            try:
                # Order matters: drain critical first so any
                # remaining acks make it out before we report flush
                # complete. The drain thread always processes
                # critical items before each data-plane item, so by
                # the time the data-plane join returns, both queues
                # are empty -- but joining critical first makes the
                # invariant explicit and survives any future drain
                # loop refactor.
                self._critical_queue.join()
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
        agent calls teardown() (B-K limitation -- handlers run with no
        timeout on the directive thread).
        """
        self._queue.put(_SENTINEL)
        self._drain_thread.join(timeout=5)
        if self._drain_thread.is_alive():
            _log.error(
                "close: drain thread did not exit within 5s; "
                "process teardown will kill it as a daemon"
            )
        if self._directive_queue is not None and self._directive_thread is not None:
            self._directive_queue.put(_SENTINEL)
            self._directive_thread.join(timeout=5)
            if self._directive_thread.is_alive():
                _log.error(
                    "close: directive handler thread did not exit "
                    "within 5s -- a custom handler is likely still "
                    "running. The thread will be killed by process "
                    "teardown."
                )

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _drain_loop(self) -> None:
        """Background thread: drain queues, post events, hand off directives.

        Each iteration:

        1. **Drain ALL critical events first** (non-blocking). The
           critical queue carries directive_result acks that must
           never be starved by data-plane traffic, so we empty it
           completely before touching the data-plane queue. ``while
           get_nowait()`` is bounded because ``enqueue_critical``
           caps the queue at ``_MAX_CRITICAL_QUEUE_SIZE`` (100).
        2. **Pull ONE data-plane event** with a 1 s timeout so the
           loop wakes periodically to recheck the critical queue
           even when the data-plane queue is idle.
        3. **Process** the event via :meth:`_process_event`. The
           same helper handles both queues -- a critical event and
           a routine post_call go through the identical
           ``post_event`` round trip; the only difference is which
           queue they came from and the priority order.

        Each item gets ``task_done()`` after processing -- success,
        failure, and the sentinel -- so ``Queue.join()`` (used by
        ``flush()``) always reflects the true number of unprocessed
        events on both queues.

        Shutdown ordering: when the data-plane sentinel arrives we
        drain any remaining critical items one last time so that an
        ``enqueue_critical(...)`` immediately followed by
        ``close()`` cannot race-lose the critical event. The
        existing flush()-before-close() in
        ``Session.end()`` already provides this guarantee, but the
        belt-and-braces drain here makes the invariant local to the
        drain loop and survives any future refactor of the close
        path.
        """
        while True:
            # 1. Drain all pending critical events first.
            self._drain_critical_queue()

            # 2. Pull one data-plane event (timeout=1s lets the loop
            #    wake periodically to recheck the critical queue).
            try:
                item = self._queue.get(timeout=1.0)
            except queue.Empty:
                continue

            try:
                if item is _SENTINEL:
                    # Final critical drain before shutdown so the
                    # close() path cannot race-lose a late ack.
                    self._drain_critical_queue()
                    return
                self._process_event(item)
            finally:
                self._queue.task_done()

    def _drain_critical_queue(self) -> None:
        """Pop and process every pending critical event without blocking.

        Bounded by ``_MAX_CRITICAL_QUEUE_SIZE`` (100), so a single
        invocation can never run unbounded even if the producer is
        currently faster than the network round-trip time.
        """
        while True:
            try:
                item = self._critical_queue.get_nowait()
            except queue.Empty:
                return
            try:
                self._process_event(item)
            finally:
                self._critical_queue.task_done()

    def _process_event(self, item: dict[str, Any] | object) -> None:
        """POST one event and hand off any returned directive.

        Shared by both queue paths so that critical and data-plane
        events go through identical processing -- the only difference
        is the priority order in :meth:`_drain_loop`. Never raises.
        """
        directive: Directive | None = None
        try:
            directive = self._client.post_event(item)  # type: ignore[arg-type]
        except Exception as exc:
            event_type = "unknown"
            if isinstance(item, dict):
                event_type = str(item.get("event_type", "unknown"))
            _log.warning(
                "drain: failed to post %s event: %s",
                event_type,
                exc,
            )
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
                    "drain: directive queue full (%d), "
                    "dropping incoming directive: action=%s",
                    _MAX_DIRECTIVE_QUEUE_SIZE,
                    directive.action.value,
                )

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
        with no recovery (Phase 4.5 audit Hat 4 finding). The wider
        clause is safe in this daemon-thread context because Python
        signals are delivered to the main thread, not background
        threads, so the usual concern about catching
        ``KeyboardInterrupt`` does not apply here. Exceptions are
        logged and the loop continues.
        """
        assert self._directive_queue is not None
        assert self._directive_handler is not None
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
