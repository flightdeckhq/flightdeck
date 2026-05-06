"""Pure data types for flightdeck-sensor. No external dependencies."""

from __future__ import annotations

import enum
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable


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
