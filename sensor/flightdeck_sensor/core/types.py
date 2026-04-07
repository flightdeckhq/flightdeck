"""Pure data types for flightdeck-sensor. No external dependencies."""

from __future__ import annotations

import enum
import uuid
from dataclasses import dataclass, field


class SessionState(enum.Enum):
    """Lifecycle state of a sensor session."""

    ACTIVE = "active"
    IDLE = "idle"
    STALE = "stale"
    CLOSED = "closed"
    LOST = "lost"


class EventType(enum.Enum):
    """All event types the sensor can emit."""

    SESSION_START = "session_start"
    SESSION_END = "session_end"
    HEARTBEAT = "heartbeat"
    PRE_CALL = "pre_call"
    POST_CALL = "post_call"
    TOOL_CALL = "tool_call"


class DirectiveAction(enum.Enum):
    """Actions the control plane can instruct the sensor to take."""

    SHUTDOWN = "shutdown"
    SHUTDOWN_FLAVOR = "shutdown_flavor"
    DEGRADE = "degrade"
    THROTTLE = "throttle"
    POLICY_UPDATE = "policy_update"
    CHECKPOINT = "checkpoint"


class PolicyDecision(enum.Enum):
    """Result of a policy check against current token usage."""

    ALLOW = "allow"
    WARN = "warn"
    DEGRADE = "degrade"
    BLOCK = "block"


@dataclass(frozen=True)
class TokenUsage:
    """Token counts from a single LLM call."""

    input_tokens: int = 0
    output_tokens: int = 0

    @property
    def total(self) -> int:
        return self.input_tokens + self.output_tokens


@dataclass
class SensorConfig:
    """Configuration for a sensor session."""

    server: str
    token: str
    capture_prompts: bool = False
    unavailable_policy: str = "continue"
    agent_flavor: str = "unknown"
    agent_type: str = "autonomous"
    session_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    quiet: bool = False


@dataclass(frozen=True)
class Directive:
    """A control-plane directive received in the event response envelope."""

    action: DirectiveAction
    reason: str
    grace_period_ms: int = 5000


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
