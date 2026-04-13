import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { Search, RefreshCw, X, LayoutGrid, GitBranch, Bot, Server, Camera } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { fetchSessions, type SessionsParams } from "@/lib/api";
import type { SessionListItem, SessionState } from "@/lib/types";
import { DateRangePicker, type DateRangeWithPreset } from "@/components/ui/DateRangePicker";
import { Pagination } from "@/components/ui/Pagination";
import { SessionDrawer } from "@/components/session/SessionDrawer";
import { OSIcon } from "@/components/ui/OSIcon";
import { OrchestrationIcon } from "@/components/ui/OrchestrationIcon";
import { ProviderLogo } from "@/components/ui/provider-logo";
import { getProvider } from "@/lib/models";
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

const COL_WIDTHS = {
  flavor: "16%",
  hostname: "13%",
  os: "4%",
  orch: "4%",
  model: "15%",
  started: "14%",
  duration: "8%",
  tokens: "9%",
  capture: "5%",
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
// Facet value icons
// ---------------------------------------------------------------------------

function FacetIcon({ groupKey, value }: { groupKey: string; value: string }) {
  if (groupKey === "state") {
    return (
      <span
        className={cn("inline-block rounded-full shrink-0", STATE_COLORS[value] ?? "bg-text-muted")}
        style={{ width: 5, height: 5 }}
      />
    );
  }
  if (groupKey === "os") {
    return <OSIcon os={value} size={12} />;
  }
  if (groupKey === "model") {
    const provider = getProvider(value);
    if (provider !== "unknown") {
      return <ProviderLogo provider={provider} size={12} />;
    }
    return null;
  }
  if (groupKey === "flavor") {
    return <Bot size={12} style={{ color: "var(--text-muted)", flexShrink: 0 }} />;
  }
  if (groupKey === "git_branch") {
    return <GitBranch size={12} style={{ color: "var(--text-muted)", flexShrink: 0 }} />;
  }
  if (groupKey === "hostname") {
    return <Server size={12} style={{ color: "var(--text-muted)", flexShrink: 0 }} />;
  }
  return null;
}

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
  const searchRef = useRef<HTMLInputElement>(null);

  // Refresh state
  const [lastUpdated, setLastUpdated] = useState(Date.now());
  const [lastUpdatedLabel, setLastUpdatedLabel] = useState("just now");
  const [autoRefreshMs, setAutoRefreshMs] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
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
            placeholder="Search flavor, model, hostname, git branch..."
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
            <div key={group.key}>
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
                  (group.key === "model" && urlState.model === v.value);
                return (
                  <button
                    key={v.value}
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
                      <span className="truncate">{v.value}</span>
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
                  className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs"
                  style={{
                    background: "var(--primary-glow)",
                    color: "var(--primary)",
                  }}
                >
                  search:{urlState.q}
                  <button
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
                  className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs"
                  style={{
                    background: "var(--primary-glow)",
                    color: "var(--primary)",
                  }}
                >
                  {f.label}
                  <button onClick={f.onRemove} className="hover:opacity-70 transition-opacity duration-150">
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
                    className="group cursor-pointer uppercase transition-colors duration-150 hover:text-text"
                    style={{ color: "var(--text-muted)", fontSize: 10, fontWeight: 600, letterSpacing: "0.07em", padding: "0 12px", width: COL_WIDTHS.flavor }}
                    onClick={() => handleSort("flavor")}
                  >
                    Flavor{sortArrow("flavor")}
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
                    className="uppercase text-center"
                    style={{ color: "var(--text-muted)", fontSize: 10, fontWeight: 600, letterSpacing: "0.07em", padding: "0 4px", width: COL_WIDTHS.capture }}
                    aria-label="Prompt capture"
                  >
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span style={{ display: "inline-block", lineHeight: 0, verticalAlign: "middle" }}>
                            <Camera size={12} style={{ color: "var(--text-muted)" }} />
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>Prompt capture</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
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
                    onClick={() => setSelectedSessionId(s.session_id)}
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
                    <td className="truncate" style={{ padding: "0 12px", width: COL_WIDTHS.flavor, fontSize: 13, fontWeight: 500, color: "var(--text)" }}>{s.flavor}</td>
                    <td className="truncate" style={{ padding: "0 12px", width: COL_WIDTHS.hostname, fontSize: 12, color: "var(--text-secondary)" }}>
                      {(s.context?.hostname as string) ?? s.host ?? "\u2014"}
                    </td>
                    <td style={{ padding: "0 8px", width: COL_WIDTHS.os, textAlign: "center" }}>
                      <OSIcon os={(s.context?.os as string) ?? ""} size={16} />
                    </td>
                    <td style={{ padding: "0 8px", width: COL_WIDTHS.orch, textAlign: "center" }}>
                      <OrchestrationIcon
                        orchestration={(s.context?.orchestration as string) ?? ""}
                        size={16}
                      />
                    </td>
                    <td className="truncate" style={{ padding: "0 12px", width: COL_WIDTHS.model, fontSize: 12, color: "var(--text-secondary)" }}>
                      {s.model ? (
                        <span className="inline-flex items-center gap-1.5 min-w-0">
                          <ProviderLogo provider={getProvider(s.model)} size={12} />
                          <span className="truncate">{s.model}</span>
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
                    <td style={{ padding: "0 4px", width: COL_WIDTHS.capture, textAlign: "center" }}>
                      {s.capture_enabled && (
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span style={{ display: "inline-block", lineHeight: 0 }}>
                                <Camera size={14} style={{ color: "var(--accent)" }} />
                              </span>
                            </TooltipTrigger>
                            <TooltipContent>Prompt capture enabled</TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      )}
                    </td>
                    <td style={{ padding: "0 12px", width: COL_WIDTHS.state }}>
                      <StateBadge state={s.state} />
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
        onClose={() => setSelectedSessionId(null)}
      />
    </div>
  );
}
