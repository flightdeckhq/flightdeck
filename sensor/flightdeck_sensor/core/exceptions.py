"""Exceptions raised by flightdeck-sensor."""

from __future__ import annotations


class BudgetExceededError(Exception):
    """Raised when the token budget is exhausted and policy is BLOCK."""

    def __init__(
        self,
        session_id: str,
        tokens_used: int,
        token_limit: int,
    ) -> None:
        self.session_id = session_id
        self.tokens_used = tokens_used
        self.token_limit = token_limit
        super().__init__(
            f"Token budget exceeded: {tokens_used}/{token_limit} "
            f"(session {session_id})"
        )


class DirectiveError(Exception):
    """Raised when a directive requires halting and halt policy is active."""

    def __init__(self, action: str, reason: str) -> None:
        self.action = action
        self.reason = reason
        super().__init__(f"Directive {action}: {reason}")


class ConfigurationError(Exception):
    """Raised when init() receives invalid arguments."""
