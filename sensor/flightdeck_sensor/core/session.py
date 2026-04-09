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

        # Lazy import to avoid circular dependency at module level.
        from flightdeck_sensor.transport.client import EventQueue as LocalEventQueue

        self.event_queue: EventQueue = event_queue or LocalEventQueue(client)
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

        self._host = socket.gethostname()
        self._framework: str | None = None
        self._model: str | None = None

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

    def record_usage(self, usage: TokenUsage) -> None:
        """Atomically increment session token counts."""
        with self._lock:
            self._tokens_used += usage.total

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
        self.record_usage(usage)
        self.record_model(model)
        return self._post_event(
            event_type,
            model=model,
            tokens_input=usage.input_tokens,
            tokens_output=usage.output_tokens,
            tokens_total=usage.total,
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
        self.record_usage(usage)
        self.record_model(model)
        payload = self._build_payload(
            event_type,
            model=model,
            tokens_input=usage.input_tokens,
            tokens_output=usage.output_tokens,
            tokens_total=usage.total,
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
                f"{self.config.server}/v1/policy"
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
        """Build a directive_result event payload."""
        return self._build_payload(
            EventType.DIRECTIVE_RESULT,
            directive_name=directive_name,
            directive_success=success,
            directive_result=result,
            directive_error=error,
        )

    def _execute_custom_directive(self, directive: Directive) -> None:
        """Execute a custom directive handler by name.

        Looks up the handler in the global registry, verifies the
        fingerprint matches, executes with a 5-second timeout
        (SIGALRM on non-Windows), and posts a directive_result event.
        Never raises -- always fails open.
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
        directive = self.client.post_event(payload)
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
            "event_type": event_type.value,
            "host": self._host,
            "framework": framework,
            "model": model,
            "tokens_input": None,
            "tokens_output": None,
            "tokens_total": None,
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
            with self._lock:
                self._shutdown_requested = True
                self._shutdown_reason = directive.reason

        elif directive.action == DirectiveAction.SHUTDOWN_FLAVOR:
            _log.warning(
                "[flightdeck] fleet shutdown directive received for flavor %s: %s",
                self.config.agent_flavor,
                directive.reason,
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
