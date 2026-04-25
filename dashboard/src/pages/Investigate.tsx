import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Search,
  RefreshCw,
  X,
  LayoutGrid,
  FileText,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { FacetIcon } from "@/components/facets/FacetIcon";
import { TruncatedText } from "@/components/ui/TruncatedText";
import { fetchSessions, type SessionsParams } from "@/lib/api";
import type { AgentSummary, SessionListItem, SessionState } from "@/lib/types";
import { useFleetStore } from "@/store/fleet";
import {
  seedAgents,
  useAgentIdentity,
} from "@/lib/agent-identity-cache";
import { DateRangePicker, type DateRangeWithPreset } from "@/components/ui/DateRangePicker";
import { Pagination } from "@/components/ui/Pagination";
import { SessionDrawer, type DrawerTab } from "@/components/session/SessionDrawer";
import { OSIcon } from "@/components/ui/OSIcon";
import { OrchestrationIcon } from "@/components/ui/OrchestrationIcon";
import { ProviderLogo } from "@/components/ui/provider-logo";
import { ClaudeCodeLogo } from "@/components/ui/claude-code-logo";
import { CodingAgentBadge } from "@/components/ui/coding-agent-badge";
import { getProvider, isClaudeCodeSession } from "@/lib/models";
import { truncateSessionId } from "@/lib/events";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// URL state helpers
// ---------------------------------------------------------------------------

export function parseUrlState(sp: URLSearchParams) {
  const page = Math.max(1, parseInt(sp.get("page") ?? "1", 10) || 1);
  const perPage = [25, 50, 100].includes(parseInt(sp.get("per_page") ?? "", 10))
    ? parseInt(sp.get("per_page")!, 10)
    : 25;
  return {
    q: sp.get("q") ?? "",
    from: sp.get("from") ?? new Date(Date.now() - 7 * 86400000).toISOString(),
    to: sp.get("to") ?? new Date().toISOString(),
    states: sp.getAll("state") as SessionState[],
    flavors: sp.getAll("flavor"),
    // D115: single-agent filter. Deep-linked from the Fleet agent
    // table and the Investigate AGENT sidebar facet. Empty string
    // means no filter.
    agentId: sp.get("agent_id") ?? "",
    agentTypes: sp.getAll("agent_type"),
    frameworks: sp.getAll("framework"),
    // Scalar context filters. The key list here must stay in sync
    // with api/internal/store/sessions.go::AllowedContextFilterKeys
    // and with buildUrlParams below. git_commit is filter-only (no
    // facet) but round-trips through the URL the same way.
    contextUsers: sp.getAll("user"),
    contextOS: sp.getAll("os"),
    contextArch: sp.getAll("arch"),
    contextHostnames: sp.getAll("hostname"),
    contextProcessNames: sp.getAll("process_name"),
    contextNodeVersions: sp.getAll("node_version"),
    contextPythonVersions: sp.getAll("python_version"),
    contextGitBranches: sp.getAll("git_branch"),
    contextGitCommits: sp.getAll("git_commit"),
    contextGitRepos: sp.getAll("git_repo"),
    contextOrchestrations: sp.getAll("orchestration"),
    // Phase 4: error-type filter (repeatable). Round-trips as
    // ``?error_type=rate_limit&error_type=authentication`` and
    // narrows the result set to sessions that emitted an llm_error
    // event of one of the listed taxonomy values. Drives the
    // ERROR TYPE sidebar facet and the active-filter chips.
    errorTypes: sp.getAll("error_type"),
    // ``session`` carries the session id of an open drawer so a
    // deep-link (e.g. clicking a result in the global search modal)
    // routes the user into Investigate AND pops the drawer in one
    // navigation. Empty string when no drawer is pinned to the URL.
    session: sp.get("session") ?? "",
    model: sp.get("model") ?? "",
    sort: sp.get("sort") ?? "started_at",
    order: (sp.get("order") ?? "desc") as "asc" | "desc",
    page,
    perPage,
  };
}

