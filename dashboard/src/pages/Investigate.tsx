import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { RefreshCw, MessageSquareText } from "lucide-react";
import { fetchBulkEvents, fetchEventFacets } from "@/lib/api";
import type { AgentEvent, EventFacets, EventFacetValue } from "@/lib/types";
import { useFleetStore } from "@/store/fleet";
import { DateRangePicker } from "@/components/ui/DateRangePicker";
import { Pagination } from "@/components/ui/Pagination";
import { SessionDrawer } from "@/components/session/SessionDrawer";
import { EventDetailDrawer } from "@/components/fleet/EventDetailDrawer";
import { ClientTypePill } from "@/components/facets/ClientTypePill";
import { AgentTypeBadge } from "@/components/facets/AgentTypeBadge";
import { FrameworkPill } from "@/components/facets/FrameworkPill";
import { FacetIcon } from "@/components/facets/FacetIcon";
import { EventTypePill } from "@/components/facets/EventTypePill";
import { ProviderLogo } from "@/components/ui/provider-logo";
import { getProvider } from "@/lib/models";
import { isClientType, isAgentType } from "@/lib/agent-identity";
import { TruncatedText } from "@/components/ui/TruncatedText";
import { getEventDetail, truncateSessionId } from "@/lib/events";
import { relativeTime } from "@/lib/agents-format";
import {
  clampInvestigateSidebarWidth,
  persistInvestigateSidebarWidth,
  readPersistedInvestigateSidebarWidth,
} from "@/lib/investigate-sidebar-width";
import { INVESTIGATE_DEFAULT_LOOKBACK_MS } from "@/lib/constants";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// URL state
// ---------------------------------------------------------------------------

const PER_PAGE_OPTIONS = [25, 50, 100];
const DEFAULT_PER_PAGE = 50;

// Delay between the last keystroke in the search box and the URL /
// fetch update. 300 ms is the standard search-as-you-type debounce:
// long enough that a fast typist's intermediate keystrokes don't
// each trigger a server round-trip, short enough that the results
// feel responsive once typing pauses.
const SEARCH_DEBOUNCE_MS = 300;

const AUTO_REFRESH_OPTIONS = [
  { label: "Off", ms: 0 },
  { label: "30s", ms: 30_000 },
  { label: "1m", ms: 60_000 },
  { label: "5m", ms: 300_000 },
];

/** Event-grain URL state for the `/events` page. Every facet
 *  dimension is a repeatable query param; `run` carries the run
 *  drawer's session_id for deep-linking. */
export function parseEventsUrlState(sp: URLSearchParams) {
  const page = Math.max(1, parseInt(sp.get("page") ?? "1", 10) || 1);
  const perPage = PER_PAGE_OPTIONS.includes(
    parseInt(sp.get("per_page") ?? "", 10),
  )
    ? parseInt(sp.get("per_page")!, 10)
    : DEFAULT_PER_PAGE;
  return {
    from:
      sp.get("from") ??
      new Date(Date.now() - INVESTIGATE_DEFAULT_LOOKBACK_MS).toISOString(),
    to: sp.get("to") ?? new Date().toISOString(),
    eventTypes: sp.getAll("event_type"),
    errorTypes: sp.getAll("error_type"),
    models: sp.getAll("model"),
    frameworks: sp.getAll("framework"),
    agentId: sp.get("agent_id") ?? "",
    closeReasons: sp.getAll("close_reason"),
    estimatedVia: sp.getAll("estimated_via"),
    matchedEntryIds: sp.getAll("matched_entry_id"),
    originatingCallContexts: sp.getAll("originating_call_context"),
    mcpServers: sp.getAll("mcp_server"),
    terminalOnly: sp.get("terminal") === "true",
    // `q` backs the top-of-page free-text search bar; the server
    // resolves it via an ILIKE across event_type / model /
    // session_id and the session's agent_name / framework.
    q: sp.get("q") ?? "",
    // `run` deep-links the run drawer; `?session=` is the legacy
    // param, redirected to `?run=` on load (see the component).
    run: sp.get("run") ?? "",
    page,
    perPage,
  };
}

