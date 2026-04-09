import type { AgentEvent } from "./types";

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

export function getBadge(eventType: string): BadgeConfig {
  return eventBadgeConfig[eventType] ?? defaultBadge;
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
