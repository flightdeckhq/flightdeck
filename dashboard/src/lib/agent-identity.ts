/**
 * D114 / D115 agent identity enums.
 *
 * Const-object "enum" pattern (not TS ``enum``) so the runtime emits
 * no helper objects and the literal values are preserved byte-for-
 * byte on the wire -- the sensor, plugin, and Go ingestion API all
 * compare against the raw strings "claude_code", "flightdeck_sensor",
 * "coding", "production". Any new consumer imports these constants
 * instead of spelling the literal string so a typo surfaces at
 * compile time rather than as a silent API 400.
 *
 * Helpers at the bottom of the file are the narrowing type-guards
 * for each enum; consumers use them when converting wire strings
 * (e.g. a query param or a response body) into the typed form.
 */

export const ClientType = {
  ClaudeCode: "claude_code",
  FlightdeckSensor: "flightdeck_sensor",
} as const;
export type ClientType = (typeof ClientType)[keyof typeof ClientType];

export const AgentType = {
  Coding: "coding",
  Production: "production",
} as const;
export type AgentType = (typeof AgentType)[keyof typeof AgentType];

export const CLIENT_TYPE_VALUES: readonly ClientType[] =
  Object.values(ClientType);
export const AGENT_TYPE_VALUES: readonly AgentType[] = Object.values(AgentType);

export function isClientType(value: unknown): value is ClientType {
  return (
    typeof value === "string" &&
    (CLIENT_TYPE_VALUES as readonly string[]).includes(value)
  );
}

export function isAgentType(value: unknown): value is AgentType {
  return (
    typeof value === "string" &&
    (AGENT_TYPE_VALUES as readonly string[]).includes(value)
  );
}

/**
 * Human-readable pill label for the ``client_type`` badge rendered
 * next to an agent_name in the Fleet and Investigate views. Kept
 * beside the enum definition so adding a new client in the future
 * forces the caller to supply its label.
 */
export const CLIENT_TYPE_LABEL: Record<ClientType, string> = {
  [ClientType.ClaudeCode]: "Claude Code",
  [ClientType.FlightdeckSensor]: "Sensor",
};
