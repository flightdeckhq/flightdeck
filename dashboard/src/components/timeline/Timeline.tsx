import { useMemo, useState, useEffect, useRef } from "react";
import { scaleTime } from "d3-scale";
import type { FlavorSummary } from "@/lib/types";
import type { ViewMode, TimeRange } from "@/pages/Fleet";
import { TIMELINE_RANGE_MS, timelineWidthFor, LEFT_PANEL_WIDTH } from "@/lib/constants";
import { TimeAxis } from "./TimeAxis";
import { SwimLane } from "./SwimLane";

interface TimelineProps {
  flavors: FlavorSummary[];
  flavorFilter?: string | null;
  viewMode: ViewMode;
  timeRange: TimeRange;
  expandedFlavor: string | null;
  onExpandFlavor: (flavor: string) => void;
  onNodeClick: (sessionId: string, eventId?: string, event?: import("@/lib/types").AgentEvent) => void;
  activeFilter?: string | null;
  paused?: boolean;
  pausedAt?: Date | null;
  sessionVersions?: Record<string, number>;
}

export function Timeline({
  flavors,
  flavorFilter,
  viewMode,
  timeRange,
  expandedFlavor,
  onExpandFlavor,
  onNodeClick,
  activeFilter,
  paused,
  pausedAt,
  sessionVersions,
}: TimelineProps) {
  // Live-updating "now" — throttled to 10fps (100ms) for performance
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (paused) return;
    let rafId: number;
    let lastUpdate = 0;
    const tick = (timestamp: number) => {
      if (timestamp - lastUpdate >= 100) {
        setNow(new Date());
        lastUpdate = timestamp;
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [paused]);

  const filteredFlavors = useMemo(() => {
    if (!flavorFilter) return flavors;
    return flavors.filter((f) => f.flavor === flavorFilter);
  }, [flavors, flavorFilter]);

  const rangeMs = TIMELINE_RANGE_MS[timeRange] ?? 60_000;
  const scaleEnd = paused && pausedAt ? pausedAt : now;
  const start = useMemo(() => new Date(scaleEnd.getTime() - rangeMs), [scaleEnd, rangeMs]);

  // Width of the event-circles area scales linearly with the time
  // range so pixel-per-second density stays constant. The right
  // panel becomes horizontally scrollable for ranges >= 5m.
  const timelineWidth = timelineWidthFor(timeRange);

  const scale = useMemo(
    () => scaleTime().domain([start, scaleEnd]).range([0, timelineWidth]),
    [start, scaleEnd, timelineWidth]
  );

  // On mount and on every range change, scroll the right panel to
  // its rightmost position so "now" is always visible. We do NOT
  // force-scroll on pause or resume -- the user is investigating and
  // the scroll position should be theirs.
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollLeft = scrollRef.current.scrollWidth;
    }
  }, [timeRange]);

  if (flavors.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center text-text-muted">
        No agents connected. Start an agent with flightdeck_sensor.init() to
        see it here.
      </div>
    );
  }

  // Single horizontal scroll container that holds the time axis row
  // plus every SwimLane. Each SwimLane's 240px left panel uses
  // position: sticky; left: 0 to stay pinned during horizontal scroll;
  // only the event-circles area scrolls. This keeps every flavor row
  // in sync without manual scroll wiring.
  const innerWidth = timelineWidth + LEFT_PANEL_WIDTH;

  return (
    <div
      ref={scrollRef}
      className="relative"
      style={{ overflowX: "auto", overflowY: "hidden" }}
      data-testid="timeline-scroll"
    >
      <div style={{ width: innerWidth, minWidth: "100%" }}>
        {/* Shared time axis -- offset by the sticky left panel so it
            starts at pixel 240 inside the scroll container. */}
        <div className="flex">
          <div
            className="shrink-0"
            style={{
              width: LEFT_PANEL_WIDTH,
              height: 28,
              position: "sticky",
              left: 0,
              zIndex: 3,
              background: "var(--bg)",
              borderRight: "1px solid var(--border)",
            }}
          />
          <div style={{ width: timelineWidth }}>
            <TimeAxis
              start={start}
              end={scaleEnd}
              width={timelineWidth}
              timeRange={timeRange}
            />
          </div>
        </div>

        {/* Flavor rows */}
        {filteredFlavors.map((f) => (
          <SwimLane
            key={f.flavor}
            flavor={f.flavor}
            activeCount={f.active_count}
            sessions={f.sessions}
            scale={scale}
            onSessionClick={onNodeClick}
            expanded={expandedFlavor === f.flavor}
            onToggleExpand={() => onExpandFlavor(f.flavor)}
            viewMode={viewMode}
            start={start}
            end={scaleEnd}
            width={innerWidth}
            activeFilter={activeFilter}
            sessionVersions={sessionVersions}
          />
        ))}
      </div>
    </div>
  );
}
