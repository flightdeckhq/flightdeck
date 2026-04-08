"""Local token budget enforcement cache.

Holds both local (init() limit) and server-side policy thresholds.
Local limits fire WARN only -- never BLOCK or DEGRADE (see D035).
Server thresholds can fire any action.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass
from typing import Any

from flightdeck_sensor.core.types import PolicyDecision

_DEFAULT_WARN_AT_PCT = 80
_DEFAULT_DEGRADE_AT_PCT = 90
_DEFAULT_BLOCK_AT_PCT = 100


@dataclass
class PolicyResult:
    """Result of a policy check, including which source triggered it."""

    decision: PolicyDecision
    source: str | None = None  # "local" or "server", None for ALLOW


class PolicyCache:
    """Thread-safe local cache of the token budget policy.

    Evaluates both local (from ``init(limit=...)``) and server-side
    thresholds.  Local thresholds only fire WARN -- never BLOCK or DEGRADE.
    Most-restrictive-wins: whichever threshold fires first takes effect.
    """

    def __init__(
        self,
        token_limit: int | None = None,
        warn_at_pct: int = _DEFAULT_WARN_AT_PCT,
        degrade_at_pct: int = _DEFAULT_DEGRADE_AT_PCT,
        block_at_pct: int = _DEFAULT_BLOCK_AT_PCT,
        degrade_to: str | None = None,
        local_limit: int | None = None,
        local_warn_at: float = 0.8,
    ) -> None:
        # Server-side thresholds
        self.token_limit = token_limit
        self.warn_at_pct = warn_at_pct
        self.degrade_at_pct = degrade_at_pct
        self.block_at_pct = block_at_pct
        self.degrade_to = degrade_to

        # Local thresholds (WARN-only, see D035)
        self.local_limit = local_limit
        self.local_warn_at = local_warn_at

        self._server_warned = False
        self._local_warned = False
        self._lock = threading.Lock()

    def check(self, tokens_used: int, estimated: int) -> PolicyResult:
        """Evaluate all thresholds against *tokens_used* + *estimated*.

        Server-side thresholds can return BLOCK, DEGRADE, or WARN.
        Local thresholds only return WARN (never BLOCK/DEGRADE per D035).
        Most-restrictive fires first within each source.
        """
        projected = tokens_used + estimated

        with self._lock:
            # Server-side evaluation (can BLOCK/DEGRADE/WARN)
            if self.token_limit is not None and self.token_limit > 0:
                pct = (projected * 100) // self.token_limit

                if pct >= self.block_at_pct:
                    return PolicyResult(PolicyDecision.BLOCK, source="server")

                if pct >= self.degrade_at_pct:
                    return PolicyResult(PolicyDecision.DEGRADE, source="server")

                if pct >= self.warn_at_pct and not self._server_warned:
                    self._server_warned = True
                    return PolicyResult(PolicyDecision.WARN, source="server")

            # Local evaluation (WARN-only per D035)
            if self.local_limit is not None and self.local_limit > 0:
                threshold = int(self.local_limit * self.local_warn_at)
                if projected >= threshold and not self._local_warned:
                    self._local_warned = True
                    return PolicyResult(PolicyDecision.WARN, source="local")

            return PolicyResult(PolicyDecision.ALLOW)

    def set_degrade_model(self, model: str) -> None:
        """Set the model to degrade to, thread-safe."""
        with self._lock:
            self.degrade_to = model

    def update(self, policy_dict: dict[str, Any]) -> None:
        """Atomically replace server-side fields from a directive payload."""
        with self._lock:
            self.token_limit = policy_dict.get("token_limit", self.token_limit)
            self.warn_at_pct = policy_dict.get("warn_at_pct", self.warn_at_pct)
            self.degrade_at_pct = policy_dict.get("degrade_at_pct", self.degrade_at_pct)
            self.block_at_pct = policy_dict.get("block_at_pct", self.block_at_pct)
            self.degrade_to = policy_dict.get("degrade_to", self.degrade_to)
            self._server_warned = False
