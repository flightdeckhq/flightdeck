import { useState, useCallback } from "react";
import { useFleet } from "@/hooks/useFleet";
import { useFleetStore } from "@/store/fleet";
import { FleetPanel } from "@/components/fleet/FleetPanel";
import { DirectivesPanel } from "@/components/fleet/DirectivesPanel";
import { EventFilterBar } from "@/components/fleet/EventFilterBar";
import { LiveFeed } from "@/components/fleet/LiveFeed";
import { EventDetailDrawer } from "@/components/fleet/EventDetailDrawer";
import { Timeline } from "@/components/timeline/Timeline";
import { SessionDrawer } from "@/components/session/SessionDrawer";
import type { AgentEvent } from "@/lib/types";

export type ViewMode = "swimlane" | "bars";
export type TimeRange = "1m" | "5m" | "15m" | "30m" | "1h" | "6h";

const TIME_RANGES: TimeRange[] = ["1m", "5m", "15m", "30m", "1h", "6h"];

export function Fleet() {
  const [feedEvents, setFeedEvents] = useState<AgentEvent[]>([]);

  const handleNewEvent = useCallback((event: AgentEvent) => {
    setFeedEvents((prev) => [...prev, event].slice(-500));
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
  const [initialEventId, setInitialEventId] = useState<string | null>(null);
  const [activeFilter, setActiveFilter] = useState<string | null>(null);

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

  return (
    <div className="flex h-full">
      <FleetPanel
        flavors={flavors}
        onFlavorClick={handleFlavorClick}
        activeFlavorFilter={flavorFilter}
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

          {/* Live indicator */}
          <div className="ml-auto flex items-center gap-1.5">
            <div className="pulse-dot" />
            <span
              className="font-mono text-[11px]"
              style={{ color: "var(--text-muted)" }}
            >
              Live
            </span>
          </div>
        </div>

        {/* Event type filter bar */}
        <EventFilterBar
          activeFilter={activeFilter}
          onFilterChange={setActiveFilter}
        />

        {/* Timeline area */}
        <div className="flex-1 overflow-auto">
          <Timeline
            flavors={flavors}
            flavorFilter={flavorFilter}
            viewMode={viewMode}
            timeRange={timeRange}
            expandedFlavor={expandedFlavor}
            onExpandFlavor={handleExpandFlavor}
            onNodeClick={(id, eventId) => {
              selectSession(id);
              setInitialEventId(eventId ?? null);
            }}
            activeFilter={activeFilter}
          />
        </div>

        {/* Live feed */}
        <LiveFeed
          events={feedEvents}
          onEventClick={setSelectedEvent}
          activeFilter={activeFilter}
        />
      </div>

      <SessionDrawer
        sessionId={selectedSessionId}
        onClose={() => { selectSession(null); setInitialEventId(null); }}
        initialEventId={initialEventId}
      />

      <EventDetailDrawer
        event={selectedEvent}
        onClose={() => setSelectedEvent(null)}
      />
    </div>
  );
}
