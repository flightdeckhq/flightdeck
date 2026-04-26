import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { useFleet } from "@/hooks/useFleet";
import { useFleetStore } from "@/store/fleet";
import { useHistoricalEvents } from "@/hooks/useHistoricalEvents";
import { FleetPanel } from "@/components/fleet/FleetPanel";
import { EventFilterBar } from "@/components/fleet/EventFilterBar";
import { LiveFeed } from "@/components/fleet/LiveFeed";
import { EventDetailDrawer } from "@/components/fleet/EventDetailDrawer";
import { Timeline } from "@/components/timeline/Timeline";
import {
  AgentTable,
  isAgentTableSortColumn,
  type AgentTableSortColumn,
  type AgentTableSortDirection,
} from "@/components/fleet/AgentTable";
import { SessionDrawer } from "@/components/session/SessionDrawer";
import type {
  AgentEvent,
  AgentSummary,
  FeedEvent,
  FlavorSummary,
  Session,
} from "@/lib/types";
import { bucketFor, sortByActivityBucket } from "@/lib/fleet-ordering";
import type { ContextFilters } from "@/types/context";
import {
  FEED_MAX_EVENTS,
  PAUSE_QUEUE_MAX_EVENTS,
  SWIM_FADE_WIDTH_PX,
} from "@/lib/constants";
import { useLeftPanelWidth } from "@/lib/leftPanelWidth";
import { useSwimlaneScroll } from "@/lib/useSwimlaneScroll";
import { eventsCache } from "@/hooks/useSessionEvents";

/**
 * v0.4.0 Phase 1 (D115): Fleet view modes. ``swimlane`` is the
 * default live-activity view (one row per agent on the time axis);
 * ``table`` is the paginated agent-level alternative that matches
 * the Investigate page's session-table styling. URL-driven via the
 * ``view`` query param so refreshes and shared links preserve the
 * user's choice.
 */
export type FleetView = "swimlane" | "table";
const DEFAULT_VIEW: FleetView = "swimlane";

function parseViewParam(raw: string | null): FleetView {
  return raw === "table" ? "table" : DEFAULT_VIEW;
}

/**
 * Timeline view mode. The "bars" stacked-histogram variant was
 * removed in the April 2026 cleanup -- at the fixed 900px canvas
 * width it never conveyed meaningful information compared to the
 * swimlane's per-session event dots. The type alias is kept as a
 * single literal so downstream components don't need to be
 * retyped to `"swimlane"` everywhere at once.
 */
export type ViewMode = "swimlane";
export type TimeRange = "1m" | "5m" | "15m" | "30m" | "1h";

const TIME_RANGES: TimeRange[] = ["1m", "5m", "15m", "30m", "1h"];

const TIME_RANGE_MS: Record<TimeRange, number> = {
  "1m": 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "30m": 30 * 60_000,
  "1h": 60 * 60_000,
};

/**
 * Sort flavors (swimlane-shaped rows) into the three activity buckets
 * defined in ``lib/fleet-ordering.ts``: LIVE (<15s), RECENT (15s–5m),
 * IDLE (>5m or never). Within LIVE / RECENT the order is
 * ``enteredBucketAt`` DESC so newly-arrived rows sit at the top of
 * their bucket and existing rows stay put under event bursts. IDLE is
 * alphabetical by agent_name.
 *
 * Exported for unit tests; callers inside the component should use
 * the ``useFleetStore`` ``enteredBucketAt`` map so the within-bucket
 * stability invariant holds across renders.
 */
export function sortFlavorsByActivity(
  flavors: FlavorSummary[],
  now: number = Date.now(),
  enteredBucketAt: Map<string, number> = new Map(),
): FlavorSummary[] {
  return sortByActivityBucket(
    flavors,
    (f) => ({
      id: f.agent_id ?? f.flavor,
      lastSeenAt: f.last_seen_at,
      displayName: f.agent_name ?? f.flavor,
    }),
    now,
    enteredBucketAt,
  ).map((row) => row.item);
}

/**
 * Sort agents (Fleet table rows) into the same three activity buckets
 * so the table and swimlane agree on row order under live traffic.
 */
export function sortAgentsByActivity(
  agents: AgentSummary[],
  now: number = Date.now(),
  enteredBucketAt: Map<string, number> = new Map(),
): AgentSummary[] {
  return sortByActivityBucket(
    agents,
    (a) => ({
      id: a.agent_id,
      lastSeenAt: a.last_seen_at,
      displayName: a.agent_name,
    }),
    now,
    enteredBucketAt,
  ).map((row) => row.item);
}

