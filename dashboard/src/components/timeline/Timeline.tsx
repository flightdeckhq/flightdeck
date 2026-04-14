import { useMemo, useState, useEffect, useCallback, useRef } from "react";
import { scaleTime } from "d3-scale";
import type { FlavorSummary } from "@/lib/types";
import type { TimeRange } from "@/pages/Fleet";
import {
  TIMELINE_RANGE_MS,
  TIMELINE_WIDTH_PX,
  LEFT_PANEL_MIN_WIDTH,
  LEFT_PANEL_MAX_WIDTH,
  LEFT_PANEL_DEFAULT_WIDTH,
  LEFT_PANEL_WIDTH_KEY,
} from "@/lib/constants";
import { TimeAxis } from "./TimeAxis";
import { AllSwimLane } from "./SwimLane";
import { VirtualizedSwimLane } from "./VirtualizedSwimLane";

interface TimelineProps {
  flavors: FlavorSummary[];
  flavorFilter?: string | null;
  timeRange: TimeRange;
  /**
   * Set of currently-expanded flavor names. Multiple flavors can be
   * open simultaneously. Owned by Fleet.tsx and toggled via
   * onExpandFlavor below.
   */
  expandedFlavors: Set<string>;
  onExpandFlavor: (flavor: string) => void;
  onNodeClick: (sessionId: string, eventId?: string, event?: import("@/lib/types").AgentEvent) => void;
  activeFilter?: string | null;
  paused?: boolean;
  pausedAt?: Date | null;
  sessionVersions?: Record<string, number>;
  /**
   * Set of session IDs that match the active CONTEXT sidebar filter.
   * null = no filters active, every session matches. Sessions not in
   * the set are hidden inside SwimLane, AND any flavor whose sessions
   * have zero overlap with this set is dropped entirely from the
   * timeline -- see filteredFlavors below for the flavor-level cull.
   */
  matchingSessionIds?: Set<string> | null;
}

