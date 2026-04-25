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
/**
 * Canonical visible labels for ``client_type`` used everywhere a
 * client_type renders (Fleet swimlane pill, Fleet sidebar pill,
 * AgentTable client column, Investigate AGENT facet pill, the
 * Claude-Code session-drawer badge). Single source of truth for the
 * vocabulary — every label-rendering site imports from here so the
 * Fleet view and the Investigate view never disagree on what to
 * call a client_type. The pill component renders the value through
 * ``text-transform: uppercase`` so the on-screen result is
 * ``CLAUDE CODE`` / ``SENSOR``.
 */
export const CLIENT_TYPE_LABEL: Record<ClientType, string> = {
  [ClientType.ClaudeCode]: "Claude Code",
  [ClientType.FlightdeckSensor]: "Sensor",
};

/**
 * Colour treatment for the ``client_type`` pill.
 *
 * Rationale for the current assignments:
 *
 *   claude_code         → ``--claude-code`` (amber). Matches the
 *                         CLAUDE_CODE_ICON / Anthropic brand colour
 *                         already used by the provider logo in
 *                         components/ui/provider-icons.ts. The
 *                         CODING AGENT badge owns violet
 *                         (``--primary``) as the ``agent_type`` cue,
 *                         so letting the client pill own its own
 *                         brand colour prevents the two pills reading
 *                         as one blob when they render side-by-side.
 *
 *   flightdeck_sensor   → ``--chart-openai`` (cyan). A neutral
 *                         compute colour since the generic Python
 *                         sensor is vendor-agnostic; matches the
 *                         analytics provider palette rather than any
 *                         SDK brand.
 *
 * Adding a new client in the future means adding an entry here. Use
 * existing theme tokens rather than raw hex so dark/light theme
 * parity is free; if a token does not exist yet, introduce it in
 * ``themes.css`` and reference it here so all downstream consumers
 * pick up the new colour in one place.
 */
export interface ClientTypeColor {
  /** Background tint for the pill. Matches the ``--*-glow`` pattern. */
  bg: string;
  /** Foreground text colour. Matches a solid brand/accent token. */
  fg: string;
  /** Border colour. Typically the same token as ``fg`` at full opacity. */
  border: string;
}

export const CLIENT_TYPE_COLOR: Record<ClientType, ClientTypeColor> = {
  [ClientType.ClaudeCode]: {
    bg: "color-mix(in srgb, var(--claude-code) 15%, transparent)",
    fg: "var(--claude-code)",
    border: "color-mix(in srgb, var(--claude-code) 35%, transparent)",
  },
  [ClientType.FlightdeckSensor]: {
    bg: "color-mix(in srgb, var(--chart-openai) 15%, transparent)",
    fg: "var(--chart-openai)",
    border: "color-mix(in srgb, var(--chart-openai) 35%, transparent)",
  },
};
