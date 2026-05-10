"""Pure data types for flightdeck-sensor. No external dependencies."""

from __future__ import annotations

import enum
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Literal


class SessionState(enum.Enum):
    """Lifecycle state of a sensor session."""

    ACTIVE = "active"
    IDLE = "idle"
    STALE = "stale"
    CLOSED = "closed"
    LOST = "lost"


class EventType(enum.Enum):
    """All event types the sensor can emit.

    POLICY_WARN / POLICY_DEGRADE / POLICY_BLOCK events carry a ``source``
    field. POLICY_WARN can be ``"local"`` (from ``init(limit=...)``) or
    ``"server"`` (from server-side policy). POLICY_DEGRADE / POLICY_BLOCK
    are always ``"server"`` because local thresholds fire WARN only (D035).
    """

    SESSION_START = "session_start"
    SESSION_END = "session_end"
    PRE_CALL = "pre_call"
    POST_CALL = "post_call"
    TOOL_CALL = "tool_call"
    POLICY_WARN = "policy_warn"
    POLICY_DEGRADE = "policy_degrade"
    POLICY_BLOCK = "policy_block"
    DIRECTIVE_RESULT = "directive_result"
    EMBEDDINGS = "embeddings"
    LLM_ERROR = "llm_error"
    MCP_TOOL_LIST = "mcp_tool_list"
    MCP_TOOL_CALL = "mcp_tool_call"
    MCP_RESOURCE_LIST = "mcp_resource_list"
    MCP_RESOURCE_READ = "mcp_resource_read"
    MCP_PROMPT_LIST = "mcp_prompt_list"
    MCP_PROMPT_GET = "mcp_prompt_get"
    # MCP Protection Policy (D131). policy_mcp_warn / _block emit at
    # call_tool time when the cached policy decides warn or block
    # respectively; mcp_server_name_changed emits at initialize time
    # when an agent declares a server whose canonical URL is already
    # known under a different name.
    POLICY_MCP_WARN = "policy_mcp_warn"
    POLICY_MCP_BLOCK = "policy_mcp_block"
    MCP_SERVER_NAME_CHANGED = "mcp_server_name_changed"
    # D140 step 6.6 A2 — emitted by record_mcp_server inside
    # ClientSession.initialize once per (name, server_url) tuple.
    # Drives live SessionDrawer MCP SERVERS panel population: the
    # worker UPSERTs the per-server fingerprint into
    # sessions.context.mcp_servers so operators investigating
    # in-flight sessions see attached servers within ~2-3 s.
    MCP_SERVER_ATTACHED = "mcp_server_attached"


class DirectiveAction(enum.Enum):
    """Actions the control plane can instruct the sensor to take."""

    SHUTDOWN = "shutdown"
    SHUTDOWN_FLAVOR = "shutdown_flavor"
    WARN = "warn"
    DEGRADE = "degrade"
    THROTTLE = "throttle"
    POLICY_UPDATE = "policy_update"
    CHECKPOINT = "checkpoint"
    CUSTOM = "custom"


class PolicyDecision(enum.Enum):
    """Result of a policy check against current token usage."""

    ALLOW = "allow"
    WARN = "warn"
    DEGRADE = "degrade"
    BLOCK = "block"


# D149 — originating_call_context enum. Identifies the agent operation
# that triggered an MCP-policy emission. Plugin populates ``tool_call``
# (the only stage Claude Code's hook surface exposes); sensor populates
# any of the seven values depending on which ClientSession method
# tripped the policy cache. Recorded once in ARCHITECTURE.md so the
# enum boundary is explicit for future contributors.
OriginatingCallContext = Literal[
    "tool_call",
    "list_tools",
    "read_resource",
    "get_prompt",
    "list_resources",
    "list_prompts",
    "session_boot",
]