export function buildUrlParams(s: ReturnType<typeof parseUrlState>): URLSearchParams {
  const p = new URLSearchParams();
  if (s.q) p.set("q", s.q);
  if (s.from) p.set("from", s.from);
  if (s.to) p.set("to", s.to);
  for (const st of s.states) p.append("state", st);
  for (const fl of s.flavors) p.append("flavor", fl);
  if (s.agentId) p.set("agent_id", s.agentId);
  for (const at of s.agentTypes) p.append("agent_type", at);
  for (const fw of s.frameworks) p.append("framework", fw);
  for (const u of s.contextUsers) p.append("user", u);
  for (const o of s.contextOS) p.append("os", o);
  for (const a of s.contextArch) p.append("arch", a);
  for (const h of s.contextHostnames) p.append("hostname", h);
  for (const pn of s.contextProcessNames) p.append("process_name", pn);
  for (const nv of s.contextNodeVersions) p.append("node_version", nv);
  for (const pv of s.contextPythonVersions) p.append("python_version", pv);
  for (const gb of s.contextGitBranches) p.append("git_branch", gb);
  for (const gc of s.contextGitCommits) p.append("git_commit", gc);
  for (const gr of s.contextGitRepos) p.append("git_repo", gr);
  for (const oc of s.contextOrchestrations) p.append("orchestration", oc);
  for (const et of s.errorTypes) p.append("error_type", et);
  if (s.session) p.set("session", s.session);
  if (s.model) p.set("model", s.model);
  if (s.sort !== "started_at") p.set("sort", s.sort);
  if (s.order !== "desc") p.set("order", s.order);
  if (s.page > 1) p.set("page", String(s.page));
  if (s.perPage !== 25) p.set("per_page", String(s.perPage));
  return p;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AUTO_REFRESH_OPTIONS = [
  { label: "Off", ms: 0 },
  { label: "30s", ms: 30_000 },
  { label: "1m", ms: 60_000 },
  { label: "5m", ms: 300_000 },
];

const COL_WIDTHS = {
  // Fixed pixel width keeps the SESSION column narrow at any viewport
  // (supervisor: "don't let it grow"); the percent columns divide the
  // remaining space the usual way.
  session: "100px",
  flavor: "16%",
  hostname: "13%",
  os: "4%",
  orch: "4%",
  model: "14%",
  started: "13%",
  duration: "8%",
  tokens: "8%",
  capture: "8%",
  state: "12%",
};

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 600) {
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function timeAgo(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `Updated ${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `Updated ${m}m ago`;
  return `Updated ${Math.round(m / 60)}h ago`;
}

// ---------------------------------------------------------------------------
// Facet computation (client-side from current result set)
// ---------------------------------------------------------------------------

interface FacetGroup {
  key: string;
  label: string;
  /** ``value`` is the wire value the filter clicks on (e.g. agent_id
   *  UUID for the AGENT facet); optional ``label`` is the human
   *  display string (e.g. agent_name) rendered in place of the
   *  value. Omit ``label`` when value and display are the same. */
  values: { value: string; count: number; label?: string }[];
}

/**
 * Per-dimension "facet source" map. When a filter is active on
 * state/flavor/model, the page runs a parallel fetch that drops that
 * single dimension's filter (keeping all others) and stores the
 * resulting sessions here. computeFacets then uses dim-specific
 * sources for the STATE / FLAVOR / MODEL facets so the user still
 * sees every value in the current context (sticky facets pattern).
 * Other dimensions (os / git_branch / hostname) always compute from
 * the fully-filtered main result -- those have no active-dim filter
 * to strip, and cross-filtering on them is correct as-is.
 */
export interface FacetSources {
  state?: SessionListItem[];
  flavor?: SessionListItem[];
  model?: SessionListItem[];
  framework?: SessionListItem[];
  agent_type?: SessionListItem[];
  /** D115 sticky-facet source for the AGENT sidebar facet. When
   *  an agent_id filter is active, this holds the result set with
   *  the agent filter stripped so the AGENT facet keeps listing
   *  every distinct agent instead of collapsing to one row. */
  agent_id?: SessionListItem[];
  // Per-key overrides for scalar context facets. Each key, when
  // populated, contributes its session list to THAT facet only --
  // keeps an actively-filtered facet from collapsing to a single row
  // while the rest of the sidebar still reflects the fully filtered
  // result. Keys mirror AllowedContextFilterKeys on the server.
  user?: SessionListItem[];
  os?: SessionListItem[];
  arch?: SessionListItem[];
  hostname?: SessionListItem[];
  process_name?: SessionListItem[];
  node_version?: SessionListItem[];
  python_version?: SessionListItem[];
  git_branch?: SessionListItem[];
  git_repo?: SessionListItem[];
  orchestration?: SessionListItem[];
  /** Phase 4 sticky-facet source for the ERROR TYPE sidebar
   *  facet. When at least one error_type filter is active, this
   *  holds the result set with the error_type filter stripped so
   *  the facet keeps showing every distinct value the user could
   *  toggle to instead of collapsing to just the active rows. */
  error_type?: SessionListItem[];
}

/** Scalar context keys that render as facets in the Investigate
 *  sidebar. Ordering is the canonical sidebar order. git_commit is
 *  filter-only (no facet) so it is absent. Must stay in sync with the
 *  server's AllowedContextFilterKeys minus git_commit. */
export const CONTEXT_FACET_KEYS = [
  "os",
  "arch",
  "hostname",
  "user",
  "process_name",
  "node_version",
  "python_version",
  "git_branch",
  "git_repo",
  "orchestration",
] as const;

type ContextFacetKey = (typeof CONTEXT_FACET_KEYS)[number];

function readScalarContext(
  session: SessionListItem,
  key: ContextFacetKey,
): string | undefined {
  // context.hostname is authoritative for the HOSTNAME facet; the
  // sessions.host column is a legacy fallback for sessions predating
  // the context collector. Prefer context, fall through to host when
  // context is missing that key.
  if (key === "hostname") {
    const ctx = session.context?.hostname;
    if (typeof ctx === "string" && ctx) return ctx;
    return session.host ?? undefined;
  }
  const v = session.context?.[key];
  return typeof v === "string" && v ? v : undefined;
}

export function computeFacets(
  sessions: SessionListItem[],
  sources: FacetSources = {},
): FacetGroup[] {
  const stateCounts = new Map<string, number>();
  const flavorCounts = new Map<string, number>();
  const modelCounts = new Map<string, number>();
  const frameworkCounts = new Map<string, number>();
  const agentTypeCounts = new Map<string, number>();
  // Phase 4: per-session error_types[] aggregates across the visible
  // result set. Each session contributes ONCE per distinct value it
  // carries (so a session with [rate_limit, authentication] adds 1
  // to each, not 2 to either). Sessions with no errors are silently
  // skipped — they're not omitted from the table, just not counted
  // here.
  const errorTypeCounts = new Map<string, number>();
  // D115 AGENT facet: keyed on agent_id (clickable filter value) with
  // an accompanying name map for display rendering. Sessions without
  // agent_id (pre-v0.4.0 legacy rows) are silently skipped -- they
  // cannot participate in an agent-based filter.
  const agentIdCounts = new Map<string, number>();
  const agentIdNames = new Map<string, string>();
  // Scalar context counts. Initialised once per key so downstream code
  // can address them via the same key string the facets emit under.
  const ctxCounts: Record<ContextFacetKey, Map<string, number>> = {
    os: new Map(),
    arch: new Map(),
    hostname: new Map(),
    user: new Map(),
    process_name: new Map(),
    node_version: new Map(),
    python_version: new Map(),
    git_branch: new Map(),
    git_repo: new Map(),
    orchestration: new Map(),
  };

  // Per-dim override helpers: when a dim's source is present, tally
  // THAT source into the matching map and skip the main loop's entry
  // for that dim. This way a selected flavor doesn't collapse the
  // FLAVOR facet to a single row while still allowing MODEL / OS /
  // etc. to reflect the fully-filtered main result.
  if (sources.state) {
    for (const s of sources.state) {
      stateCounts.set(s.state, (stateCounts.get(s.state) ?? 0) + 1);
    }
  }
  if (sources.flavor) {
    for (const s of sources.flavor) {
      flavorCounts.set(s.flavor, (flavorCounts.get(s.flavor) ?? 0) + 1);
    }
  }
  if (sources.model) {
    for (const s of sources.model) {
      if (s.model) modelCounts.set(s.model, (modelCounts.get(s.model) ?? 0) + 1);
    }
  }
  if (sources.framework) {
    for (const s of sources.framework) {
      for (const fw of (s.context?.frameworks as string[] | undefined) ?? []) {
        frameworkCounts.set(fw, (frameworkCounts.get(fw) ?? 0) + 1);
      }
    }
  }
  if (sources.agent_type) {
    for (const s of sources.agent_type) {
      if (s.agent_type) {
        agentTypeCounts.set(
          s.agent_type,
          (agentTypeCounts.get(s.agent_type) ?? 0) + 1,
        );
      }
    }
  }
  if (sources.agent_id) {
    for (const s of sources.agent_id) {
      if (s.agent_id) {
        agentIdCounts.set(s.agent_id, (agentIdCounts.get(s.agent_id) ?? 0) + 1);
        if (s.agent_name) agentIdNames.set(s.agent_id, s.agent_name);
      }
    }
  }
  if (sources.error_type) {
    for (const s of sources.error_type) {
      for (const et of s.error_types ?? []) {
        errorTypeCounts.set(et, (errorTypeCounts.get(et) ?? 0) + 1);
      }
    }
  }
  // Sticky-source pass for scalar context facets. A key whose source
  // override is present consumes THAT list; the main-loop branch
  // below skips it to avoid double-counting.
  for (const key of CONTEXT_FACET_KEYS) {
    const src = sources[key];
    if (!src) continue;
    for (const s of src) {
      const v = readScalarContext(s, key);
      if (v) ctxCounts[key].set(v, (ctxCounts[key].get(v) ?? 0) + 1);
    }
  }

  for (const s of sessions) {
    if (!sources.state) stateCounts.set(s.state, (stateCounts.get(s.state) ?? 0) + 1);
    if (!sources.flavor) flavorCounts.set(s.flavor, (flavorCounts.get(s.flavor) ?? 0) + 1);
    if (!sources.model && s.model) modelCounts.set(s.model, (modelCounts.get(s.model) ?? 0) + 1);
    if (!sources.framework) {
      for (const fw of (s.context?.frameworks as string[] | undefined) ?? []) {
        frameworkCounts.set(fw, (frameworkCounts.get(fw) ?? 0) + 1);
      }
    }
    if (!sources.agent_type && s.agent_type) {
      agentTypeCounts.set(
        s.agent_type,
        (agentTypeCounts.get(s.agent_type) ?? 0) + 1,
      );
    }
    if (!sources.agent_id && s.agent_id) {
      agentIdCounts.set(s.agent_id, (agentIdCounts.get(s.agent_id) ?? 0) + 1);
      if (s.agent_name) agentIdNames.set(s.agent_id, s.agent_name);
    }
    if (!sources.error_type) {
      for (const et of s.error_types ?? []) {
        errorTypeCounts.set(et, (errorTypeCounts.get(et) ?? 0) + 1);
      }
    }
    for (const key of CONTEXT_FACET_KEYS) {
      if (sources[key]) continue;
      const v = readScalarContext(s, key);
      if (v) ctxCounts[key].set(v, (ctxCounts[key].get(v) ?? 0) + 1);
    }
  }

  const toArr = (m: Map<string, number>) =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([value, count]) => ({ value, count }));

  // Sidebar order: lifecycle (STATE), identity (FLAVOR / AGENT TYPE /
  // MODEL / FRAMEWORK), runtime (OS / ARCH / HOSTNAME), operator
  // (USER / PROCESS_NAME / NODE / PYTHON VERSION), git, orchestration.
  // Matches the canonical order in the Phase 3 addendum #2 brief.
  const CTX_LABELS: Record<ContextFacetKey, string> = {
    os: "OS",
    arch: "ARCH",
    hostname: "HOSTNAME",
    user: "USER",
    process_name: "PROCESS_NAME",
    node_version: "NODE VERSION",
    python_version: "PYTHON VERSION",
    git_branch: "GIT BRANCH",
    git_repo: "GIT REPO",
    orchestration: "ORCHESTRATION",
  };
  const scalarCtxGroups = CONTEXT_FACET_KEYS.map((k) => ({
    key: k,
    label: CTX_LABELS[k],
    values: toArr(ctxCounts[k]),
  }));

  // D115 AGENT group: keyed on agent_id, display label = agent_name.
  // Sorted by count DESC (toArr does this already) so the busiest
  // agents land at the top of the facet list.
  const agentGroupValues = [...agentIdCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, count]) => ({
      value: id,
      count,
      label: agentIdNames.get(id) ?? id,
    }));

  return [
    { key: "state", label: "STATE", values: toArr(stateCounts) },
    { key: "agent_id", label: "AGENT", values: agentGroupValues },
    { key: "flavor", label: "FLAVOR", values: toArr(flavorCounts) },
    { key: "agent_type", label: "AGENT TYPE", values: toArr(agentTypeCounts) },
    { key: "model", label: "MODEL", values: toArr(modelCounts) },
    { key: "framework", label: "FRAMEWORK", values: toArr(frameworkCounts) },
    ...scalarCtxGroups,
    // Phase 4: ERROR TYPE facet sits last in the sidebar so the
    // existing facet ordering is preserved for users who learned
    // the v0.4.0 layout. Hidden by the .filter() below when no
    // session in the visible result set has any llm_error events.
    { key: "error_type", label: "ERROR TYPE", values: toArr(errorTypeCounts) },
  ].filter((g) => g.values.length > 0);
}

// ---------------------------------------------------------------------------
// Facet value icons
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// State badge pill
// ---------------------------------------------------------------------------

const STATE_BADGE_STYLES: Record<string, { bg: string; color: string; border?: string }> = {
  active: { bg: "color-mix(in srgb, var(--status-active) 15%, transparent)", color: "var(--status-active)" },
  idle: { bg: "color-mix(in srgb, var(--status-idle) 15%, transparent)", color: "var(--status-idle)" },
  stale: { bg: "color-mix(in srgb, var(--status-stale) 15%, transparent)", color: "var(--status-stale)" },
  lost: { bg: "color-mix(in srgb, var(--status-lost) 15%, transparent)", color: "var(--status-lost)" },
  closed: { bg: "transparent", color: "var(--text-muted)", border: "1px solid var(--border)" },
};

function StateBadge({ state }: { state: string }) {
  const s = STATE_BADGE_STYLES[state] ?? STATE_BADGE_STYLES.closed;
  return (
    <span
      className="inline-flex items-center"
      style={{
        gap: 5,
        padding: "2px 8px",
        borderRadius: 9999,
        fontSize: 11,
        fontWeight: 500,
        background: s.bg,
        color: s.color,
        border: s.border ?? "1px solid transparent",
      }}
    >
      <span
        className="inline-block rounded-full"
        style={{ width: 5, height: 5, background: s.color, flexShrink: 0 }}
      />
      {state}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Skeleton rows for loading state
// ---------------------------------------------------------------------------

function SkeletonRows() {
  return (
    <>
      {[0, 1, 2, 3, 4].map((i) => (
        <tr key={i} style={{ height: 44, borderBottom: "1px solid var(--border-subtle)" }}>
          <td style={{ padding: "0 12px", width: COL_WIDTHS.session }}>
            <div className="h-3.5 w-2/3 animate-pulse rounded" style={{ background: "var(--border)" }} />
          </td>
          <td style={{ padding: "0 12px", width: COL_WIDTHS.flavor }}>
            <div className="h-3.5 w-3/4 animate-pulse rounded" style={{ background: "var(--border)" }} />
          </td>
          <td style={{ padding: "0 12px", width: COL_WIDTHS.hostname }}>
            <div className="h-3.5 w-2/3 animate-pulse rounded" style={{ background: "var(--border)" }} />
          </td>
          <td style={{ padding: "0 8px", width: COL_WIDTHS.os }}>
            <div className="h-4 w-4 animate-pulse rounded" style={{ background: "var(--border)", margin: "0 auto" }} />
          </td>
          <td style={{ padding: "0 8px", width: COL_WIDTHS.orch }}>
            <div className="h-4 w-4 animate-pulse rounded" style={{ background: "var(--border)", margin: "0 auto" }} />
          </td>
          <td style={{ padding: "0 12px", width: COL_WIDTHS.model }}>
            <div className="h-3.5 w-3/4 animate-pulse rounded" style={{ background: "var(--border)" }} />
          </td>
          <td style={{ padding: "0 12px", width: COL_WIDTHS.started }}>
            <div className="h-3.5 w-2/3 animate-pulse rounded" style={{ background: "var(--border)" }} />
          </td>
          <td style={{ padding: "0 12px", width: COL_WIDTHS.duration }}>
            <div className="h-3.5 w-1/2 animate-pulse rounded" style={{ background: "var(--border)" }} />
          </td>
          <td style={{ padding: "0 12px", width: COL_WIDTHS.tokens }}>
            <div className="h-3.5 w-1/2 animate-pulse rounded" style={{ background: "var(--border)" }} />
          </td>
          <td style={{ padding: "0 4px", width: COL_WIDTHS.capture }} />
          <td style={{ padding: "0 12px", width: COL_WIDTHS.state }}>
            <div className="h-3.5 w-2/3 animate-pulse rounded" style={{ background: "var(--border)" }} />
          </td>
        </tr>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Pure helpers exposed for unit testing
// ---------------------------------------------------------------------------

/** Shape of an active-filter chip rendered in the top bar. */
export interface ActiveFilterPill {
  label: string;
  onRemove: () => void;
}

/**
 * Module-level set so the UUID-prefix fallback warns once per agent_id,
 * not once per render. Clean up is intentional noop -- the set is
 * bounded by the number of distinct agents the user filters on in a
 * session, which is low.
 */
const warnedUnresolvedAgents = new Set<string>();
function warnUnresolvedAgentOnce(agentId: string): void {
  if (warnedUnresolvedAgents.has(agentId)) return;
  warnedUnresolvedAgents.add(agentId);
  console.warn(
    `agent_id ${agentId} did not resolve to an agent_name via fleet store or sessions list; ` +
      `chip label falls back to the UUID prefix. Proper fix tracked in FOLLOWUPS.md.`,
  );
}

/** Type alias for the subset of URL state the filter-chip logic reads. */
export type UrlStateSnapshot = ReturnType<typeof parseUrlState>;

/** Update callback shape the chip ``onRemove`` handlers close over. */
export type UpdateUrlFn = (patch: Partial<UrlStateSnapshot>) => void;

/**
 * Build the active-filter chip list from the URL state.
 *
 * Pure function of (urlState, sessions, agents, updateUrl) so the
 * chip logic is testable in isolation from the Investigate component.
 *
 * ``agent_id`` chip label resolution, in order:
 *   1. Fleet-store agents[] (hydrated at page load by the always-
 *      fetch-on-Investigate-mount effect). This is the authoritative
 *      source and works independent of which sessions happen to be
 *      in the current filtered result set -- the prior UUID-prefix
 *      fallback was the "No sessions found" bug in Phase 2.
 *   2. Sessions list. Kept as a secondary source for deployments or
 *      race conditions where the fleet store has not hydrated yet
 *      but the sessions fetch already returned rows for this agent.
 *   3. 8-char UUID prefix. Final fallback when neither lookup
 *      resolves. Console-warns so a future ``/v1/agents/:id``
 *      endpoint is easy to justify when it comes up.
 */
export function buildActiveFilters(
  urlState: UrlStateSnapshot,
  sessions: SessionListItem[],
  agents: AgentSummary[],
  updateUrl: UpdateUrlFn,
  // Optional 5th source — an authoritative agent_name pulled from
  // /v1/agents/{id} when neither the fleet-store roster nor the
  // sessions list could resolve it. Consumers that don't wire the
  // cache simply pass ``null`` (or omit the arg) and the legacy
  // two-source fallback + UUID-prefix chain still works.
  resolvedAgentName: string | null = null,
): ActiveFilterPill[] {
  const pills: ActiveFilterPill[] = [];
  for (const st of urlState.states) {
    pills.push({
      label: `state:${st}`,
      onRemove: () =>
        updateUrl({ states: urlState.states.filter((s) => s !== st), page: 1 }),
    });
  }
  for (const fl of urlState.flavors) {
    pills.push({
      label: `agent:${fl}`,
      onRemove: () =>
        updateUrl({ flavors: urlState.flavors.filter((f) => f !== fl), page: 1 }),
    });
  }
  if (urlState.model) {
    pills.push({
      label: `model:${urlState.model}`,
      onRemove: () => updateUrl({ model: "", page: 1 }),
    });
  }
  for (const fw of urlState.frameworks) {
    pills.push({
      label: `framework:${fw}`,
      onRemove: () =>
        updateUrl({ frameworks: urlState.frameworks.filter((f) => f !== fw), page: 1 }),
    });
  }
  for (const at of urlState.agentTypes) {
    pills.push({
      label: `agent_type:${at}`,
      onRemove: () =>
        updateUrl({
          agentTypes: urlState.agentTypes.filter((a) => a !== at),
          page: 1,
        }),
    });
  }
  for (const et of urlState.errorTypes) {
    pills.push({
      label: `error_type:${et}`,
      onRemove: () =>
        updateUrl({
          errorTypes: urlState.errorTypes.filter((x) => x !== et),
          page: 1,
        }),
    });
  }
  if (urlState.agentId) {
    // ``?? []`` guards against a caller handing a runtime null where
    // the type asserts an array (e.g. a fleet fetch that nominally
    // returns AgentSummary[] but reached us before hydration).
    const agentMatch = (agents ?? []).find(
      (a) => a.agent_id === urlState.agentId,
    );
    const sessionMatch = (sessions ?? []).find(
      (s) => s.agent_id === urlState.agentId,
    );
    // Resolver order: fleet roster > sessions list > /v1/agents/{id}
    // cache hit > UUID prefix. The cached lookup sits between "nice
    // source happened to be in the current view" and "show the raw
    // id"; see agent-identity-cache.ts for the fetch lifecycle.
    const label =
      agentMatch?.agent_name ??
      sessionMatch?.agent_name ??
      resolvedAgentName ??
      urlState.agentId.slice(0, 8);
    if (!agentMatch && !sessionMatch && !resolvedAgentName) {
      // Hit the UUID-prefix fallback. One console line per render is
      // annoying; emit only when the pill would render for the first
      // time and keep it quiet on re-renders via a module-level Set.
      warnUnresolvedAgentOnce(urlState.agentId);
    }
    pills.push({
      label: `agent:${label}`,
      onRemove: () => updateUrl({ agentId: "", page: 1 }),
    });
  }
  const ctxPills: Array<[string, string[], (next: string[]) => void]> = [
    ["os", urlState.contextOS, (n) => updateUrl({ contextOS: n, page: 1 })],
    ["arch", urlState.contextArch, (n) => updateUrl({ contextArch: n, page: 1 })],
    ["hostname", urlState.contextHostnames, (n) => updateUrl({ contextHostnames: n, page: 1 })],
    ["user", urlState.contextUsers, (n) => updateUrl({ contextUsers: n, page: 1 })],
    ["process_name", urlState.contextProcessNames, (n) => updateUrl({ contextProcessNames: n, page: 1 })],
    ["node_version", urlState.contextNodeVersions, (n) => updateUrl({ contextNodeVersions: n, page: 1 })],
    ["python_version", urlState.contextPythonVersions, (n) => updateUrl({ contextPythonVersions: n, page: 1 })],
    ["git_branch", urlState.contextGitBranches, (n) => updateUrl({ contextGitBranches: n, page: 1 })],
    ["git_commit", urlState.contextGitCommits, (n) => updateUrl({ contextGitCommits: n, page: 1 })],
    ["git_repo", urlState.contextGitRepos, (n) => updateUrl({ contextGitRepos: n, page: 1 })],
    ["orchestration", urlState.contextOrchestrations, (n) => updateUrl({ contextOrchestrations: n, page: 1 })],
  ];
  for (const [key, values, setter] of ctxPills) {
    for (const v of values) {
      pills.push({
        label: `${key}:${v}`,
        onRemove: () => setter(values.filter((x) => x !== v)),
      });
    }
  }
  return pills;
}

/**
 * Patch handed to ``updateUrl`` by the "Clear all filters" link.
 * Every filter-bearing URL state field must appear here with its
 * empty value -- missing a field means that filter survives the
 * clear, which is the regression we guard against in unit tests.
 */
export const CLEAR_ALL_FILTERS_PATCH: Partial<UrlStateSnapshot> = {
  states: [],
  flavors: [],
  agentId: "",
  agentTypes: [],
  frameworks: [],
  contextUsers: [],
  contextOS: [],
  contextArch: [],
  contextHostnames: [],
  contextProcessNames: [],
  contextNodeVersions: [],
  contextPythonVersions: [],
  contextGitBranches: [],
  contextGitCommits: [],
  contextGitRepos: [],
  contextOrchestrations: [],
  errorTypes: [],
  model: "",
  q: "",
  page: 1,
};

/**
 * Fold a ``Promise.allSettled`` result for the aux facet-source
 * fetches into a ``FacetSources`` map. Fulfilled entries land in the
 * map; rejected entries are logged (unless the rejection is an
 * AbortError, which indicates a superseded fetch and is expected) and
 * dropped, so the caller falls back to computing that dimension's
 * facet counts from the main result set. Pure function, testable in
 * isolation.
 */
export function collectFacetSources(
  settled: PromiseSettledResult<readonly [string, SessionListItem[] | undefined]>[],
  keys: readonly string[],
  log: (msg: string, err: unknown) => void = console.error,
): FacetSources {
  const sources: FacetSources = {};
  for (let i = 0; i < settled.length; i += 1) {
    const s = settled[i];
    if (s.status === "fulfilled") {
      const [k, sess] = s.value;
      if (sess) (sources as Record<string, SessionListItem[]>)[k] = sess;
    } else if ((s.reason as Error | undefined)?.name !== "AbortError") {
      log(
        `aux facet-source fetch for "${keys[i]}" failed; falling back to main result set`,
        s.reason,
      );
    }
  }
  return sources;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Investigate() {
  const [searchParams, setSearchParams] = useSearchParams();
  const urlState = useMemo(() => parseUrlState(searchParams), [searchParams]);

  // Fleet store -- hydrated on mount so the agent_id filter chip
  // label resolves via agent identity rather than falling through to
  // the UUID prefix when the current sessions list happens not to
  // contain a row for the filtered agent. One extra /v1/fleet call
  // per Investigate mount is cheap (small, cached at store layer
  // after the first fetch) and closes the "No sessions found" + UUID
  // chip UX that PR #24 Bug 2 surfaced.
  // ``?? []`` guards against a store selector returning ``undefined``
  // during initial mount before the create() factory runs, and also
  // surfaces the pattern that a future JSON null from the wire (see
  // ``api/internal/store/postgres.go::GetAgentFleet`` on an empty
  // fleet) cannot crash the component via a ``.length`` on null.
  // Memoized so useMemo consumers downstream get a stable reference.
  const rawFleetAgents = useFleetStore((s) => s.agents);
  const fleetAgents = useMemo(() => rawFleetAgents ?? [], [rawFleetAgents]);
  const fleetLoad = useFleetStore((s) => s.load);
  useEffect(() => {
    if (fleetAgents.length === 0) {
      void fleetLoad();
    }
    // Run-once on mount is the desired behaviour; agent roster refresh
    // under live traffic is the Fleet page's responsibility.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Seed the /v1/agents/{id} cache with whatever the fleet store has
  // already loaded so cache hits are free when an agent is in the
  // roster. ``seedAgents`` only overwrites pending/missing entries
  // so a concrete fetch result (hit or miss) is not clobbered.
  useEffect(() => {
    if (fleetAgents.length > 0) seedAgents(fleetAgents);
  }, [fleetAgents]);

  // Core data state
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  // Sticky facet sources. Populated by parallel aux fetches that drop
  // the matching dimension's filter so the sidebar can render ALL
  // values of an actively-filtered dimension (the selected value
  // stays highlighted via urlState.* below). Cleared when the
  // corresponding filter turns off so the next render falls back to
  // the main result's tally.
  const [facetSources, setFacetSources] = useState<FacetSources>({});

  // Search input (debounced)
  const [searchInput, setSearchInput] = useState(urlState.q);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const searchRef = useRef<HTMLInputElement>(null);

  // Refresh state
  const [lastUpdated, setLastUpdated] = useState(Date.now());
  const [lastUpdatedLabel, setLastUpdatedLabel] = useState("just now");
  const [autoRefreshMs, setAutoRefreshMs] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const autoRefreshRef = useRef<ReturnType<typeof setInterval>>();

  // Drawer state. Initialised from the ``session`` URL param so a
  // deep-link from the global search modal (or a shared URL) opens
  // the drawer on mount. The local state stays authoritative during
  // row clicks; the URL is synced after the initial mount via the
  // effect below so rapid drawer open/close doesn't thrash history.
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    urlState.session || null,
  );
  // Tab the drawer should land on. The camera-icon button in the
  // capture column sets this to "prompts" so the drawer opens
  // directly on captured prompts. Cleared on close so a subsequent
  // row click defaults back to Timeline.
  const [drawerInitialTab, setDrawerInitialTab] = useState<DrawerTab | undefined>(undefined);

  // Abort controller for in-flight requests
  const abortRef = useRef<AbortController>();

  // -----------------------------------------------------------------------
  // Data fetch
  // -----------------------------------------------------------------------

  const doFetch = useCallback(
    async (state: ReturnType<typeof parseUrlState>, skipIfDrawerOpen = false) => {
      if (skipIfDrawerOpen && selectedSessionId) return;

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setLoading(true);
      const baseParams: SessionsParams = {
        q: state.q || undefined,
        from: state.from,
        to: state.to,
        state: state.states.length > 0 ? state.states : undefined,
        flavor: state.flavors.length > 0 ? state.flavors : undefined,
        agent_id: state.agentId || undefined,
        agent_type: state.agentTypes.length > 0 ? state.agentTypes : undefined,
        framework: state.frameworks.length > 0 ? state.frameworks : undefined,
        model: state.model || undefined,
        // Scalar context filters, driven from URL state. Each param
        // only materialises when non-empty so the server does not
        // see ``?user=&os=`` no-op blanks.
        user: state.contextUsers.length > 0 ? state.contextUsers : undefined,
        os: state.contextOS.length > 0 ? state.contextOS : undefined,
        arch: state.contextArch.length > 0 ? state.contextArch : undefined,
        hostname: state.contextHostnames.length > 0 ? state.contextHostnames : undefined,
        process_name: state.contextProcessNames.length > 0 ? state.contextProcessNames : undefined,
        node_version: state.contextNodeVersions.length > 0 ? state.contextNodeVersions : undefined,
        python_version: state.contextPythonVersions.length > 0 ? state.contextPythonVersions : undefined,
        git_branch: state.contextGitBranches.length > 0 ? state.contextGitBranches : undefined,
        git_commit: state.contextGitCommits.length > 0 ? state.contextGitCommits : undefined,
        git_repo: state.contextGitRepos.length > 0 ? state.contextGitRepos : undefined,
        orchestration: state.contextOrchestrations.length > 0 ? state.contextOrchestrations : undefined,
        error_type: state.errorTypes.length > 0 ? state.errorTypes : undefined,
        sort: state.sort,
        order: state.order,
        limit: state.perPage,
        offset: (state.page - 1) * state.perPage,
      };

      // Sticky-facet aux fetches. One per actively-filtered dimension
      // (any filter list non-empty or model non-blank), each with THAT
      // dimension's filter stripped so the facet itself doesn't
      // collapse to a single row. Fan-out is proportional to active
      // filters -- typical interactive use is 1-2; even a worst-case
      // "every facet filtered" run stays bounded by the number of
      // facet keys. All fetches share the main controller so a stale
      // render cancels them together. FACET_LIMIT must match
      // ``sessionsMaxLimit`` in
      // ``api/internal/handlers/sessions_list.go`` (currently 100); a
      // larger value triggers ``"limit exceeds maximum of 100"`` 400s
      // that, without the Promise.allSettled + early main-state-write
      // fix below, used to silently strand the main table on stale
      // data. Drawer refresh short-circuits before we reach this
      // block so the fan-out only happens on URL-state changes.
      const FACET_LIMIT = 100;
      const facetBase = { ...baseParams, limit: FACET_LIMIT, offset: 0 };
      const auxPromises: Record<string, Promise<Awaited<ReturnType<typeof fetchSessions>>> | null> = {
        state: state.states.length > 0
          ? fetchSessions({ ...facetBase, state: undefined }, controller.signal)
          : null,
        flavor: state.flavors.length > 0
          ? fetchSessions({ ...facetBase, flavor: undefined }, controller.signal)
          : null,
        model: state.model
          ? fetchSessions({ ...facetBase, model: undefined }, controller.signal)
          : null,
        framework: state.frameworks.length > 0
          ? fetchSessions({ ...facetBase, framework: undefined }, controller.signal)
          : null,
        agent_type: state.agentTypes.length > 0
          ? fetchSessions({ ...facetBase, agent_type: undefined }, controller.signal)
          : null,
        agent_id: state.agentId
          ? fetchSessions({ ...facetBase, agent_id: undefined }, controller.signal)
          : null,
        user: state.contextUsers.length > 0
          ? fetchSessions({ ...facetBase, user: undefined }, controller.signal)
          : null,
        os: state.contextOS.length > 0
          ? fetchSessions({ ...facetBase, os: undefined }, controller.signal)
          : null,
        arch: state.contextArch.length > 0
          ? fetchSessions({ ...facetBase, arch: undefined }, controller.signal)
          : null,
        hostname: state.contextHostnames.length > 0
          ? fetchSessions({ ...facetBase, hostname: undefined }, controller.signal)
          : null,
        process_name: state.contextProcessNames.length > 0
          ? fetchSessions({ ...facetBase, process_name: undefined }, controller.signal)
          : null,
        node_version: state.contextNodeVersions.length > 0
          ? fetchSessions({ ...facetBase, node_version: undefined }, controller.signal)
          : null,
        python_version: state.contextPythonVersions.length > 0
          ? fetchSessions({ ...facetBase, python_version: undefined }, controller.signal)
          : null,
        git_branch: state.contextGitBranches.length > 0
          ? fetchSessions({ ...facetBase, git_branch: undefined }, controller.signal)
          : null,
        git_repo: state.contextGitRepos.length > 0
          ? fetchSessions({ ...facetBase, git_repo: undefined }, controller.signal)
          : null,
        orchestration: state.contextOrchestrations.length > 0
          ? fetchSessions({ ...facetBase, orchestration: undefined }, controller.signal)
          : null,
        error_type: state.errorTypes.length > 0
          ? fetchSessions({ ...facetBase, error_type: undefined }, controller.signal)
          : null,
      };

      try {
        const resp = await fetchSessions(baseParams, controller.signal);
        // Land the main table state immediately -- the filtered
        // session list and total are what the user sees, and they
        // must not depend on the aux facet-source fetches succeeding.
        // Pre-fix, a single aux rejection (e.g. the limit=500 / cap
        // 100 mismatch) drained the whole branch into ``catch`` and
        // the table stayed on stale data. Landing the main state
        // here decouples render correctness from facet-count
        // integrity.
        setSessions(resp.sessions);
        setTotal(resp.total);
        setLastUpdated(Date.now());

        // Aux fetches use allSettled so one dimension failing (400
        // on a bad param, transient 5xx, network blip, anything)
        // degrades gracefully: the failing dimension falls back to
        // its in-main-resp facet source -- which is the exact
        // behavior used when no filter is active for that dimension
        // anyway, so downstream code already tolerates a missing
        // entry in ``FacetSources``. See ``collectFacetSources`` for
        // the fold logic.
        const auxKeys = Object.keys(auxPromises) as (keyof typeof auxPromises)[];
        const settled = await Promise.allSettled(
          auxKeys.map(async (k) => {
            const p = auxPromises[k];
            if (!p) return [k, undefined] as const;
            const r = await p;
            return [k, r.sessions] as const;
          }),
        );
        setFacetSources(collectFacetSources(settled, auxKeys));
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          console.error("fetchSessions error:", err);
        }
      } finally {
        setLoading(false);
      }
    },
    [selectedSessionId]
  );

  // Initial fetch + refetch on URL state change
  useEffect(() => {
    doFetch(urlState);
    return () => abortRef.current?.abort();
  }, [urlState, doFetch]);

  // URL-param -> drawer state sync. Fires when an external navigation
  // (global search click, shared link, browser history) changes the
  // ``session`` param out from under us. Local drawer state stays
  // authoritative for row clicks; this effect only applies changes
  // that originated in the URL. Guarded against self-triggering by
  // comparing the param against the current local state first.
  useEffect(() => {
    const fromUrl = urlState.session || null;
    if (fromUrl !== selectedSessionId) {
      setSelectedSessionId(fromUrl);
    }
    // selectedSessionId is deliberately NOT a dependency -- we only
    // react to URL changes here; the state-to-URL direction lives on
    // the close handler further down.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlState.session]);

  // "Last updated" label tick
  useEffect(() => {
    const id = setInterval(() => {
      setLastUpdatedLabel(timeAgo(Date.now() - lastUpdated));
    }, 1000);
    return () => clearInterval(id);
  }, [lastUpdated]);

  // Auto-refresh
  useEffect(() => {
    if (autoRefreshRef.current) clearInterval(autoRefreshRef.current);
    if (autoRefreshMs > 0) {
      autoRefreshRef.current = setInterval(() => {
        doFetch(urlState, true);
      }, autoRefreshMs);
    }
    return () => {
      if (autoRefreshRef.current) clearInterval(autoRefreshRef.current);
    };
  }, [autoRefreshMs, urlState, doFetch]);

  // -----------------------------------------------------------------------
  // URL state mutations
  // -----------------------------------------------------------------------

  const updateUrl = useCallback(
    (patch: Partial<ReturnType<typeof parseUrlState>>) => {
      const next = { ...urlState, ...patch };
      setSearchParams(buildUrlParams(next), { replace: true });
    },
    [urlState, setSearchParams]
  );

  // Debounced search
  const handleSearchChange = useCallback(
    (value: string) => {
      setSearchInput(value);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        if (value.length >= 2 || value.length === 0) {
          updateUrl({ q: value, page: 1 });
        }
      }, 300);
    },
    [updateUrl]
  );

  const handleSearchKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Escape") {
        handleSearchChange("");
        searchRef.current?.blur();
      }
    },
    [handleSearchChange]
  );

  // Date range
  const handleDateChange = useCallback(
    (range: DateRangeWithPreset) => {
      updateUrl({
        from: range.from.toISOString(),
        to: range.to.toISOString(),
        page: 1,
      });
    },
    [updateUrl]
  );

  // Sort
  const handleSort = useCallback(
    (col: string) => {
      if (urlState.sort === col) {
        updateUrl({ order: urlState.order === "asc" ? "desc" : "asc", page: 1 });
      } else {
        updateUrl({ sort: col, order: "desc", page: 1 });
      }
    },
    [urlState, updateUrl]
  );

  // Facet click
  const handleFacetClick = useCallback(
    (group: string, value: string) => {
      if (group === "state") {
        const current = urlState.states;
        const next = current.includes(value as SessionState)
          ? current.filter((s) => s !== value)
          : [...current, value as SessionState];
        updateUrl({ states: next, page: 1 });
      } else if (group === "flavor") {
        const current = urlState.flavors;
        const next = current.includes(value)
          ? current.filter((f) => f !== value)
          : [...current, value];
        updateUrl({ flavors: next, page: 1 });
      } else if (group === "model") {
        updateUrl({ model: urlState.model === value ? "" : value, page: 1 });
      } else if (group === "framework") {
        const current = urlState.frameworks;
        const next = current.includes(value)
          ? current.filter((f) => f !== value)
          : [...current, value];
        updateUrl({ frameworks: next, page: 1 });
      } else if (group === "agent_type") {
        const current = urlState.agentTypes;
        const next = current.includes(value)
          ? current.filter((a) => a !== value)
          : [...current, value];
        updateUrl({ agentTypes: next, page: 1 });
      } else if (group === "agent_id") {
        // D115 AGENT facet is single-select: clicking the active
        // agent clears the filter; clicking a different agent
        // replaces it. Matches the MODEL facet UX.
        updateUrl({
          agentId: urlState.agentId === value ? "" : value,
          page: 1,
        });
      } else if (group === "error_type") {
        // Phase 4 ERROR TYPE facet is multi-select with the same
        // toggle pattern as STATE / FLAVOR -- clicking a value
        // adds/removes it from the active filter list.
        const current = urlState.errorTypes;
        const next = current.includes(value)
          ? current.filter((x) => x !== value)
          : [...current, value];
        updateUrl({ errorTypes: next, page: 1 });
      } else {
        // Scalar context facets. Lookup table keeps the per-facet
        // boilerplate (urlState slot, toggle, URL key) in one place
        // so adding a new facet is a one-row change here plus the
        // whitelist updates in parseUrlState / buildUrlParams.
        const ctxKeyToField: Record<
          string,
          { get: () => string[]; set: (next: string[]) => void }
        > = {
          os: {
            get: () => urlState.contextOS,
            set: (next) => updateUrl({ contextOS: next, page: 1 }),
          },
          arch: {
            get: () => urlState.contextArch,
            set: (next) => updateUrl({ contextArch: next, page: 1 }),
          },
          hostname: {
            get: () => urlState.contextHostnames,
            set: (next) => updateUrl({ contextHostnames: next, page: 1 }),
          },
          user: {
            get: () => urlState.contextUsers,
            set: (next) => updateUrl({ contextUsers: next, page: 1 }),
          },
          process_name: {
            get: () => urlState.contextProcessNames,
            set: (next) => updateUrl({ contextProcessNames: next, page: 1 }),
          },
          node_version: {
            get: () => urlState.contextNodeVersions,
            set: (next) => updateUrl({ contextNodeVersions: next, page: 1 }),
          },
          python_version: {
            get: () => urlState.contextPythonVersions,
            set: (next) => updateUrl({ contextPythonVersions: next, page: 1 }),
          },
          git_branch: {
            get: () => urlState.contextGitBranches,
            set: (next) => updateUrl({ contextGitBranches: next, page: 1 }),
          },
          git_repo: {
            get: () => urlState.contextGitRepos,
            set: (next) => updateUrl({ contextGitRepos: next, page: 1 }),
          },
          orchestration: {
            get: () => urlState.contextOrchestrations,
            set: (next) => updateUrl({ contextOrchestrations: next, page: 1 }),
          },
        };
        const field = ctxKeyToField[group];
        if (field) {
          const current = field.get();
          const next = current.includes(value)
            ? current.filter((x) => x !== value)
            : [...current, value];
          field.set(next);
        }
      }
    },
    [urlState, updateUrl]
  );

  // /v1/agents/{id} lookup for the chip label. When the fleet store
  // roster and the current sessions list both miss the active
  // agent_id filter (e.g. the time window excluded every session
  // for that agent) this triggers a background fetch and the chip
  // re-renders with the real agent_name once the response lands.
  const resolvedAgent = useAgentIdentity(urlState.agentId);
  const resolvedAgentName = resolvedAgent?.agent_name ?? null;

  // Active filter pills -- pure function for testability. Agents
  // come from the fleet store, hydrated at mount below so the
  // agent_id chip label resolves via agent identity (authoritative)
  // instead of falling through to the 8-char UUID prefix when the
  // filtered sessions list happens to be empty -- Bug 2b fix.
  const activeFilters = useMemo(
    () =>
      buildActiveFilters(
        urlState,
        sessions,
        fleetAgents,
        updateUrl,
        resolvedAgentName,
      ),
    [urlState, sessions, fleetAgents, updateUrl, resolvedAgentName],
  );

  const clearAllFilters = useCallback(() => {
    updateUrl(CLEAR_ALL_FILTERS_PATCH);
    setSearchInput("");
  }, [updateUrl]);

  // Facets from current result set. Actively-filtered dimensions
  // (state / flavor / model) pull their values from the per-dim aux
  // sources populated in doFetch so selecting a flavor doesn't
  // collapse the FLAVOR facet to a single row. See the FacetSources
  // comment near the top of the file for the full sticky-facet model.
  const facets = useMemo(
    () => computeFacets(sessions, facetSources),
    [sessions, facetSources],
  );

  const hasActiveFilters = activeFilters.length > 0 || !!urlState.q;

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  const sortArrow = (col: string, sortable = true) => {
    if (urlState.sort === col) {
      return (
        <span style={{ color: "var(--primary)" }}>
          {urlState.order === "asc" ? " \u2191" : " \u2193"}
        </span>
      );
    }
    if (sortable) {
      return <span style={{ color: "var(--text-disabled)", opacity: 0 }} className="group-hover:!opacity-100 transition-opacity duration-150">{" \u2195"}</span>;
    }
    return null;
  };

  const dateRange = useMemo(
    () => ({ from: new Date(urlState.from), to: new Date(urlState.to) }),
    [urlState.from, urlState.to]
  );

  return (
    <div className="flex h-full flex-col overflow-hidden" style={{ background: "var(--bg)" }}>
      {/* Top bar — single row */}
      <div
        className="flex items-center gap-3 border-b px-4 py-2.5"
        style={{ borderColor: "var(--border)" }}
      >
        {/* Search bar */}
        <div className="relative flex-1 min-w-0">
          <Search
            className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4"
            style={{ color: "var(--text-muted)" }}
          />
          <input
            ref={searchRef}
            type="text"
            value={searchInput}
            onChange={(e) => handleSearchChange(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder="Search agent, model, hostname, git branch..."
            className="h-10 w-full rounded-md placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary"
            style={{
              border: "2px solid var(--border)",
              background: "var(--surface)",
              color: "var(--text)",
              fontSize: 13,
              paddingLeft: 40,
              paddingRight: searchInput ? 36 : 12,
            }}
          />
          {searchInput && (
            <button
              onClick={() => handleSearchChange("")}
              className="absolute right-3 top-1/2 -translate-y-1/2 flex h-5 w-5 items-center justify-center rounded-sm transition-colors duration-150 hover:bg-surface-hover"
              aria-label="Clear search"
            >
              <X className="h-3.5 w-3.5" style={{ color: "var(--text-muted)" }} />
            </button>
          )}
        </div>

        {/* Date range presets */}
        <div className="shrink-0">
          <DateRangePicker
            value={dateRange}
            onChange={handleDateChange}
            defaultPreset="last7days"
          />
        </div>

        {/* Refresh controls */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={async () => {
              setIsRefreshing(true);
              try {
                await doFetch(urlState);
              } finally {
                setIsRefreshing(false);
              }
            }}
            disabled={isRefreshing}
            className="flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 font-medium transition-colors duration-150 hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-70"
            style={{
              fontSize: 12,
              borderColor: "var(--border)",
              color: "var(--text-muted)",
            }}
            aria-label="Refresh"
          >
            <RefreshCw
              className={cn("h-3.5 w-3.5", isRefreshing && "animate-[spin_600ms_linear_infinite]")}
              style={{
                color: isRefreshing ? "var(--accent)" : undefined,
              }}
            />
            Refresh
          </button>
          <div className="flex items-center gap-1.5">
            <span className="whitespace-nowrap" style={{ fontSize: 12, color: "var(--text-muted)" }}>
              Auto-refresh:
            </span>
            <select
              value={autoRefreshMs}
              onChange={(e) => setAutoRefreshMs(Number(e.target.value))}
              className="h-7 rounded-md border px-1.5 focus:outline-none focus:ring-1 focus:ring-primary"
              style={{
                fontSize: 12,
                borderColor: "var(--border)",
                background: "var(--surface)",
                color: "var(--text-secondary)",
              }}
            >
              {AUTO_REFRESH_OPTIONS.map((opt) => (
                <option key={opt.ms} value={opt.ms}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
          <span className="whitespace-nowrap" style={{ fontSize: 12, color: "var(--text-muted)" }}>
            {lastUpdatedLabel}
          </span>
        </div>
      </div>

      {/* Body: sidebar + table */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left sidebar */}
        <div
          className="w-[220px] flex-shrink-0 overflow-y-auto"
          style={{ borderRight: "1px solid var(--border-subtle)" }}
        >
          {facets.map((group, gi) => (
            <div
              key={group.key}
              data-testid={
                group.key === "error_type" ? "investigate-error-type-facet" : undefined
              }
            >
              <div
                className="font-semibold uppercase"
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  letterSpacing: "0.08em",
                  color: "var(--text-muted)",
                  padding: gi === 0 ? "12px 12px 6px 12px" : "16px 12px 6px 12px",
                }}
              >
                {group.label}
              </div>
              {group.values.slice(0, 10).map((v) => {
                const isActive =
                  (group.key === "state" && urlState.states.includes(v.value as SessionState)) ||
                  (group.key === "flavor" && urlState.flavors.includes(v.value)) ||
                  (group.key === "model" && urlState.model === v.value) ||
                  (group.key === "framework" && urlState.frameworks.includes(v.value)) ||
                  (group.key === "agent_type" && urlState.agentTypes.includes(v.value)) ||
                  (group.key === "agent_id" && urlState.agentId === v.value) ||
                  (group.key === "error_type" && urlState.errorTypes.includes(v.value)) ||
                  (group.key === "os" && urlState.contextOS.includes(v.value)) ||
                  (group.key === "arch" && urlState.contextArch.includes(v.value)) ||
                  (group.key === "hostname" && urlState.contextHostnames.includes(v.value)) ||
                  (group.key === "user" && urlState.contextUsers.includes(v.value)) ||
                  (group.key === "process_name" && urlState.contextProcessNames.includes(v.value)) ||
                  (group.key === "node_version" && urlState.contextNodeVersions.includes(v.value)) ||
                  (group.key === "python_version" && urlState.contextPythonVersions.includes(v.value)) ||
                  (group.key === "git_branch" && urlState.contextGitBranches.includes(v.value)) ||
                  (group.key === "git_repo" && urlState.contextGitRepos.includes(v.value)) ||
                  (group.key === "orchestration" && urlState.contextOrchestrations.includes(v.value));
                return (
                  <button
                    key={v.value}
                    data-testid={
                      group.key === "error_type"
                        ? `investigate-error-type-pill-${v.value}`
                        : undefined
                    }
                    onClick={() => handleFacetClick(group.key, v.value)}
                    className="flex w-full items-center cursor-pointer transition-colors duration-150"
                    style={{
                      fontSize: 13,
                      padding: "4px 12px",
                      borderRadius: 4,
                      color: isActive ? "var(--primary)" : "var(--text)",
                      background: isActive ? "color-mix(in srgb, var(--primary) 15%, transparent)" : undefined,
                    }}
                    onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = "var(--bg-elevated)"; }}
                    onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = ""; }}
                  >
                    <span className="flex items-center min-w-0 flex-1" style={{ gap: 8 }}>
                      <FacetIcon groupKey={group.key} value={v.value} />
                      <TruncatedText text={v.label ?? v.value} />
                    </span>
                    <span
                      className="shrink-0"
                      style={{
                        fontSize: 11,
                        fontWeight: 500,
                        color: "var(--text-muted)",
                        marginLeft: "auto",
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {v.count}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
          {facets.length === 0 && !loading && (
            <div style={{ fontSize: 12, color: "var(--text-muted)", padding: "16px 12px", textAlign: "center" }}>
              No facets available
            </div>
          )}
        </div>

        {/* Main content */}
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Active filter pills — above table, hidden when empty */}
          {hasActiveFilters && (
            <div
              className="flex items-center gap-1.5 flex-wrap border-b px-4 py-2"
              style={{ borderColor: "var(--border)" }}
            >
              {urlState.q && (
                <span
                  data-testid="active-filter-pill"
                  className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs"
                  style={{
                    background: "var(--primary-glow)",
                    color: "var(--primary)",
                  }}
                >
                  search:{urlState.q}
                  <button
                    data-testid="active-filter-remove"
                    onClick={() => {
                      updateUrl({ q: "", page: 1 });
                      setSearchInput("");
                    }}
                    className="hover:opacity-70 transition-opacity duration-150"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              )}
              {activeFilters.map((f) => (
                <span
                  key={f.label}
                  data-testid="active-filter-pill"
                  className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs"
                  style={{
                    background: "var(--primary-glow)",
                    color: "var(--primary)",
                  }}
                >
                  {f.label}
                  <button data-testid="active-filter-remove" onClick={f.onRemove} className="hover:opacity-70 transition-opacity duration-150">
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
              <button
                onClick={clearAllFilters}
                className="text-xs transition-colors duration-150 hover:underline"
                style={{ color: "var(--text-muted)" }}
              >
                Clear all filters
              </button>
            </div>
          )}

          {/* Table */}
          <div className="flex-1 overflow-auto">
            <table className="w-full text-xs" style={{ color: "var(--text)", tableLayout: "fixed" }}>
              <thead>
                <tr
                  className="sticky top-0 z-10 text-left"
                  style={{ background: "var(--surface)", borderBottom: "1px solid var(--border)", height: 32 }}
                >
                  <th
                    className="uppercase"
                    style={{ color: "var(--text-muted)", fontSize: 10, fontWeight: 600, letterSpacing: "0.07em", padding: "0 12px", width: COL_WIDTHS.session }}
                  >
                    Session
                  </th>
                  <th
                    className="group cursor-pointer uppercase transition-colors duration-150 hover:text-text"
                    style={{ color: "var(--text-muted)", fontSize: 10, fontWeight: 600, letterSpacing: "0.07em", padding: "0 12px", width: COL_WIDTHS.flavor }}
                    onClick={() => handleSort("flavor")}
                  >
                    Agent{sortArrow("flavor")}
                  </th>
                  <th
                    className="uppercase"
                    style={{ color: "var(--text-muted)", fontSize: 10, fontWeight: 600, letterSpacing: "0.07em", padding: "0 12px", width: COL_WIDTHS.hostname }}
                  >
                    Hostname
                  </th>
                  <th
                    className="uppercase"
                    style={{ color: "var(--text-muted)", fontSize: 10, fontWeight: 600, letterSpacing: "0.07em", padding: "0 8px", width: COL_WIDTHS.os }}
                  >
                    OS
                  </th>
                  <th
                    className="uppercase"
                    style={{ color: "var(--text-muted)", fontSize: 10, fontWeight: 600, letterSpacing: "0.07em", padding: "0 8px", width: COL_WIDTHS.orch }}
                  >
                    Orch
                  </th>
                  <th
                    className="uppercase"
                    style={{ color: "var(--text-muted)", fontSize: 10, fontWeight: 600, letterSpacing: "0.07em", padding: "0 12px", width: COL_WIDTHS.model }}
                  >
                    Model
                  </th>
                  <th
                    className="group cursor-pointer uppercase transition-colors duration-150 hover:text-text"
                    style={{ color: "var(--text-muted)", fontSize: 10, fontWeight: 600, letterSpacing: "0.07em", padding: "0 12px", width: COL_WIDTHS.started }}
                    onClick={() => handleSort("started_at")}
                  >
                    Started{sortArrow("started_at")}
                  </th>
                  <th
                    className="group cursor-pointer uppercase transition-colors duration-150 hover:text-text"
                    style={{ color: "var(--text-muted)", fontSize: 10, fontWeight: 600, letterSpacing: "0.07em", padding: "0 12px", width: COL_WIDTHS.duration }}
                    onClick={() => handleSort("duration")}
                  >
                    Duration{sortArrow("duration")}
                  </th>
                  <th
                    className="group cursor-pointer uppercase transition-colors duration-150 hover:text-text"
                    style={{ color: "var(--text-muted)", fontSize: 10, fontWeight: 600, letterSpacing: "0.07em", padding: "0 12px", width: COL_WIDTHS.tokens }}
                    onClick={() => handleSort("tokens_used")}
                  >
                    Tokens{sortArrow("tokens_used")}
                  </th>
                  <th
                    className="uppercase"
                    style={{
                      color: "var(--text-muted)",
                      fontSize: 10,
                      fontWeight: 600,
                      letterSpacing: "0.07em",
                      padding: "0 8px",
                      width: COL_WIDTHS.capture,
                      whiteSpace: "normal",
                      verticalAlign: "middle",
                    }}
                    aria-label="Prompt capture"
                  >
                    <div className="flex items-center justify-center gap-1.5">
                      <FileText
                        size={12}
                        strokeWidth={2}
                        className="shrink-0 self-center"
                        style={{ color: "var(--text-muted)" }}
                      />
                      <span className="leading-tight">
                        PROMPT
                        <br />
                        CAPTURE
                      </span>
                    </div>
                  </th>
                  <th
                    className="uppercase"
                    style={{ color: "var(--text-muted)", fontSize: 10, fontWeight: 600, letterSpacing: "0.07em", padding: "0 12px", width: COL_WIDTHS.state }}
                  >
                    State
                  </th>
                </tr>
              </thead>
              <tbody>
                {loading && sessions.length === 0 && <SkeletonRows />}
                {sessions.map((s) => (
                  <tr
                    key={s.session_id}
                    onClick={() => {
                      setDrawerInitialTab(undefined);
                      setSelectedSessionId(s.session_id);
                    }}
                    className="cursor-pointer transition-colors duration-150"
                    style={{
                      height: 44,
                      borderBottom: "1px solid var(--border-subtle)",
                      background: selectedSessionId === s.session_id
                        ? "color-mix(in srgb, var(--primary) 10%, transparent)"
                        : undefined,
                    }}
                    onMouseEnter={(e) => { if (selectedSessionId !== s.session_id) e.currentTarget.style.background = "rgba(128,128,128,0.08)"; }}
                    onMouseLeave={(e) => { if (selectedSessionId !== s.session_id) e.currentTarget.style.background = ""; }}
                  >
                    <td
                      style={{
                        padding: "0 12px",
                        width: COL_WIDTHS.session,
                        fontFamily: "var(--font-mono)",
                        fontSize: 12,
                        color: "var(--text-secondary)",
                        // Table cells drop the raw ``truncate``
                        // Tailwind class in favour of an inner
                        // ``<TruncatedText/>`` -- the cell still
                        // constrains width, the primitive handles
                        // ellipsis + title-attribute tooltip reveal.
                        overflow: "hidden",
                      }}
                      data-testid={`investigate-row-session-${s.session_id}`}
                    >
                      <TruncatedText text={truncateSessionId(s.session_id)} />
                    </td>
                    <td style={{ padding: "0 12px", width: COL_WIDTHS.flavor, fontSize: 13, fontWeight: 500, color: "var(--text)", overflow: "hidden" }}>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0, maxWidth: "100%" }}>
                        {isClaudeCodeSession(s) && (
                          <ClaudeCodeLogo size={14} className="shrink-0" />
                        )}
                        <TruncatedText text={s.flavor} />
                        {isClaudeCodeSession(s) && <CodingAgentBadge />}
                      </span>
                    </td>
                    <td style={{ padding: "0 12px", width: COL_WIDTHS.hostname, fontSize: 12, color: "var(--text-secondary)", overflow: "hidden" }}>
                      <TruncatedText
                        text={(s.context?.hostname as string) ?? s.host ?? "\u2014"}
                      />
                    </td>
                    <td style={{ padding: "0 8px", width: COL_WIDTHS.os }}>
                      <OSIcon os={(s.context?.os as string) ?? ""} size={16} />
                    </td>
                    <td style={{ padding: "0 8px", width: COL_WIDTHS.orch }}>
                      <OrchestrationIcon
                        orchestration={(s.context?.orchestration as string) ?? ""}
                        size={16}
                      />
                    </td>
                    <td style={{ padding: "0 12px", width: COL_WIDTHS.model, fontSize: 12, color: "var(--text-secondary)", overflow: "hidden" }}>
                      {s.model ? (
                        <span className="inline-flex items-center gap-1.5 min-w-0 max-w-full">
                          <ProviderLogo provider={getProvider(s.model)} size={12} />
                          <TruncatedText text={s.model} />
                        </span>
                      ) : (
                        "\u2014"
                      )}
                    </td>
                    <td className="whitespace-nowrap" style={{ padding: "0 12px", width: COL_WIDTHS.started, fontSize: 12, color: "var(--text-secondary)", fontVariantNumeric: "tabular-nums" }}>
                      {new Date(s.started_at).toLocaleString(undefined, {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </td>
                    <td style={{ padding: "0 12px", width: COL_WIDTHS.duration, fontSize: 12, color: "var(--text-secondary)", fontVariantNumeric: "tabular-nums", fontFamily: "var(--font-mono)" }}>
                      {formatDuration(s.duration_s)}
                    </td>
                    <td style={{ padding: "0 12px", width: COL_WIDTHS.tokens, fontSize: 12, color: "var(--text)", fontWeight: 500, fontVariantNumeric: "tabular-nums", fontFamily: "var(--font-mono)" }}>
                      {formatTokens(s.tokens_used)}
                    </td>
                    <td style={{ padding: "0 8px", width: COL_WIDTHS.capture, textAlign: "center" }}>
                      {s.capture_enabled && (
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button
                                type="button"
                                aria-label="View captured prompts"
                                data-testid="capture-prompts-button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setDrawerInitialTab("prompts");
                                  setSelectedSessionId(s.session_id);
                                }}
                                style={{
                                  display: "inline-flex",
                                  alignItems: "center",
                                  justifyContent: "center",
                                  background: "transparent",
                                  border: "none",
                                  padding: 4,
                                  borderRadius: 4,
                                  cursor: "pointer",
                                  lineHeight: 0,
                                  color: "var(--accent)",
                                }}
                              >
                                <FileText size={12} strokeWidth={2.25} />
                              </button>
                            </TooltipTrigger>
                            <TooltipContent>Prompts captured</TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      )}
                    </td>
                    <td style={{ padding: "0 12px", width: COL_WIDTHS.state }}>
                      <span className="inline-flex items-center gap-1.5">
                        {s.error_types && s.error_types.length > 0 && (
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span
                                  data-testid={`session-row-error-indicator-${s.session_id}`}
                                  aria-label={`Session emitted llm_error events: ${s.error_types.join(", ")}`}
                                  className="inline-block rounded-full"
                                  style={{
                                    width: 7,
                                    height: 7,
                                    background: "var(--event-error)",
                                    boxShadow:
                                      "0 0 0 2px color-mix(in srgb, var(--event-error) 25%, transparent)",
                                    flexShrink: 0,
                                  }}
                                />
                              </TooltipTrigger>
                              <TooltipContent>
                                {`Errors: ${s.error_types.join(", ")}`}
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        )}
                        <StateBadge state={s.state} />
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Empty state */}
            {!loading && sessions.length === 0 && (
              <div
                className="flex flex-col items-center justify-center py-20"
                style={{ color: "var(--text-muted)" }}
              >
                <LayoutGrid className="h-10 w-10 mb-3 opacity-30" />
                <p className="text-sm font-medium">No sessions found</p>
                <p className="text-xs mt-1 opacity-70">
                  Try adjusting your filters or time range.
                </p>
                {hasActiveFilters && (
                  <button
                    onClick={clearAllFilters}
                    className="mt-3 text-xs font-medium transition-colors duration-150 hover:underline"
                    style={{ color: "var(--primary)" }}
                  >
                    Clear filters
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Pagination */}
          {total > 0 && (
            <div
              className="border-t px-4 py-2 shrink-0"
              style={{ borderColor: "var(--border)", background: "var(--surface)" }}
            >
              <Pagination
                total={total}
                offset={(urlState.page - 1) * urlState.perPage}
                limit={urlState.perPage}
                onPageChange={(newOffset) =>
                  updateUrl({ page: Math.floor(newOffset / urlState.perPage) + 1 })
                }
                onLimitChange={(newLimit) =>
                  updateUrl({ perPage: newLimit, page: 1 })
                }
              />
            </div>
          )}
        </div>
      </div>

      {/* Session drawer */}
      <SessionDrawer
        sessionId={selectedSessionId}
        onClose={() => {
          setSelectedSessionId(null);
          setDrawerInitialTab(undefined);
          // If the drawer was opened via the ``session`` URL param
          // (global search deep-link, shared link), strip the param
          // so closing the drawer doesn't leave a stale id in the
          // URL. Safe when the param wasn't set -- updateUrl only
          // writes keys that actually change.
          if (urlState.session) {
            updateUrl({ session: "", page: urlState.page });
          }
        }}
        initialTab={drawerInitialTab}
      />
    </div>
  );
}
