/**
 * Agent identity enums.
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

/** Every ``client_type`` value the API accepts: the client type
 *  registry, mirrored from ``contracts/client_types.json`` (a unit test
 *  pins this copy to it). Only the Claude Code plugin and the Python
 *  sensor send events today; the other values are reserved for planned
 *  integrations (GitHub issues labelled ``roadmap``). */
export const ClientType = {
  ClaudeCode: "claude_code",
  FlightdeckSensor: "flightdeck_sensor",
  ClaudeAgentSdk: "claude_agent_sdk",
  Codex: "codex",
  Copilot: "copilot",
  OpenCode: "opencode",
  GeminiCli: "gemini_cli",
  Cursor: "cursor",
  Otlp: "otlp",
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

/** One client type's registry entry: its display label and the
 *  defaults the system applies when a session does not state its own
 *  (ARCHITECTURE.md, "Client type registry"). */
export interface ClientTypeMeta {
  label: string;
  /** The ``agent_type`` the client sends in normal use. Ingestion does
   *  not enforce the pairing; the Fleet anomaly check and the test
   *  fixtures assert it. */
  agentType: AgentType;
  /** Whether a session of this type can act on a directive when its
   *  ``session_start`` does not say. */
  supportsDirectives: boolean;
  /** The billing mode the worker stores for a call that arrives
   *  without one. */
  billingMode: "metered" | "subscription" | "local";
  /** Whether the worker redacts a failed tool call's error text on a
   *  capture-off session for this type. */
  stripsToolErrorText: boolean;
}

export const CLIENT_TYPE_META: Record<ClientType, ClientTypeMeta> = {
  [ClientType.ClaudeCode]: { label: "Claude Code", agentType: AgentType.Coding, supportsDirectives: false, billingMode: "subscription", stripsToolErrorText: true },
  [ClientType.FlightdeckSensor]: { label: "Sensor", agentType: AgentType.Production, supportsDirectives: true, billingMode: "metered", stripsToolErrorText: false },
  [ClientType.ClaudeAgentSdk]: { label: "Claude Agent SDK", agentType: AgentType.Production, supportsDirectives: true, billingMode: "metered", stripsToolErrorText: false },
  [ClientType.Codex]: { label: "Codex CLI", agentType: AgentType.Coding, supportsDirectives: false, billingMode: "subscription", stripsToolErrorText: true },
  [ClientType.Copilot]: { label: "GitHub Copilot", agentType: AgentType.Coding, supportsDirectives: false, billingMode: "subscription", stripsToolErrorText: true },
  [ClientType.OpenCode]: { label: "OpenCode", agentType: AgentType.Coding, supportsDirectives: false, billingMode: "metered", stripsToolErrorText: true },
  [ClientType.GeminiCli]: { label: "Gemini CLI", agentType: AgentType.Coding, supportsDirectives: false, billingMode: "metered", stripsToolErrorText: true },
  [ClientType.Cursor]: { label: "Cursor", agentType: AgentType.Coding, supportsDirectives: false, billingMode: "subscription", stripsToolErrorText: true },
  [ClientType.Otlp]: { label: "OpenTelemetry", agentType: AgentType.Production, supportsDirectives: false, billingMode: "metered", stripsToolErrorText: true },
};

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
export const CLIENT_TYPE_LABEL = Object.fromEntries(
  CLIENT_TYPE_VALUES.map((c) => [c, CLIENT_TYPE_META[c].label]),
) as Record<ClientType, string>;

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
 *   every other type    → the muted ``--text-secondary`` treatment.
 *                         These types have no emitter yet, so they
 *                         render only once a client sends them; each
 *                         gets its own brand colour (a ``themes.css``
 *                         token) with its integration.
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

/** The muted pill treatment for a client type that has no emitter (and
 *  so no brand colour) yet. */
const RESERVED_CLIENT_COLOR: ClientTypeColor = {
  bg: "color-mix(in srgb, var(--text-secondary) 14%, transparent)",
  fg: "var(--text-secondary)",
  border: "color-mix(in srgb, var(--text-secondary) 32%, transparent)",
};

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
  [ClientType.ClaudeAgentSdk]: RESERVED_CLIENT_COLOR,
  [ClientType.Codex]: RESERVED_CLIENT_COLOR,
  [ClientType.Copilot]: RESERVED_CLIENT_COLOR,
  [ClientType.OpenCode]: RESERVED_CLIENT_COLOR,
  [ClientType.GeminiCli]: RESERVED_CLIENT_COLOR,
  [ClientType.Cursor]: RESERVED_CLIENT_COLOR,
  [ClientType.Otlp]: RESERVED_CLIENT_COLOR,
};

/**
 * Canonical visible labels for the `agent_type` badge (`coding` /
 * `production`) rendered beside an agent_name in the Fleet swimlane
 * label strip and the Events table. Kept beside the enum so a future
 * agent_type forces the caller to supply its label.
 */
export const AGENT_TYPE_LABEL: Record<AgentType, string> = {
  [AgentType.Coding]: "Coding",
  [AgentType.Production]: "Production",
};

/**
 * Colour treatment for the `agent_type` badge, reusing the
 * `ClientTypeColor` shape so the badge renders as a member of the
 * same pill family as `ClientTypePill`.
 *
 *   coding      → `--primary` (violet). Matches the existing
 *                 CodingAgentBadge, which the agent-identity colour
 *                 notes already reserve violet for as the agent_type
 *                 cue. The special, observer-only category gets the
 *                 accented treatment so it catches the eye.
 *   production  → a neutral muted treatment built from
 *                 `--text-secondary`. Production is the expected
 *                 default; a quiet badge keeps the row legible
 *                 ("information-rich without clutter") while still
 *                 reading as a badge rather than plain text.
 *
 * Uses existing theme tokens only — no `themes.css` change — so
 * dark/light parity is free.
 */
export const AGENT_TYPE_COLOR: Record<AgentType, ClientTypeColor> = {
  [AgentType.Coding]: {
    bg: "color-mix(in srgb, var(--primary) 15%, transparent)",
    fg: "var(--primary)",
    border: "color-mix(in srgb, var(--primary) 35%, transparent)",
  },
  [AgentType.Production]: {
    bg: "color-mix(in srgb, var(--text-secondary) 14%, transparent)",
    fg: "var(--text-secondary)",
    border: "color-mix(in srgb, var(--text-secondary) 32%, transparent)",
  },
};
