import type { AgentEvent, EventPayloadFields } from "./types";

/* ---- Directive activity color helper ---- */

/**
 * Resolve a CSS color variable for a directive activity entry.
 *
 * Used by the FleetPanel DIRECTIVE ACTIVITY sidebar and any other
 * surface that needs to color-code directive events. Single source
 * of truth for the directive color mapping -- do not inline these
 * colors anywhere else.
 *
 * - directive_result success/acknowledged → green
 * - directive_result error/timeout → red
 * - directive (sent, no result yet) → purple
 */
export function getDirectiveResultColor(
  eventType: string,
  status: string | undefined,
): string {
  if (eventType === "directive_result") {
    if (status === "success" || status === "acknowledged") {
      return "var(--status-active)";
    }
    if (status === "error" || status === "timeout") {
      return "var(--status-lost)";
    }
    return "var(--event-result)";
  }
  // event_type === "directive" or anything else falls back to purple
  return "var(--event-directive)";
}

/**
 * Build the inline status badge text+color for a directive activity row.
 * Returns null when the event is a sent directive (no badge), or when
 * the status is unknown.
 */
export function getDirectiveBadge(
  payload: EventPayloadFields | undefined,
): { label: string; color: string } | null {
  const status = payload?.directive_status;
  if (!status) return null;
  if (status === "success") return { label: "✓ success", color: "var(--status-active)" };
  if (status === "acknowledged") return { label: "✓ acknowledged", color: "var(--status-active)" };
  if (status === "error") return { label: "✗ error", color: "var(--status-lost)" };
  if (status === "timeout") return { label: "✗ timeout", color: "var(--status-lost)" };
  return null;
}

/* ---- Event type badge config ---- */

export interface BadgeConfig {
  cssVar: string;
  label: string;
}

export const eventBadgeConfig: Record<string, BadgeConfig> = {
  post_call: { cssVar: "var(--event-llm)", label: "LLM CALL" },
  pre_call: { cssVar: "var(--event-llm)", label: "PRE CALL" },
  tool_call: { cssVar: "var(--event-tool)", label: "TOOL" },
  policy_warn: { cssVar: "var(--event-warn)", label: "WARN" },
  policy_block: { cssVar: "var(--event-block)", label: "BLOCK" },
  policy_degrade: { cssVar: "var(--event-degrade)", label: "DEGRADE" },
  directive: { cssVar: "var(--event-directive)", label: "DIRECTIVE" },
  directive_result: { cssVar: "var(--event-result)", label: "RESULT" },
  session_start: { cssVar: "var(--event-lifecycle)", label: "START" },
  session_end: { cssVar: "var(--event-lifecycle)", label: "END" },
};

export const defaultBadge: BadgeConfig = { cssVar: "var(--event-lifecycle)", label: "EVENT" };

/**
 * Badge for a session_start event whose timestamp lines up with an
 * entry in the session's attachments array (D094). Amber, distinct
 * from the default lifecycle blue, not alarming. Used by the drawer
 * EventFeed and surfaced as the swimlane circle colour via EventNode's
 * isAttachment prop.
 *
 * Uses var(--warning), which is the actual amber token defined in
 * themes.css -- the earlier iteration pointed at var(--status-warn)
 * (no such token), so color-mix silently resolved to transparent and
 * the pill lost its background. --warning is #eab308 in neon dark
 * and #ca8a04 in clean light; both themes give enough contrast for a
 * 15% background tint against the drawer surface.
 */
export const attachBadge: BadgeConfig = {
  cssVar: "var(--warning)",
  label: "ATTACH",
};

export function getBadge(eventType: string): BadgeConfig {
  return eventBadgeConfig[eventType] ?? defaultBadge;
}

/**
 * Match window in milliseconds for deciding whether a session_start
 * event is an attachment. The ingestion API records the attachment
 * timestamp at NOW() when the HTTP request hits the attach store, and
 * the session_start event itself carries the sensor-side
 * `timestamp` field which is set before the request leaves the
 * sensor's process. Network latency + clock skew between the two
 * fits comfortably inside ±2 s.
 */
export const ATTACH_MATCH_WINDOW_MS = 2000;

/**
 * Decide whether `event` is a session_start that corresponds to a
 * recorded re-attachment in `attachments`.
 *
 * - Only session_start events are eligible; anything else returns
 *   false trivially.
 * - An event matches an attachment when |occurred_at - attached_at|
 *   ≤ ATTACH_MATCH_WINDOW_MS.
 * - The very first session_start (the original) has no matching
 *   attachment row and therefore returns false unchanged.
 *
 * Linear scan against `attachments` is fine -- sessions typically
 * have 0..10 attachments even for aggressive orchestrators.
 */
