import type {
  AgentSummary,
  AgentSummaryResponse,
  FlavorSummary,
} from "@/lib/types";

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
 * shuffle. Family-blind: every agent sorts independently. Use
 * ``sortAgentsWithFamilies`` for the family-grouped variant the
 * ``/agents`` table consumes.
 */
export function sortAgents(
  agents: AgentSummary[],
  summariesByAgentId: Map<string, AgentSummaryResponse>,
  sort: SortState,
): AgentSummary[] {
  const cmp = buildComparator(summariesByAgentId, sort);
  return [...agents].sort(cmp);
}

function buildComparator(
  summariesByAgentId: Map<string, AgentSummaryResponse>,
  sort: SortState,
): (a: AgentSummary, b: AgentSummary) => number {
  const sign = sort.direction === "asc" ? 1 : -1;
  return (a, b) => {
    const ka = sortKey(a, summariesByAgentId.get(a.agent_id), sort.column);
    const kb = sortKey(b, summariesByAgentId.get(b.agent_id), sort.column);
    if (ka < kb) return -1 * sign;
    if (ka > kb) return 1 * sign;
    // Tie-breaker — deterministic page-to-page ordering matters
    // for pagination correctness.
    if (a.agent_id < b.agent_id) return -1;
    if (a.agent_id > b.agent_id) return 1;
    return 0;
  };
}

/**
 * Resolve each agent's direct parent_agent_id from the bundled
 * ``AgentSummary.recent_sessions``, optionally augmented by the
 * fleet store's flavors view. The walked map is
 * ``session_id → agent_id`` across both sources; an agent is a
 * child of P when one of its sessions carries a
 * ``parent_session_id`` resolving to a session owned by P (and P
 * is a different agent than self).
 *
 * Why two sources: each has its own windowing limit and the two
 * are complementary.
 *
 *   * ``recent_sessions`` is the per-agent rollup the API returns
 *     on ``/v1/fleet``. It is capped at ``RecentSessionsPerAgent``
 *     (5, in ``api/internal/store/postgres.go``) and mirrored
 *     client-side by ``RECENT_SESSIONS_WINDOW`` in
 *     ``store/fleet.ts``. Immune to a global wall-clock window
 *     (an old agent with no recent activity still carries its 5
 *     most-recent sessions), but a busy parent that has spawned
 *     5+ sessions since starting a sub-agent rolls the spawn-
 *     context session out of its own window — the linkage then
 *     fails to resolve on this source alone.
 *   * ``fleetFlavors`` is the broader session graph the
 *     ``/v1/sessions`` endpoint feeds into ``useFleetStore``. It
 *     carries up to ~200 most-recent sessions across all agents.
 *     Recovers the busy-parent case, but a parent whose sessions
 *     all fall outside this wall-clock window won't appear here
 *     (the Phase-2 L38 sub-agent windowing bug).
 *
 * Combining the two recovers the linkage in both edge cases.
 * ``recent_sessions`` wins when both sources cover a session_id
 * because the per-agent slice is immune to wall-clock churn.
 *
 * Pre-D158 deployments may have ``recent_sessions`` absent — the
 * function treats undefined the same as an empty slice; affected
 * agents collapse to lone families (no grouping) but never crash.
 *
 * Returned map maps child_agent_id → parent_agent_id. Agents NOT
 * in the map have no resolvable parent within the supplied
 * ``agents`` list (i.e. they're roots OR orphan children).
 */
function resolveParents(
  agents: AgentSummary[],
  fleetFlavors?: ReadonlyArray<FlavorSummary>,
): Map<string, string> {
  // Build the session_id → agent_id fallback map from the two
  // windowed sources. Used only when ``parent_agent_id`` is
  // missing from the child's recent_sessions row (pre-D-prj
  // deployments, or future SQL refactors that drop the
  // projection); newer rows resolve directly without consulting
  // the map at all.
  const sessionToAgent = new Map<string, string>();
  for (const a of agents) {
    for (const s of a.recent_sessions ?? []) {
      sessionToAgent.set(s.session_id, a.agent_id);
    }
  }
  if (fleetFlavors) {
    for (const f of fleetFlavors) {
      for (const s of f.sessions) {
        if (!sessionToAgent.has(s.session_id)) {
          sessionToAgent.set(s.session_id, f.flavor);
        }
      }
    }
  }
  const parentMap = new Map<string, string>();
  for (const a of agents) {
    for (const s of a.recent_sessions ?? []) {
      if (!s.parent_session_id) continue;
      // Server-projected parent_agent_id wins when present — it
      // is authoritative and immune to every windowing cap that
      // affects the fallback map walk below.
      const direct = s.parent_agent_id;
      if (direct && direct !== a.agent_id) {
        parentMap.set(a.agent_id, direct);
        break;
      }
      const parentId = sessionToAgent.get(s.parent_session_id);
      if (parentId && parentId !== a.agent_id) {
        parentMap.set(a.agent_id, parentId);
        break;
      }
    }
  }
  return parentMap;
}

/**
 * Set of agent_ids that render as a descendant under their
 * resolved parent in the family-grouped layout — drives the
 * `<tr data-topology="child">` stamp that triggers the existing
 * ``[data-topology="child"] > td:first-child`` 28-px indent in
 * ``globals.css``. An orphan child (whose parent isn't in the
 * current ``agents`` slice) is NOT in this set — it renders as
 * its own root family at its own sort position.
 */
