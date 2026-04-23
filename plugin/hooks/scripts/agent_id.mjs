// Agent identity derivation -- Node twin of
// sensor/flightdeck_sensor/core/agent_id.py.
//
// Both implementations MUST produce byte-identical UUIDs for identical
// inputs. The fixture vector in plugin/tests/agent_id.test.mjs asserts
// this against the Python canonical value. See DECISIONS.md D115.
//
// Uses only Node built-ins plus the existing hand-rolled uuid5 helper
// in ./uuid5.mjs so the plugin preserves its zero-npm-dependency
// posture.

import { NAMESPACE_URL as _NS_URL_UNUSED, uuid5 } from "./uuid5.mjs";
// ^ NAMESPACE_URL imported only to keep the module surface symmetric
// with uuid5.mjs; intentionally unused here -- see NAMESPACE_FLIGHTDECK
// below. Silences bundlers that prune unreferenced named imports.
void _NS_URL_UNUSED;

// Frozen forever. Changing this constant orphans every historical
// agent_id in every deployment. Derived once from
// ``uuid5(NAMESPACE_DNS, "flightdeck.dev")`` so the value is
// regenerable from a memorable seed rather than an opaque random
// UUID -- anyone can re-verify it from first principles:
//
//     python3 -c "import uuid;
//         print(uuid.uuid5(uuid.NAMESPACE_DNS, 'flightdeck.dev'))"
//     // -> ee22ab58-26fc-54ef-91b4-b5c0a97f9b61
//
// The sensor's Python twin carries the identical literal.
export const NAMESPACE_FLIGHTDECK =
  "ee22ab58-26fc-54ef-91b4-b5c0a97f9b61";

/**
 * Derive the deterministic agent_id for the given identity tuple.
 *
 * Grammar (five path segments, every one required, no optional
 * components):
 *
 *     flightdeck://{agent_type}/{user}@{hostname}/{client_type}/{agent_name}
 *
 * Callers substitute "unknown" for any component they cannot
 * determine -- empty strings would collide distinct identities.
 */
export function deriveAgentId({
  agent_type,
  user,
  hostname,
  client_type,
  agent_name,
}) {
  const path =
    `flightdeck://${agent_type}/${user}@${hostname}` +
    `/${client_type}/${agent_name}`;
  return uuid5(NAMESPACE_FLIGHTDECK, path);
}