/**
 * Bucket assignments for a flavor list, exposed separately from the
 * sort so the Fleet page can render visual separators between buckets
 * without re-running the sort.
 */
export function bucketAssignments(
  flavors: FlavorSummary[],
  now: number = Date.now(),
): Map<string, "live" | "recent" | "idle"> {
  const map = new Map<string, "live" | "recent" | "idle">();
  for (const f of flavors) {
    const key = f.agent_id ?? f.flavor;
    map.set(key, bucketFor(f.last_seen_at, now));
  }
  return map;
}

export function Fleet() {
  // S-SWIM. Horizontal scroll affordances for the swimlane: the
  // hook drives Fleet's main-content div as the H scroll container,
  // landing the user on "now" (rightmost) on mount and exposing
  // canScroll{Left,Right} flags for the fade-overlay rendering
  // below. useLeftPanelWidth tracks the persisted column width so
  // the left-fade overlay sits flush against the sticky agent-name
  // column's right edge -- through Timeline drags too, via the
  // CustomEvent in lib/leftPanelWidth.ts.
  const {
    scrollContainerRef: swimScrollRef,
    canScrollLeft: swimCanScrollLeft,
    canScrollRight: swimCanScrollRight,
    onKeyDown: swimOnKeyDown,
  } = useSwimlaneScroll();
  const leftPanelWidth = useLeftPanelWidth();

  // View toggle (D115). Default swimlane; ``?view=table`` flips the
  // main-area rendering to the paginated AgentTable. Persists in URL
  // query so reloads and shared links keep the user's choice.
  const [searchParams, setSearchParams] = useSearchParams();
  const view: FleetView = parseViewParam(searchParams.get("view"));
  const setView = useCallback(
    (next: FleetView) => {
      const sp = new URLSearchParams(searchParams);
      if (next === DEFAULT_VIEW) {
        sp.delete("view");
      } else {
        sp.set("view", next);
      }
      setSearchParams(sp, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  // AgentTable sort state lives in the URL so reloads and shared
  // links preserve the user's choice, and the Fleet <-> Investigate
  // round-trip keeps the table ordering when a user hits "back".
  // When neither param is present we keep the legacy bucket ordering
  // (LIVE / RECENT / IDLE) which the table renders as divider rows.
  const rawSort = searchParams.get("sort");
  const rawOrder = searchParams.get("order");
  const tableSort: AgentTableSortColumn | null = isAgentTableSortColumn(rawSort)
    ? rawSort
    : null;
  const tableOrder: AgentTableSortDirection =
    rawOrder === "asc" ? "asc" : "desc";
  const handleAgentTableSort = useCallback(
    (column: AgentTableSortColumn) => {
      const sp = new URLSearchParams(searchParams);
      const currentSort = sp.get("sort");
      const currentOrder = sp.get("order");
      if (currentSort === column) {
        // Same column: toggle direction. desc is the default, so a
        // second click flips to asc and a third click clears the
        // explicit sort entirely (back to bucket ordering).
        if (currentOrder === "asc") {
          sp.delete("sort");
          sp.delete("order");
        } else {
          sp.set("sort", column);
          sp.set("order", "asc");
        }
      } else {
        sp.set("sort", column);
        sp.set("order", "desc");
      }
      setSearchParams(sp, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const agents = useFleetStore((s) => s.agents);
  const enteredBucketAt = useFleetStore((s) => s.enteredBucketAt);
  const expandedSessions = useFleetStore((s) => s.expandedSessions);
  const loadExpandedSessions = useFleetStore((s) => s.loadExpandedSessions);
  const fleetTotal = useFleetStore((s) => s.total);
  const fleetPage = useFleetStore((s) => s.page);
  const fleetPerPage = useFleetStore((s) => s.perPage);
  const storeLoad = useFleetStore((s) => s.load);
  const [feedEvents, setFeedEvents] = useState<FeedEvent[]>([]);
  const [pauseQueue, setPauseQueue] = useState<FeedEvent[]>([]);
  const [paused, setPaused] = useState(false);
  const [pausedAt, setPausedAt] = useState<Date | null>(null);
  // Virtual clock for DVR-style catch-up after Resume. Null = live
  // (use wall clock). A non-null value is a ms-epoch that advances at
  // >=1x wall-clock speed until it reaches Date.now(), at which point
  // it snaps back to null and the timeline is "live" again.
  const [virtualNow, setVirtualNow] = useState<number | null>(null);
  const pausedRef = useRef(false);
  const [sessionVersions, setSessionVersions] = useState<Record<string, number>>({});
  // Monotonic counter ensures every FeedEvent has a unique arrivedAt even
  // if multiple events arrive in the same millisecond.
  const arrivalCounter = useRef(0);

  const handleNewEvent = useCallback((event: AgentEvent) => {
    // Inject into eventsCache for swimlane (instant update via version bump)
    const sid = event.session_id;
    const cached = eventsCache.get(sid) ?? [];
    if (!cached.some((e) => e.id === event.id)) {
      eventsCache.set(sid, [...cached, event]);
      setSessionVersions((prev) => ({ ...prev, [sid]: (prev[sid] ?? 0) + 1 }));
    }

    // Stamp arrivedAt NOW — monotonic counter avoids same-millisecond collisions
    arrivalCounter.current += 1;
    const fe: FeedEvent = { arrivedAt: Date.now() + arrivalCounter.current * 0.001, event };

    // Add to live feed — direct setState, no batch timer.
    // React 18 automatic batching handles multiple setState calls in the same tick.
    if (pausedRef.current) {
      setPauseQueue((prev) => {
        if (prev.some((p) => p.event.id === event.id)) return prev;
        const next = [...prev, fe];
        return next.length > PAUSE_QUEUE_MAX_EVENTS ? next.slice(-PAUSE_QUEUE_MAX_EVENTS) : next;
      });
    } else {
      setFeedEvents((prev) =>
        prev.some((p) => p.event.id === event.id)
          ? prev
          : [...prev, fe].slice(-FEED_MAX_EVENTS),
      );
    }
  }, []);

  const { flavors, loading, error } = useFleet(handleNewEvent);
  const contextFacets = useFleetStore((s) => s.contextFacets);
  const {
    selectedSessionId,
    selectSession,
    flavorFilter,
    setFlavorFilter,
  } = useFleetStore();

  // CONTEXT sidebar filters. Empty object = no filters active.
  // sessionMatchesContext below applies these to dim non-matching
  // session rows in the swimlane and feed events.
  const [contextFilters, setContextFilters] = useState<ContextFilters>({});

  const handleContextFilter = useCallback((key: string, value: string) => {
    setContextFilters((prev) => {
      const current = prev[key] ?? [];
      const next = { ...prev };
      if (current.includes(value)) {
        const remaining = current.filter((v) => v !== value);
        if (remaining.length === 0) {
          delete next[key];
        } else {
          next[key] = remaining;
        }
      } else {
        next[key] = [...current, value];
      }
      return next;
    });
  }, []);

  const handleClearContext = useCallback(() => setContextFilters({}), []);

  const sessionMatchesContext = useCallback(
    (session: Session): boolean => {
      const entries = Object.entries(contextFilters);
      if (entries.length === 0) return true;
      return entries.every(([key, values]) => {
        const v = session.context?.[key];
        return values.includes(String(v ?? ""));
      });
    },
    [contextFilters],
  );

  // Precompute the set of session IDs whose context matches the
  // active filters. null = no filters active, everything matches.
  // Both the swimlane and the live feed use this to dim or filter
  // out non-matching sessions.
  const matchingSessionIds = useMemo<Set<string> | null>(() => {
    if (Object.keys(contextFilters).length === 0) return null;
    const set = new Set<string>();
    for (const flavor of flavors) {
      for (const session of flavor.sessions) {
        if (sessionMatchesContext(session)) {
          set.add(session.session_id);
        }
      }
    }
    return set;
  }, [flavors, contextFilters, sessionMatchesContext]);

  const [timeRange, setTimeRange] = useState<TimeRange>("1m");

  // Wall-clock tick. Re-renders once per second so the token window
  // filter below (Bug 4) ages events out of the rolling window even
  // when no new events are arriving. Pure client-side; no extra
  // backend calls.
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Virtual clock ticker. Advances `virtualNow` forward toward wall
  // clock using a dynamic catch-up rate: 1x for short gaps (smooth
  // playback), 4x for medium gaps, and gap/30s for long gaps so the
  // timeline is always live within ~30 seconds regardless of how long
  // the user was paused. Uses performance.now() deltas so a tab
  // backgrounded mid-catch-up resumes accurately on wake.
  useEffect(() => {
    if (virtualNow === null) return;
    let rafId: number;
    let lastFrame = performance.now();
    const step = (frame: number) => {
      const wallDelta = frame - lastFrame;
      lastFrame = frame;
      setVirtualNow((v) => {
        if (v === null) return null;
        const wall = Date.now();
        const gap = wall - v;
        if (gap <= 500) return null; // caught up — snap to live
        let rate: number;
        if (gap <= 10_000) rate = 1;
        else if (gap <= 60_000) rate = 4;
        else rate = gap / 30_000;
        const next = Math.min(wall, v + wallDelta * rate);
        return wall - next <= 500 ? null : next;
      });
      rafId = requestAnimationFrame(step);
    };
    rafId = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafId);
    // Phase 4.5 M-29 justification: we want the rAF to (re)start
    // only on the BOOLEAN transition virtualNow null↔non-null,
    // not on every frame's value change. The expression
    // ``virtualNow !== null`` evaluates to a boolean that React
    // memoizes; eslint can't see through the expression so we
    // disable it here rather than introduce an extra useState.
  }, [virtualNow !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  // Single source of truth for "what time is shown". Drives the
  // swimlane scale domain (via <Timeline>), the live feed cutoff,
  // and the token counter so all three surfaces stay locked together
  // across pause / catch-up / live transitions.
  const effectiveNowMs = useMemo(() => {
    if (paused && pausedAt) return pausedAt.getTime();
    if (virtualNow !== null) return virtualNow;
    return now;
  }, [paused, pausedAt, virtualNow, now]);
  // Set of currently-expanded flavor names. Multiple flavors can be
  // open at once -- the chevron toggle adds or removes a name from
  // the set rather than overwriting a single value. The previous
  // single-string state forced clicking a second flavor to collapse
  // the first, which made it impossible to compare two flavors
  // side-by-side.
  const [expandedFlavors, setExpandedFlavors] = useState<Set<string>>(
    () => new Set(),
  );
  const [selectedEvent, setSelectedEvent] = useState<AgentEvent | null>(null);
  const [directEventDetail, setDirectEventDetail] = useState<AgentEvent | null>(null);
  const [activeFilter, setActiveFilter] = useState<string | null>(null);

  // Bulk historical events load — one request replaces all per-session fetches
  const { events: historicalEvents } = useHistoricalEvents(timeRange);

  // Populate eventsCache and feedEvents from bulk load
  useEffect(() => {
    if (!historicalEvents.length) return;

    // Group by session_id and populate cache
    const grouped = new Map<string, AgentEvent[]>();
    for (const event of historicalEvents) {
      const existing = grouped.get(event.session_id) ?? [];
      grouped.set(event.session_id, [...existing, event]);
    }
    grouped.forEach((events, sessionId) => {
      const existing = eventsCache.get(sessionId);
      if (!existing || existing.length < events.length) {
        eventsCache.set(sessionId, events);
      }
    });

    // Increment versions for all affected sessions
    setSessionVersions((prev) => {
      const next = { ...prev };
      grouped.forEach((_, sessionId) => {
        next[sessionId] = (next[sessionId] ?? 0) + 1;
      });
      return next;
    });

    // Populate live feed from historical events
    const feedFromHistory: FeedEvent[] = historicalEvents.map((event) => ({
      arrivedAt: new Date(event.occurred_at).getTime(),
      event,
    }));
    setFeedEvents((prev) => {
      const seen = new Set(prev.map((fe) => fe.event.id));
      const merged = [...prev, ...feedFromHistory.filter((fe) => !seen.has(fe.event.id))];
      return merged.slice(-FEED_MAX_EVENTS);
    });
  }, [historicalEvents]);

  // Recent directive events for the FleetPanel sidebar.
  // MUST be declared before any conditional return to satisfy
  // the Rules of Hooks (hook order must be stable across renders).
  const directiveEvents = useMemo(() =>
    feedEvents
      .filter((fe) => fe.event.event_type === "directive" || fe.event.event_type === "directive_result")
      .slice(-20)
      .reverse()
      .slice(0, 5),
    [feedEvents]
  );

  // Session state counts derived from the live flavors array. This
  // computation runs on every WebSocket message that updates flavors,
  // so the SESSION STATES sidebar block stays current without any
  // separate polling or local count state. (FIX 1 -- previously
  // SessionStateBar computed counts from flavors itself, but a
  // memoized parent could keep stale counts on screen between
  // updates.)
  const sessionStateCounts = useMemo(() => {
    const counts = { active: 0, idle: 0, stale: 0, closed: 0, lost: 0 };
    flavors.forEach((flavor) =>
      flavor.sessions.forEach((s) => {
        if (s.state in counts) {
          counts[s.state as keyof typeof counts]++;
        }
      }),
    );
    return counts;
  }, [flavors]);

  // Sort flavors (swimlane) and agents (table) into the three
  // activity buckets defined in ``lib/fleet-ordering.ts``. Both share
  // the store's ``enteredBucketAt`` map so the swimlane and the
  // table surface rows in the same order. The ``now`` state ticks
  // every second so bucket-crossings are picked up without waiting
  // for an explicit WebSocket event.
  const sortedFlavors = useMemo(
    () => sortFlavorsByActivity(flavors, now, enteredBucketAt),
    [flavors, now, enteredBucketAt],
  );
  const sortedAgents = useMemo(
    () => sortAgentsByActivity(agents, now, enteredBucketAt),
    [agents, now, enteredBucketAt],
  );

  // Tokens scoped to the currently selected time range. Filters
  // feedEvents by occurred_at > now - timeRangeMs so events outside
  // the rolling window are excluded from the total. Depends on the
  // 1-second `now` tick so the number decrements as events age out,
  // regardless of whether new events are arriving. (Bug 4)
  const scopedTokens = useMemo(() => {
    const cutoff = effectiveNowMs - TIME_RANGE_MS[timeRange];
    let total = 0;
    for (const fe of feedEvents) {
      const occurredAt = fe.event.occurred_at
        ? new Date(fe.event.occurred_at).getTime()
        : fe.arrivedAt;
      if (occurredAt <= cutoff || occurredAt > effectiveNowMs) continue;
      total += fe.event.tokens_total ?? 0;
    }
    return total;
  }, [feedEvents, timeRange, effectiveNowMs]);

  // Live feed events scoped to the active time window. Mirrors the
  // scopedTokens cutoff so the feed shows the same events that
  // contribute to the token total. Re-evaluates whenever
  // effectiveNowMs changes -- 1Hz wall tick in live mode, rAF cadence
  // during catch-up, frozen while paused. Upper bound `<= effectiveNow`
  // is what lets queued events appear gradually during catch-up: an
  // event whose occurred_at hasn't yet been reached by the virtual
  // clock is held back until the clock passes it. CONTEXT sidebar
  // filter is applied after the time window.
  const scopedFeedEvents = useMemo(() => {
    const cutoff = effectiveNowMs - TIME_RANGE_MS[timeRange];
    const inWindow = feedEvents.filter((fe) => {
      const t = fe.event.occurred_at
        ? new Date(fe.event.occurred_at).getTime()
        : fe.arrivedAt;
      return t > cutoff && t <= effectiveNowMs;
    });
    if (matchingSessionIds === null) return inWindow;
    return inWindow.filter((fe) =>
      matchingSessionIds.has(fe.event.session_id),
    );
  }, [feedEvents, timeRange, effectiveNowMs, matchingSessionIds]);

  if (loading && flavors.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-text-muted">
        Loading fleet...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-danger">
        {error}
      </div>
    );
  }

  function handleFlavorClick(flavor: string) {
    setFlavorFilter(flavorFilter === flavor ? null : flavor);
  }

  function handleExpandFlavor(flavor: string) {
    setExpandedFlavors((prev) => {
      const next = new Set(prev);
      if (next.has(flavor)) {
        next.delete(flavor);
      } else {
        next.add(flavor);
        // On expand (not collapse): fetch every session under this
        // agent so the expanded SESSIONS list shows closed / old
        // sessions that fall outside the 24-hour Fleet rollup
        // window. Fresh fetch per expand; no cache. The call
        // populates ``expandedSessions`` in the fleet store, which
        // the swimlane renderer merges in for this flavor only so
        // the main timeline above the expansion stays windowed.
        void loadExpandedSessions(flavor);
      }
      return next;
    });
  }

  function handlePause() {
    // Anchor the pause to effectiveNowMs, not wall clock: pausing
    // during catch-up must freeze the virtual clock where it is,
    // otherwise the timeline would teleport forward to Date.now().
    setPausedAt(new Date(effectiveNowMs));
    setPaused(true);
    pausedRef.current = true;
    setVirtualNow(null);
  }

  function handleResume() {
    if (!pausedAt) return;
    // Drain queue into feedEvents -- scopedFeedEvents' upper-bound
    // filter will hold these back from the feed until the virtual
    // clock passes each event's occurred_at.
    setFeedEvents((prev) => [...prev, ...pauseQueue].slice(-FEED_MAX_EVENTS));
    setPauseQueue([]);
    setVirtualNow(pausedAt.getTime());
    setPaused(false);
    pausedRef.current = false;
    setPausedAt(null);
  }

  function handleReturnToLive() {
    // Jump straight to live: discard queue, cancel any catch-up
    // in progress, snap the effective clock back to wall clock.
    setPauseQueue([]);
    setPaused(false);
    pausedRef.current = false;
    setPausedAt(null);
    setVirtualNow(null);
    setTimeRange("1m");
  }

  // True while the virtual clock is still catching up to wall clock.
  // Derived so it cannot drift out of sync with virtualNow.
  const catchingUp = virtualNow !== null;

  return (
    <div className="flex h-full">
      <FleetPanel
        flavors={sortedFlavors}
        sessionStateCounts={sessionStateCounts}
        tokensInRange={scopedTokens}
        timeRange={timeRange}
        onFlavorClick={handleFlavorClick}
        activeFlavorFilter={flavorFilter}
        directiveEvents={directiveEvents}
        contextFacets={contextFacets}
        contextFilters={contextFilters}
        onContextFilter={handleContextFilter}
        onClearContext={handleClearContext}
      />

      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Fleet header */}
        <div
          className="flex h-10 shrink-0 items-center gap-3 px-3"
          style={{
            background: "var(--bg)",
            borderBottom: "1px solid var(--border-subtle)",
          }}
        >
          {/* Time range */}
          <div className="flex gap-0.5">
            {TIME_RANGES.map((range) => (
              <button
                key={range}
                className="rounded px-2.5 py-[3px] text-xs transition-colors"
                style={
                  timeRange === range
                    ? {
                        background: "var(--bg-elevated)",
                        color: "var(--text)",
                        border: "1px solid var(--border-strong)",
                      }
                    : {
                        background: "transparent",
                        color: "var(--text-muted)",
                        border: "1px solid transparent",
                      }
                }
                onClick={() => setTimeRange(range)}
              >
                {range}
              </button>
            ))}
          </div>

          {/* Pause controls -- three states drive the visible buttons:
                paused        → Resume + Return to Live
                catching up   → Return to Live only (Pause is suppressed;
                                the user can still auto-pause via sort)
                live          → Pause only
              Matches the button-state spec for DVR playback. */}
          {paused ? (
            <div className="flex gap-1.5">
              <button
                className="rounded px-2.5 py-[3px] text-xs transition-colors"
                style={{
                  background: "var(--bg-elevated)",
                  color: "var(--text)",
                  border: "1px solid var(--border-strong)",
                  borderRadius: 4,
                  cursor: "pointer",
                }}
                onClick={handleResume}
                data-testid="resume-btn"
              >
                ▶ Resume
              </button>
              <button
                className="rounded px-2.5 py-[3px] text-xs font-semibold transition-colors"
                style={{
                  background: "var(--accent-glow)",
                  color: "var(--accent)",
                  border: "1px solid var(--accent-border)",
                  borderRadius: 4,
                  cursor: "pointer",
                }}
                onClick={handleReturnToLive}
                data-testid="return-to-live-btn"
              >
                ⚡ Return to live
              </button>
            </div>
          ) : catchingUp ? (
            <button
              className="rounded px-2.5 py-[3px] text-xs font-semibold transition-colors"
              style={{
                background: "var(--accent-glow)",
                color: "var(--accent)",
                border: "1px solid var(--accent-border)",
                borderRadius: 4,
                cursor: "pointer",
              }}
              onClick={handleReturnToLive}
              data-testid="return-to-live-btn"
            >
              ⚡ Return to live
            </button>
          ) : (
            <button
              className="rounded px-2.5 py-[3px] text-xs transition-colors"
              style={{
                background: "transparent",
                color: "var(--text-muted)",
                border: "1px solid var(--border)",
                borderRadius: 4,
                cursor: "pointer",
              }}
              onClick={handlePause}
              data-testid="pause-btn"
            >
              ⏸ Pause
            </button>
          )}

          {/* Status indicator -- same three-way state as the buttons. */}
          <div className="ml-auto flex items-center gap-1.5">
            {paused ? (
              <>
                <div
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ background: pauseQueue.length >= PAUSE_QUEUE_MAX_EVENTS ? "var(--status-stale)" : "var(--status-idle)" }}
                  data-testid="pause-dot"
                />
                <span
                  className="font-mono text-[11px]"
                  style={{ color: pauseQueue.length >= PAUSE_QUEUE_MAX_EVENTS ? "var(--status-stale)" : "var(--status-idle)" }}
                >
                  Paused at {pausedAt?.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                </span>
                {pauseQueue.length > 0 && (
                  <span
                    className="font-mono text-[11px]"
                    style={{ color: pauseQueue.length >= PAUSE_QUEUE_MAX_EVENTS ? "var(--status-stale)" : "var(--text-muted)" }}
                    data-testid="queue-count"
                  >
                    · {pauseQueue.length >= PAUSE_QUEUE_MAX_EVENTS
                      ? `${pauseQueue.length.toLocaleString()} events buffered (oldest dropped)`
                      : `${pauseQueue.length} events waiting`}
                  </span>
                )}
              </>
            ) : catchingUp ? (
              <>
                <div
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ background: "var(--accent)" }}
                  data-testid="catching-up-dot"
                />
                <span
                  className="font-mono text-[11px]"
                  style={{ color: "var(--accent)" }}
                  data-testid="catching-up-label"
                >
                  Catching up to live…
                </span>
              </>
            ) : (
              <>
                <div className="pulse-dot" />
                <span
                  className="font-mono text-[11px]"
                  style={{ color: "var(--status-active)" }}
                >
                  Live
                </span>
              </>
            )}
          </div>
        </div>

        {/* Event type filter bar */}
        <EventFilterBar
          activeFilter={activeFilter}
          onFilterChange={setActiveFilter}
        />

        {/* D115 view toggle: swimlane (default) vs paginated agent
            table. URL-driven. Typography + pill geometry mirror
            EventFilterBar immediately above so the two strips read
            as a continuous fleet-header unit. */}
        <div
          data-testid="fleet-view-toggle"
          role="tablist"
          aria-label="Fleet view mode"
          className="flex h-9 shrink-0 items-center gap-1.5 px-3"
          style={{
            background: "var(--bg)",
            borderBottom: "1px solid var(--border-subtle)",
          }}
        >
          {(["swimlane", "table"] as const).map((mode) => {
            const active = view === mode;
            return (
              <button
                key={mode}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setView(mode)}
                data-testid={`fleet-view-toggle-${mode}`}
                style={{
                  height: 22,
                  padding: "0 10px",
                  cursor: "pointer",
                  borderRadius: 4,
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  fontWeight: 500,
                  letterSpacing: "0.02em",
                  ...(active
                    ? {
                        background: "var(--bg-elevated)",
                        color: "var(--text)",
                        border: "1px solid var(--border-strong)",
                      }
                    : {
                        background: "transparent",
                        color: "var(--text-muted)",
                        border: "1px solid var(--border-subtle)",
                      }),
                }}
              >
                {mode === "swimlane" ? "Swimlane" : "Table"}
              </button>
            );
          })}
        </div>

        {/* Context filter status bar. Only renders when a CONTEXT
            filter is active. Shows matched / total session counts
            and a one-click clear so the user always knows how many
            sessions are being hidden by the filter. Non-matching
            sessions are fully hidden in SwimLane (not dimmed), so
            this bar is the primary signal that filtering is on. */}
        {matchingSessionIds !== null && (
          <div
            data-testid="context-filter-status"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 11,
              color: "var(--accent)",
              padding: "3px 12px 4px",
              fontFamily: "var(--font-mono)",
              background: "var(--bg)",
              borderBottom: "1px solid var(--border-subtle)",
            }}
          >
            <span>
              Filtered: {matchingSessionIds.size} of{" "}
              {sortedFlavors.reduce(
                (n, f) => n + f.sessions.length,
                0,
              )}{" "}
              sessions
            </span>
            <button
              type="button"
              onClick={handleClearContext}
              data-testid="context-filter-status-clear"
              style={{
                cursor: "pointer",
                color: "var(--text-muted)",
                background: "transparent",
                border: "none",
                padding: "0 4px",
                fontFamily: "inherit",
                fontSize: "inherit",
              }}
            >
              × clear
            </button>
          </div>
        )}

        {/* Main view area. Swimlane is the default live view; the
            agent table is the paginated alternate selected via the
            view toggle above. Both consume the same agent-grouped
            data from the fleet store (store.load() fetches the
            agents roster AND a recent-sessions window in one pass).

            S-SWIM. The flex-1 div is the horizontal+vertical scroll
            container -- overflowX:auto means narrow viewports
            (~1280-1440px MacBook screens) can reach the older end
            of the timeline, overflowY:auto preserves the existing
            page-scroll. The relative shell hosts two pointer-events-
            none fade overlays that surface only when the container
            actually has overflow in that direction; the left fade
            sits at left=leftPanelWidth so it lands on the boundary
            between the sticky agent-name column and the timeline,
            doubling as both the S-SWIM-3 sticky-column shadow cue
            and the S-SWIM-4 left-edge fade. tabIndex=0 + onKeyDown
            covers S-SWIM-5 keyboard scroll. */}
        <div className="relative flex-1 overflow-hidden">
          <div
            ref={swimScrollRef}
            tabIndex={0}
            onKeyDown={swimOnKeyDown}
            data-testid="fleet-main-scroll"
            className="h-full"
            style={{ overflowY: "auto", overflowX: "auto", outline: "none" }}
          >
            {view === "swimlane" ? (
              <Timeline
                flavors={sortedFlavors}
                flavorFilter={flavorFilter}
                timeRange={timeRange}
                expandedFlavors={expandedFlavors}
                onExpandFlavor={handleExpandFlavor}
                expandedSessions={expandedSessions}
                onNodeClick={(id, _eventId, event) => {
                  selectSession(id);
                  setDirectEventDetail(event ?? null);
                }}
                activeFilter={activeFilter}
                paused={paused}
                pausedAt={pausedAt}
                effectiveNowMs={effectiveNowMs}
                sessionVersions={sessionVersions}
                matchingSessionIds={matchingSessionIds}
              />
            ) : (
              <div className="p-4">
                <AgentTable
                  agents={sortedAgents}
                  loading={loading}
                  sort={tableSort}
                  order={tableOrder}
                  onSortChange={handleAgentTableSort}
                />
                <FleetTablePagination
                  total={fleetTotal}
                  page={fleetPage}
                  perPage={fleetPerPage}
                  loading={loading}
                  onPage={(next) => void storeLoad({ page: next })}
                />
              </div>
            )}
          </div>
          {swimCanScrollLeft && view === "swimlane" && (
            <div
              aria-hidden
              data-testid="swimlane-fade-left"
              style={{
                position: "absolute",
                top: 0,
                bottom: 0,
                left: leftPanelWidth,
                width: SWIM_FADE_WIDTH_PX,
                pointerEvents: "none",
                background:
                  "linear-gradient(to right, var(--bg) 0%, transparent 100%)",
                boxShadow: "inset 4px 0 6px -4px rgba(0,0,0,0.25)",
                zIndex: 6,
              }}
            />
          )}
          {swimCanScrollRight && (
            <div
              aria-hidden
              data-testid="swimlane-fade-right"
              style={{
                position: "absolute",
                top: 0,
                bottom: 0,
                right: 0,
                width: SWIM_FADE_WIDTH_PX,
                pointerEvents: "none",
                background:
                  "linear-gradient(to left, var(--bg) 0%, transparent 100%)",
                zIndex: 6,
              }}
            />
          )}
        </div>

        {/* Live feed.
            The header "▶ Resume" and "⚡ Return to live" buttons live
            outside LiveFeed and are wired directly to handleResume
            (FIFO drain) and handleReturnToLive (discard queue) above.
            LiveFeed itself only owns the sort-triggered pause path:
            clicking a non-time column auto-pauses, and the in-feed
            "Return to live" link inside LiveFeed snaps back to live
            and discards the queue. Sort-pause is analytical mode --
            the user is reordering events to investigate, not waiting
            for the buffered events. So onResume here is intentionally
            wired to handleReturnToLive, not handleResume. */}
        <LiveFeed
          events={scopedFeedEvents}
          onEventClick={setSelectedEvent}
          activeFilter={activeFilter}
          onFilterChange={setActiveFilter}
          isPaused={paused}
          queueLength={pauseQueue.length}
          catchingUp={catchingUp}
          onPause={handlePause}
          onResume={handleReturnToLive}
        />
      </div>

      <SessionDrawer
        sessionId={selectedSessionId}
        onClose={() => { selectSession(null); setDirectEventDetail(null); }}
        directEventDetail={directEventDetail}
        onClearDirectEvent={() => setDirectEventDetail(null)}
        version={selectedSessionId ? (sessionVersions[selectedSessionId] ?? 0) : 0}
      />

      <EventDetailDrawer
        event={selectedEvent}
        onClose={() => setSelectedEvent(null)}
      />
    </div>
  );
}

