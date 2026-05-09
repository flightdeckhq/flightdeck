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
import uuid
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any

from pydantic import ValidationError

from flightdeck_sensor.core.agent_id import derive_agent_id
from flightdeck_sensor.core.policy import PolicyCache
from flightdeck_sensor.core.types import (
    Directive,
    DirectiveAction,
    DirectiveContext,
    DirectiveRegistration,
    EventType,
    MCPServerFingerprint,
    SensorConfig,
    SessionState,
    StatusResponse,
    SubagentMessage,
    TokenUsage,
)

if TYPE_CHECKING:
    from flightdeck_sensor.transport.client import ControlPlaneClient, EventQueue

_log = logging.getLogger("flightdeck_sensor.core.session")


# Phase 7 Step 4 (D152): operator-actionable session_start enrichment.
# These helpers populate sensor_version + interceptor_versions +
# policy_snapshot so the dashboard's triage workflow can answer
# "did this run under the buggy build" / "what policy was in effect
# at session start" without joining time-windowed log state by hand.
#
# All three helpers are best-effort: a missing dep / unreadable
# version metadata returns the safest empty result rather than
# breaking the session_start emission. Per Rule 28 (sensor fail-open).

# Frameworks the sensor knows about — version captured via
# importlib.metadata when installed in the agent's process.
_INTERCEPTOR_DEPS: tuple[str, ...] = (
    "anthropic",
    "openai",
    "litellm",
    "langchain",
    "langgraph",
    "llama-index-core",
    "crewai",
    "mcp",
)


def _sensor_version() -> str:
    """flightdeck_sensor's __version__ (from package metadata).
    Returns empty string when the metadata can't be read (rare —
    editable installs in some pip versions)."""
    try:
        from importlib.metadata import version

        return version("flightdeck-sensor")
    except Exception:
        try:
            import flightdeck_sensor as _fs

            return getattr(_fs, "__version__", "")
        except Exception:
            return ""


def _collect_interceptor_versions() -> dict[str, str]:
    """Return ``{dep_name: version}`` for every framework the sensor
    has interceptors for that's installed in the current process.
    Uninstalled deps are silently omitted (the agent didn't import
    them, so the version is not operationally meaningful)."""
    out: dict[str, str] = {}
    try:
        from importlib.metadata import PackageNotFoundError, version
    except Exception:
        return out
    for dep in _INTERCEPTOR_DEPS:
        try:
            out[dep] = version(dep)
        except PackageNotFoundError:
            continue
        except Exception:
            continue
    return out


def _build_policy_snapshot(
    token_policy: Any,
    mcp_policy: Any,
) -> dict[str, Any]:
    """Snapshot the policy state in effect at session_start.

    Token-budget side: ``policy_id`` + ``scope`` already captured
    in PolicyCache by Step 2 (D148); pass through.

    MCP side: ``MCPPolicyCache`` exposes ``snapshot_identity()``
    when populated; returns ``{global_policy_id, flavor_policy_id,
    populated_at}``. Empty cache (preflight failed) returns ``{}``
    and the snapshot omits the mcp section.
    """
    snap: dict[str, Any] = {}
    try:
        if token_policy is not None and getattr(token_policy, "policy_id", None):
            snap["token_budget"] = {
                "policy_id": token_policy.policy_id,
                "scope": getattr(token_policy, "matched_policy_scope", None) or "",
            }
    except Exception:
        pass
    try:
        if mcp_policy is not None:
            ident = getattr(mcp_policy, "snapshot_identity", None)
            if callable(ident):
                mcp_snap = ident()
                if mcp_snap:
                    snap["mcp"] = mcp_snap
    except Exception:
        pass
    return snap


_PREFLIGHT_TIMEOUT_SECS = 1
# Custom directive handler timeout (M-4). SIGALRM-based wall-clock
# bound on user-supplied handlers so a hung handler cannot block the
# directive queue indefinitely. Note: this fires only on the main
# thread on Unix; the directive handler thread bypasses SIGALRM by
# design (B-H two-queue refactor) and a hung handler stalls the
# directive queue but NOT event throughput.
_CUSTOM_DIRECTIVE_HANDLER_TIMEOUT_SECS = 5