@dataclass(frozen=True)
class PolicyDecisionSummary:
    """Shared payload-block schema for every policy enforcement event
    (D148). Used by ``policy_warn``, ``policy_degrade``, ``policy_block``,
    ``policy_mcp_warn``, and ``policy_mcp_block``.

    Lands on the wire as ``payload["policy_decision"] = {...}``. Always
    included regardless of ``capture_prompts`` per Phase 7 Q2 — this is
    state metadata, not content.

    The shape is canonical with optional MCP-specific fields. Token-
    budget events leave ``decision_path`` / ``matched_entry_id`` /
    ``matched_entry_label`` ``None``; MCP events populate all fields.
    Operators read the same shape across event types so a single
    dashboard renderer covers all five.

    Field semantics:

    - ``policy_id`` / ``scope`` — which policy row produced this
      decision. Scope is one of ``"org"`` / ``"flavor:<name>"`` /
      ``"session:<id>"`` / ``"global"`` / ``"local_failsafe"`` (the
      last only for sensor-side fail-open under MCP-cache miss).
    - ``decision`` — the action taken: ``"warn"`` / ``"degrade"`` /
      ``"block"`` / ``"allow"`` / ``"deny"``. Distinct from the
      event_type (which encodes warn-vs-block at the type level)
      because operators reading the policy_decision block in
      isolation need it self-describing.
    - ``reason`` — operator-readable single-line summary built by
      the sensor at emission time. Pattern locked in Step 2 plan
      readback: "<what happened> + <by what mechanism> + <relevant
      context>". No newlines.
    - ``decision_path`` — MCP-only. Mirrors ``MCPPolicyDecision``.
    - ``matched_entry_id`` / ``matched_entry_label`` — MCP-only.
      Populated when the decision came from an entry hit (flavor
      or global); ``None`` on the mode-default fall-through path
      where no entry matched. The label is the entry's
      ``server_name`` (display formatting belongs to the dashboard).
    """

    policy_id: str
    scope: str
    decision: str
    reason: str
    decision_path: str | None = None
    matched_entry_id: str | None = None
    matched_entry_label: str | None = None

    def as_payload_dict(self) -> dict[str, Any]:
        """Render to the wire shape. Drops ``None``-valued MCP-only
        fields so token-budget events ship a compact 4-key block; MCP
        events ship the full 7-key block. Stable across language
        boundaries — the plugin-side JSON has the same shape."""
        out: dict[str, Any] = {
            "policy_id": self.policy_id,
            "scope": self.scope,
            "decision": self.decision,
            "reason": self.reason,
        }
        if self.decision_path is not None:
            out["decision_path"] = self.decision_path
        if self.matched_entry_id is not None:
            out["matched_entry_id"] = self.matched_entry_id
        if self.matched_entry_label is not None:
            out["matched_entry_label"] = self.matched_entry_label
        return out


@dataclass(frozen=True)
class TokenUsage:
    """Token counts from a single LLM call.

    ``input_tokens`` is the full input sum (uncached + cache_read + cache_creation)
    so policy/budget arithmetic stays numerically identical to the pre-D100
    behaviour. ``cache_read_tokens`` and ``cache_creation_tokens`` are the
    Anthropic cache-specific breakdown surfaced as separate fields so cache
    economics survive into analytics; they are already included in the
    ``input_tokens`` sum and must not be added to ``total`` a second time.
    OpenAI responses populate the cache fields with 0.
    """

    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_creation_tokens: int = 0

    @property
    def total(self) -> int:
        return self.input_tokens + self.output_tokens


@dataclass
class SensorConfig:
    """Configuration for a sensor session.

    D115 v0.4.0 Phase 1: agent identity fields (``agent_id``,
    ``agent_name``, ``user_name``, ``hostname``, ``client_type``) are
    resolved by :func:`flightdeck_sensor.init` and passed in -- they
    do not have defaults here because deriving them requires calls to
    ``socket.gethostname()`` / ``pwd`` that belong at the edge of the
    library, not in a dataclass default-factory.
    """

    server: str
    token: str
    # Identity (D115). Required on construction by init(); the
    # default empty strings exist only so tests / fixtures that
    # instantiate SensorConfig directly do not have to populate
    # every field.
    agent_id: str = ""
    agent_name: str = ""
    user_name: str = ""
    hostname: str = ""
    client_type: str = "flightdeck_sensor"
    api_url: str = ""
    capture_prompts: bool = False
    unavailable_policy: str = "continue"
    agent_flavor: str = "unknown"
    agent_type: str = "production"
    session_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    quiet: bool = False
    limit: int | None = None
    warn_at: float = 0.8
    # MCP Protection Policy (D128 / D129). When True AND the
    # control plane is unreachable at session preflight (so the MCP
    # policy cache is empty), unmatched MCP server URLs in
    # mode-default fall-through resolve to block instead of allow.
    # The operator failsafe for the cache-miss case. Default False
    # preserves Rule 28's fail-open posture.
    mcp_block_on_uncertainty: bool = False

    def __post_init__(self) -> None:
        if not self.api_url:
            self.api_url = self.server


