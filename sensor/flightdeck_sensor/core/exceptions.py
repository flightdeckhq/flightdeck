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
            f"Token budget exceeded: {tokens_used}/{token_limit} (session {session_id})"
        )


class DirectiveError(Exception):
    """Raised when a directive requires halting and halt policy is active."""

    def __init__(self, action: str, reason: str) -> None:
        self.action = action
        self.reason = reason
        super().__init__(f"Directive {action}: {reason}")


class MCPPolicyBlocked(Exception):  # noqa: N818
    """Raised when an MCP tool call is blocked by the protection policy.

    Sibling of :class:`BudgetExceededError` in the
    "control-plane-driven halt" exception family — both are typed
    exceptions the sensor raises into agent code so frameworks can
    surface the failure as a tool-call error in the reasoning loop
    (D130). Inherits directly from ``Exception`` rather than from
    ``DirectiveError`` because the field set
    (server_url, server_name, fingerprint, policy_id, decision_path)
    doesn't fit DirectiveError's (action, reason) constructor — the
    "lineage" phrasing in D130's body was descriptive of conceptual
    family, not a literal class hierarchy. Frameworks that want to
    handle "any sensor halt" generically should catch the three
    families explicitly: ``BudgetExceededError``, ``DirectiveError``,
    ``MCPPolicyBlocked``.

    Carries the resolved policy decision attribution so the agent (or
    its surrounding harness) can render an actionable failure
    message. ``decision_path`` is one of ``"flavor_entry"`` /
    ``"global_entry"`` / ``"mode_default"`` mirroring the D135
    resolution algorithm.
    """

    def __init__(
        self,
        *,
        server_url: str,
        server_name: str,
        fingerprint: str,
        policy_id: str,
        decision_path: str,
        message: str | None = None,
    ) -> None:
        self.server_url = server_url
        self.server_name = server_name
        self.fingerprint = fingerprint
        self.policy_id = policy_id
        self.decision_path = decision_path
        if message is None:
            message = (
                f"MCP policy blocked tool call to {server_name} ({server_url}) via {decision_path}"
            )
        super().__init__(message)


class ConfigurationError(Exception):
    """Raised when init() receives invalid arguments."""
