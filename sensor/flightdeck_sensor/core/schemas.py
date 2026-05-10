"""Pydantic v2 schemas for validating control plane responses.

Used at four parse sites in the sensor to replace raw dict .get() calls
with structured validation. All schemas fail open: ValidationError is
caught and logged, never raised to the caller.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel


class DirectivePayloadSchema(BaseModel):
    """Payload for action='custom' directives."""

    directive_name: str
    fingerprint: str
    parameters: dict[str, Any] = {}


class PolicyResponseSchema(BaseModel):
    """Response from GET /v1/policy (preflight).

    Phase 7 Step 2 (D148): capture ``id`` + ``scope`` + ``scope_value``
    so the sensor can populate ``policy_decision.policy_id`` /
    ``policy_decision.scope`` on policy_warn / policy_degrade /
    policy_block emissions. The API has always returned these on the
    wire (per ``store.Policy`` JSON tags); the schema previously
    stripped them on parse, leaving emissions unable to identify
    which policy row produced its threshold values.
    """

    id: str | None = None
    scope: str | None = None
    scope_value: str | None = None
    token_limit: int | None = None
    warn_at_pct: int | None = None
    degrade_at_pct: int | None = None
    degrade_to: str | None = None
    block_at_pct: int | None = None
    unavailable_policy: str = "continue"


class DirectiveResponseSchema(BaseModel):
    """Directive envelope in POST /v1/events response."""

    action: str
    reason: str | None = None
    grace_period_ms: int = 5000
    degrade_to: str | None = None
    payload: dict[str, Any] | None = None


class SyncResponseSchema(BaseModel):
    """Response from POST /v1/directives/sync."""

    unknown_fingerprints: list[str] = []