@dataclass(frozen=True)
class Directive:
    """A control-plane directive received in the event response envelope."""

    action: DirectiveAction
    reason: str
    grace_period_ms: int = 5000
    payload: dict[str, Any] = field(default_factory=dict)


@dataclass
class StatusResponse:
    """Current status of the sensor session, returned by get_status()."""

    session_id: str
    flavor: str
    agent_type: str
    state: SessionState
    tokens_used: int
    token_limit: int | None
    pct_used: float | None


@dataclass
class DirectiveParameter:
    """Schema for a single parameter accepted by a custom directive handler."""

    name: str
    type: str
    description: str = ""
    options: list[str] = field(default_factory=list)
    required: bool = False
    default: Any = None


@dataclass
class DirectiveRegistration:
    """A custom directive handler registered via the ``@directive`` decorator."""

    name: str
    description: str
    parameters: list[DirectiveParameter]
    fingerprint: str
    handler: Callable[..., Any]


@dataclass
class DirectiveContext:
    """Execution context passed to custom directive handlers."""

    session_id: str
    flavor: str
    tokens_used: int
    model: str


@dataclass(frozen=True)
class SubagentMessage:
    """A single cross-agent message body for a sub-agent session (D126).

    Captured by the framework interceptors (CrewAI, LangGraph, AutoGen
    0.4 / 0.2) and the Claude Code plugin on the child session's
    boundaries when ``capture_prompts=True``:

    - ``incoming`` — the parent's input to the child (CrewAI task
      description, LangGraph inbound state dict, AutoGen inbound
      message body, Claude Code Task ``prompt`` argument). Stamped
      on the child's ``session_start`` payload.
    - ``outgoing`` — the child's response back to the parent
      (CrewAI return value, LangGraph outbound state dict, AutoGen
      outbound message body, Claude Code Task tool response).
      Stamped on the child's ``session_end`` payload.

    The framework's source shape is preserved verbatim as a Python
    object (``str`` / ``dict`` / ``list``); JSON serialisation
    happens at payload-build time so the receiving end sees exactly
    what the framework produced.

    Large bodies route through the existing event_content overflow
    path (D119, 8 KiB inline / 2 MiB hard cap). When the body
    exceeds the inline threshold the worker projects it into
    ``event_content`` and the dashboard fetches via
    ``GET /v1/events/{id}/content``; small bodies stay inline on
    ``events.payload``. When ``capture_prompts=False`` the
    interceptor skips construction entirely and no
    ``SubagentMessage`` reaches the wire.
    """

    body: Any
    captured_at: str


@dataclass(frozen=True)
class MCPServerFingerprint:
    """Identity record for an MCP server a session connected to.

    Captured exactly once per server during ``ClientSession.initialize()``
    by the MCP interceptor and appended to the session's ``mcp_servers``
    list. Surfaces on the ``session_start`` event payload under
    ``context.mcp_servers`` so the worker can persist it into
    ``sessions.context``.

    The full fingerprint sits at session level; per-event payloads carry
    only ``server_name`` + ``transport`` to keep events lean.

    ``protocol_version`` matches the SDK's ``InitializeResult.protocolVersion``
    type (``str | int``) verbatim. Recent MCP spec drafts ship integer-coded
    versions and the SDK preserves the source type. The dashboard handles
    both with a one-line type guard rather than us coercing here — preserves
    source data for future-proofing.
    """

    name: str
    transport: str | None
    protocol_version: str | int
    version: str | None
    capabilities: dict[str, Any] = field(default_factory=dict)
    instructions: str | None = None
    # Server URL captured at ``ClientSession.initialize()`` time. The
    # MCP Protection Policy identity model (D127) treats URL as the
    # primary security key — the fingerprint without URL can't be
    # resolved against a policy. Empty string when the transport
    # didn't expose a URL marker (rare; preserved verbatim, not
    # coerced to None, so the dashboard can render "no URL captured"
    # with intent rather than as a missing field).
    server_url: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "transport": self.transport,
            "protocol_version": self.protocol_version,
            "version": self.version,
            "capabilities": self.capabilities,
            "instructions": self.instructions,
            "server_url": self.server_url,
        }
