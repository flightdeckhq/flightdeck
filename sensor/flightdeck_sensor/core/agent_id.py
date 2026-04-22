"""Agent identity derivation.

Shared helper for the Python sensor and, via a hand-matched Node
implementation (``plugin/hooks/scripts/agent_id.mjs``), the Claude
Code plugin. Both implementations MUST produce byte-identical UUIDs
for identical inputs; the fixture vector at the bottom of this
module and its Node twin assert this explicitly.

See DECISIONS.md D115 for the rationale behind the five-segment
grammar and the namespace choice.
"""

from __future__ import annotations

from uuid import UUID, uuid5

# Frozen forever. Changing this constant orphans every historical
# agent_id in every deployment. Derived once from
# ``uuid5(NAMESPACE_DNS, "flightdeck.dev")`` so the value is
# regenerable from a memorable seed rather than an opaque random
# UUID -- anyone can re-verify it from first principles:
#
#     python3 -c "import uuid; \
#         print(uuid.uuid5(uuid.NAMESPACE_DNS, 'flightdeck.dev'))"
#     # -> ee22ab58-26fc-54ef-91b4-b5c0a97f9b61
#
# The plugin's Node twin carries the identical literal.
NAMESPACE_FLIGHTDECK = UUID("ee22ab58-26fc-54ef-91b4-b5c0a97f9b61")


def derive_agent_id(
    *,
    agent_type: str,
    user: str,
    hostname: str,
    client_type: str,
    agent_name: str,
) -> UUID:
    """Return the deterministic agent_id for the given identity tuple.

    Grammar (five path segments, every one required, no optional
    components):

        flightdeck://{agent_type}/{user}@{hostname}/{client_type}/{agent_name}

    Every field is included verbatim. Empty strings would collide
    identities across deployments (e.g. two agents with distinct
    hostnames but both empty ``user``), so each argument is
    required-kwarg and callers are expected to substitute a non-empty
    placeholder (``"unknown"``) before calling if a real value is
    unavailable.

    Returns a :class:`uuid.UUID`. Callers that need the canonical
    string form use ``str(derive_agent_id(...))``.
    """
    path = (
        f"flightdeck://{agent_type}/{user}@{hostname}"
        f"/{client_type}/{agent_name}"
    )
    return uuid5(NAMESPACE_FLIGHTDECK, path)
