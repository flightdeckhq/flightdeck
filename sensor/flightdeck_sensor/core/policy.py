"""Local token budget enforcement cache.

Holds the current policy thresholds (pulled from the control plane via
directive envelope) and evaluates them on every LLM call.
"""

from __future__ import annotations

import threading
from typing import Any

from flightdeck_sensor.core.types import PolicyDecision


class PolicyCache:
    """Thread-safe local cache of the token budget policy.

    ``check()`` is called on every LLM call before and after the actual
    provider request.  It is deliberately cheap -- all data is in memory,
    no I/O, no locking beyond a fast ``threading.Lock`` for the fire-once
    flag.
    """

    def __init__(
        self,
        token_limit: int | None = None,
        warn_at_pct: int = 80,
        degrade_at_pct: int = 90,
        block_at_pct: int = 100,
        degrade_to: str | None = None,
    ) -> None:
        self.token_limit = token_limit
        self.warn_at_pct = warn_at_pct
        self.degrade_at_pct = degrade_at_pct
        self.block_at_pct = block_at_pct
        self.degrade_to = degrade_to

        self._warned = False
        self._lock = threading.Lock()

    def check(self, tokens_used: int, estimated: int) -> PolicyDecision:
        """Evaluate thresholds against *tokens_used* + *estimated*.

        Returns the highest-severity decision that applies:

        * :attr:`PolicyDecision.BLOCK` -- budget exhausted, call must not
          proceed.
        * :attr:`PolicyDecision.DEGRADE` -- budget nearly exhausted, swap
          to a cheaper model.
        * :attr:`PolicyDecision.WARN` -- approaching limit (fires once
          per session).
        * :attr:`PolicyDecision.ALLOW` -- under all thresholds.
        """
        if self.token_limit is None:
            return PolicyDecision.ALLOW

        projected = tokens_used + estimated
        pct = (projected * 100) // self.token_limit

        if pct >= self.block_at_pct:
            return PolicyDecision.BLOCK

        if pct >= self.degrade_at_pct:
            return PolicyDecision.DEGRADE

        if pct >= self.warn_at_pct:
            with self._lock:
                if not self._warned:
                    self._warned = True
                    return PolicyDecision.WARN
            return PolicyDecision.ALLOW

        return PolicyDecision.ALLOW

    def update(self, policy_dict: dict[str, Any]) -> None:
        """Atomically replace all fields from a directive payload."""
        self.token_limit = policy_dict.get("token_limit", self.token_limit)
        self.warn_at_pct = policy_dict.get("warn_at_pct", self.warn_at_pct)
        self.degrade_at_pct = policy_dict.get("degrade_at_pct", self.degrade_at_pct)
        self.block_at_pct = policy_dict.get("block_at_pct", self.block_at_pct)
        self.degrade_to = policy_dict.get("degrade_to", self.degrade_to)
        # Reset warn flag when policy changes
        with self._lock:
            self._warned = False