# D126 § 6 sub-agent message routing thresholds.
#
# Bodies up to ``SUBAGENT_INLINE_THRESHOLD_BYTES`` ride inline on the
# event payload's ``incoming_message`` / ``outgoing_message`` field
# and are projected into ``events.payload`` JSONB by the worker's
# BuildEventExtra. Bodies above the inline threshold but at or below
# ``SUBAGENT_HARD_CAP_BYTES`` route through the existing D119
# event_content path: the wire stub on the payload field becomes
# ``{has_content: True, content_bytes: <int>, captured_at: ...}``,
# the full body lands on the wire's PromptContent envelope under
# ``response`` (with ``provider="flightdeck-subagent"`` so the
# dashboard's content-fetch consumer disambiguates from LLM
# content), and the worker's existing InsertEventContent writes the
# event_content row.
#
# 8 KiB chosen to match the design-doc threshold and the typical
# upper bound for inter-agent messages we've seen empirically (CrewAI
# Task descriptions are usually a paragraph or two; LangGraph state
# dicts under a kilobyte for routing-style nodes). The hard cap at
# 2 MiB is the design-doc "abuse budget" — bodies above that are
# almost certainly someone dumping the entire conversation transcript
# or a binary-encoded artifact into a sub-agent message; we drop +
# warn rather than silently truncate so the operator notices.
SUBAGENT_INLINE_THRESHOLD_BYTES = 8 * 1024
SUBAGENT_HARD_CAP_BYTES = 2 * 1024 * 1024
# Discriminator the dashboard's content-fetch consumer reads to pick
# the sub-agent renderer over the LLM PromptViewer.
SUBAGENT_OVERFLOW_PROVIDER = "flightdeck-subagent"


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
        # MCP Protection Policy cache (D128 / D129). Populated at
        # session preflight from GET /v1/mcp-policies/global +
        # /:flavor; refreshed on policy_update directive arrival.
        # Empty until populate runs; fail-open per Rule 28 unless
        # the agent opted into the local failsafe via
        # init(mcp_block_on_uncertainty=True).
        from flightdeck_sensor.core.mcp_policy import MCPPolicyCache

        self.mcp_policy = MCPPolicyCache(
            mcp_block_on_uncertainty=config.mcp_block_on_uncertainty,
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

        # MCP server fingerprints captured during ClientSession.initialize().
        # Append-only list (a session may connect to multiple MCP servers).
        # Merged into ``context.mcp_servers`` on the session_start event
        # payload — see _build_payload. Held under self._lock for the
        # same multi-thread reasons as _tokens_used / _model.
        self._mcp_servers: list[MCPServerFingerprint] = []

        # Phase 7 Step 2 (D149): originating_event_id chain. Tracks the
        # UUID of the most-recent ``pre_call`` emission so downstream
        # events fired during the same LLM call (tool_call, llm_error,
        # mcp_*, policy_mcp_*, policy_warn/degrade/block) can stamp
        # ``payload.originating_event_id`` and the dashboard can chain
        # them visually. Cleared on ``post_call`` enqueue (the call
        # window closes there). ``None`` outside an active call window;
        # session_start / session_end / mcp_server_attached do NOT set
        # it because they don't belong to any LLM call.
        self._current_call_event_id: str | None = None

        # Per-(provider, request_id) retry counter for llm_error
        # enrichment. Bounded LRU at 256 entries; eviction-on-overflow
        # keeps memory bounded for long-lived sessions making millions
        # of calls. The field's value is "did the retry chain finally
        # give up" — a short-window question — so older entries don't
        # matter.
        from collections import OrderedDict as _OrderedDict

        self._retry_counters: _OrderedDict[tuple[str, str], int] = _OrderedDict()

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
        """Preflight policy, fire SESSION_START, register handlers, and sync directives.

        Policy preflights run before SESSION_START emission so the
        session_start payload's policy_snapshot reflects the actual
        in-effect policy state. Otherwise the snapshot is empty for
        every fresh session — the cache hasn't populated yet.
        """
        self._preflight_policy()
        self._preflight_mcp_policy()
        self._post_event(EventType.SESSION_START)
        self._register_handlers()

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

    # ------------------------------------------------------------------
    # Originating-event-id chain (D149)
    # ------------------------------------------------------------------

    def set_current_call_event_id(self, event_id: str | None) -> None:
        """Stash the most-recent pre_call emission's UUID so downstream
        events fired during the same call window can reference it via
        ``originating_event_id``. Called by the interceptor's _pre_call
        right after _build_payload mints the id; cleared on _post_call
        emission (the call window closes there)."""
        with self._lock:
            self._current_call_event_id = event_id

    def get_current_call_event_id(self) -> str | None:
        """Read the current call's originating event id, or None when
        outside a call window. Called by downstream emissions to thread
        ``payload.originating_event_id`` through."""
        with self._lock:
            return self._current_call_event_id

    def record_retry_attempt(self, provider: str, request_id: str | None) -> int:
        """Increment + return the retry counter for an llm_error.

        Keyed by ``(provider, request_id)`` — the SDK's request_id is
        unique per logical request and preserved across retries by
        every major SDK we wrap. Returns 1 on the first emission for
        a key, 2 on the second, and so on. When ``request_id`` is
        ``None`` (provider didn't surface one) the counter is keyed
        by ``(provider, "")`` and effectively counts unattributed
        errors per-provider.

        Bounded LRU at 256 entries; eviction-on-overflow keeps the
        dict small in long-running sessions.
        """
        key = (provider or "", request_id or "")
        with self._lock:
            current = self._retry_counters.get(key, 0) + 1
            self._retry_counters[key] = current
            self._retry_counters.move_to_end(key)
            while len(self._retry_counters) > 256:
                self._retry_counters.popitem(last=False)
            return current

    def record_framework(self, framework: str) -> None:
        """Record the framework if detected."""
        with self._lock:
            self._framework = framework

    def record_mcp_server(self, fingerprint: MCPServerFingerprint) -> bool:
        """Append an MCP server fingerprint captured at initialize time.

        Called by the MCP interceptor's patched ``ClientSession.initialize``
        once per server handshake. Order of arrival is preserved so the
        dashboard can render servers in the order the agent connected.
        Duplicates (same name + transport) are de-duplicated in case a
        framework reconstructs a session against the same server.

        Returns ``True`` when the fingerprint is a new addition,
        ``False`` when it was de-duplicated. The interceptor uses
        the boolean to gate D140 ``mcp_server_attached`` emission —
        a duplicate initialize must not re-broadcast the attach event
        (idempotency at the source matches the worker's idempotency
        at the sink).
        """
        with self._lock:
            for existing in self._mcp_servers:
                if (
                    existing.name == fingerprint.name
                    and existing.transport == fingerprint.transport
                ):
                    return False
            self._mcp_servers.append(fingerprint)
            return True

    # ------------------------------------------------------------------
    # Sub-agent emission (D126)
    # ------------------------------------------------------------------
    #
    # Framework interceptors (CrewAI Agent.execute, LangGraph
    # agent-bearing nodes, AutoGen 0.4 / 0.2 participant message
    # handlers) wrap a child execution and call:
    #
    #     child_id  = uuid.uuid4().hex
    #     agent_id  = session.derive_subagent_id("Researcher")
    #     session.emit_subagent_session_start(
    #         child_session_id=child_id,
    #         child_agent_id=agent_id,
    #         child_agent_name="researcher@host",
    #         agent_role="Researcher",
    #         incoming_message=SubagentMessage(body=task, captured_at=...),
    #     )
    #     try:
    #         result = framework.execute(...)
    #     except Exception as exc:
    #         session.emit_subagent_session_end(
    #             child_session_id=child_id,
    #             child_agent_id=agent_id,
    #             child_agent_name="researcher@host",
    #             agent_role="Researcher",
    #             state="error",
    #             error={"type": type(exc).__name__, "message": str(exc)},
    #         )
    #         raise
    #     else:
    #         session.emit_subagent_session_end(
    #             child_session_id=child_id,
    #             ...,
    #             outgoing_message=SubagentMessage(body=result, captured_at=...),
    #         )
    #
    # The methods POST through the same control-plane client as every
    # other event so back-pressure / unavailability / capture_prompts
    # behaviour is uniform with the rest of the sensor.

    def derive_subagent_id(self, agent_role: str) -> str:
        """Return the deterministic ``agent_id`` for a sub-agent of
        the given role under this Session's identity tuple.

        Convenience wrapper around :func:`derive_agent_id` that
        substitutes this Session's identity 5-tuple and joins
        ``agent_role`` as the conditional 6th input. The framework
        interceptors call this once per child execution so the
        per-role agent rollups in the fleet view stay stable across
        a parent's lifetime.
        """
        return str(
            derive_agent_id(
                agent_type=self.config.agent_type,
                user=self.config.user_name,
                hostname=self.config.hostname,
                client_type=self.config.client_type,
                agent_name=self.config.agent_name,
                agent_role=agent_role,
            )
        )

    def _route_subagent_message(
        self,
        message: SubagentMessage | None,
        direction: str,
    ) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
        """Resolve a sub-agent message into (payload_field, content_envelope)
        per D126 § 6.

        ``direction`` is ``"incoming"`` or ``"outgoing"`` — written
        into the content envelope so the dashboard's content-fetch
        consumer can label the body without inferring direction
        from the event_type alone.

        Returns:
            ``(None, None)`` when the message is absent OR
            ``capture_prompts`` is False OR the body exceeds the
            hard cap (with a WARN log on the cap path so operators
            notice).

            ``({body, captured_at}, None)`` for bodies at or below
            the inline threshold. Caller stamps the dict into
            payload's ``incoming_message`` / ``outgoing_message``
            field. ``has_content`` stays False; the body lives in
            ``events.payload`` via BuildEventExtra.

            ``(stub, content_envelope)`` for bodies above the
            inline threshold but at or below the hard cap. Caller
            stamps ``stub`` into the payload field, sets
            ``has_content=True``, and stamps ``content_envelope``
            into ``payload['content']`` so the worker's existing
            D119 InsertEventContent path stores the full body in
            ``event_content``. The dashboard fetches via
            ``GET /v1/events/{id}/content``; the
            ``provider="flightdeck-subagent"`` discriminator picks
            the sub-agent renderer over the LLM PromptViewer.
        """
        if message is None or not self.config.capture_prompts:
            return None, None
        # JSON-encode the body once to size it — the same encoding
        # the worker will see on the wire, so this byte count is
        # the authoritative measure for the inline-vs-overflow
        # decision (rather than ``len(str(body))`` which varies per
        # framework body type).
        body_bytes = json.dumps(message.body).encode("utf-8")
        size = len(body_bytes)
        if size > SUBAGENT_HARD_CAP_BYTES:
            _log.warning(
                "sub-agent %s_message body exceeds %d-byte hard cap "
                "(size=%d bytes); dropped per D126 § 6 — capture "
                "the trailing tail elsewhere if needed",
                direction,
                SUBAGENT_HARD_CAP_BYTES,
                size,
            )
            return None, None
        if size <= SUBAGENT_INLINE_THRESHOLD_BYTES:
            return {
                "body": message.body,
                "captured_at": message.captured_at,
            }, None
        # Overflow: stub on the payload field, full envelope on
        # content. The PromptContent shape required by the existing
        # InsertEventContent has NOT NULL ``messages`` (default
        # ``[]``) and NOT NULL ``response``; we leave messages
        # empty (sub-agent messages aren't LLM messages) and stuff
        # the body into ``response`` along with the direction
        # discriminator. ``input`` stays None — embedding-only
        # column.
        stub = {
            "has_content": True,
            "content_bytes": size,
            "captured_at": message.captured_at,
        }
        envelope: dict[str, Any] = {
            "provider": SUBAGENT_OVERFLOW_PROVIDER,
            "model": "",
            "system": None,
            "messages": [],
            "tools": None,
            "response": {
                "direction": direction,
                "body": message.body,
                "captured_at": message.captured_at,
            },
            "input": None,
        }
        return stub, envelope

    def emit_subagent_session_start(
        self,
        *,
        child_session_id: str,
        child_agent_id: str,
        child_agent_name: str,
        agent_role: str,
        incoming_message: SubagentMessage | None = None,
    ) -> None:
        """Emit a ``session_start`` event for a child sub-agent.

        Called by the framework interceptors at child-context entry.
        ``parent_session_id`` on the wire is this Session's
        ``session_id``. ``child_agent_id`` is what
        :meth:`derive_subagent_id` returns for the same role; the
        caller passes it explicitly so the interceptor controls the
        identity end-to-end (and so tests can assert against a known
        UUID without re-derivation).

        ``incoming_message`` carries the parent's input to the child
        (CrewAI task description, LangGraph inbound state, Claude
        Code Task ``prompt`` argument). Routing depends on body size
        per D126 § 6 — see :meth:`_route_subagent_message`.
        ``capture_prompts=False`` drops the body at this boundary
        regardless of size.
        """
        payload = self._build_subagent_payload(
            event_type=EventType.SESSION_START,
            child_session_id=child_session_id,
            child_agent_id=child_agent_id,
            child_agent_name=child_agent_name,
            agent_role=agent_role,
        )
        stub_or_inline, content_envelope = self._route_subagent_message(
            incoming_message,
            "incoming",
        )
        if stub_or_inline is not None:
            payload["incoming_message"] = stub_or_inline
        if content_envelope is not None:
            payload["has_content"] = True
            payload["content"] = content_envelope
        self.client.post_event(payload)

    def emit_subagent_session_end(
        self,
        *,
        child_session_id: str,
        child_agent_id: str,
        child_agent_name: str,
        agent_role: str,
        state: str = "closed",
        outgoing_message: SubagentMessage | None = None,
        error: dict[str, Any] | None = None,
    ) -> None:
        """Emit a ``session_end`` event for a child sub-agent.

        ``state`` defaults to ``"closed"`` for the success path; the
        framework interceptors pass ``state="error"`` when the
        child's execution raised, alongside an ``error`` dict
        carrying ``type`` (exception class name) and ``message``
        (exception string). The L8 row-level failure cue on the
        dashboard reads ``state=error`` to render the red dot on
        Investigate / Fleet AgentTable / swimlane left panel.

        ``outgoing_message`` carries the child's response back to
        the parent. Same capture_prompts gating as
        ``incoming_message``.
        """
        payload = self._build_subagent_payload(
            event_type=EventType.SESSION_END,
            child_session_id=child_session_id,
            child_agent_id=child_agent_id,
            child_agent_name=child_agent_name,
            agent_role=agent_role,
        )
        # Default state="closed" matches the worker's existing
        # session_end → state=closed projection. Only emit the
        # explicit "state" key when the child ended in an error so
        # the wire shape stays unchanged for the success path.
        if state != "closed":
            payload["state"] = state
        if error is not None:
            payload["error"] = error
        stub_or_inline, content_envelope = self._route_subagent_message(
            outgoing_message,
            "outgoing",
        )
        if stub_or_inline is not None:
            payload["outgoing_message"] = stub_or_inline
        if content_envelope is not None:
            payload["has_content"] = True
            payload["content"] = content_envelope
        self.client.post_event(payload)

    def _build_subagent_payload(
        self,
        *,
        event_type: EventType,
        child_session_id: str,
        child_agent_id: str,
        child_agent_name: str,
        agent_role: str,
    ) -> dict[str, Any]:
        """Build a child sub-agent ``session_start`` / ``session_end``
        payload.

        Identity fields are overridden to the child's values;
        non-identity fields (``flavor``, ``framework``, ``host``)
        inherit from this Session because a sub-agent shares its
        parent's deployment scope, framework attribution, and
        hostname. ``parent_session_id`` is this Session's
        ``session_id``.

        The payload includes the LLM-baseline null fields so the
        worker's existing ``EventPayload`` projection (which
        unmarshals strict JSON) accepts the shape without changes
        on the way in. Sub-agent-specific fields
        (``parent_session_id``, ``agent_role``,
        ``incoming_message``, ``outgoing_message``, ``state``,
        ``error``) are added by the caller after this returns.
        """
        out = {
            "session_id": child_session_id,
            "parent_session_id": self.config.session_id,
            "agent_role": agent_role,
            # Identity overridden for the child.
            "agent_id": child_agent_id,
            "agent_name": child_agent_name,
            "agent_type": self.config.agent_type,
            "client_type": self.config.client_type,
            "user": self.config.user_name,
            "hostname": self.config.hostname,
            # Inherited from the parent's deployment.
            "flavor": self.config.agent_flavor,
            "framework": self._framework,
            "host": self._host,
            # Event metadata.
            "event_type": event_type.value,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            # LLM-baseline nulls (kept for wire-shape parity with
            # other non-MCP events; child sessions don't directly
            # carry per-call token data on session_start /
            # session_end).
            "tokens_used_session": 0,
            "token_limit_session": None,
            "model": None,
            "tokens_input": None,
            "tokens_output": None,
            "tokens_total": None,
            "tokens_cache_read": 0,
            "tokens_cache_creation": 0,
            "latency_ms": None,
            "tool_name": None,
            "tool_input": None,
            "tool_result": None,
            "has_content": False,
            "content": None,
        }
        # Match the parent session_start contract: ingestion requires
        # sensor_version on every session_start event. The sub-agent
        # session_start path inherits the same wire requirement; emitting
        # the parent session's sensor_version is correct since the child
        # session is observed by the same sensor build.
        if event_type == EventType.SESSION_START:
            out["sensor_version"] = _sensor_version()
            # Inherit the parent's runtime context (os, hostname, user,
            # git_branch, frameworks, etc.) so the dashboard's swimlane
            # renders the same os/hostname pills on the sub-agent row
            # as the parent. Sub-agents share their parent's deployment
            # context — they run in the same process, on the same host,
            # under the same user. The context dict is computed once on
            # the parent's session_start emission and cached on the
            # Session.
            if self._context:
                out["context"] = self._context
        return out

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
                # Phase 7 Step 2 (D148): API now surfaces id + scope on
                # the effective-policy response (always has — the
                # ``store.Policy`` JSON tags include them; the sensor
                # schema previously stripped them on parse). Pass through
                # so policy_warn / policy_degrade / policy_block emissions
                # can populate the shared policy_decision block.
                if parsed.id is not None:
                    policy_fields["policy_id"] = parsed.id
                if parsed.scope is not None:
                    matched_scope = parsed.scope
                    if parsed.scope_value:
                        matched_scope = f"{parsed.scope}:{parsed.scope_value}"
                    policy_fields["matched_policy_scope"] = matched_scope
                if policy_fields:
                    self.policy.update(policy_fields)
        except Exception:
            _log.debug("preflight policy fetch failed, proceeding with empty cache", exc_info=True)

    def _preflight_mcp_policy(self) -> None:
        """Populate the MCP Protection Policy cache from the control
        plane at session start (D129). Fetches global + flavor policies
        in two HTTP calls (sequential, ~1s each timeout). Failures
        fail-open per Rule 28 — the cache stays empty and per-call
        evaluation falls back on the local-failsafe toggle if set.
        """
        try:
            self.mcp_policy.populate_from_control_plane(
                api_url=self.config.api_url,
                token=self.config.token,
                flavor=self.config.agent_flavor,
            )
        except Exception:
            _log.debug(
                "preflight mcp policy fetch failed, proceeding with empty cache",
                exc_info=True,
            )

    # ------------------------------------------------------------------
    # Custom directives
    # ------------------------------------------------------------------

    def _sync_directives(self, registry: dict[str, DirectiveRegistration]) -> None:
        """Sync registered custom directives with the control plane.

        Sends fingerprints to the server. For any the server does not
        recognise, sends the full schema in a follow-up register call.
        Fails open on any error.
        """
        try:
            summaries = [
                {"name": reg.name, "fingerprint": reg.fingerprint} for reg in registry.values()
            ]
            unknown_fps = self.client.sync_directives(self.config.agent_flavor, summaries)
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
                    self.client.register_directives(self.config.agent_flavor, to_register)
        except Exception:
            _log.debug("directive sync failed, proceeding without sync", exc_info=True)

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
            parsed_payload = DirectivePayloadSchema.model_validate(directive.payload)
            name = parsed_payload.directive_name
            fingerprint = parsed_payload.fingerprint
            params = parsed_payload.parameters
        except (ValidationError, Exception) as exc:
            _log.warning("[flightdeck] custom directive payload validation failed: %s", exc)
            return

        reg = _directive_registry.get(name)
        if reg is None:
            _log.warning("[flightdeck] custom directive '%s' not found in registry", name)
            payload = self._build_directive_result_event(
                name, success=False, error="handler not found"
            )
            self.event_queue.enqueue(payload)
            return

        if reg.fingerprint != fingerprint:
            _log.warning(
                "[flightdeck] custom directive '%s' fingerprint mismatch (expected %s, got %s)",
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
            payload = self._build_directive_result_event(name, success=True, result=result)
            self.event_queue.enqueue(payload)
        except TimeoutError:
            _log.warning("[flightdeck] custom directive '%s' timed out after 5s", name)
            payload = self._build_directive_result_event(name, success=False, error="timeout")
            self.event_queue.enqueue(payload)
        except Exception as exc:
            _log.warning("[flightdeck] custom directive '%s' raised: %s", name, exc)
            payload = self._build_directive_result_event(name, success=False, error=str(exc))
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
            signal.alarm(_CUSTOM_DIRECTIVE_HANDLER_TIMEOUT_SECS)
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

        is_mcp = event_type.value.startswith("mcp_")

        # Phase 7 Step 2 (D149): mint a sensor-side UUID per event so
        # the originating_event_id chain works without round-tripping
        # the worker. Worker's InsertEvent uses this id directly when
        # present, falling back to gen_random_uuid() only for legacy
        # callers. Idempotency: if a sensor retries the same payload
        # after a network blip, the worker's INSERT ... ON CONFLICT
        # (id, occurred_at) DO NOTHING suppresses the duplicate.
        event_id = str(uuid.uuid4())

        # Common identity + session-level state. Every event (LLM-shaped
        # or MCP-shaped) carries these — they describe WHO the event
        # belongs to and the session's running token state, both of
        # which are meaningful regardless of payload semantics.
        payload: dict[str, Any] = {
            "id": event_id,
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
            "tokens_used_session": tokens_used_session,
            "token_limit_session": self._token_limit,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }

        # Phase 7 Step 2 (D149): originating_event_id chain. Stamp the
        # current call window's originator event id (post_call, or
        # pre_call when post_call hasn't fired yet) onto every
        # downstream emission so the dashboard can render the call →
        # sub-event ancestry. Suppressed for:
        #   - the originators themselves (PRE_CALL, POST_CALL, EMBEDDINGS
        #     — embeddings is its own originator, not chained off an LLM
        #     call);
        #   - call-window-independent events (SESSION_*, MCP_SERVER_*,
        #     DIRECTIVE_RESULT) that don't belong to any LLM call.
        # The set is the "downstream of an LLM call" types per the
        # Phase 7 audit § originating_event_id chain.
        chained_event_types = {
            EventType.TOOL_CALL,
            EventType.LLM_ERROR,
            EventType.POLICY_WARN,
            EventType.POLICY_DEGRADE,
            EventType.POLICY_BLOCK,
            EventType.MCP_TOOL_LIST,
            EventType.MCP_TOOL_CALL,
            EventType.MCP_RESOURCE_LIST,
            EventType.MCP_RESOURCE_READ,
            EventType.MCP_PROMPT_LIST,
            EventType.MCP_PROMPT_GET,
            EventType.POLICY_MCP_WARN,
            EventType.POLICY_MCP_BLOCK,
        }
        if event_type in chained_event_types:
            origin_id = self.get_current_call_event_id()
            if origin_id is not None:
                payload["originating_event_id"] = origin_id

        if not is_mcp:
            # LLM-shaped baseline. Fields are nullable for non-LLM event
            # types (e.g. policy_*, directive_result) where they don't
            # apply, but the columns are part of the established wire
            # contract for everything except MCP events. Phase 5 split
            # MCP events out so they don't carry six perpetually-null
            # LLM fields through every wire trip and Postgres row.
            payload.update(
                {
                    "model": model,
                    "tokens_input": None,
                    "tokens_output": None,
                    "tokens_total": None,
                    # D100: cache-token breakdown. Default 0 so the worker
                    # always receives a non-null value for the NOT NULL
                    # DEFAULT 0 columns.
                    "tokens_cache_read": 0,
                    "tokens_cache_creation": 0,
                    "latency_ms": None,
                    "tool_name": None,
                    "tool_input": None,
                    "tool_result": None,
                    "has_content": False,
                    "content": None,
                }
            )

        # Attach runtime context only on session_start events. The
        # control plane stores sessions.context once and never updates
        # it on conflict, so sending it on every event would be
        # wasteful network traffic.
        if event_type == EventType.SESSION_START:
            ctx = dict(self._context) if self._context else {}
            with self._lock:
                if self._mcp_servers:
                    # Phase 5: merge the per-session MCP server fingerprint
                    # list into context. The worker's UpsertSession ON
                    # CONFLICT writes context once and never updates it,
                    # so any MCP servers connected before session_start
                    # land permanently; servers connected later in the
                    # session do NOT update sessions.context (the per-
                    # event server_name on each MCP_* event is the
                    # authoritative real-time signal).
                    ctx["mcp_servers"] = [fp.to_dict() for fp in self._mcp_servers]
            if ctx:
                payload["context"] = ctx
            # Phase 7 Step 4 (D152): operator-actionable triage
            # enrichment. sensor_version + interceptor_versions answer
            # "did this session run under the buggy build" without
            # requiring a separate log dive. policy_snapshot answers
            # "what budget/MCP rules were in effect at session start"
            # without joining time-windowed policy state.
            payload["sensor_version"] = _sensor_version()
            iv = _collect_interceptor_versions()
            if iv:
                payload["interceptor_versions"] = iv
            ps = _build_policy_snapshot(self.policy, self.mcp_policy)
            if ps:
                payload["policy_snapshot"] = ps

        # Phase 7 Step 4 (D152): session_end carries close_reason for
        # the sensor-knowable paths. Worker fills the rest (orphan
        # timeout / sigkill detection) on the session-table-update
        # path because those decisions live worker-side.
        if event_type == EventType.SESSION_END:
            reason = self._sensor_close_reason()
            if reason is not None:
                payload["close_reason"] = reason

        payload.update(extra)
        return payload

    def _sensor_close_reason(self) -> str | None:
        """Return what the sensor knows about why this session ended.

        Phase 7 Step 4 (D152). Sensor-knowable values:
          * ``directive_shutdown`` — _apply_directive(SHUTDOWN) set
            _shutdown_requested before end() fired.
          * ``normal_exit`` — end() fired with no shutdown flag and
            no policy-block wind-down (the common path: caller invoked
            teardown / atexit).

        Worker fills the orphan-detector and SIGKILL paths because
        those decisions live worker-side. policy_block as a
        close_reason fires when BudgetExceededError tore down the
        process before end(); the sensor's atexit handler then runs
        end() with _shutdown_requested still false but the worker's
        post-mortem can attribute it.
        """
        with self._lock:
            if self._shutdown_requested:
                return "directive_shutdown"
        return "normal_exit"

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
            # M-8 lock discipline: capture session state into locals
            # under the lock, then use the captured values verbatim for
            # both the policy_degrade payload and the directive_result
            # ack. A concurrent record_model() / record_usage() would
            # update self._model / self._tokens_used after the lock
            # release, but we never re-read self.* after that — the
            # snapshot below is the canonical "what the session was
            # when DEGRADE arrived." Downstream policy.set_degrade_model
            # doesn't depend on current_model so no further reads needed.
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
            #
            # Phase 7 Step 2 (D148): shared policy_decision block.
            # Built inline here (not via PolicyDecisionSummary import) to
            # keep this module dependency-light; the dict shape mirrors
            # PolicyDecisionSummary.as_payload_dict() byte-for-byte.
            from flightdeck_sensor.core.types import PolicyDecisionSummary

            degrade_pct = self.policy.degrade_at_pct
            denom = token_limit if token_limit and token_limit > 0 else 1
            degrade_decision = PolicyDecisionSummary(
                policy_id=self.policy.policy_id or "",
                scope=self.policy.matched_policy_scope or "",
                decision="degrade",
                reason=(
                    f"Token usage {tokens_used}/{token_limit} "
                    f"({(tokens_used * 100) // denom}%) "
                    f"crossed degrade threshold ({degrade_pct}%, server policy); "
                    f"model swapped {current_model} → {degrade_to}"
                ),
            )
            policy_event = self._build_payload(
                EventType.POLICY_DEGRADE,
                source="server",
                threshold_pct=degrade_pct,
                tokens_used=tokens_used,
                token_limit=token_limit,
                from_model=current_model,
                to_model=degrade_to,
                policy_decision=degrade_decision.as_payload_dict(),
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
                "token_limit",
                "warn_at_pct",
                "degrade_at_pct",
                "degrade_to",
                "block_at_pct",
            }
            fields = {k: v for k, v in directive.payload.items() if k in allowed}
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
                    "[flightdeck] shutdown: failed to flush acknowledgement event: %s",
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
                    "[flightdeck] shutdown_flavor: failed to flush acknowledgement event: %s",
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
