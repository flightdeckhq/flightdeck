import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { useFleet } from "@/hooks/useFleet";
import { useFleetStore } from "@/store/fleet";
import { useHistoricalEvents } from "@/hooks/useHistoricalEvents";
import { FleetPanel } from "@/components/fleet/FleetPanel";
import { DirectivesPanel } from "@/components/fleet/DirectivesPanel";
import { EventFilterBar } from "@/components/fleet/EventFilterBar";
import { LiveFeed } from "@/components/fleet/LiveFeed";
import { EventDetailDrawer } from "@/components/fleet/EventDetailDrawer";
import { Timeline } from "@/components/timeline/Timeline";
import { SessionDrawer } from "@/components/session/SessionDrawer";
import type { AgentEvent, FeedEvent, FlavorSummary } from "@/lib/types";
import { FEED_MAX_EVENTS, PAUSE_QUEUE_MAX_EVENTS } from "@/lib/constants";
import { eventsCache } from "@/hooks/useSessionEvents";

export type ViewMode = "swimlane" | "bars";
export type TimeRange = "1m" | "5m" | "15m" | "30m" | "1h";

const TIME_RANGES: TimeRange[] = ["1m", "5m", "15m", "30m", "1h"];

/**
 * Sort flavors by activity priority so flavors with active or idle
 * sessions always sit at the top of the swimlane and stale/closed
 * ones sink to the bottom. Stable secondary order is alphabetical.
 *
 * Exported so unit tests can verify the ordering directly without
 * mounting the full Fleet page (which would require mocking the
 * WebSocket store and bulk events fetch). FIX 3 -- part A.
 */
export function sortFlavorsByActivity(flavors: FlavorSummary[]): FlavorSummary[] {
  const priority = (states: string[]): number => {
    if (states.includes("active")) return 0;
    if (states.includes("idle")) return 1;
    if (states.includes("stale")) return 2;
    if (states.includes("lost")) return 3;
    return 4;
  };
  return [...flavors].sort((a, b) => {
    const pa = priority(a.sessions.map((s) => s.state));
    const pb = priority(b.sessions.map((s) => s.state));
    if (pa !== pb) return pa - pb;
    return a.flavor.localeCompare(b.flavor);
  });
}

export function Fleet() {
  const [feedEvents, setFeedEvents] = useState<FeedEvent[]>([]);
  const [pauseQueue, setPauseQueue] = useState<FeedEvent[]>([]);
  const [paused, setPaused] = useState(false);
  const [pausedAt, setPausedAt] = useState<Date | null>(null);
  const [catchingUp, setCatchingUp] = useState(false);
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
        const next = [...prev, fe];
        return next.length > PAUSE_QUEUE_MAX_EVENTS ? next.slice(-PAUSE_QUEUE_MAX_EVENTS) : next;
      });
    } else {
      setFeedEvents((prev) => [...prev, fe].slice(-FEED_MAX_EVENTS));
    }
  }, []);

  const { flavors, loading, error } = useFleet(handleNewEvent);
  const {
    selectedSessionId,
    selectSession,
    flavorFilter,
    setFlavorFilter,
  } = useFleetStore();

  const [viewMode, setViewMode] = useState<ViewMode>("swimlane");
  const [timeRange, setTimeRange] = useState<TimeRange>("1m");
  const [expandedFlavor, setExpandedFlavor] = useState<string | null>(null);
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
    setFeedEvents(feedFromHistory.slice(-FEED_MAX_EVENTS));
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

  // Sort flavors by activity priority. Re-sorts automatically on
  // every flavors update via useMemo. See sortFlavorsByActivity
  // above for the priority function. (FIX 3 -- part A)
  const sortedFlavors = useMemo(() => sortFlavorsByActivity(flavors), [flavors]);

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
    setExpandedFlavor(expandedFlavor === flavor ? null : flavor);
  }

  function handlePause() {
    setPaused(true);
    pausedRef.current = true;
    setPausedAt(new Date());
  }

  function handleResume() {
    // Drain queue into feedEvents in FIFO order
    setCatchingUp(true);
    setFeedEvents((prev) => [...prev, ...pauseQueue].slice(-FEED_MAX_EVENTS));
    setPauseQueue([]);
    setPaused(false);
    pausedRef.current = false;
    setPausedAt(null);
    setTimeout(() => setCatchingUp(false), 500);
  }

  function handleReturnToLive() {
    // Discard queue entirely
    setPauseQueue([]);
    setPaused(false);
    pausedRef.current = false;
    setPausedAt(null);
    setTimeRange("1m");
    setCatchingUp(false);
  }

  return (
    <div className="flex h-full">
      <FleetPanel
        flavors={sortedFlavors}
        sessionStateCounts={sessionStateCounts}
        onFlavorClick={handleFlavorClick}
        activeFlavorFilter={flavorFilter}
        directiveEvents={directiveEvents}
      >
        <DirectivesPanel
          flavorFilter={flavorFilter}
          selectedSessionId={selectedSessionId}
        />
      </FleetPanel>

      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Fleet header */}
        <div
          className="flex h-10 shrink-0 items-center gap-3 px-3"
          style={{
            background: "var(--bg)",
            borderBottom: "1px solid var(--border-subtle)",
          }}
        >
          {/* View mode toggle */}
          <div className="flex gap-0.5">
            {(["swimlane", "bars"] as const).map((mode) => (
              <button
                key={mode}
                className="rounded px-2.5 py-[3px] text-xs capitalize transition-colors"
                style={
                  viewMode === mode
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
                onClick={() => setViewMode(mode)}
              >
                {mode === "swimlane" ? "Swimlane" : "Bars"}
              </button>
            ))}
          </div>

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

          {/* Pause controls */}
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

          {/* Live indicator */}
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

        {/* Timeline area. Horizontal scroll lives inside Timeline
            (proportional to the selected time range); only vertical
            scroll bubbles up here. */}
        <div className="flex-1" style={{ overflowY: "auto", overflowX: "hidden" }}>
          <Timeline
            flavors={sortedFlavors}
            flavorFilter={flavorFilter}
            viewMode={viewMode}
            timeRange={timeRange}
            expandedFlavor={expandedFlavor}
            onExpandFlavor={handleExpandFlavor}
            onNodeClick={(id, _eventId, event) => {
              selectSession(id);
              setDirectEventDetail(event ?? null);
            }}
            activeFilter={activeFilter}
            paused={paused}
            pausedAt={pausedAt}
            sessionVersions={sessionVersions}
          />
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
          events={feedEvents}
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
