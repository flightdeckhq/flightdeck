import type { AgentSummary, AgentSummaryResponse } from "@/lib/types";

/**
 * Sortable column keys on the `/agents` table. The sparkline tile
 * columns share the column's numeric total as the sort key — the
 * sparkline shape itself is visual-only and not a sortable axis.
 */
export type AgentSortColumn =
  | "agent_name"
  | "topology"
  | "tokens_7d"
  | "latency_p95_7d"
  | "errors_7d"
  | "sessions_7d"
  | "cost_usd_7d"
  | "last_seen_at"
  | "state";

export type SortDirection = "asc" | "desc";

export interface SortState {
  column: AgentSortColumn;
  direction: SortDirection;
}

/**
 * State badge severity ranking — most-engaged states sort to the
 * top under DESC (matches the operator intuition "sort by state
 * desc = active agents first"). Same ladder the backend's
 * agents.go `state` ordinal uses so the dashboard and the API
 * stay byte-compatible on order.
 */
const STATE_ORDINAL: Record<string, number> = {
  active: 5,
  idle: 4,
  stale: 3,
  closed: 2,
  lost: 1,
  "": 0,
};

/**
 * Topology ordinal — `parent` and `child` are richer relationships
 * than `lone`; sorting parent > child > lone groups the sub-agent
 * graph together under DESC.
 */
const TOPOLOGY_ORDINAL: Record<string, number> = {
  parent: 3,
  child: 2,
  lone: 1,
};

/**
 * Toggle the sort direction. The convention: clicking the
 * already-active column flips direction; clicking a different
 * column resets to the column's default direction.
 */
export function toggleSort(
  current: SortState,
  next: AgentSortColumn,
): SortState {
  if (current.column === next) {
    return { column: next, direction: current.direction === "asc" ? "desc" : "asc" };
  }
  return { column: next, direction: defaultDirection(next) };
}

/**
 * Default direction per column. Numeric / time columns default
 * DESC ("biggest first"); textual columns default ASC.
 */
function defaultDirection(column: AgentSortColumn): SortDirection {
  switch (column) {
    case "agent_name":
      return "asc";
    case "topology":
      return "asc";
    default:
      return "desc";
  }
}

/**
 * Look up an agent's sort key for the active column. Returns a
 * number for numeric columns and a lowercased string for textual
 * columns so the comparator can dispatch on `typeof` cleanly.
 *
 * `summariesByAgentId` carries the per-agent
 * `AgentSummaryResponse` keyed by agent_id; an agent whose summary
 * fetch has not landed yet sorts as if its KPI columns were zero
 * (numeric) so its row doesn't bounce around when the fetch
 * resolves.
 */
function sortKey(
  agent: AgentSummary,
  summary: AgentSummaryResponse | undefined,
  column: AgentSortColumn,
): number | string {
  switch (column) {
    case "agent_name":
      return agent.agent_name.toLowerCase();
    case "topology":
      return TOPOLOGY_ORDINAL[agent.topology] ?? 0;
    case "tokens_7d":
      return summary?.totals.tokens ?? 0;
    case "latency_p95_7d":
      return summary?.totals.latency_p95_ms ?? 0;
    case "errors_7d":
      return summary?.totals.errors ?? 0;
    case "sessions_7d":
      return summary?.totals.sessions ?? 0;
    case "cost_usd_7d":
      return summary?.totals.cost_usd ?? 0;
    case "last_seen_at":
      return new Date(agent.last_seen_at).getTime();
    case "state":
      return STATE_ORDINAL[agent.state] ?? 0;
  }
}

/**
 * Sort an agent list by the active column + direction. Returns a
 * new array; the input is never mutated. Stable on ties via the
 * agent_id ASC tie-breaker so page-to-page ordering doesn't
 * shuffle.
 */
export function sortAgents(
  agents: AgentSummary[],
  summariesByAgentId: Map<string, AgentSummaryResponse>,
  sort: SortState,
): AgentSummary[] {
  const sign = sort.direction === "asc" ? 1 : -1;
  return [...agents].sort((a, b) => {
    const ka = sortKey(a, summariesByAgentId.get(a.agent_id), sort.column);
    const kb = sortKey(b, summariesByAgentId.get(b.agent_id), sort.column);
    if (ka < kb) return -1 * sign;
    if (ka > kb) return 1 * sign;
    // Tie-breaker — deterministic page-to-page ordering matters
    // for pagination correctness.
    if (a.agent_id < b.agent_id) return -1;
    if (a.agent_id > b.agent_id) return 1;
    return 0;
  });
}