export function Timeline({
  flavors,
  flavorFilter,
  timeRange,
  expandedFlavors,
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

  // Mirror leftPanelWidth into a ref so handleResizeStart can read
  // the latest value at drag-start time WITHOUT taking leftPanelWidth
  // as a useCallback dependency. The previous design had
  // leftPanelWidth in deps -- which meant the callback identity
  // changed on every drag frame, causing React to rebind the
  // onMouseDown handler on every move. The ref approach removes the
  // dep churn entirely; the in-progress drag still uses the
  // closed-over startWidth so behavior is unchanged.
  const leftPanelWidthRef = useRef(leftPanelWidth);
  useEffect(() => {
    leftPanelWidthRef.current = leftPanelWidth;
  }, [leftPanelWidth]);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = leftPanelWidthRef.current;

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
  }, []);

  // Count sessions that can still produce events. Closed / lost
  // sessions are frozen history -- if the whole fleet is in that
  // state, the timeline has nothing new to show, so the rAF tick
  // below short-circuits and the Timeline re-render cadence drops
  // from 10/sec to zero. Drives both this early-out and the eventual
  // AllSwimLane hide (via its own prop check).
  const liveSessionCount = useMemo(
    () =>
      flavors.reduce(
        (acc, f) =>
          acc +
          f.sessions.filter(
            (s) =>
              s.state === "active" ||
              s.state === "idle" ||
              s.state === "stale",
          ).length,
        0,
      ),
    [flavors],
  );

  // Live-updating "now" — throttled to 10fps (100ms) for performance.
  // Skips the rAF loop entirely when paused OR when no sessions are
  // live. With zero active agents, re-rendering the timeline 10x/sec
  // only shifts the "now" cursor by 100ms each frame; it cannot
  // surface any new events because there are none. A one-shot setNow
  // when liveSessionCount hits zero snaps the cursor to the current
  // wall clock and then stops.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (paused) return;
    if (liveSessionCount === 0) {
      setNow(new Date());
      return;
    }
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
  }, [paused, liveSessionCount]);

  const filteredFlavors = useMemo(() => {
    let result = flavors;
    if (flavorFilter) {
      result = result.filter((f) => f.flavor === flavorFilter);
    }
    // FIX 3 -- when a CONTEXT filter is active, drop any flavor whose
    // sessions have zero overlap with matchingSessionIds. The flavor
    // header used to render anyway and the user saw a label with no
    // body underneath. Hiding the whole flavor row keeps the swimlane
    // dense and matches the filter status bar count.
    if (matchingSessionIds !== null) {
      result = result.filter((f) =>
        f.sessions.some((s) => matchingSessionIds.has(s.session_id)),
      );
    }
    return result;
  }, [flavors, flavorFilter, matchingSessionIds]);

  const rangeMs = TIMELINE_RANGE_MS[timeRange] ?? 60_000;

  // Floor the scale's right-hand domain to 1-second granularity.
  // The rAF loop above still ticks `now` every 100ms so derived
  // visuals (hover tooltips, transient layout) stay smooth, but
  // feeding a stable primitive (ms epoch floored to 1s) into the
  // scale memo keeps its identity stable for a full second. Before
  // this floor, scale churned 10x/sec, which in turn invalidated
  // every per-session `nodes` memo at the same cadence and defeated
  // the SwimLane.memo custom equality that bails out for sub-second
  // domain deltas. Events only arrive at human speed -- a 1-second
  // step on the time axis is imperceptible.
  const rawEndMs = paused && pausedAt ? pausedAt.getTime() : now.getTime();
  const scaleEndMs = Math.floor(rawEndMs / 1000) * 1000;
  const scaleEnd = useMemo(() => new Date(scaleEndMs), [scaleEndMs]);
  const start = useMemo(() => new Date(scaleEndMs - rangeMs), [scaleEndMs, rangeMs]);

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
      return scale(new Date(scaleEndMs - msAgo));
    });
  }, [scale, rangeMs, scaleEndMs]);

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
              leftPanelWidth. This spacer hosts the resize handle:
              the time-axis row itself is `position: sticky; top: 0`
              against Fleet.tsx's outer scroll, so the handle stays
              visible even when the user scrolls through many
              flavor rows. */}
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
          >
            {/* Drag handle for resizing the left panel. `position:
                absolute` anchors it to the sticky parent so it
                doesn't affect flex layout. Only one handle exists
                in the whole Timeline -- the width state is shared
                across every SwimLane below via props, so dragging
                resizes every row simultaneously. */}
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
              onMouseDown={handleResizeStart}
            />
          </div>
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

        {/* ALL aggregate row.
            Sits above the FLAVORS section as a single non-expandable
            lane that merges every session's events into one timeline.
            Reads from the unfiltered `flavors` prop (NOT
            filteredFlavors) so it always shows the whole fleet
            regardless of the CONTEXT sidebar filter -- it's a
            fleet-wide overview, not a filtered subset. The event-type
            filter (`activeFilter`) still applies inside each circle
            via EventNode.isVisible. */}
        <AllSwimLane
          flavors={flavors}
          scale={scale}
          onSessionClick={onNodeClick}
          timelineWidth={timelineWidth}
          leftPanelWidth={leftPanelWidth}
          activeFilter={activeFilter}
          sessionVersions={sessionVersions}
        />

        {/* FLAVORS section header.
            Flex row with the label slot sticky to the viewport's
            left edge. The drag handle for resizing the left panel
            lives on the time axis row's sticky spacer above (which
            is vertically sticky so the handle stays visible even
            when the user scrolls through many flavors). */}
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
              {matchingSessionIds !== null && (
                <span
                  data-testid="flavors-filtered-suffix"
                  style={{
                    marginLeft: 6,
                    fontWeight: 400,
                    textTransform: "none",
                    letterSpacing: 0,
                    color: "var(--accent)",
                  }}
                >
                  (filtered)
                </span>
              )}
            </span>
          </div>
          <div style={{ width: timelineWidth, flexShrink: 0 }} />
        </div>

        {/* Flavor rows. Wrapped in VirtualizedSwimLane so rows
            scrolled out of the Fleet panel unmount to a same-height
            spacer. At 50+ flavors a smoke test fleet was exceeding
            9,000 DOM nodes and 80 ms of style-recalc per tick --
            memoization alone couldn't fix that because the absolute
            DOM footprint was the bottleneck. Expansion state lives
            in Fleet's `expandedFlavors` Set, so the unmount
            round-trip is lossless. The ALL row above is NOT
            virtualized -- it's always the top row and would defeat
            its own purpose if it flickered between spacer and real
            content. */}
        {filteredFlavors.map((f) => (
          <VirtualizedSwimLane
            key={f.flavor}
            flavor={f.flavor}
            sessions={f.sessions}
            scale={scale}
            onSessionClick={onNodeClick}
            expanded={expandedFlavors.has(f.flavor)}
            onToggleExpand={() => onExpandFlavor(f.flavor)}
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
