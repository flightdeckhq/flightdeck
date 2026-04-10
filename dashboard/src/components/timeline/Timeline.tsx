import { useMemo, useState, useEffect, useCallback } from "react";
import { scaleTime } from "d3-scale";
import type { FlavorSummary } from "@/lib/types";
import type { ViewMode, TimeRange } from "@/pages/Fleet";
import {
  TIMELINE_RANGE_MS,
  TIMELINE_WIDTH_PX,
  LEFT_PANEL_MIN_WIDTH,
  LEFT_PANEL_MAX_WIDTH,
  LEFT_PANEL_DEFAULT_WIDTH,
  LEFT_PANEL_WIDTH_KEY,
} from "@/lib/constants";
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
  /**
   * Set of session IDs that match the active CONTEXT sidebar filter.
   * null = no filters active, every session matches. Used to dim
   * non-matching sessions in the swimlane (opacity 0.15 +
   * pointer-events: none).
   */
  matchingSessionIds?: Set<string> | null;
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
  matchingSessionIds = null,
}: TimelineProps) {
  // Resizable left panel width. Persisted to localStorage so the
  // user's preference survives page reloads. Clamped on init AND on
  // every drag so a stale storage value can't push the panel past
  // its bounds.
  const [leftPanelWidth, setLeftPanelWidth] = useState<number>(() => {
    try {
      const stored = localStorage.getItem(LEFT_PANEL_WIDTH_KEY);
      const n = stored ? parseInt(stored, 10) : LEFT_PANEL_DEFAULT_WIDTH;
      if (Number.isNaN(n)) return LEFT_PANEL_DEFAULT_WIDTH;
      return Math.min(
        LEFT_PANEL_MAX_WIDTH,
        Math.max(LEFT_PANEL_MIN_WIDTH, n),
      );
    } catch {
      return LEFT_PANEL_DEFAULT_WIDTH;
    }
  });

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = leftPanelWidth;

      const onMove = (ev: MouseEvent) => {
        const delta = ev.clientX - startX;
        const next = Math.min(
          LEFT_PANEL_MAX_WIDTH,
          Math.max(LEFT_PANEL_MIN_WIDTH, startWidth + delta),
        );
        setLeftPanelWidth(next);
        try {
          localStorage.setItem(LEFT_PANEL_WIDTH_KEY, String(next));
        } catch {
          /* storage unavailable -- drag still works for this session */
        }
      };

      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [leftPanelWidth],
  );

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

  // X positions for the 6 vertical grid lines that drop down from
  // the time axis labels through every flavor row. Same fractions
  // as the labels in TimeAxis.tsx (0, 0.2, 0.4, 0.6, 0.8, 1.0). The
  // i=5 entry sits at xScale(now) and is highlighted as the "now"
  // line.
  const gridLines = useMemo(() => {
    return Array.from({ length: 6 }, (_, i) => {
      const fraction = i / 5;
      const msAgo = Math.round(rangeMs * (1 - fraction));
      return scale(new Date(scaleEnd.getTime() - msAgo));
    });
  }, [scale, rangeMs, scaleEnd]);

  if (flavors.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center text-text-muted">
        No agents connected. Start an agent with flightdeck_sensor.init() to
        see it here.
      </div>
    );
  }

  // Total content width = leftPanelWidth + TIMELINE_WIDTH_PX. The
  // timeline area is fixed at 900px; only the left panel resizes.
  // No horizontal scrollbar -- the entire row fits in the visible
  // area at every range.
  const innerWidth = timelineWidth + leftPanelWidth;

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
        {/* Vertical grid line overlay. Six lines at the same x
            positions as the time axis labels, dropping from the top
            of the inner content div to the bottom of the last
            flavor row. Constrained to the right-panel area only
            (left: leftPanelWidth, width: timelineWidth) so the
            resizable label column stays clean. zIndex: 1 so lines
            paint ABOVE the flavor row backgrounds but BELOW the
            event circles (which use zIndex 2). pointerEvents: none
            keeps it from blocking circle clicks. */}
        <div
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: leftPanelWidth,
            width: timelineWidth,
            pointerEvents: "none",
            zIndex: 1,
          }}
          data-testid="timeline-grid-overlay"
        >
          {gridLines.map((x, i) => {
            const isNow = i === 5;
            return (
              <div
                key={i}
                data-testid={isNow ? "grid-line-now" : `grid-line-${i}`}
                style={{
                  position: "absolute",
                  left: x,
                  top: 0,
                  bottom: 0,
                  width: 1,
                  // var(--border) (medium brightness, between
                  // --border-subtle and --border-strong) gives the
                  // non-now lines enough contrast to be visible
                  // through the row backgrounds without competing
                  // with event circles. var(--border-default) does
                  // not exist in the theme.
                  background: isNow
                    ? "var(--accent)"
                    : "var(--border)",
                  opacity: isNow ? 0.6 : 0.4,
                }}
              />
            );
          })}
        </div>

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
              horizontally so it stays pinned over the labels when
              the user scrolls right. Width tracks the resizable
              leftPanelWidth. */}
          <div
            className="shrink-0"
            style={{
              width: leftPanelWidth,
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
            Flex row with the label slot sticky to the viewport's
            left edge (width narrower than innerWidth so sticky has
            room to take effect). The drag handle sits on the right
            edge of the label slot -- it's `position: absolute` so it
            doesn't affect the flex layout, and it hoovers hover
            events to paint a 4px accent-coloured indicator while
            the user is close to it. */}
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
              width: leftPanelWidth,
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
            {/* Drag handle for resizing the left panel. Only needs
                to exist on one row -- the width state is shared
                across every SwimLane below via props, so dragging
                here resizes every session row simultaneously. */}
            <div
              data-testid="left-panel-resize-handle"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize left panel"
              style={{
                position: "absolute",
                right: 0,
                top: 0,
                bottom: 0,
                width: 4,
                cursor: "col-resize",
                zIndex: 10,
                background: "transparent",
                transition: "background 150ms ease",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "var(--accent)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "transparent";
              }}
              onMouseDown={handleResizeStart}
            />
          </div>
          <div style={{ width: timelineWidth, flexShrink: 0 }} />
        </div>

        {/* Flavor rows. Each SwimLane receives both leftPanelWidth
            and timelineWidth as props so its internal flex layout
            (sticky left + timeline right) stays in sync with the
            resizable left column. */}
        {filteredFlavors.map((f) => (
          <SwimLane
            key={f.flavor}
            flavor={f.flavor}
            sessions={f.sessions}
            scale={scale}
            onSessionClick={onNodeClick}
            expanded={expandedFlavor === f.flavor}
            onToggleExpand={() => onExpandFlavor(f.flavor)}
            viewMode={viewMode}
            start={start}
            end={scaleEnd}
            timelineWidth={timelineWidth}
            leftPanelWidth={leftPanelWidth}
            activeFilter={activeFilter}
            sessionVersions={sessionVersions}
            matchingSessionIds={matchingSessionIds}
          />
        ))}
      </div>
    </div>
  );
}
