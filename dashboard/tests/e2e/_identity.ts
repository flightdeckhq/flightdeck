/**
 * The ids the seed (tests/e2e-fixtures/seed.py, through
 * tests/shared/fixtures.py) and the sensor derive, computed here the same
 * way, so a spec or helper can name a seeded row by the id the seed gave
 * it without copying the id.
 */
import { createHash } from "node:crypto";

/** The Flightdeck uuid5 namespace: the sensor's ``NAMESPACE_FLIGHTDECK``
 *  (sensor/flightdeck_sensor/core/agent_id.py). */
export const FLIGHTDECK_NAMESPACE = "ee22ab58-26fc-54ef-91b4-b5c0a97f9b61";

/** RFC 4122 version-5 UUID (SHA-1), as Python's ``uuid.uuid5``. */
export function uuid5(name: string, namespace: string): string {
  const ns = Uint8Array.from(
    namespace.replace(/-/g, "").match(/../g)!.map((h) => parseInt(h, 16)),
  );
  const bytes = createHash("sha1")
    .update(Buffer.concat([Buffer.from(ns), Buffer.from(name, "utf8")]))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A root agent's identity, as canonical.json declares one. */
export interface AgentIdentity {
  agent_type: string;
  user: string;
  hostname: string;
  client_type: string;
  agent_name: string;
}

/** The agent id of a root agent (no ``agent_role``), as the sensor's
 *  ``derive_agent_id`` computes it and the seed sends it:
 *  uuid5 of ``flightdeck://{agent_type}/{user}@{hostname}/{client_type}/{agent_name}``. */
export function deriveAgentId(identity: AgentIdentity): string {
  const { agent_type, user, hostname, client_type, agent_name } = identity;
  return uuid5(
    `flightdeck://${agent_type}/${user}@${hostname}/${client_type}/${agent_name}`,
    FLIGHTDECK_NAMESPACE,
  );
}