type EventsUrlState = ReturnType<typeof parseEventsUrlState>;

/** The repeatable-array facet fields of EventsUrlState — the set a
 *  multi-value facet group may toggle. */
type MultiValueUrlField =
  | "eventTypes"
  | "errorTypes"
  | "models"
  | "frameworks"
  | "closeReasons"
  | "estimatedVia"
  | "matchedEntryIds"
  | "originatingCallContexts"
  | "mcpServers";

export function buildEventsUrlParams(s: EventsUrlState): URLSearchParams {
  const p = new URLSearchParams();
  if (s.from) p.set("from", s.from);
  if (s.to) p.set("to", s.to);
  for (const v of s.eventTypes) p.append("event_type", v);
  for (const v of s.errorTypes) p.append("error_type", v);
  for (const v of s.models) p.append("model", v);
  for (const v of s.frameworks) p.append("framework", v);
  if (s.agentId) p.set("agent_id", s.agentId);
  for (const v of s.closeReasons) p.append("close_reason", v);
  for (const v of s.estimatedVia) p.append("estimated_via", v);
  for (const v of s.matchedEntryIds) p.append("matched_entry_id", v);
  for (const v of s.originatingCallContexts)
    p.append("originating_call_context", v);
  for (const v of s.mcpServers) p.append("mcp_server", v);
  if (s.terminalOnly) p.set("terminal", "true");
  if (s.q) p.set("q", s.q);
  if (s.run) p.set("run", s.run);
  if (s.page > 1) p.set("page", String(s.page));
  if (s.perPage !== DEFAULT_PER_PAGE) p.set("per_page", String(s.perPage));
  return p;
}

// ---------------------------------------------------------------------------
// Facet sidebar configuration
// ---------------------------------------------------------------------------

// Policy-enforcement event types. The EVENT TYPE facet excludes
// these; the POLICY facet shows only these. Both write to the same
// `event_type` filter dimension — the split is display-only.
const POLICY_EVENT_TYPES = new Set<string>([
  "policy_warn",
  "policy_degrade",
  "policy_block",
  "policy_mcp_warn",
  "policy_mcp_block",
  "mcp_server_name_changed",
  "mcp_policy_user_remembered",
]);

// A facet group: which URL-state key it filters and how the chip
// values are sourced from the server-computed EventFacets.
interface FacetGroupSpec {
  key: string;
  label: string;
  /** The EventsUrlState array field this group toggles. */
  urlField: keyof EventsUrlState;
}

const FACET_GROUPS: FacetGroupSpec[] = [
  { key: "agent_id", label: "AGENT", urlField: "agentId" },
  { key: "event_type", label: "EVENT TYPE", urlField: "eventTypes" },
  { key: "policy_event_type", label: "POLICY", urlField: "eventTypes" },
  { key: "error_type", label: "ERROR TYPE", urlField: "errorTypes" },
  { key: "framework", label: "FRAMEWORK", urlField: "frameworks" },
  { key: "model", label: "MODEL", urlField: "models" },
  { key: "close_reason", label: "CLOSE REASON", urlField: "closeReasons" },
  { key: "estimated_via", label: "ESTIMATED VIA", urlField: "estimatedVia" },
  {
    key: "matched_entry_id",
    label: "MATCHED ENTRY",
    urlField: "matchedEntryIds",
  },
  {
    key: "originating_call_context",
    label: "ORIGINATING CALL",
    urlField: "originatingCallContexts",
  },
  { key: "mcp_server", label: "MCP SERVER", urlField: "mcpServers" },
  { key: "terminal", label: "TERMINAL", urlField: "terminalOnly" },
];

const FACET_TOP_N = 10;

// ---------------------------------------------------------------------------
// Status chip
// ---------------------------------------------------------------------------