/** Minimal pagination strip for the table view. Matches the
 *  ``Prev / Page X of Y / Next`` pattern used below the Investigate
 *  session table -- kept locally because it is the only Fleet
 *  consumer and the component surface is trivial. */
function FleetTablePagination({
  total,
  page,
  perPage,
  loading,
  onPage,
}: {
  total: number;
  page: number;
  perPage: number;
  loading: boolean;
  onPage: (next: number) => void;
}) {
  const pageCount = Math.max(1, Math.ceil(total / perPage));
  return (
    <div className="mt-4 flex items-center justify-between text-xs text-muted-foreground">
      <span>
        {total === 0
          ? "0 agents"
          : `Showing ${Math.min((page - 1) * perPage + 1, total)}–${Math.min(
              page * perPage,
              total,
            )} of ${total}`}
      </span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onPage(Math.max(1, page - 1))}
          disabled={page <= 1 || loading}
          className="px-2 py-1 rounded-sm border border-border disabled:opacity-40"
        >
          Prev
        </button>
        <span>
          Page {page} / {pageCount}
        </span>
        <button
          type="button"
          onClick={() => onPage(Math.min(pageCount, page + 1))}
          disabled={page >= pageCount || loading}
          className="px-2 py-1 rounded-sm border border-border disabled:opacity-40"
        >
          Next
        </button>
      </div>
    </div>
  );
}
