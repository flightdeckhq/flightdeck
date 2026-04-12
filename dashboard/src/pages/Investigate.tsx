import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { Search, RefreshCw, X } from "lucide-react";
import { fetchSessions, type SessionsParams } from "@/lib/api";
import type { SessionListItem, SessionState } from "@/lib/types";
import { DateRangePicker, type DateRangeWithPreset } from "@/components/ui/DateRangePicker";
import { Pagination } from "@/components/ui/Pagination";
import { SessionDrawer } from "@/components/session/SessionDrawer";
import { OSIcon } from "@/components/ui/OSIcon";
import { OrchestrationIcon } from "@/components/ui/OrchestrationIcon";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// URL state helpers
// ---------------------------------------------------------------------------

function parseUrlState(sp: URLSearchParams) {
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
    model: sp.get("model") ?? "",
    sort: sp.get("sort") ?? "started_at",
    order: (sp.get("order") ?? "desc") as "asc" | "desc",
    page,
    perPage,
  };
}

function buildUrlParams(s: ReturnType<typeof parseUrlState>): URLSearchParams {
  const p = new URLSearchParams();
  if (s.q) p.set("q", s.q);
  if (s.from) p.set("from", s.from);
  if (s.to) p.set("to", s.to);
  for (const st of s.states) p.append("state", st);
  for (const fl of s.flavors) p.append("flavor", fl);
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

const STATE_COLORS: Record<string, string> = {
  active: "bg-status-active",
  idle: "bg-status-idle",
  stale: "bg-status-stale",
  closed: "bg-status-closed",
  lost: "bg-status-lost",
};
const AUTO_REFRESH_OPTIONS = [
  { label: "Off", ms: 0 },
  { label: "30s", ms: 30_000 },
  { label: "1m", ms: 60_000 },
  { label: "5m", ms: 300_000 },
];

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
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
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

// ---------------------------------------------------------------------------
// Facet computation (client-side from current result set)
// ---------------------------------------------------------------------------

interface FacetGroup {
  key: string;
  label: string;
  values: { value: string; count: number }[];
}

function computeFacets(sessions: SessionListItem[]): FacetGroup[] {
  const stateCounts = new Map<string, number>();
  const flavorCounts = new Map<string, number>();
  const modelCounts = new Map<string, number>();
  const osCounts = new Map<string, number>();
  const branchCounts = new Map<string, number>();
  const hostCounts = new Map<string, number>();

  for (const s of sessions) {
    stateCounts.set(s.state, (stateCounts.get(s.state) ?? 0) + 1);
    flavorCounts.set(s.flavor, (flavorCounts.get(s.flavor) ?? 0) + 1);
    if (s.model) modelCounts.set(s.model, (modelCounts.get(s.model) ?? 0) + 1);
    const os = s.context?.os as string | undefined;
    if (os) osCounts.set(os, (osCounts.get(os) ?? 0) + 1);
    const branch = s.context?.git_branch as string | undefined;
    if (branch) branchCounts.set(branch, (branchCounts.get(branch) ?? 0) + 1);
    const hostname = (s.context?.hostname ?? s.host) as string | undefined;
    if (hostname) hostCounts.set(hostname, (hostCounts.get(hostname) ?? 0) + 1);
  }

  const toArr = (m: Map<string, number>) =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([value, count]) => ({ value, count }));

  return [
    { key: "state", label: "STATE", values: toArr(stateCounts) },
    { key: "flavor", label: "FLAVOR", values: toArr(flavorCounts) },
    { key: "model", label: "MODEL", values: toArr(modelCounts) },
    { key: "os", label: "OS", values: toArr(osCounts) },
    { key: "git_branch", label: "GIT BRANCH", values: toArr(branchCounts) },
    { key: "hostname", label: "HOSTNAME", values: toArr(hostCounts) },
  ].filter((g) => g.values.length > 0);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Investigate() {
  const [searchParams, setSearchParams] = useSearchParams();
  const urlState = useMemo(() => parseUrlState(searchParams), [searchParams]);

  // Core data state
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  // Search input (debounced)
  const [searchInput, setSearchInput] = useState(urlState.q);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  // Refresh state
  const [lastUpdated, setLastUpdated] = useState(Date.now());
  const [lastUpdatedLabel, setLastUpdatedLabel] = useState("just now");
  const [autoRefreshMs, setAutoRefreshMs] = useState(0);
  const autoRefreshRef = useRef<ReturnType<typeof setInterval>>();

  // Drawer state (ephemeral, not in URL)
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);

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
      try {
        const params: SessionsParams = {
          q: state.q || undefined,
          from: state.from,
          to: state.to,
          state: state.states.length > 0 ? state.states : undefined,
          flavor: state.flavors.length > 0 ? state.flavors : undefined,
          model: state.model || undefined,
          sort: state.sort,
          order: state.order,
          limit: state.perPage,
          offset: (state.page - 1) * state.perPage,
        };
        const resp = await fetchSessions(params, controller.signal);
        setSessions(resp.sessions);
        setTotal(resp.total);
        setLastUpdated(Date.now());
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
      }
      // os, git_branch, hostname use the q search for now
    },
    [urlState, updateUrl]
  );

  // Active filter pills
  const activeFilters = useMemo(() => {
    const pills: { label: string; onRemove: () => void }[] = [];
    for (const st of urlState.states) {
      pills.push({
        label: `state:${st}`,
        onRemove: () =>
          updateUrl({ states: urlState.states.filter((s) => s !== st), page: 1 }),
      });
    }
    for (const fl of urlState.flavors) {
      pills.push({
        label: `flavor:${fl}`,
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
    return pills;
  }, [urlState, updateUrl]);

  const clearAllFilters = useCallback(() => {
    updateUrl({ states: [], flavors: [], model: "", q: "", page: 1 });
    setSearchInput("");
  }, [updateUrl]);

  // Facets from current result set
  const facets = useMemo(() => computeFacets(sessions), [sessions]);

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  const sortArrow = (col: string) => {
    if (urlState.sort !== col) return null;
    return urlState.order === "asc" ? " \u2191" : " \u2193";
  };

  const dateRange = useMemo(
    () => ({ from: new Date(urlState.from), to: new Date(urlState.to) }),
    [urlState.from, urlState.to]
  );

  return (
    <div className="flex h-full flex-col overflow-hidden" style={{ background: "var(--bg)" }}>
      {/* Header */}
      <div
        className="flex flex-col gap-2 border-b px-4 py-3"
        style={{ borderColor: "var(--border)" }}
      >
        <div className="flex items-center gap-3">
          <h1 className="text-[15px] font-semibold" style={{ color: "var(--text)" }}>
            Investigate
          </h1>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          {/* Search */}
          <div className="relative flex-1 max-w-md">
            <Search
              className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5"
              style={{ color: "var(--text-muted)" }}
            />
            <input
              type="text"
              value={searchInput}
              onChange={(e) => handleSearchChange(e.target.value)}
              placeholder="Search flavor, model, hostname, git branch..."
              className="h-8 w-full rounded-md border border-border bg-surface pl-8 pr-3 text-xs text-text placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>

          {/* Date range */}
          <DateRangePicker
            value={dateRange}
            onChange={handleDateChange}
            defaultPreset="last7days"
          />

          {/* Refresh */}
          <div className="flex items-center gap-2 ml-auto">
            <button
              onClick={() => doFetch(urlState)}
              className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-text-secondary hover:bg-surface-hover transition-colors"
              aria-label="Refresh"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
            </button>
            <select
              value={autoRefreshMs}
              onChange={(e) => setAutoRefreshMs(Number(e.target.value))}
              className="h-7 rounded-md border border-border bg-surface px-1.5 text-xs text-text-secondary focus:outline-none focus:ring-1 focus:ring-primary"
            >
              {AUTO_REFRESH_OPTIONS.map((opt) => (
                <option key={opt.ms} value={opt.ms}>
                  {opt.label}
                </option>
              ))}
            </select>
            <span className="text-[11px] text-text-muted whitespace-nowrap">
              {lastUpdatedLabel}
            </span>
          </div>
        </div>

        {/* Active filter pills */}
        {(activeFilters.length > 0 || urlState.q) && (
          <div className="flex items-center gap-1.5 flex-wrap">
            {urlState.q && (
              <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
                search:{urlState.q}
                <button
                  onClick={() => {
                    updateUrl({ q: "", page: 1 });
                    setSearchInput("");
                  }}
                  className="hover:text-text"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            )}
            {activeFilters.map((f) => (
              <span
                key={f.label}
                className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary"
              >
                {f.label}
                <button onClick={f.onRemove} className="hover:text-text">
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
            <button
              onClick={clearAllFilters}
              className="text-xs text-text-muted hover:text-text transition-colors"
            >
              Clear all
            </button>
          </div>
        )}
      </div>

      {/* Body: sidebar + table */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left sidebar */}
        <div
          className="w-[220px] flex-shrink-0 overflow-y-auto border-r p-3"
          style={{ borderColor: "var(--border)" }}
        >
          {facets.map((group) => (
            <div key={group.key} className="mb-4">
              <div className="mb-1.5 text-[10px] font-semibold tracking-wider text-text-muted">
                {group.label}
              </div>
              {group.values.slice(0, 10).map((v) => {
                const isActive =
                  (group.key === "state" && urlState.states.includes(v.value as SessionState)) ||
                  (group.key === "flavor" && urlState.flavors.includes(v.value)) ||
                  (group.key === "model" && urlState.model === v.value);
                return (
                  <button
                    key={v.value}
                    onClick={() => handleFacetClick(group.key, v.value)}
                    className={cn(
                      "flex w-full items-center justify-between rounded px-1.5 py-0.5 text-xs transition-colors",
                      isActive
                        ? "bg-primary/10 text-primary"
                        : "text-text-secondary hover:bg-surface-hover"
                    )}
                  >
                    <span className="truncate">{v.value}</span>
                    <span className="ml-1 text-text-muted">{v.count}</span>
                  </button>
                );
              })}
            </div>
          ))}
          {facets.length === 0 && !loading && (
            <div className="text-xs text-text-muted py-4 text-center">
              No facets available
            </div>
          )}
        </div>

        {/* Main content */}
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Table */}
          <div className="flex-1 overflow-auto">
            <table className="w-full text-xs" style={{ color: "var(--text)" }}>
              <thead>
                <tr
                  className="sticky top-0 z-10 text-left text-[11px] font-medium"
                  style={{ background: "var(--surface)", borderBottom: "1px solid var(--border)" }}
                >
                  <th
                    className="cursor-pointer px-3 py-2 hover:text-text"
                    style={{ color: "var(--text-secondary)" }}
                    onClick={() => handleSort("flavor")}
                  >
                    Flavor{sortArrow("flavor")}
                  </th>
                  <th className="px-3 py-2" style={{ color: "var(--text-secondary)" }}>
                    Hostname
                  </th>
                  <th className="px-2 py-2 w-8" style={{ color: "var(--text-secondary)" }}>
                    OS
                  </th>
                  <th className="px-2 py-2 w-8" style={{ color: "var(--text-secondary)" }}>
                    Orch
                  </th>
                  <th className="px-3 py-2" style={{ color: "var(--text-secondary)" }}>
                    Model
                  </th>
                  <th
                    className="cursor-pointer px-3 py-2 hover:text-text"
                    style={{ color: "var(--text-secondary)" }}
                    onClick={() => handleSort("started_at")}
                  >
                    Started{sortArrow("started_at")}
                  </th>
                  <th
                    className="cursor-pointer px-3 py-2 hover:text-text"
                    style={{ color: "var(--text-secondary)" }}
                    onClick={() => handleSort("duration")}
                  >
                    Duration{sortArrow("duration")}
                  </th>
                  <th
                    className="cursor-pointer px-3 py-2 hover:text-text"
                    style={{ color: "var(--text-secondary)" }}
                    onClick={() => handleSort("tokens_used")}
                  >
                    Tokens{sortArrow("tokens_used")}
                  </th>
                  <th className="px-3 py-2" style={{ color: "var(--text-secondary)" }}>
                    State
                  </th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <tr
                    key={s.session_id}
                    onClick={() => setSelectedSessionId(s.session_id)}
                    className={cn(
                      "cursor-pointer border-b transition-colors",
                      selectedSessionId === s.session_id
                        ? "bg-primary/5"
                        : "hover:bg-surface-hover"
                    )}
                    style={{ borderColor: "var(--border-subtle)" }}
                  >
                    <td className="px-3 py-2 font-medium">{s.flavor}</td>
                    <td className="px-3 py-2 text-text-secondary">
                      {(s.context?.hostname as string) ?? s.host ?? "\u2014"}
                    </td>
                    <td className="px-2 py-2">
                      <OSIcon os={(s.context?.os as string) ?? ""} size={14} />
                    </td>
                    <td className="px-2 py-2">
                      <OrchestrationIcon
                        orchestration={(s.context?.orchestration as string) ?? ""}
                        size={14}
                      />
                    </td>
                    <td className="px-3 py-2 text-text-secondary font-mono text-[11px]">
                      {s.model ?? "\u2014"}
                    </td>
                    <td className="px-3 py-2 text-text-secondary whitespace-nowrap">
                      {new Date(s.started_at).toLocaleString(undefined, {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </td>
                    <td className="px-3 py-2 text-text-secondary">
                      {formatDuration(s.duration_s)}
                    </td>
                    <td className="px-3 py-2 text-text-secondary font-mono">
                      {formatTokens(s.tokens_used)}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={cn(
                          "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium",
                          s.state === "active" && "text-status-active",
                          s.state === "idle" && "text-status-idle",
                          s.state === "stale" && "text-status-stale",
                          s.state === "closed" && "text-text-muted",
                          s.state === "lost" && "text-status-lost"
                        )}
                      >
                        <span
                          className={cn(
                            "h-1.5 w-1.5 rounded-full",
                            STATE_COLORS[s.state] ?? "bg-text-muted"
                          )}
                        />
                        {s.state}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Empty state */}
            {!loading && sessions.length === 0 && (
              <div className="flex flex-col items-center justify-center py-16 text-text-muted">
                <Search className="h-10 w-10 mb-3 opacity-30" />
                {activeFilters.length > 0 || urlState.q ? (
                  <>
                    <p className="text-sm">No sessions match your filters.</p>
                    <button
                      onClick={clearAllFilters}
                      className="mt-2 text-xs text-primary hover:underline"
                    >
                      Clear filters to see all sessions
                    </button>
                  </>
                ) : (
                  <p className="text-sm">No sessions found</p>
                )}
              </div>
            )}
          </div>

          {/* Pagination */}
          {total > 0 && (
            <div
              className="border-t px-4 py-2"
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
        onClose={() => setSelectedSessionId(null)}
      />
    </div>
  );
}
