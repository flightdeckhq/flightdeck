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
    """Response from GET /v1/policy (preflight)."""

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
