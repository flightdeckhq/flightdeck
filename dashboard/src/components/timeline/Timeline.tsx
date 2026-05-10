import React, { useLayoutEffect, useMemo, useState, useEffect, useCallback, useRef } from "react";
import { scaleTime } from "d3-scale";
import type { FlavorSummary } from "@/lib/types";
import type { TimeRange } from "@/pages/Fleet";
import {
  TIMELINE_RANGE_MS,
  TIMELINE_WIDTH_PX,
  LEFT_PANEL_MIN_WIDTH,
  LEFT_PANEL_MAX_WIDTH,
  EVENT_CIRCLE_SIZE,
} from "@/lib/constants";
import {
  persistLeftPanelWidth,
  readPersistedLeftPanelWidth,
} from "@/lib/leftPanelWidth";
import { TimeAxis } from "./TimeAxis";
import { AllSwimLane } from "./SwimLane";
import { VirtualizedSwimLane } from "./VirtualizedSwimLane";
import {
  SubAgentConnector,
  pickSpawnEvent,
  type SubAgentConnectorSpec,
} from "./SubAgentConnector";
import { bucketFor, groupChildrenUnderParents } from "@/lib/fleet-ordering";
import { deriveRelationship } from "@/lib/relationship";
import { eventsCache } from "@/hooks/useSessionEvents";

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
  /**
   * Per-flavor on-demand session lists, keyed by flavor (which is
   * the agent_id under D115). When the map has an entry for a given
   * flavor, the SwimLane's expanded SESSIONS drawer renders from it
   * instead of the 24-hour Fleet-windowed ``f.sessions`` subset, so
   * old / closed sessions appear in the drawer but NOT on the main
   * event-circle row. Populated by the fleet store's
   * ``loadExpandedSessions(agentId)`` action.
   */
  expandedSessions?: Map<string, import("@/lib/types").Session[]>;
  onNodeClick: (sessionId: string, eventId?: string, event?: import("@/lib/types").AgentEvent) => void;
  activeFilter?: string | null;
  paused?: boolean;
  pausedAt?: Date | null;
  /**
   * "Effective now" in ms-epoch form, owned by Fleet. When provided,
   * it replaces the local `now` tick + rAF fallback below -- Fleet's
   * single source of truth drives the scale domain's right edge, the
   * live feed cutoff, and the token counter in lockstep. Optional so
   * existing unit tests that mount <Timeline> directly without Fleet
   * keep working via the wall-clock fallback.
   */
  effectiveNowMs?: number;
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
  expandedSessions,
  onNodeClick,
  activeFilter,
  paused,
  pausedAt,
  effectiveNowMs,
  sessionVersions,
  matchingSessionIds = null,
}: TimelineProps) {
  // Resizable left panel width. Persisted to localStorage so the
  // user's preference survives page reloads. Clamped on init AND on
  // every drag so a stale storage value can't push the panel past
  // its bounds.
  const [leftPanelWidth, setLeftPanelWidth] = useState<number>(
    readPersistedLeftPanelWidth,
  );

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

  const handleResizeStart = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // Pointer Events rather than mouse events. Firefox aborts a
      // global ``mousemove`` drag the moment its text-selection
      // heuristic kicks in over any text-bearing ancestor (the
      // swimlane's flavor labels / agent names) —
      // ``e.preventDefault()`` on mousedown isn't sufficient because
      // Firefox restarts the selection on the first ``mousemove`` it
      // gets to itself. Pointer events sit in a separate event class
      // that bypasses text-selection heuristics in every modern
      // browser. Same fix applied in
      // ``components/fleet/FleetPanel.tsx`` and
      // ``pages/Investigate.tsx``.
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = leftPanelWidthRef.current;

      const onMove = (ev: PointerEvent) => {
        const delta = ev.clientX - startX;
        const next = Math.min(
          LEFT_PANEL_MAX_WIDTH,
          Math.max(LEFT_PANEL_MIN_WIDTH, startWidth + delta),
        );
        setLeftPanelWidth(next);
        // persistLeftPanelWidth writes localStorage AND fires a same-
        // tab CustomEvent so Fleet.tsx's left-fade overlay tracks the
        // column's right edge as the user drags.
        persistLeftPanelWidth(next);
      };

      const onUp = () => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.removeEventListener("pointercancel", onUp);
      };

      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
      document.addEventListener("pointercancel", onUp);
    },
    [],
  );

  // Live-updating "now" — throttled to 10fps (100ms) for performance.
  // The tick is kept alive as long as there is at least one event
  // circle inside the current [scaleStart, scaleEnd] domain across
  // any session in the fleet; see hasVisibleEventsInWindow below.
  // The previous implementation gated this on liveSessionCount
  // (number of active/idle/stale sessions), which froze the clock
  // whenever every session was closed/lost -- even while closed-
  // session circles were still visible. Those frozen circles then
  // failed to scroll out of the time window because the time window
  // itself stopped advancing. Keying off visible events instead
  // makes the clock track whatever is actually being drawn.
  const [now, setNow] = useState(() => new Date());

  // scaleEndMs / rangeMs are derived below from `now`; forward-
  // declare them at their final values so the visibility memo can
  // depend on them. They are declared inside useMemo below too, but
  // we need their primitive ms form for this dependency list. See
  // rawEndMs / scaleEndMs computation a few lines down.
  const rangeMs = TIMELINE_RANGE_MS[timeRange] ?? 60_000;
  // Prefer Fleet's effectiveNowMs (pause / catch-up / live all
  // collapse into a single ms-epoch there). Fall back to the local
  // paused/pausedAt/now chain for standalone test mounts.
  const rawEndMs =
    effectiveNowMs !== undefined
      ? effectiveNowMs
      : paused && pausedAt
        ? pausedAt.getTime()
        : now.getTime();
  const scaleEndMs = Math.floor(rawEndMs / 1000) * 1000;

  // True when any session in the fleet has at least one cached event
  // whose occurred_at lands inside the current [scaleStart, scaleEnd]
  // domain. Drives:
  //   1. the rAF tick's stop condition (visible circles must keep
  //      scrolling with the time window), and
  //   2. the AllSwimLane visibility gate passed below (the ALL row
  //      should hide only when the window is completely empty, not
  //      when all sessions happen to be closed).
  //
  // Reads straight from the module-level eventsCache populated by
  // useSessionEvents -- no new API calls, no new state. sessionVersions
  // is a dep so WebSocket-injected events force a recompute.
  const hasVisibleEventsInWindow = useMemo(() => {
    const startMs = scaleEndMs - rangeMs;
    // Upper bound uses `t >= startMs` only, not a hard `t <= scaleEndMs`.
    // scaleEndMs is floored to 1-second granularity (see comment further
    // down), so an event whose occurred_at lands in the current (partial)
    // second would otherwise fail the check and the ALL row would flicker
    // off between the floor boundary and the next tick. A just-arrived
    // WebSocket event with t slightly past scaleEndMs also counts here,
    // which is what lets the rAF restart when new activity arrives after
    // the timeline has gone idle.
    for (const f of flavors) {
      for (const s of f.sessions) {
        const cached = eventsCache.get(s.session_id);
        if (!cached) continue;
        for (const e of cached) {
          const t = new Date(e.occurred_at).getTime();
          if (t >= startMs) return true;
        }
      }
    }
    return false;
    // Phase 4.5 M-29 justification: ``sessionVersions`` is the
    // membership-change signal; flavors[].sessions[].events identity
    // changes via the same per-session version bump, so deps are
    // funnelled through ``sessionVersions`` rather than the deep
    // event arrays. Adding the deep ``events`` would be either
    // wrong (no membership change → no re-fire) or redundant
    // (covered by versions). ``startMs`` derives from
    // ``scaleEndMs`` and ``rangeMs`` already in deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flavors, sessionVersions, scaleEndMs, rangeMs]);

  useEffect(() => {
    if (paused) return;
    // Fleet drives re-renders via effectiveNowMs; the local rAF is
    // a no-op in that path. Unit tests that mount Timeline directly
    // still hit the fallback below.
    if (effectiveNowMs !== undefined) return;
    if (!hasVisibleEventsInWindow) {
      // Nothing to animate right now. Snap `now` to the wall clock
      // once so scaleEnd catches up -- this is what lets a fresh
      // WebSocket event (which bumps sessionVersions → re-renders →
      // hasVisibleEventsInWindow recomputes with the snapped
      // scaleEnd) flip the flag back to true and restart the rAF.
      // Without this snap, scaleEnd would stay frozen at the value
      // it held when rAF last stopped, and a new event arriving at
      // wall-clock would sit just outside [scaleStart, scaleEnd]
      // forever.
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
  }, [paused, hasVisibleEventsInWindow, effectiveNowMs]);

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
    // D126 UX revision 2026-05-03 — β-grouping. Group child flavors
    // immediately under their parent flavor in the visible list.
    // ``deriveRelationship`` resolves each flavor's
    // ``parentAgentId`` against the visible fleet; ``groupChildren-
    // UnderParents`` reorders so each child sits right after its
    // parent. Within a parent group, children sort by their
    // earliest session's ``started_at`` ASC (spawn-time order).
    // Lone flavors and parents whose parent isn't visible keep
    // their natural activity-bucket position from the upstream
    // sort owned by Fleet's store.
    const earliestStartedAt = (f: typeof result[number]): string => {
      let earliest: string | undefined;
      for (const s of f.sessions) {
        if (!earliest || s.started_at < earliest) earliest = s.started_at;
      }
      return earliest ?? "";
    };
    const parentByFlavor = new Map<string, string | null>();
    for (const f of result) {
      const rel = deriveRelationship(f.flavor, f.sessions, result);
      parentByFlavor.set(
        f.flavor,
        rel.mode === "child" ? rel.parentAgentId : null,
      );
    }
    return groupChildrenUnderParents(result, {
      id: (f) => f.flavor,
      parentId: (f) => parentByFlavor.get(f.flavor) ?? null,
      childOrder: (f) => earliestStartedAt(f),
    });
  }, [flavors, flavorFilter, matchingSessionIds]);

  // D126 UX revision 2026-05-03 — topology lookup keyed by flavor.
  // Built once per filteredFlavors change so the per-row prop look-
  // up stays O(1) at render time. ``"child"`` rows light up the
  // ``[data-topology="child"]`` indent + bg-tint via globals.css.
  const topologyByFlavor = useMemo(() => {
    const m = new Map<string, "root" | "child">();
    const visibleIds = new Set(filteredFlavors.map((f) => f.flavor));
    for (const f of filteredFlavors) {
      const rel = deriveRelationship(f.flavor, f.sessions, filteredFlavors);
      const isChild =
        rel.mode === "child" && visibleIds.has(rel.parentAgentId);
      m.set(f.flavor, isChild ? "child" : "root");
    }
    return m;
  }, [filteredFlavors]);

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
  // rangeMs / rawEndMs / scaleEndMs are declared above because
  // hasVisibleEventsInWindow depends on them; scaleEnd (Date object)
  // stays here next to its consumers.
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

  // D126 § 4.3 — sub-agent time-flow connector overlay. Hooks
  // declared BEFORE the empty-fleet early return below per the
  // rules-of-hooks contract; the useLayoutEffect's body short-
  // circuits cleanly when there's nothing to measure.
  const innerContentRef = useRef<HTMLDivElement | null>(null);
  const [connectorSpecs, setConnectorSpecs] = useState<
    SubAgentConnectorSpec[]
  >([]);
  const [overlaySize, setOverlaySize] = useState<{
    width: number;
    height: number;
  }>({ width: 0, height: 0 });
  // Connector specs depend on ``eventsCache`` which is a module-
  // level Map populated asynchronously by ``useSessionEvents``
  // per-session fetches. The cache mutation does NOT trigger a
  // Timeline re-render (the per-session hooks bump their own
  // local state, not Timeline's), so the layout effect would
  // freeze on its empty-cache snapshot. Bumping a nonce on a
  // short interval forces the effect to re-fire until specs
  // are stable. The interval clears itself once specs are
  // non-empty AND a maximum back-off elapses to keep the
  // overhead bounded on long-lived dashboards.
  const [connectorNonce, setConnectorNonce] = useState(0);
  useEffect(() => {
    // Bump every 1s for the lifetime of the page. The cost is one
    // useLayoutEffect re-run per second per Timeline mount, which
    // is dwarfed by the rAF cadence the rest of the timeline
    // already drives. Keeping the bump always-on rather than time-
    // boxing covers slow-fetch scenarios where the test runner
    // takes > 10s to settle a page (parallel-worker contention,
    // cold-cache reload), which surfaced as flaky T34 runs.
    const id = window.setInterval(() => {
      setConnectorNonce((n) => n + 1);
    }, 1000);
    return () => window.clearInterval(id);
  }, []);
  useLayoutEffect(() => {
    const container = innerContentRef.current;
    if (!container) return;
    const containerRect = container.getBoundingClientRect();
    setOverlaySize({
      width: containerRect.width,
      height: containerRect.height,
    });
    // session_id → row element via the SwimLane outer wrapper's
    // data-agent-id attribute. Each session lives under exactly one
    // agent (D126 § 2 identity model) so the lookup is single-hop.
    const sessionToRow = new Map<string, HTMLElement>();
    for (const f of filteredFlavors) {
      const row = container.querySelector<HTMLElement>(
        `[data-agent-id="${CSS.escape(f.flavor)}"]`,
      );
      if (!row) continue;
      for (const s of f.sessions) {
        sessionToRow.set(s.session_id, row);
      }
    }
    const specs: SubAgentConnectorSpec[] = [];
    const seen = new Set<string>();
    const domain = scale.domain();
    const [domainStartDate, domainEndDate] = [domain[0], domain[1]];
    if (!domainStartDate || !domainEndDate) return;
    const domainStart = domainStartDate.getTime();
    const domainEnd = domainEndDate.getTime();
    for (const childFlavor of filteredFlavors) {
      for (const childSession of childFlavor.sessions) {
        const parentId = childSession.parent_session_id;
        if (!parentId) continue;
        const parentRow = sessionToRow.get(parentId);
        const childRow = sessionToRow.get(childSession.session_id);
        // Both rows must currently be MOUNTED (not virtualized as a
        // spacer). VirtualizedSwimLane's spacer carries no
        // data-agent-id, so the lookup naturally returns undefined
        // for evicted rows and the connector skips them.
        if (!parentRow || !childRow) continue;
        if (parentRow === childRow) continue;
        const parentEvents = eventsCache.get(parentId);
        const childEvents = eventsCache.get(childSession.session_id);
        if (!parentEvents?.length || !childEvents?.length) continue;
        const childFirstEvent = childEvents[0];
        if (!childFirstEvent) continue;
        const parentSpawnEvent = pickSpawnEvent(parentEvents, childFirstEvent);
        if (!parentSpawnEvent) continue;
        const parentTs = new Date(parentSpawnEvent.occurred_at).getTime();
        const childTs = new Date(childFirstEvent.occurred_at).getTime();
        if (
          parentTs < domainStart ||
          parentTs > domainEnd ||
          childTs < domainStart ||
          childTs > domainEnd
        ) {
          continue;
        }
        const parentX =
          leftPanelWidth + (scale(new Date(parentTs)) as number);
        const childX =
          leftPanelWidth + (scale(new Date(childTs)) as number);
        const parentRect = parentRow.getBoundingClientRect();
        const childRect = childRow.getBoundingClientRect();
        const parentY =
          parentRect.top - containerRect.top + parentRect.height / 2;
        const childY =
          childRect.top - containerRect.top + childRect.height / 2;
        const id = `${parentId}->${childSession.session_id}`;
        if (seen.has(id)) continue;
        seen.add(id);
        specs.push({
          id,
          parentX,
          parentY,
          parentR: EVENT_CIRCLE_SIZE / 2,
          childX,
          childY,
        });
      }
    }
    setConnectorSpecs(specs);
  }, [
    filteredFlavors,
    scale,
    leftPanelWidth,
    expandedFlavors,
    sessionVersions,
    connectorNonce,
  ]);

  // Bucket-divider rows interleaved with VirtualizedSwimLane rows.
  // Walks ``filteredFlavors`` once, tracking the previous ROOT
  // flavor's bucket so a thin horizontal divider is injected at
  // LIVE→RECENT and RECENT→IDLE transitions between parent-child
  // clusters (no label, just a visual gap). Bucket-for reads
  // ``last_seen_at`` against ``rawEndMs`` so it picks up the rAF
  // pause / catch-up time source Fleet drives.
  //
  // Children (topology="child") are SKIPPED for divider calculation
  // and don't advance ``prevBucket``: a parent and its sub-agents
  // share one visual group regardless of each row's individual
  // bucket. Without this skip the loop would inject a divider
  // between a LIVE parent and its RECENT-bucket child (closed
  // sub-agent), splitting the cluster mid-group. The divider key
  // is also pinned to the flavor it precedes so duplicate
  // (prev → next) bucket transitions across the list don't collide
  // on a shared `bucket-live-to-recent` key — that collision was
  // the root of the "dividers accumulate" visual artifact reported
  // on PR #33.
  //
  // Declared above the conditional `flavors.length === 0` early
  // return so the hook order stays stable on every render
  // (rules-of-hooks). The empty-fleet branch never references
  // ``swimlaneRows`` so the wasted memo is purely cosmetic.
  const swimlaneRows = useMemo(() => {
    let prevBucket: "live" | "recent" | "idle" | null = null;
    const rendered: React.ReactNode[] = [];
    for (const f of filteredFlavors) {
      const isChild = topologyByFlavor.get(f.flavor) === "child";
      const b = bucketFor(f.last_seen_at, rawEndMs);
      if (!isChild && prevBucket !== null && b !== prevBucket) {
        rendered.push(
          <div
            key={`bucket-divider-before-${f.flavor}`}
            data-testid={`bucket-divider-${prevBucket}-${b}`}
            aria-hidden="true"
            style={{
              height: 1,
              background: "var(--border)",
              margin: "4px 0",
            }}
          />,
        );
      }
      rendered.push(
        <VirtualizedSwimLane
          key={f.flavor}
          flavor={f.flavor}
          agentName={f.agent_name}
          clientType={f.client_type}
          agentType={f.agent_type}
          sessions={f.sessions}
          expandedSessions={expandedSessions?.get(f.flavor)}
          totalSessionsLifetime={f.session_count}
          scale={scale}
          onSessionClick={onNodeClick}
          expanded={expandedFlavors.has(f.flavor)}
          onToggleExpand={() => onExpandFlavor(f.flavor)}
          timelineWidth={timelineWidth}
          leftPanelWidth={leftPanelWidth}
          activeFilter={activeFilter}
          sessionVersions={sessionVersions}
          matchingSessionIds={matchingSessionIds}
          topology={topologyByFlavor.get(f.flavor) ?? "root"}
          onScrollToAgent={(agentId) => {
            // D126 § 7.fix.A — clicking the relationship pill jumps
            // to another agent's swimlane row. We already stamp
            // ``data-testid="swimlane-agent-row-<name>"`` on every
            // collapsed header, but the robust selector for client-
            // side scroll uses the agent_id itself; tag added on the
            // SwimLane outermost wrapper for this lookup. Fallback
            // to hash anchor when querySelector misses (e.g. the
            // target agent isn't in the rendered viewport; the
            // virtualizer hasn't materialized it). See
            // lib/relationship.ts::scrollToAgentRow for the shared
            // rationale on the intentional querySelector bypass of
            // React refs.
            const target = document.querySelector(
              `[data-agent-id="${CSS.escape(agentId)}"]`,
            );
            if (target && "scrollIntoView" in target) {
              (target as HTMLElement).scrollIntoView({
                behavior: "smooth",
                block: "center",
              });
            }
          }}
        />,
      );
      // Only update prevBucket on root rows. Children inherit their
      // parent's cluster scope; advancing prevBucket on a child
      // would compare the next root row against the child's bucket,
      // producing a spurious divider between the cluster end and
      // the next root.
      if (!isChild) {
        prevBucket = b;
      }
    }
    return rendered;
  }, [
    filteredFlavors,
    topologyByFlavor,
    rawEndMs,
    expandedSessions,
    expandedFlavors,
    onExpandFlavor,
    onNodeClick,
    scale,
    timelineWidth,
    leftPanelWidth,
    activeFilter,
    sessionVersions,
    matchingSessionIds,
  ]);

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
  // No horizontal scrollbar — the entire row fits in the visible
  // area at every range.
  const innerWidth = timelineWidth + leftPanelWidth;

  return (
    <div
      className="relative"
      // overflow-y: clip (NOT hidden) does not establish a scroll
      // container, which lets the time axis row use position:
      // sticky; top: 0 against Fleet.tsx's outer vertical scroller.
      // overflow-x: visible was overflow-x: hidden pre-S-SWIM; the
      // hidden value clipped Timeline's content at its parent's
      // clientWidth, which meant Fleet's S-SWIM horizontal scroll
      // container saw no overflow even when innerWidth (leftPanel +
      // 900px timeline) exceeded the viewport. visible lets content
      // extend into Fleet's scroll context where the user can pan
      // to it; the timeline's natural right edge is still at
      // innerWidth so nothing renders beyond it.
      style={{ overflowX: "visible", overflowY: "clip" }}
      data-testid="timeline-scroll"
    >
      <div
        ref={innerContentRef}
        style={{ width: innerWidth, minWidth: "100%", position: "relative" }}
      >
        {/* D126 § 4.3 — sub-agent connector overlay. Sits at
            z-index 2 (above grid lines, below event circles) so
            connector lines paint between the parent's spawn event
            and the child's first event without obscuring either
            endpoint. The overlay's pointerEvents are limited to
            the path stroke so swimlane row clicks pass through
            empty connector space. */}
        <SubAgentConnector
          connectors={connectorSpecs}
          width={overlaySize.width}
          height={overlaySize.height}
        />
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

        {/* Full-height drag handle for resizing the left panel. Lives
            here, as a sibling of the grid overlay, rather than inside
            the 28-px sticky time-axis spacer above -- that placement
            clipped the grab area to a thin strip next to the top
            pills, which was too small to be discoverable or reliable.
            Positioned at `left: leftPanelWidth - 3` so the 6-px-wide
            handle straddles the label column's right border. zIndex
            10 sits above the sticky time axis (z 4) and the grid
            overlay (z 1) so the user can still grab it while hovering
            a pill or a grid line. */}
        <div
          data-testid="left-panel-resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize left panel"
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: leftPanelWidth - 3,
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
          // Pointer events (not mouse) so Firefox does not abort the
          // drag the moment its text-selection heuristic fires over a
          // label-bearing ancestor — see handleResizeStart docstring.
          onPointerDown={handleResizeStart}
          // ``touch-action: none`` opts the handle out of the
          // browser's default touch panning so a finger drag also
          // resizes instead of scrolling the page.
          onTouchStart={(e) => e.preventDefault()}
        />

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
              leftPanelWidth. The resize handle that used to live
              inside this 28-px spacer is now rendered as a sibling
              of the grid-lines overlay (outside the sticky time-
              axis row) so its height spans the full swimlane --
              see the comment on the handle div below. */}
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
          hasVisibleEventsInWindow={hasVisibleEventsInWindow}
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
              Agents
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
        {swimlaneRows}
      </div>
    </div>
  );
}
