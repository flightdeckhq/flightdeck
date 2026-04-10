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
      // overflow-y: clip (NOT hidden) so this container does NOT
      // establish a vertical scrolling context. That lets the time
      // axis row use position: sticky; top: 0 to stick against
      // Fleet.tsx's outer vertical scroller as flavor rows scroll
      // past underneath. With overflow-y: hidden, the sticky element
      // would stick to this container's own (zero-height) scroll and
      // appear to never move. (FIX 2)
      style={{ overflowX: "auto", overflowY: "clip" }}
      data-testid="timeline-scroll"
    >
      <div style={{ width: innerWidth, minWidth: "100%", position: "relative" }}>
        {/* Shared time axis. Sticky on the vertical axis so it stays
            pinned at the top of the right panel as flavor rows scroll
            past. The container's parent (Fleet.tsx) provides vertical
            scroll; this sticky positions against that scroll context. */}
        <div
          className="flex"
          style={{
            position: "sticky",
            top: 0,
            zIndex: 4,
            background: "var(--bg)",
          }}
        >
          {/* Left spacer above the flavor labels column. Sticky
              horizontally so it stays pinned over the labels when the
              user scrolls right. */}
          <div
            className="shrink-0"
            style={{
              width: LEFT_PANEL_WIDTH,
              height: 28,
              position: "sticky",
              left: 0,
              zIndex: 5,
              background: "var(--bg)",
              borderRight: "1px solid var(--border)",
            }}
          />
          <div style={{ width: timelineWidth, flexShrink: 0 }}>
            <TimeAxis
              start={start}
              end={scaleEnd}
              width={timelineWidth}
              timeRange={timeRange}
            />
          </div>
        </div>

        {/* FLAVORS section header. Sticky horizontally so the label
            stays at the left edge of the viewport regardless of how
            far the user has scrolled into the timeline. (FIX 4 +
            wide-range regression fix.) */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            height: 24,
            paddingLeft: 12,
            borderBottom: "1px solid var(--border-subtle)",
            background: "var(--bg)",
            position: "sticky",
            left: 0,
            zIndex: 3,
            // The sticky element must extend the full content width
            // so the bottom border draws all the way across the
            // timeline rather than stopping at LEFT_PANEL_WIDTH.
            width: innerWidth,
          }}
        >
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: "0.08em",
              color: "var(--text-muted)",
              textTransform: "uppercase",
              fontFamily: "var(--font-ui)",
              // The span itself sits at viewport-left because the
              // parent is sticky-left.
              position: "sticky",
              left: 12,
            }}
          >
            Flavors
          </span>
        </div>

        {/* Flavor rows. Each SwimLane receives timelineWidth directly
            and is responsible for its own internal flex layout
            (sticky 240px left + timelineWidth right). */}
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
            timelineWidth={timelineWidth}
            activeFilter={activeFilter}
            sessionVersions={sessionVersions}
          />
        ))}
      </div>
    </div>
  );
}