export function deriveFamilyDescendantSet(
  agents: AgentSummary[],
  fleetFlavors?: ReadonlyArray<FlavorSummary>,
): Set<string> {
  const parentMap = resolveParents(agents, fleetFlavors);
  const agentIdSet = new Set(agents.map((a) => a.agent_id));
  const descendants = new Set<string>();
  for (const a of agents) {
    const parent = parentMap.get(a.agent_id);
    if (parent && agentIdSet.has(parent)) {
      descendants.add(a.agent_id);
    }
  }
  return descendants;
}

/**
 * Family-grouped agent sort. Parents (and lone agents) are sorted
 * as FAMILIES by the active column + direction; each family's
 * children render directly under their root, sorted among
 * themselves by the same key + direction. Mirrors the Fleet
 * swimlane's parent-then-children clustering on the
 * ``/agents`` table.
 *
 * Depth-2 middle agents (parent AND child) flatten under their
 * root grand-parent: every descendant of a root joins one family,
 * regardless of nesting depth. The visual indent is one level
 * (the existing ``[data-topology="child"]`` CSS rule), matching
 * the swimlane's two-level rendering contract.
 *
 * Orphan children — a child whose parent is NOT in the supplied
 * ``agents`` list (e.g. filtered out OR off the API window) —
 * render as a degenerate single-row family at their own sort
 * position so a filtered view doesn't hide a child whose parent
 * left the view.
 */
export function sortAgentsWithFamilies(
  agents: AgentSummary[],
  summariesByAgentId: Map<string, AgentSummaryResponse>,
  sort: SortState,
  fleetFlavors?: ReadonlyArray<FlavorSummary>,
): AgentSummary[] {
  const parentMap = resolveParents(agents, fleetFlavors);
  const agentIdSet = new Set(agents.map((a) => a.agent_id));
  const agentById = new Map(agents.map((a) => [a.agent_id, a]));

  // Find the effective root (walk up parentMap, stopping at an
  // ancestor not in this view's agentIdSet OR a no-parent root).
  // Cycle defence: if the walk re-enters a node already on the
  // current path, the chain loops — there is no "true" root.
  // Return ``startId`` so every cycle member becomes its OWN
  // single-row family. The naive alternative (return the
  // current node on cycle) makes each cycle node a descendant
  // of its neighbour, which then produces duplicate rows when
  // families flatten. The wire contract is acyclic; this branch
  // is pure defence against pathological upstream data.
  function findRoot(startId: string): string {
    const visited = new Set<string>([startId]);
    let cur = startId;
    while (true) {
      const parent = parentMap.get(cur);
      if (!parent) return cur;
      if (!agentIdSet.has(parent)) return cur;
      if (visited.has(parent)) return startId;
      visited.add(parent);
      cur = parent;
    }
  }

  // Group agents under their root.
  const families = new Map<string, AgentSummary[]>();
  for (const a of agents) {
    const root = findRoot(a.agent_id);
    let bucket = families.get(root);
    if (!bucket) {
      bucket = [];
      families.set(root, bucket);
    }
    bucket.push(a);
  }

  const cmp = buildComparator(summariesByAgentId, sort);

  // For each family, sort descendants (root stays at position 0).
  const familyGroups: AgentSummary[][] = [];
  for (const [rootId, members] of families) {
    const root = agentById.get(rootId);
    if (!root) continue;
    const descendants = members
      .filter((a) => a.agent_id !== rootId)
      .sort(cmp);
    familyGroups.push([root, ...descendants]);
  }

  // Sort families by the root's sort key.
  familyGroups.sort((fa, fb) => cmp(fa[0]!, fb[0]!));

  // Flatten back to a row sequence.
  const result: AgentSummary[] = [];
  for (const family of familyGroups) {
    result.push(...family);
  }
  return result;
}

/**
 * Pack the flat family-grouped row sequence into pages that NEVER
 * split a family across a page boundary. The boundary scanner
 * identifies family runs by tracking when a non-descendant row
 * starts (descendants come from ``deriveFamilyDescendantSet``).
 *
 * Edge case: a single family larger than ``pageSize`` lands on
 * its own oversized page rather than splitting; the algorithm
 * always advances past at least one family per page so it never
 * loops. Practically, sub-agent fan-out per parent stays well
 * under any sensible page size (real-world clusters are ≤ 10
 * descendants), so this branch is defensive.
 *
 * Returns an array of pages; each page is a slice of the input.
 * An empty input returns ``[]``.
 */
export function paginateFamilies(
  sorted: AgentSummary[],
  descendantSet: ReadonlySet<string>,
  pageSize: number,
): AgentSummary[][] {
  if (pageSize <= 0) {
    throw new Error(
      `paginateFamilies: pageSize must be > 0, got ${pageSize}`,
    );
  }
  if (sorted.length === 0) return [];
  // Split the flat sequence into family runs first.
  const families: AgentSummary[][] = [];
  let current: AgentSummary[] = [];
  for (const a of sorted) {
    if (!descendantSet.has(a.agent_id) && current.length > 0) {
      families.push(current);
      current = [];
    }
    current.push(a);
  }
  if (current.length > 0) families.push(current);

  // Greedy pack into pages.
  const pages: AgentSummary[][] = [];
  let page: AgentSummary[] = [];
  for (const family of families) {
    if (family.length > pageSize) {
      // Oversized family — flush any in-progress page first,
      // then dedicate one page to this family. Never splits.
      if (page.length > 0) {
        pages.push(page);
        page = [];
      }
      pages.push(family);
      continue;
    }
    if (page.length > 0 && page.length + family.length > pageSize) {
      pages.push(page);
      page = [];
    }
    page.push(...family);
  }
  if (page.length > 0) pages.push(page);
  return pages;
}
