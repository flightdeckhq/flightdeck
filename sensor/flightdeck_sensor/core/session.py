"""Session lifecycle management for flightdeck-sensor.

A ``Session`` represents one running instance of an agent.  It holds the
sensor configuration, manages the heartbeat daemon thread, registers
process-exit handlers, and posts lifecycle events to the control plane.
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
    EventType,
    SensorConfig,
    SessionState,
    StatusResponse,
    TokenUsage,
)

if TYPE_CHECKING:
    from flightdeck_sensor.transport.client import ControlPlaneClient, EventQueue

_log = logging.getLogger("flightdeck_sensor.core.session")

_HEARTBEAT_INTERVAL_SECS = 30
_HEARTBEAT_JOIN_TIMEOUT_SECS = 5
_PREFLIGHT_TIMEOUT_SECS = 5


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

        self._stopped = threading.Event()
        self._heartbeat_thread: threading.Thread | None = None
        self._host = socket.gethostname()
        self._framework: str | None = None
        self._model: str | None = None

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def start(self) -> None:
        """Fire SESSION_START and begin the heartbeat daemon thread."""
        self._post_event(EventType.SESSION_START)
        self._start_heartbeat()
        self._register_handlers()
        self._preflight_policy()
        if not self.config.quiet:
            _log.info(
                "Flightdeck session started: flavor=%s session=%s",
                self.config.agent_flavor,
                self.config.session_id,
            )

    def end(self) -> None:
        """Fire SESSION_END and stop the heartbeat thread.

        Safe to call multiple times -- second call is a no-op.
        """
        if self._state == SessionState.CLOSED:
            return
        self._state = SessionState.CLOSED
        self._stopped.set()
        if self._heartbeat_thread is not None:
            self._heartbeat_thread.join(timeout=_HEARTBEAT_JOIN_TIMEOUT_SECS)
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
                policy_fields: dict[str, Any] = {}
                if "token_limit" in data:
                    policy_fields["token_limit"] = data["token_limit"]
                if "warn_at_pct" in data:
                    policy_fields["warn_at_pct"] = data["warn_at_pct"]
                if "degrade_at_pct" in data:
                    policy_fields["degrade_at_pct"] = data["degrade_at_pct"]
                if "degrade_to" in data:
                    policy_fields["degrade_to"] = data["degrade_to"]
                if "block_at_pct" in data:
                    policy_fields["block_at_pct"] = data["block_at_pct"]
                if policy_fields:
                    self.policy.update(policy_fields)
        except Exception:
            _log.debug("preflight policy fetch failed, proceeding with empty cache", exc_info=True)

    # ------------------------------------------------------------------
    # Heartbeat
    # ------------------------------------------------------------------

    def _start_heartbeat(self) -> None:
        self._heartbeat_thread = threading.Thread(
            target=self._heartbeat_loop,
            daemon=True,
            name="flightdeck-heartbeat",
        )
        self._heartbeat_thread.start()

    def _heartbeat_loop(self) -> None:
        """Daemon thread: post heartbeat every 30 s until stopped."""
        while not self._stopped.wait(timeout=_HEARTBEAT_INTERVAL_SECS):
            directive = self.client.post_heartbeat(self.config.session_id)
            if directive is not None:
                self._apply_directive(directive)

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

        Called from both the heartbeat thread (for WARN, DEGRADE, POLICY_UPDATE)
        and the interceptor hot path (for SHUTDOWN via flag). Must never raise
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
