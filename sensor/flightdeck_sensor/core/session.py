"""Session lifecycle management for flightdeck-sensor.

A ``Session`` represents one running instance of an agent.  It holds the
sensor configuration, manages the heartbeat daemon thread, registers
process-exit handlers, and posts lifecycle events to the control plane.
"""

from __future__ import annotations

import atexit
import logging
import os
import signal
import socket
import threading
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
    from flightdeck_sensor.transport.client import ControlPlaneClient

_log = logging.getLogger("flightdeck_sensor.core.session")

_HEARTBEAT_INTERVAL_SECS = 30


class Session:
    """Manages the lifecycle of a single sensor session."""

    def __init__(
        self,
        config: SensorConfig,
        client: ControlPlaneClient,
    ) -> None:
        self.config = config
        self.client = client
        self.policy = PolicyCache(
            local_limit=config.limit,
            local_warn_at=config.warn_at,
        )

        self._state = SessionState.ACTIVE
        self._tokens_used = 0
        self._token_limit: int | None = None
        self._lock = threading.Lock()

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
            self._heartbeat_thread.join(timeout=5)
        self._post_event(EventType.SESSION_END)
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
        self._model = model

    def record_framework(self, framework: str) -> None:
        """Record the framework if detected."""
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

        payload: dict[str, Any] = {
            "session_id": self.config.session_id,
            "flavor": self.config.agent_flavor,
            "agent_type": self.config.agent_type,
            "event_type": event_type.value,
            "host": self._host,
            "framework": self._framework,
            "model": self._model,
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
        """Handle a directive received from the control plane."""
        if directive.action == DirectiveAction.POLICY_UPDATE:
            _log.info("Policy update received")
        elif directive.action in (
            DirectiveAction.SHUTDOWN,
            DirectiveAction.SHUTDOWN_FLAVOR,
        ):
            _log.warning(
                "Shutdown directive received: %s (reason: %s)",
                directive.action.value,
                directive.reason,
            )
        else:
            _log.info("Directive received: %s", directive.action.value)

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
