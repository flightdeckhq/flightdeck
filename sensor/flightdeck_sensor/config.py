"""Single source of truth for FLIGHTDECK_* environment variable names.

Pre-Phase-4.5 these were scattered as inline string literals across
``__init__.py``, ``transport/client.py``, and ``core/session.py``.
Adding or renaming a var required grepping multiple files. This
module owns the surface; call sites import the name constant rather
than hardcode the string.

Resolution semantics still live at the call sites (different vars
have different precedence rules and validation: e.g. ``AGENT_TYPE``
falls back to a legacy unprefixed name; ``SESSION_ID`` requires UUID
validation; ``CAPTURE_PROMPTS`` is bool-coerced). Centralizing JUST
the names — not the logic — keeps the surface visible without
changing the existing tested behaviour. Phase 4.5 M-26.
"""

from __future__ import annotations

# ----------------------------------------------------------------
# Control-plane connection
# ----------------------------------------------------------------
ENV_SERVER = "FLIGHTDECK_SERVER"
ENV_API_URL = "FLIGHTDECK_API_URL"
ENV_TOKEN = "FLIGHTDECK_TOKEN"

# ----------------------------------------------------------------
# Identity
# ----------------------------------------------------------------
ENV_SESSION_ID = "FLIGHTDECK_SESSION_ID"
ENV_AGENT_TYPE = "FLIGHTDECK_AGENT_TYPE"
ENV_AGENT_NAME = "FLIGHTDECK_AGENT_NAME"
ENV_HOSTNAME = "FLIGHTDECK_HOSTNAME"

# Legacy unprefixed names retained for v0.3.x migration. Prefer the
# FLIGHTDECK_* equivalents above; these resolve as fallback only.
ENV_AGENT_TYPE_LEGACY = "AGENT_TYPE"
ENV_AGENT_FLAVOR_LEGACY = "AGENT_FLAVOR"

# ----------------------------------------------------------------
# Behaviour flags
# ----------------------------------------------------------------
ENV_CAPTURE_PROMPTS = "FLIGHTDECK_CAPTURE_PROMPTS"
ENV_UNAVAILABLE_POLICY = "FLIGHTDECK_UNAVAILABLE_POLICY"


# Stable list of every FLIGHTDECK_* env var the sensor consults, in
# documentation order. Useful for ops surfaces that enumerate the
# config (``env | grep FLIGHTDECK`` parity, helm chart values, etc.).
ALL_ENV_VARS: tuple[str, ...] = (
    ENV_SERVER,
    ENV_API_URL,
    ENV_TOKEN,
    ENV_SESSION_ID,
    ENV_AGENT_TYPE,
    ENV_AGENT_NAME,
    ENV_HOSTNAME,
    ENV_CAPTURE_PROMPTS,
    ENV_UNAVAILABLE_POLICY,
)
