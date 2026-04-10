import { useMemo, useState, useEffect } from "react";
import { scaleTime } from "d3-scale";
import type { FlavorSummary } from "@/lib/types";
import type { ViewMode, TimeRange } from "@/pages/Fleet";
import { TIMELINE_RANGE_MS, TIMELINE_WIDTH_PX, LEFT_PANEL_WIDTH } from "@/lib/constants";
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

  // Fixed canvas width for every range. The xScale maps the range
  // domain to [0, TIMELINE_WIDTH_PX] -- wider time ranges produce
  // denser circles, which is the correct trade-off. No horizontal
  // scrollbar appears.
  const timelineWidth = TIMELINE_WIDTH_PX;

  const scale = useMemo(
    () => scaleTime().domain([start, scaleEnd]).range([0, timelineWidth]),
    [start, scaleEnd, timelineWidth]
  );

  if (flavors.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center text-text-muted">
        No agents connected. Start an agent with flightdeck_sensor.init() to
        see it here.
      </div>
    );
  }

  // Fixed total content width = LEFT_PANEL_WIDTH + TIMELINE_WIDTH_PX.
  // No horizontal scrollbar -- the entire timeline fits in the
  // visible area at every range, since timelineWidth is constant.
  const innerWidth = timelineWidth + LEFT_PANEL_WIDTH;

  return (
    <div
      className="relative"
      // overflow-x: hidden clips circles that extend past the right
      // edge of the fixed-width canvas. overflow-y: clip (NOT hidden)
      // does not establish a scroll container, which lets the time
      // axis row use position: sticky; top: 0 against Fleet.tsx's
      // outer vertical scroller. With overflow: hidden, the sticky
      // time axis would stick to this (zero-scroll) container and
      // scroll away with the flavor rows instead.
      style={{ overflowX: "hidden", overflowY: "clip" }}
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
              paused={paused}
            />
          </div>
        </div>

        {/* FLAVORS section header.
            The row is a flex container with width = innerWidth so the
            bottom border draws across the full timeline. The 240px
            label slot is `position: sticky; left: 0` -- it's NARROWER
            than its containing block (innerWidth), so sticky has room
            to actually take effect and pin the label text to the
            viewport's left edge as the user scrolls horizontally. The
            filler slot (width: timelineWidth) is non-sticky and just
            extends the row so the border reaches the right side.

            A previous version put `position: sticky; left: 0` on the
            ROW directly with `width: innerWidth`. That doesn't work --
            a sticky element with the same width as its containing
            block has no horizontal room to stick within, so it just
            scrolls along with the rest of the content and the label
            text slid off the viewport at 5m+. */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            height: 24,
            borderBottom: "1px solid var(--border-subtle)",
            background: "var(--bg)",
            width: innerWidth,
          }}
        >
          <div
            style={{
              width: LEFT_PANEL_WIDTH,
              flexShrink: 0,
              position: "sticky",
              left: 0,
              zIndex: 3,
              background: "var(--bg)",
              display: "flex",
              alignItems: "center",
              height: "100%",
              paddingLeft: 12,
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
              }}
            >
              Flavors
            </span>
          </div>
          <div style={{ width: timelineWidth, flexShrink: 0 }} />
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
