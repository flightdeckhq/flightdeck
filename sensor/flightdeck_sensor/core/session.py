"""Session lifecycle management for flightdeck-sensor.

A ``Session`` represents one running instance of an agent.  It holds the
sensor configuration, registers process-exit handlers, and posts lifecycle
events to the control plane.
"""

from __future__ import annotations

import atexit
import json
import logging
import os
import signal
import socket
import threading
import urllib.request
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any

from flightdeck_sensor.core.policy import PolicyCache
from flightdeck_sensor.core.types import (
    Directive,
    DirectiveAction,
    DirectiveContext,
    DirectiveRegistration,
    EventType,
    SensorConfig,
    SessionState,
    StatusResponse,
    TokenUsage,
)

if TYPE_CHECKING:
    from flightdeck_sensor.transport.client import ControlPlaneClient, EventQueue

_log = logging.getLogger("flightdeck_sensor.core.session")

_PREFLIGHT_TIMEOUT_SECS = 1


class Session:
    """Manages the lifecycle of a single sensor session."""

    def __init__(
        self,
        config: SensorConfig,
        client: ControlPlaneClient,
        event_queue: EventQueue | None = None,
    ) -> None:
        self.config = config
        self.client = client

        # All Session state must be initialised BEFORE the EventQueue
        # so the drain thread (which starts inside EventQueue.__init__)
        # can safely call ``self._apply_directive`` from the moment it
        # is alive. Items only enter the queue after start(), so in
        # practice the drain thread idles in queue.get() until the
        # session is fully wired -- but the order here is the safe
        # invariant.
        self.policy = PolicyCache(
            local_limit=config.limit,
            local_warn_at=config.warn_at,
        )

        self._state = SessionState.ACTIVE
        self._tokens_used = 0
        self._token_limit: int | None = None
        self._lock = threading.Lock()

        self._shutdown_requested: bool = False
        self._shutdown_reason: str = ""

        # Prefer the already-resolved hostname from config (which
        # honors FLIGHTDECK_HOSTNAME for k8s pod grouping); fall
        # back to socket for tests that construct Session /
        # SensorConfig directly without going through init().
        self._host = config.hostname or socket.gethostname()
        self._framework: str | None = None
        self._model: str | None = None

        # Set by _post_event on the first response envelope where the
        # ingestion API reports attached=true (always the session_start
        # response per D094). Guards the INFO log so it fires exactly
        # once per process even if a future protocol extension sends
        # attached=true on subsequent events.
        self._attached_logged = False

        # Runtime context (hostname, OS, git, orchestration, frameworks
        # ...). Set once via set_context() before start() and attached
        # to the session_start event payload only. The control plane
        # stores it once in sessions.context and never updates it.
        self._context: dict[str, Any] = {}

        # Lazy import to avoid circular dependency at module level.
        from flightdeck_sensor.transport.client import EventQueue as LocalEventQueue

        # Wire _apply_directive as the directive HANDLER (not the
        # drain-thread callback). EventQueue's two-queue pattern
        # (Phase 4.5 audit B-H) runs the handler on a dedicated
        # ``flightdeck-directive-queue`` daemon thread, so:
        #   * a slow custom handler cannot back up the event queue
        #   * flush() called from inside _apply_directive (e.g. on
        #     shutdown) does not deadlock, because the directive
        #     handler thread is not the drain thread
        # Tests / external callers can still pass an explicit
        # ``event_queue`` to opt out (e.g. unit tests that mock the
        # queue entirely).
        self.event_queue: EventQueue = event_queue or LocalEventQueue(
            client,
            directive_handler=self._apply_directive,
        )

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def start(self) -> None:
        """Fire SESSION_START, register handlers, fetch policy, and sync directives."""
        self._post_event(EventType.SESSION_START)
        self._register_handlers()
        self._preflight_policy()

        from flightdeck_sensor import _directive_registry

        if _directive_registry:
            self._sync_directives(_directive_registry)

        if not self.config.quiet:
            _log.info(
                "Flightdeck session started: flavor=%s session=%s",
                self.config.agent_flavor,
                self.config.session_id,
            )

    def end(self) -> None:
        """Fire SESSION_END and clean up.

        Safe to call multiple times -- second call is a no-op.
        """
        if self._state == SessionState.CLOSED:
            return
        self._state = SessionState.CLOSED
        self._post_event(EventType.SESSION_END)
        self.event_queue.flush()
        self.event_queue.close()
        self.client.close()
        if not self.config.quiet:
            _log.info(
                "Flightdeck session ended: session=%s tokens=%d",
                self.config.session_id,
                self._tokens_used,
            )

    def set_context(self, context: dict[str, Any]) -> None:
        """Attach runtime context for inclusion in the session_start event.

        Called once from ``init()`` after running the context
        collectors. Set BEFORE :meth:`start` so the first event
        payload carries the context dict.
        """
        self._context = context

    def record_usage(self, usage: TokenUsage) -> int:
        """Atomically increment session token counts and return the new total.

        Returning the post-increment value lets concurrent callers
        capture **their own** contribution without re-reading
        ``self._tokens_used`` after the lock is released, which would
        otherwise let another thread's increment leak into this
        thread's reported ``tokens_used_session`` (Phase 4.5 audit
        B-G fix).
        """
        with self._lock:
            self._tokens_used += usage.total
            return self._tokens_used

    def record_model(self, model: str) -> None:
        """Record the model used in the most recent call."""
        with self._lock:
            self._model = model

    def record_framework(self, framework: str) -> None:
        """Record the framework if detected."""
        with self._lock:
            self._framework = framework

    def post_call_event(
        self,
        event_type: EventType,
        usage: TokenUsage,
        model: str,
        latency_ms: int,
        tool_name: str | None = None,
    ) -> Directive | None:
        """Post a call event and return any received directive."""
        session_total = self.record_usage(usage)
        self.record_model(model)
        return self._post_event(
            event_type,
            model=model,
            tokens_input=usage.input_tokens,
            tokens_output=usage.output_tokens,
            tokens_total=usage.total,
            tokens_used_session=session_total,
            latency_ms=latency_ms,
            tool_name=tool_name,
        )

    def post_call_event_async(
        self,
        event_type: EventType,
        usage: TokenUsage,
        model: str,
        latency_ms: int,
        tool_name: str | None = None,
    ) -> None:
        """Enqueue a call event (non-blocking).  Used on the hot path."""
        session_total = self.record_usage(usage)
        self.record_model(model)
        payload = self._build_payload(
            event_type,
            model=model,
            tokens_input=usage.input_tokens,
            tokens_output=usage.output_tokens,
            tokens_total=usage.total,
            tokens_used_session=session_total,
            latency_ms=latency_ms,
            tool_name=tool_name,
        )
        self.event_queue.enqueue(payload)

    def get_status(self) -> StatusResponse:
        """Build a status snapshot of the current session."""
        with self._lock:
            tokens = self._tokens_used
        limit = self._token_limit
        pct: float | None = None
        if limit is not None and limit > 0:
            pct = round((tokens / limit) * 100, 1)
        return StatusResponse(
            session_id=self.config.session_id,
            flavor=self.config.agent_flavor,
            agent_type=self.config.agent_type,
            state=self._state,
            tokens_used=tokens,
            token_limit=limit,
            pct_used=pct,
        )

    @property
    def state(self) -> SessionState:
        return self._state

    @property
    def tokens_used(self) -> int:
        with self._lock:
            return self._tokens_used

    @property
    def token_limit(self) -> int | None:
        return self._token_limit

    # ------------------------------------------------------------------
    # Preflight policy
    # ------------------------------------------------------------------

    def _preflight_policy(self) -> None:
        """Fetch effective policy from control plane on session start.

        Populates PolicyCache before the first LLM call. On any failure
        (network error, 404, parse error), logs at debug level and proceeds
        with empty cache. Fail open per D007.
        """
        try:
            url = (
                f"{self.config.api_url}/v1/policy"
                f"?flavor={self.config.agent_flavor}"
                f"&session_id={self.config.session_id}"
            )
            req = urllib.request.Request(
                url,
                headers={"Authorization": f"Bearer {self.config.token}"},
                method="GET",
            )
            with urllib.request.urlopen(req, timeout=_PREFLIGHT_TIMEOUT_SECS) as resp:
                data = json.loads(resp.read().decode())
                from pydantic import ValidationError

                from flightdeck_sensor.core.schemas import PolicyResponseSchema

                try:
                    parsed = PolicyResponseSchema.model_validate(data)
                except ValidationError:
                    _log.warning("preflight policy validation failed, using empty cache")
                    return

                policy_fields: dict[str, Any] = {}
                if parsed.token_limit is not None:
                    policy_fields["token_limit"] = parsed.token_limit
                if parsed.warn_at_pct is not None:
                    policy_fields["warn_at_pct"] = parsed.warn_at_pct
                if parsed.degrade_at_pct is not None:
                    policy_fields["degrade_at_pct"] = parsed.degrade_at_pct
                if parsed.degrade_to is not None:
                    policy_fields["degrade_to"] = parsed.degrade_to
                if parsed.block_at_pct is not None:
                    policy_fields["block_at_pct"] = parsed.block_at_pct
                if policy_fields:
                    self.policy.update(policy_fields)
        except Exception:
            _log.debug("preflight policy fetch failed, proceeding with empty cache", exc_info=True)

    # ------------------------------------------------------------------
    # Custom directives
    # ------------------------------------------------------------------

    def _sync_directives(
        self, registry: dict[str, DirectiveRegistration]
    ) -> None:
        """Sync registered custom directives with the control plane.

        Sends fingerprints to the server. For any the server does not
        recognise, sends the full schema in a follow-up register call.
        Fails open on any error.
        """
        try:
            summaries = [
                {"name": reg.name, "fingerprint": reg.fingerprint}
                for reg in registry.values()
            ]
            unknown_fps = self.client.sync_directives(
                self.config.agent_flavor, summaries
            )
            if unknown_fps:
                unknown_set = set(unknown_fps)
                to_register = [
                    {
                        "name": reg.name,
                        "description": reg.description,
                        "fingerprint": reg.fingerprint,
                        "parameters": [
                            {
                                "name": p.name,
                                "type": p.type,
                                "description": p.description,
                                "options": p.options,
                                "required": p.required,
                                "default": p.default,
                            }
                            for p in reg.parameters
                        ],
                    }
                    for reg in registry.values()
                    if reg.fingerprint in unknown_set
                ]
                if to_register:
                    self.client.register_directives(
                        self.config.agent_flavor, to_register
                    )
        except Exception:
            _log.debug(
                "directive sync failed, proceeding without sync", exc_info=True
            )

    def _build_directive_context(self) -> DirectiveContext:
        """Build an execution context for a custom directive handler."""
        with self._lock:
            tokens = self._tokens_used
            model = self._model or ""
        return DirectiveContext(
            session_id=self.config.session_id,
            flavor=self.config.agent_flavor,
            tokens_used=tokens,
            model=model,
        )

    def _build_directive_result_event(
        self,
        directive_name: str,
        success: bool,
        result: Any = None,
        error: str | None = None,
    ) -> dict[str, Any]:
        """Build a directive_result event payload for a custom directive.

        Field names match the worker's ``consumer.EventPayload`` schema
        (``directive_status`` / ``result`` / ``error``) so that
        ``BuildEventExtra`` can persist them into ``events.payload``.
        Previously this method emitted ``directive_success`` /
        ``directive_result`` / ``directive_error``, none of which the
        worker decoded -- causing the success flag, the handler return
        value, and any handler error message to be silently dropped at
        the ingestion boundary. Phase 4.5 audit B-D fix.
        """
        payload = self._build_payload(
            EventType.DIRECTIVE_RESULT,
            directive_name=directive_name,
            directive_action="custom",
            directive_status="success" if success else "error",
        )
        if result is not None:
            payload["result"] = result
        if error is not None:
            payload["error"] = error
        return payload

    def _execute_custom_directive(self, directive: Directive) -> None:
        """Execute a custom directive handler by name.

        Looks up the handler in the global registry, verifies the
        fingerprint matches, executes with a 5-second timeout
        (SIGALRM on non-Windows when running on the main thread --
        bypassed on the directive handler daemon thread, see B-K),
        and posts a directive_result event. Never raises -- always
        fails open.

        **Parameter validation is shape-only.**
        ``DirectivePayloadSchema`` validates the top-level shape of
        the directive payload (``directive_name: str``,
        ``fingerprint: str``, ``parameters: dict[str, Any]``), but
        the values inside ``parameters`` are passed to the handler
        unchanged via ``handler(ctx, **params)``. The
        ``DirectiveParameter`` schema declared at registration time
        (the ``parameters=[...]`` argument to
        ``@flightdeck_sensor.directive``) is used to compute the
        fingerprint and to render the dashboard form -- it is NOT
        enforced on incoming directive parameters. Handlers must
        validate their own inputs. Phase 4.5 audit Hat 4 finding.
        """
        from flightdeck_sensor import _directive_registry
        from flightdeck_sensor.core.schemas import DirectivePayloadSchema

        try:
            from pydantic import ValidationError
            parsed_payload = DirectivePayloadSchema.model_validate(directive.payload)
            name = parsed_payload.directive_name
            fingerprint = parsed_payload.fingerprint
            params = parsed_payload.parameters
        except (ValidationError, Exception) as exc:
            _log.warning("[flightdeck] custom directive payload validation failed: %s", exc)
            return

        reg = _directive_registry.get(name)
        if reg is None:
            _log.warning(
                "[flightdeck] custom directive '%s' not found in registry", name
            )
            payload = self._build_directive_result_event(
                name, success=False, error="handler not found"
            )
            self.event_queue.enqueue(payload)
            return

        if reg.fingerprint != fingerprint:
            _log.warning(
                "[flightdeck] custom directive '%s' fingerprint mismatch "
                "(expected %s, got %s)",
                name,
                reg.fingerprint,
                fingerprint,
            )
            payload = self._build_directive_result_event(
                name, success=False, error="fingerprint mismatch"
            )
            self.event_queue.enqueue(payload)
            return

        ctx = self._build_directive_context()

        try:
            result = self._run_handler_with_timeout(reg.handler, ctx, params)
            payload = self._build_directive_result_event(
                name, success=True, result=result
            )
            self.event_queue.enqueue(payload)
        except TimeoutError:
            _log.warning(
                "[flightdeck] custom directive '%s' timed out after 5s", name
            )
            payload = self._build_directive_result_event(
                name, success=False, error="timeout"
            )
            self.event_queue.enqueue(payload)
        except Exception as exc:
            _log.warning(
                "[flightdeck] custom directive '%s' raised: %s", name, exc
            )
            payload = self._build_directive_result_event(
                name, success=False, error=str(exc)
            )
            self.event_queue.enqueue(payload)

    @staticmethod
    def _run_handler_with_timeout(
        handler: Any,
        ctx: DirectiveContext,
        params: dict[str, Any],
    ) -> Any:
        """Run a directive handler with a 5-second timeout.

        Uses SIGALRM on non-Windows platforms. On Windows, runs without
        a timeout (the handler is trusted to return quickly).
        """
        if os.name != "nt" and threading.current_thread() is threading.main_thread():
            def _alarm_handler(signum: int, frame: Any) -> None:
                raise TimeoutError("custom directive handler timed out")

            old_handler = signal.signal(signal.SIGALRM, _alarm_handler)
            signal.alarm(5)
            try:
                result: Any = handler(ctx, **params)
            finally:
                signal.alarm(0)
                signal.signal(signal.SIGALRM, old_handler)
            return result
        else:
            return handler(ctx, **params)

    # ------------------------------------------------------------------
    # Event posting
    # ------------------------------------------------------------------

    def _post_event(
        self,
        event_type: EventType,
        **extra: Any,
    ) -> Directive | None:
        """Build the full event payload and POST it to the control plane."""
        payload = self._build_payload(event_type, **extra)
        directive, attached = self.client.post_event(payload)
        # Per D094, the ingestion response's ``attached`` flag only
        # ever surfaces true on the session_start envelope (the
        # synchronous lookup runs exactly once, at session_start
        # arrival). Guarding on _attached_logged keeps the behaviour
        # defensive: if a future ingestion version sets the flag on
        # more envelopes, we still log the confirmation exactly once
        # per sensor process rather than flooding the log at call
        # cadence.
        if attached and not self._attached_logged:
            self._attached_logged = True
            if not self.config.quiet:
                _log.info(
                    "Attached to existing session %s.",
                    self.config.session_id,
                )
        if directive is not None:
            self._apply_directive(directive)
        return directive

    def _build_payload(
        self,
        event_type: EventType,
        **extra: Any,
    ) -> dict[str, Any]:
        with self._lock:
            tokens_used_session = self._tokens_used
            framework = self._framework
            model = self._model

        payload: dict[str, Any] = {
            "session_id": self.config.session_id,
            "flavor": self.config.agent_flavor,
            "agent_type": self.config.agent_type,
            # D115 identity fields on every event.
            "agent_id": self.config.agent_id,
            "agent_name": self.config.agent_name,
            "client_type": self.config.client_type,
            "user": self.config.user_name,
            "hostname": self.config.hostname,
            "event_type": event_type.value,
            "host": self._host,
            "framework": framework,
            "model": model,
            "tokens_input": None,
            "tokens_output": None,
            "tokens_total": None,
            # D100: cache-token breakdown. Default 0 so the worker always
            # receives a non-null value for the NOT NULL DEFAULT 0 columns.
            "tokens_cache_read": 0,
            "tokens_cache_creation": 0,
            "tokens_used_session": tokens_used_session,
            "token_limit_session": self._token_limit,
            "latency_ms": None,
            "tool_name": None,
            "tool_input": None,
            "tool_result": None,
            "has_content": False,
            "content": None,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }

        # Attach runtime context only on session_start events. The
        # control plane stores sessions.context once and never updates
        # it on conflict, so sending it on every event would be
        # wasteful network traffic.
        if event_type == EventType.SESSION_START and self._context:
            payload["context"] = self._context

        payload.update(extra)
        return payload

    # ------------------------------------------------------------------
    # Directives
    # ------------------------------------------------------------------

    def _apply_directive(self, directive: Directive) -> None:
        """Apply a directive received from the control plane.

        Called from _post_event() on every event POST response. Must never raise
        for WARN, DEGRADE, or POLICY_UPDATE. SHUTDOWN and SHUTDOWN_FLAVOR set
        the _shutdown_requested flag -- the actual raise happens in _pre_call().
        """
        if directive.action == DirectiveAction.WARN:
            _log.warning("[flightdeck] policy warning: %s", directive.reason)
            payload = self._build_payload(
                EventType.POLICY_WARN,
                source="server",
                reason=directive.reason,
            )
            self.event_queue.enqueue(payload)

        elif directive.action == DirectiveAction.DEGRADE:
            degrade_to = directive.payload.get("degrade_to", "")
            with self._lock:
                current_model = self._model or ""
                tokens_used = self._tokens_used
                token_limit = self._token_limit
            # POLICY_DEGRADE: the user-facing enforcement decision event.
            # Fires ONCE per directive arrival (not per subsequent call) —
            # per-call swaps are visible via post_call.model only. Source
            # is always ``"server"`` because DEGRADE never originates from
            # a local init(limit=...) threshold (D035 — local fires WARN
            # only).
            policy_event = self._build_payload(
                EventType.POLICY_DEGRADE,
                source="server",
                threshold_pct=self.policy.degrade_at_pct,
                tokens_used=tokens_used,
                token_limit=token_limit,
                from_model=current_model,
                to_model=degrade_to,
            )
            self.event_queue.enqueue(policy_event)
            # DIRECTIVE_RESULT (acknowledged): the plumbing-level
            # acknowledgement that pairs with every other inbound
            # directive type. Ordered AFTER the POLICY_DEGRADE so the
            # decision event lands on the timeline before the ack.
            ack = self._build_payload(
                EventType.DIRECTIVE_RESULT,
                directive_name="degrade",
                directive_action="degrade",
                directive_status="acknowledged",
            )
            ack["result"] = {
                "message": "model degraded",
                "from_model": current_model,
                "to_model": degrade_to,
            }
            self.event_queue.enqueue(ack)
            self.policy.set_degrade_model(degrade_to)
            _log.info("[flightdeck] model degraded to: %s", degrade_to)

        elif directive.action == DirectiveAction.POLICY_UPDATE:
            allowed = {
                "token_limit", "warn_at_pct", "degrade_at_pct",
                "degrade_to", "block_at_pct",
            }
            fields = {
                k: v
                for k, v in directive.payload.items()
                if k in allowed
            }
            self.policy.update(fields)
            _log.debug("[flightdeck] policy updated from directive")

        elif directive.action == DirectiveAction.SHUTDOWN:
            _log.warning(
                "[flightdeck] shutdown directive received: %s",
                directive.reason,
            )
            # Acknowledge shutdown before flipping the flag. flush()
            # is now safe to call unconditionally because the B-H
            # two-queue refactor moved _apply_directive off the drain
            # thread onto a dedicated directive handler thread. The
            # event queue's drain thread is independent and continues
            # to make progress on Queue.join().
            ack = self._build_payload(
                EventType.DIRECTIVE_RESULT,
                directive_name="shutdown",
                directive_action="shutdown",
                directive_status="acknowledged",
            )
            ack["result"] = {
                "message": "agent shutting down",
                "reason": directive.reason or "directive received",
            }
            self.event_queue.enqueue(ack)
            try:
                self.event_queue.flush()
            except Exception as exc:
                _log.warning(
                    "[flightdeck] shutdown: failed to flush "
                    "acknowledgement event: %s",
                    exc,
                )
            with self._lock:
                self._shutdown_requested = True
                self._shutdown_reason = directive.reason

        elif directive.action == DirectiveAction.SHUTDOWN_FLAVOR:
            _log.warning(
                "[flightdeck] fleet shutdown directive received for flavor %s: %s",
                self.config.agent_flavor,
                directive.reason,
            )
            # Same architecture as the SHUTDOWN branch above -- safe
            # synchronous flush via the B-H two-queue refactor.
            ack = self._build_payload(
                EventType.DIRECTIVE_RESULT,
                directive_name="shutdown_flavor",
                directive_action="shutdown_flavor",
                directive_status="acknowledged",
            )
            ack["result"] = {
                "message": "agent shutting down (fleet-wide)",
                "reason": directive.reason or "fleet directive received",
            }
            self.event_queue.enqueue(ack)
            try:
                self.event_queue.flush()
            except Exception as exc:
                _log.warning(
                    "[flightdeck] shutdown_flavor: failed to flush "
                    "acknowledgement event: %s",
                    exc,
                )
            with self._lock:
                self._shutdown_requested = True
                self._shutdown_reason = directive.reason

        elif directive.action == DirectiveAction.THROTTLE:
            _log.warning(
                "[flightdeck] directive action not yet implemented: throttle. Ignoring.",
            )

        elif directive.action == DirectiveAction.CHECKPOINT:
            _log.warning(
                "[flightdeck] directive action not yet implemented: checkpoint. Ignoring.",
            )

        elif directive.action == DirectiveAction.CUSTOM:
            self._execute_custom_directive(directive)

        else:
            _log.debug("[flightdeck] unknown directive action: %s", directive.action.value)

    # ------------------------------------------------------------------
    # Process exit handlers
    # ------------------------------------------------------------------

    def _register_handlers(self) -> None:
        """Register atexit and signal handlers for clean shutdown."""
        atexit.register(self.end)
        # Only register signal handlers on the main thread
        if threading.current_thread() is threading.main_thread():
            self._register_signal(signal.SIGTERM)
            if os.name != "nt":
                self._register_signal(signal.SIGINT)

    def _register_signal(self, sig: signal.Signals) -> None:
        """Install a signal handler that calls end() and re-raises."""
        prev = signal.getsignal(sig)

        def _handler(signum: int, frame: Any) -> None:
            self.end()
            if callable(prev):
                prev(signum, frame)

        signal.signal(sig, _handler)
