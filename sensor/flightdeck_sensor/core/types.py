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

    POLICY_WARN events carry a ``source`` field: ``"local"`` (from init() limit)
    or ``"server"`` (from server-side policy).
    """

    SESSION_START = "session_start"
    SESSION_END = "session_end"
    PRE_CALL = "pre_call"
    POST_CALL = "post_call"
    TOOL_CALL = "tool_call"
    POLICY_WARN = "policy_warn"
    DIRECTIVE_RESULT = "directive_result"


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