function eventStatus(event: AgentEvent): {
  label: string;
  color: string;
} | null {
  if (event.event_type === "llm_error" || event.payload?.error) {
    return { label: "error", color: "var(--status-lost)" };
  }
  if (POLICY_EVENT_TYPES.has(event.event_type)) {
    return { label: "policy", color: "var(--event-warn)" };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Investigate() {
  const [searchParams, setSearchParams] = useSearchParams();
  const urlState = useMemo(
    () => parseEventsUrlState(searchParams),
    [searchParams],
  );

  // Fleet roster — resolves the AGENT facet's agent_id values to
  // display names + client_type pills.
  const rawFleetAgents = useFleetStore((s) => s.agents);
  const fleetAgents = useMemo(() => rawFleetAgents ?? [], [rawFleetAgents]);
  const fleetLoad = useFleetStore((s) => s.load);
  useEffect(() => {
    if (fleetAgents.length === 0) void fleetLoad();
    // Run-once on mount; the roster does not refresh under the
    // Events page (the Fleet page owns live roster refresh).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const agentLabels = useMemo(() => {
    const m = new Map<
      string,
      { name: string; clientType?: string; agentType?: string }
    >();
    for (const a of fleetAgents) {
      m.set(a.agent_id, {
        name: a.agent_name,
        clientType: a.client_type,
        agentType: a.agent_type,
      });
    }
    return m;
  }, [fleetAgents]);

  // Core data state.
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [facets, setFacets] = useState<EventFacets | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  // Refresh state.
  const [autoRefreshMs, setAutoRefreshMs] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const autoRefreshRef = useRef<ReturnType<typeof setInterval>>();

  // Resizable left sidebar — pointer-event drag, localStorage
  // round-trip. Lifted verbatim from the session-grain page so the
  // resize UX is byte-identical across the rework.
  const [sidebarWidth, setSidebarWidth] = useState<number>(() =>
    readPersistedInvestigateSidebarWidth(
      typeof window !== "undefined" ? window.innerWidth : 0,
    ),
  );
  const sidebarWidthRef = useRef(sidebarWidth);
  useEffect(() => {
    sidebarWidthRef.current = sidebarWidth;
  }, [sidebarWidth]);
  const handleSidebarResizeStart = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = sidebarWidthRef.current;
      const onMove = (ev: PointerEvent) => {
        const delta = ev.clientX - startX;
        setSidebarWidth(
          clampInvestigateSidebarWidth(startWidth + delta, window.innerWidth),
        );
      };
      const onUp = () => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.removeEventListener("pointercancel", onUp);
        persistInvestigateSidebarWidth(sidebarWidthRef.current);
      };
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
      document.addEventListener("pointercancel", onUp);
    },
    [],
  );

  // Drawer state. `selectedEvent` drives the event detail drawer
  // (transient, row click). `run` drives the run drawer and is
  // URL-backed so it deep-links.
  const [selectedEvent, setSelectedEvent] = useState<AgentEvent | null>(null);

  // Search box — local input state so typing stays instant; the URL
  // `q` filter is updated on a SEARCH_DEBOUNCE_MS trailing debounce.
  // Seeded from the URL so a `?q=` deep-link / reload pre-fills the
  // box.
  const [searchInput, setSearchInput] = useState(urlState.q);

  const abortRef = useRef<AbortController>();

  // Legacy `?session=` → `?run=` redirect. A bookmark from the
  // session-grain page keeps resolving.
  useEffect(() => {
    const legacy = searchParams.get("session");
    if (legacy && !searchParams.get("run")) {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete("session");
          next.set("run", legacy);
          return next;
        },
        { replace: true },
      );
    }
  }, [searchParams, setSearchParams]);

  // -----------------------------------------------------------------------
  // Data fetch
  // -----------------------------------------------------------------------

  const doFetch = useCallback(async (state: EventsUrlState) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(false);

    const filterParams = {
      from: state.from,
      to: state.to,
      event_types: state.eventTypes,
      error_types: state.errorTypes,
      models: state.models,
      frameworks: state.frameworks,
      agent_id: state.agentId || undefined,
      close_reasons: state.closeReasons,
      estimated_via: state.estimatedVia,
      matched_entry_ids: state.matchedEntryIds,
      originating_call_contexts: state.originatingCallContexts,
      mcp_servers: state.mcpServers,
      terminal: state.terminalOnly ? true : undefined,
      q: state.q || undefined,
    };

    try {
      const [rows, facetCounts] = await Promise.all([
        fetchBulkEvents(
          {
            ...filterParams,
            order: "desc",
            limit: state.perPage,
            offset: (state.page - 1) * state.perPage,
          },
          controller.signal,
        ),
        fetchEventFacets(filterParams, controller.signal),
      ]);
      setEvents(rows.events);
      setTotal(rows.total);
      setFacets(facetCounts);
      setLoading(false);
    } catch {
      if (controller.signal.aborted) return;
      setError(true);
      setLoading(false);
    }
  }, []);

  // Fetch on every URL-state change.
  useEffect(() => {
    void doFetch(urlState);
    return () => abortRef.current?.abort();
  }, [doFetch, urlState]);

  // Auto-refresh.
  useEffect(() => {
    if (autoRefreshMs <= 0) return;
    autoRefreshRef.current = setInterval(() => {
      void doFetch(urlState);
    }, autoRefreshMs);
    return () => clearInterval(autoRefreshRef.current);
  }, [autoRefreshMs, doFetch, urlState]);

  // -----------------------------------------------------------------------
  // URL mutation helpers
  // -----------------------------------------------------------------------

  const patchUrl = useCallback(
    (patch: Partial<EventsUrlState>) => {
      setSearchParams(
        buildEventsUrlParams({ ...urlState, page: 1, ...patch }),
      );
    },
    [urlState, setSearchParams],
  );

  // Debounce the search box: SEARCH_DEBOUNCE_MS after the last
  // keystroke, push the trimmed value into the URL `q` state (which
  // re-triggers doFetch). Skip the write when the debounced value
  // already equals the URL state so an unrelated URL change (a facet
  // click, a page nav) doesn't bounce back through here.
  useEffect(() => {
    if (searchInput === urlState.q) return;
    const t = setTimeout(() => {
      patchUrl({ q: searchInput });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [searchInput, urlState.q, patchUrl]);

  // Keep the box in sync when `q` changes from outside the box —
  // an Escape clear, a `?q=` deep-link, or browser back/forward.
  // The guard skips the no-op write on the common path where the
  // box itself drove the change (debounce → patchUrl → urlState.q),
  // so a fast typist does not pay an extra render per keystroke.
  useEffect(() => {
    if (urlState.q !== searchInput) setSearchInput(urlState.q);
    // searchInput intentionally omitted — this effect reacts to
    // outside-driven `q` changes, not to the box's own typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlState.q]);

  // Toggle a value in a multi-select facet dimension.
  const toggleFacet = useCallback(
    (groupKey: string, value: string) => {
      if (groupKey === "terminal") {
        patchUrl({ terminalOnly: !urlState.terminalOnly });
        return;
      }
      if (groupKey === "agent_id") {
        patchUrl({ agentId: urlState.agentId === value ? "" : value });
        return;
      }
      // event_type / policy_event_type both toggle the eventTypes
      // list; every other group toggles its own array field.
      const field = facetUrlField(groupKey);
      const current = urlState[field];
      const next = current.includes(value)
        ? current.filter((v) => v !== value)
        : [...current, value];
      patchUrl({ [field]: next } as Partial<EventsUrlState>);
    },
    [urlState, patchUrl],
  );

  const openRunDrawer = useCallback(
    (sessionId: string) => patchUrl({ run: sessionId }),
    [patchUrl],
  );
  const closeRunDrawer = useCallback(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("run");
        return next;
      },
      { replace: true },
    );
  }, [setSearchParams]);

  const dateRange = useMemo(
    () => ({ from: new Date(urlState.from), to: new Date(urlState.to) }),
    [urlState.from, urlState.to],
  );
  const handleDateChange = useCallback(
    (range: { from: Date; to: Date }) => {
      patchUrl({ from: range.from.toISOString(), to: range.to.toISOString() });
    },
    [patchUrl],
  );

  // -----------------------------------------------------------------------
  // Derived: the rendered facet groups.
  // -----------------------------------------------------------------------

  const facetGroups = useMemo(() => {
    if (!facets) return [];
    return FACET_GROUPS.map((spec) => {
      let values: EventFacetValue[];
      if (spec.key === "event_type") {
        values = facets.event_type.filter(
          (v) => !POLICY_EVENT_TYPES.has(v.value),
        );
      } else if (spec.key === "policy_event_type") {
        values = facets.event_type.filter((v) =>
          POLICY_EVENT_TYPES.has(v.value),
        );
      } else {
        values = facetDimension(facets, spec.key);
      }
      return { spec, values };
    }).filter((g) => g.values.length > 0);
  }, [facets]);

  const activeFacetValue = useCallback(
    (groupKey: string, value: string): boolean => {
      if (groupKey === "terminal") return urlState.terminalOnly;
      if (groupKey === "agent_id") return urlState.agentId === value;
      if (groupKey === "event_type" || groupKey === "policy_event_type") {
        return urlState.eventTypes.includes(value);
      }
      return urlState[facetUrlField(groupKey)].includes(value);
    },
    [urlState],
  );

  return (
    <div
      className="flex h-full flex-col overflow-hidden"
      style={{ background: "var(--bg)" }}
      data-testid="events-page"
    >
      {/* Top bar */}
      <div
        className="flex items-center gap-3 border-b px-4 py-2.5"
        style={{ borderColor: "var(--border)" }}
      >
        <div className="flex-1">
          <input
            type="text"
            data-testid="events-search-input"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => {
              // Escape clears both the box and the URL `q` filter.
              if (e.key === "Escape") {
                e.preventDefault();
                setSearchInput("");
                patchUrl({ q: "" });
              }
            }}
            placeholder="Search events…"
            aria-label="Search events"
            className="h-7 w-full rounded-md border px-2 focus:outline-none focus:ring-1 focus:ring-primary"
            style={{
              fontSize: 12,
              borderColor: "var(--border)",
              background: "var(--surface)",
              color: "var(--text-secondary)",
            }}
          />
        </div>
        <div className="shrink-0">
          <DateRangePicker
            value={dateRange}
            onChange={handleDateChange}
            defaultPreset="last7days"
          />
        </div>
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
            data-testid="events-refresh"
            className="flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 font-medium transition-colors duration-150 hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-70"
            style={{
              fontSize: 12,
              borderColor: "var(--border)",
              color: "var(--text-muted)",
            }}
            aria-label="Refresh"
          >
            <RefreshCw
              className={cn(
                "h-3.5 w-3.5",
                isRefreshing && "animate-[spin_600ms_linear_infinite]",
              )}
              style={{ color: isRefreshing ? "var(--accent)" : undefined }}
            />
            Refresh
          </button>
          <div className="flex items-center gap-1.5">
            <span
              className="whitespace-nowrap"
              style={{ fontSize: 12, color: "var(--text-muted)" }}
            >
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
              aria-label="Auto-refresh interval"
            >
              {AUTO_REFRESH_OPTIONS.map((opt) => (
                <option key={opt.ms} value={opt.ms}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Body: sidebar + table */}
      <div className="flex flex-1 overflow-hidden">
        {/* Facet sidebar */}
        <div
          className="relative flex-shrink-0 overflow-y-auto"
          style={{
            width: sidebarWidth,
            borderRight: "1px solid var(--border-subtle)",
          }}
          data-testid="investigate-sidebar"
        >
          {facetGroups.map(({ spec, values }, gi) => (
            <div key={spec.key} data-testid={`events-facet-${spec.key}`}>
              <div
                className="font-semibold uppercase"
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  letterSpacing: "0.08em",
                  color: "var(--text-muted)",
                  padding:
                    gi === 0 ? "12px 12px 6px 12px" : "16px 12px 6px 12px",
                }}
              >
                {spec.label}
              </div>
              {values.slice(0, FACET_TOP_N).map((v) => {
                const active = activeFacetValue(spec.key, v.value);
                const agentLabel =
                  spec.key === "agent_id"
                    ? agentLabels.get(v.value)
                    : undefined;
                return (
                  <button
                    key={v.value}
                    data-testid={`events-facet-pill-${spec.key}-${v.value}`}
                    data-active={active ? "true" : undefined}
                    aria-pressed={active}
                    onClick={() => toggleFacet(spec.key, v.value)}
                    className="flex w-full items-center cursor-pointer transition-colors duration-150"
                    style={{
                      fontSize: 13,
                      padding: "4px 12px",
                      borderRadius: 4,
                      color: active ? "var(--primary)" : "var(--text)",
                      background: active
                        ? "color-mix(in srgb, var(--primary) 15%, transparent)"
                        : undefined,
                    }}
                    onMouseEnter={(e) => {
                      if (!active)
                        e.currentTarget.style.background =
                          "var(--bg-elevated)";
                    }}
                    onMouseLeave={(e) => {
                      if (!active) e.currentTarget.style.background = "";
                    }}
                  >
                    <span
                      className="flex items-center min-w-0 flex-1"
                      style={{ gap: 8 }}
                    >
                      {spec.key === "framework" ? (
                        // FRAMEWORK facet — the value renders as a
                        // FrameworkPill, the same chrome the event
                        // row's MODEL cell carries.
                        <FrameworkPill
                          framework={v.value}
                          testId={`events-facet-framework-pill-${v.value}`}
                        />
                      ) : (
                        <>
                          {/* Per-dimension icon: provider logo for
                              MODEL, chroma dot for POLICY, category
                              glyph for ERROR_TYPE / MCP_SERVER /
                              CLOSE_REASON / ESTIMATED_VIA; nothing
                              for dimensions with no icon treatment. */}
                          <FacetIcon
                            groupKey={spec.key}
                            value={v.value}
                            testId={`events-facet-icon-${spec.key}-${v.value}`}
                          />
                          <TruncatedText
                            text={agentLabel?.name ?? v.value}
                          />
                          {/* AGENT facet — the row's identity chrome:
                              client_type pill + agent_type badge. */}
                          {agentLabel?.clientType &&
                            isClientType(agentLabel.clientType) && (
                              <ClientTypePill
                                clientType={agentLabel.clientType}
                                size="compact"
                                testId={`events-facet-client-type-${v.value}`}
                              />
                            )}
                          {agentLabel?.agentType &&
                            isAgentType(agentLabel.agentType) && (
                              <AgentTypeBadge
                                agentType={agentLabel.agentType}
                                testId={`events-facet-agent-type-${v.value}`}
                              />
                            )}
                        </>
                      )}
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
          {facetGroups.length === 0 && !loading && (
            <div
              style={{
                fontSize: 12,
                color: "var(--text-muted)",
                padding: "16px 12px",
                textAlign: "center",
              }}
            >
              No facets available
            </div>
          )}
          <div
            data-testid="investigate-sidebar-resize-handle"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize Events sidebar"
            style={{
              position: "absolute",
              right: 0,
              top: 0,
              bottom: 0,
              width: 6,
              cursor: "col-resize",
              zIndex: 10,
              background: "transparent",
              transition: "background 0.1s",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "var(--accent)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent";
            }}
            onPointerDown={handleSidebarResizeStart}
            onTouchStart={(e) => e.preventDefault()}
          />
        </div>

        {/* Event table */}
        <div className="flex flex-1 flex-col overflow-hidden">
          <div className="flex-1 overflow-auto">
            <table
              data-testid="events-table"
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 13,
              }}
            >
              <thead>
                <tr
                  style={{
                    borderBottom: "1px solid var(--border)",
                    background: "var(--surface)",
                  }}
                >
                  {["Time", "Agent", "Run", "Type", "Model", "Detail", ""].map(
                    (h, i) => (
                      <th
                        key={h || `c${i}`}
                        scope="col"
                        style={{
                          textAlign: "left",
                          padding: "8px 12px",
                          fontSize: 10,
                          fontWeight: 600,
                          letterSpacing: "0.06em",
                          textTransform: "uppercase",
                          color: "var(--text-secondary)",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {h}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <EventRow
                    key={event.id}
                    event={event}
                    onRowClick={setSelectedEvent}
                    onRunClick={openRunDrawer}
                  />
                ))}
                {!error && !loading && events.length === 0 && (
                  <tr data-testid="events-table-empty">
                    <td
                      colSpan={7}
                      style={{
                        textAlign: "center",
                        padding: "32px 12px",
                        color: "var(--text-muted)",
                      }}
                    >
                      No events match the active filters.
                    </td>
                  </tr>
                )}
                {!error && loading && events.length === 0 && (
                  <tr data-testid="events-table-loading">
                    <td
                      colSpan={7}
                      style={{
                        textAlign: "center",
                        padding: "32px 12px",
                        color: "var(--text-muted)",
                      }}
                    >
                      Loading events…
                    </td>
                  </tr>
                )}
                {error && (
                  <tr data-testid="events-table-error">
                    <td
                      colSpan={7}
                      style={{
                        textAlign: "center",
                        padding: "32px 12px",
                        color: "var(--danger)",
                      }}
                    >
                      Could not load events.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <Pagination
            total={total}
            offset={(urlState.page - 1) * urlState.perPage}
            limit={urlState.perPage}
            entityLabel="events"
            onPageChange={(newOffset) =>
              setSearchParams(
                buildEventsUrlParams({
                  ...urlState,
                  page: Math.floor(newOffset / urlState.perPage) + 1,
                }),
              )
            }
            onLimitChange={(newLimit) =>
              setSearchParams(
                buildEventsUrlParams({
                  ...urlState,
                  perPage: newLimit,
                  page: 1,
                }),
              )
            }
          />
        </div>
      </div>

      {/* Event detail drawer — row click. "View entire run →"
          closes it and opens the run drawer for the event's run. */}
      <EventDetailDrawer
        event={selectedEvent}
        onClose={() => setSelectedEvent(null)}
        onViewRun={(sessionId) => {
          setSelectedEvent(null);
          openRunDrawer(sessionId);
        }}
      />

      {/* Run drawer — run-badge click / `?run=` deep-link. */}
      <SessionDrawer
        sessionId={urlState.run || null}
        onClose={closeRunDrawer}
        onSwitchSession={(id) => openRunDrawer(id)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Event row
// ---------------------------------------------------------------------------

function EventRow({
  event,
  onRowClick,
  onRunClick,
}: {
  event: AgentEvent;
  onRowClick: (e: AgentEvent) => void;
  onRunClick: (sessionId: string) => void;
}) {
  const status = eventStatus(event);
  const detail = getEventDetail(event);
  return (
    <tr
      data-testid="events-row"
      data-event-id={event.id}
      tabIndex={0}
      aria-label={`${event.event_type} event — open detail`}
      onClick={() => onRowClick(event)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onRowClick(event);
        }
      }}
      style={{
        borderBottom: "1px solid var(--border-subtle)",
        cursor: "pointer",
      }}
    >
      <td
        style={{
          padding: "7px 12px",
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          color: "var(--text-muted)",
          whiteSpace: "nowrap",
        }}
        title={new Date(event.occurred_at).toLocaleString()}
      >
        {relativeTime(event.occurred_at)}
      </td>
      <td style={{ padding: "7px 12px", maxWidth: 280 }}>
        {/* AGENT cell — "who fired this": agent name plus the
            session-scoped identity chrome (client_type pill +
            agent_type badge), matching the Fleet swimlane label
            strip. Both apply to an event of any type. */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            minWidth: 0,
          }}
        >
          <TruncatedText
            text={event.flavor}
            style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}
          />
          {isClientType(event.client_type) && (
            <ClientTypePill
              clientType={event.client_type}
              size="compact"
              testId="events-row-client-pill"
            />
          )}
          {isAgentType(event.agent_type) && (
            <AgentTypeBadge
              agentType={event.agent_type}
              testId="events-row-agent-type"
            />
          )}
        </div>
      </td>
      <td style={{ padding: "7px 12px" }}>
        <button
          type="button"
          data-testid="events-row-run-badge"
          onClick={(e) => {
            e.stopPropagation();
            onRunClick(event.session_id);
          }}
          aria-label={`Open run ${event.session_id}`}
          title={`Open run ${event.session_id}`}
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            padding: "1px 5px",
            borderRadius: 3,
            border: "1px solid var(--border)",
            background: "transparent",
            color: "var(--text-secondary)",
            cursor: "pointer",
          }}
        >
          {truncateSessionId(event.session_id)}
        </button>
      </td>
      <td style={{ padding: "7px 12px", whiteSpace: "nowrap" }}>
        {/* Shared canonical event-type pill — byte-identical to the
            run drawer and the agent drawer Events tab. */}
        <EventTypePill eventType={event.event_type} />
      </td>
      <td
        style={{
          padding: "7px 12px",
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          color: "var(--text-muted)",
          whiteSpace: "nowrap",
        }}
      >
        {/* MODEL cell — "how it ran": provider logo + model + the
            framework pill. The cluster only carries meaning for LLM
            calls (pre/post_call, embeddings); non-LLM events carry no
            model, so the cell stays a bare em-dash. */}
        {event.model ? (
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span
              data-testid="events-row-provider-logo"
              style={{ display: "inline-flex" }}
            >
              <ProviderLogo
                provider={getProvider(event.model)}
                size={13}
                title=""
              />
            </span>
            <span>{event.model}</span>
            <FrameworkPill
              framework={event.framework}
              testId="events-row-framework"
            />
          </span>
        ) : (
          "—"
        )}
      </td>
      <td
        style={{
          padding: "7px 12px",
          color: "var(--text)",
          maxWidth: 0,
          // overflow:hidden is what makes the maxWidth:0 clamp bite —
          // without it the inner flex row can push the cell wider
          // than its table-allotted width. The text span owns the
          // ellipsis; this keeps the cell itself within bounds.
          overflow: "hidden",
        }}
      >
        {/* DETAIL cell — the humanized event summary, with a trailing
            prompt-capture indicator. The indicator is a row-level
            "content is available to drill into" affordance: it shows
            for any has_content event regardless of type (LLM prompts,
            MCP tool_input, …), so it lives here rather than in the
            LLM-only MODEL cell. */}
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span
            style={{
              flex: 1,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={detail}
          >
            {detail}
          </span>
          {event.has_content && (
            <MessageSquareText
              data-testid="events-row-capture-indicator"
              size={13}
              role="img"
              aria-label="Prompt content captured"
              style={{ color: "var(--text-muted)", flexShrink: 0 }}
            >
              <title>Prompt content captured</title>
            </MessageSquareText>
          )}
        </div>
      </td>
      <td style={{ padding: "7px 12px", textAlign: "right" }}>
        {status && (
          <span
            data-testid="events-row-status"
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 9,
              padding: "1px 5px",
              borderRadius: 3,
              border: `1px solid ${status.color}`,
              color: status.color,
            }}
          >
            {status.label}
          </span>
        )}
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Facet helpers
// ---------------------------------------------------------------------------

function facetDimension(facets: EventFacets, key: string): EventFacetValue[] {
  switch (key) {
    case "agent_id":
      return facets.agent_id;
    case "error_type":
      return facets.error_type;
    case "framework":
      return facets.framework;
    case "model":
      return facets.model;
    case "close_reason":
      return facets.close_reason;
    case "estimated_via":
      return facets.estimated_via;
    case "matched_entry_id":
      return facets.matched_entry_id;
    case "originating_call_context":
      return facets.originating_call_context;
    case "mcp_server":
      return facets.mcp_server;
    case "terminal":
      return facets.terminal;
    default:
      return [];
  }
}

// facetUrlField maps a facet group key to the EventsUrlState array
// field it toggles. event_type and policy_event_type both write the
// eventTypes list — the POLICY/EVENT TYPE split is display-only.
function facetUrlField(key: string): MultiValueUrlField {
  switch (key) {
    case "event_type":
    case "policy_event_type":
      return "eventTypes";
    case "error_type":
      return "errorTypes";
    case "framework":
      return "frameworks";
    case "model":
      return "models";
    case "close_reason":
      return "closeReasons";
    case "estimated_via":
      return "estimatedVia";
    case "matched_entry_id":
      return "matchedEntryIds";
    case "originating_call_context":
      return "originatingCallContexts";
    case "mcp_server":
      return "mcpServers";
    default:
      return "eventTypes";
  }
}