export function isAttachmentStartEvent(
  event: { event_type: string; occurred_at: string },
  attachments: string[] | undefined,
): boolean {
  if (event.event_type !== "session_start") return false;
  if (!attachments || attachments.length === 0) return false;
  const eventMs = new Date(event.occurred_at).getTime();
  if (Number.isNaN(eventMs)) return false;
  for (const att of attachments) {
    const attMs = new Date(att).getTime();
    if (Number.isNaN(attMs)) continue;
    if (Math.abs(attMs - eventMs) <= ATTACH_MATCH_WINDOW_MS) {
      return true;
    }
  }
  return false;
}

/* ---- Event detail text ---- */

export function getEventDetail(event: AgentEvent): string {
  switch (event.event_type) {
    case "post_call": {
      const parts = [event.model ?? "unknown"];
      if (event.tokens_total != null) parts.push(`${event.tokens_total.toLocaleString()} tok`);
      if (event.latency_ms != null) parts.push(`${event.latency_ms}ms`);
      return parts.join(" · ");
    }
    case "pre_call":
      return event.model ?? "unknown";
    case "tool_call":
      return event.tool_name ?? "unknown tool";
    case "policy_warn":
      return "warned at threshold";
    case "policy_block":
      return "blocked at threshold";
    case "policy_degrade":
      return "degraded model";
    case "session_start":
      return "session started";
    case "session_end":
      return "session ended";
    case "directive_result": {
      const name = event.payload?.directive_name;
      const status = event.payload?.directive_status;
      if (name && status) return `${name} · ${status}`;
      if (name) return name;
      if (status) return status;
      return "directive result";
    }
    default:
      return event.event_type;
  }
}

/* ---- Event summary rows for expanded detail ---- */

export function getSummaryRows(event: AgentEvent): [string, string][] {
  switch (event.event_type) {
    case "post_call":
      return [
        ["Model", event.model ?? "unknown"],
        ["Tokens input", event.tokens_input?.toLocaleString() ?? "—"],
        ["Tokens output", event.tokens_output?.toLocaleString() ?? "—"],
        ["Total tokens", event.tokens_total?.toLocaleString() ?? "—"],
        ["Latency", event.latency_ms != null ? `${event.latency_ms.toLocaleString()}ms` : "—"],
      ];
    case "pre_call":
      return [["Model", event.model ?? "unknown"]];
    case "tool_call":
      return [["Tool", event.tool_name ?? "unknown"]];
    case "policy_warn":
    case "policy_block":
    case "policy_degrade":
      return [["Type", event.event_type.replace("policy_", "")]];
    case "session_start":
      return [["Event", "session started"]];
    case "session_end":
      return [["Event", "session ended"]];
    case "directive_result": {
      const rows: [string, string][] = [];
      if (event.payload?.directive_name) {
        rows.push(["Name", event.payload.directive_name]);
      }
      if (event.payload?.directive_action) {
        rows.push(["Action", event.payload.directive_action]);
      }
      if (event.payload?.directive_status) {
        rows.push(["Status", event.payload.directive_status]);
      }
      if (event.payload?.duration_ms != null) {
        rows.push(["Duration", `${event.payload.duration_ms}ms`]);
      }
      if (event.payload?.error) {
        rows.push(["Error", event.payload.error]);
      }
      if (rows.length === 0) {
        rows.push(["Event", "directive result"]);
      }
      return rows;
    }
    default:
      return [["Type", event.event_type]];
  }
}

/* ---- Event type filter groups ---- */

export const EVENT_TYPE_GROUPS: Record<string, string[]> = {
  "LLM Calls": ["post_call", "pre_call"],
  "Tools": ["tool_call"],
  "Policy": ["policy_warn", "policy_block", "policy_degrade"],
  "Directives": ["directive", "directive_result"],
  "Session": ["session_start", "session_end"],
};

export const EVENT_FILTER_PILLS = [
  { label: "All", color: null },
  { label: "LLM Calls", color: "var(--event-llm)" },
  { label: "Tools", color: "var(--event-tool)" },
  { label: "Policy", color: "var(--event-warn)" },
  { label: "Directives", color: "var(--event-directive)" },
  { label: "Session", color: "var(--event-lifecycle)" },
] as const;

export function isEventVisible(eventType: string, activeFilter: string | null | undefined): boolean {
  if (!activeFilter) return true;
  const group = EVENT_TYPE_GROUPS[activeFilter];
  return group ? group.includes(eventType) : true;
}

/* ---- Session ID truncation ---- */

export function truncateSessionId(sessionId: string): string {
  return sessionId.slice(0, 8);
}

/* ---- Flavor color hash ---- */

const CHART_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

export function flavorColor(flavor: string): string {
  const hash = flavor.split("").reduce((a, c) => a + c.charCodeAt(0), 0) % 5;
  return CHART_COLORS[hash];
}
