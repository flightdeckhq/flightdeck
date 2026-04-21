import { memo, useMemo } from "react";
import type { ScaleTime } from "d3-scale";
import type { Session, AgentEvent } from "@/lib/types";
import { SESSION_ROW_HEIGHT, EVENT_CIRCLE_SIZE } from "@/lib/constants";
import { ChevronRight } from "lucide-react";
import { SessionEventRow } from "./SessionEventRow";
import { EventNode } from "./EventNode";
import { useSessionEvents, attachmentsCache } from "@/hooks/useSessionEvents";
import { isAttachmentStartEvent, isEventVisible } from "@/lib/events";
import { ClaudeCodeLogo } from "@/components/ui/claude-code-logo";

interface SwimLaneProps {
  flavor: string;
  sessions: Session[];
  scale: ScaleTime<number, number>;
  onSessionClick: (sessionId: string, eventId?: string, event?: AgentEvent) => void;
  expanded: boolean;
  onToggleExpand: () => void;
  /**
   * Width of the event-circles area in pixels. The full row width is
   * leftPanelWidth + timelineWidth. The right (event circles) panel
   * is sized exactly to this value so xScale.range = [0, timelineWidth]
   * and circles cannot escape into adjacent layout space.
   */
  timelineWidth: number;
  /**
   * Current resizable width of the left label / session-info panel.
   * Flows from Timeline.tsx's useState into every SwimLane and
   * SessionEventRow so drag updates on the Flavors header row
   * resize every row in lockstep.
   */
  leftPanelWidth: number;
  activeFilter?: string | null;
  sessionVersions?: Record<string, number>;
  /**
   * Set of session IDs that match the active CONTEXT sidebar filter.
   * null = no filters active, every session is fully visible.
   * Sessions not in the set render at opacity 0.15 with
   * pointer-events: none.
   */
  matchingSessionIds?: Set<string> | null;
}

function SwimLaneComponent({
  flavor,
  sessions,
  scale,
  onSessionClick,
  expanded,
  onToggleExpand,
  timelineWidth,
  leftPanelWidth,
  activeFilter,
  sessionVersions,
  matchingSessionIds = null,
}: SwimLaneProps) {
  // Live count = sessions that are currently active OR idle. The
  // server-side `activeCount` prop only counts state="active", but
  // for the swimlane header we want to count idle sessions as live
  // too -- an idle agent is still alive and ready to make calls.
  // Drives both the displayed number and its color (green when > 0,
  // muted gray when 0).
  const liveCount = useMemo(
    () => sessions.filter((s) => s.state === "active" || s.state === "idle").length,
    [sessions],
  );

  // Pick a representative state suffix to display next to the flavor
  // name when no sessions are currently active or idle. Priority:
  // stale > closed > lost. Returns "" for active/idle flavors so the
  // suffix is hidden in the common case.
  //
  // The previous implementation used this as a trigger to collapse
  // the entire row to a compact 28px placeholder with no chevron and
  // no event circles. That was wrong: closed sessions still have
  // historical events from the last 1-30 minutes that platform
  // engineers need to see when they zoom out the time range.
  // Auto-collapse hid that data and made the swimlane unusable for
  // historical views. The compact branch is gone -- every flavor
  // renders at full 48px with full event circles and an expand
  // chevron, regardless of session state. Sort-by-activity (active
  // flavors at the top) is preserved -- only the auto-collapse row
  // is removed.
  const stateSuffix = useMemo(() => {
    if (liveCount > 0) return "";
    const states = new Set(sessions.map((s) => s.state));
    if (states.has("stale")) return "(stale)";
    if (states.has("closed")) return "(closed)";
    if (states.has("lost")) return "(lost)";
    return "";
  }, [liveCount, sessions]);

  // Count of sessions that will actually render in the expanded
  // view. When a CONTEXT filter is active, non-matching sessions
  // are omitted from the map below, so the maxHeight animation and
  // the SESSIONS sub-header count should reflect the visible subset.
  const visibleSessionCount = useMemo(() => {
    if (matchingSessionIds === null) return sessions.length;
    return sessions.filter((s) =>
      matchingSessionIds.has(s.session_id),
    ).length;
  }, [sessions, matchingSessionIds]);

  return (
    <div style={{ borderBottom: "1px solid var(--border-subtle)" }}>
      {/* Collapsed flavor header — 48px */}
      <div
        className="flex h-12 cursor-pointer items-center"
        style={{ background: expanded ? "var(--bg-elevated)" : "var(--bg)" }}
        onClick={onToggleExpand}
      >
        {/* Left panel — sticky so it stays pinned during horizontal scroll.
            Width tracks the resizable leftPanelWidth state owned by
            Timeline.tsx. */}
        <div
          className="flex h-full items-center gap-2 px-3"
          style={{
            width: leftPanelWidth,
            flexShrink: 0,
            background: expanded ? "var(--bg-elevated)" : "var(--surface)",
            borderRight: "1px solid var(--border)",
            position: "sticky",
            left: 0,
            zIndex: 2,
            overflow: "hidden",
          }}
        >
          <ChevronRight
            size={14}
            style={{
              color: "var(--text-muted)",
              transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
              transition: "transform 200ms ease",
            }}
          />
          {flavor === "claude-code" && (
            <ClaudeCodeLogo size={14} className="shrink-0" />
          )}
          <span
            className="text-[13px] font-medium"
            style={{
              color: "var(--text)",
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {flavor}
          </span>
          <span
            className="font-mono text-[11px]"
            style={{
              color: liveCount > 0 ? "var(--status-active)" : "var(--text-muted)",
              flexShrink: 0,
            }}
            data-testid="swimlane-active-count"
          >
            {liveCount} active
          </span>
          {stateSuffix && (
            <span
              className="font-mono text-[11px]"
              style={{ color: "var(--text-muted)", flexShrink: 0 }}
              data-testid="swimlane-state-suffix"
            >
              {stateSuffix}
            </span>
          )}
        </div>

        {/* Right panel — aggregated events. Sized to exactly
            timelineWidth so xScale.range = [0, timelineWidth] and
            circles cannot escape into adjacent layout. overflow:
            hidden clips any visual that would otherwise leak into
            the next row. */}
        <div
          className="relative h-full flex items-center px-1"
          style={{
            width: timelineWidth,
            flexShrink: 0,
            overflow: "hidden",
          }}
        >
          <AggregatedSwimLane
            sessions={sessions}
            scale={scale}
            onSessionClick={onSessionClick}
            flavor={flavor}
            activeFilter={activeFilter}
            sessionVersions={sessionVersions}
          />
        </div>
      </div>

      {/* Expanded session rows. The +28 in maxHeight reserves space
          for the SESSIONS sub-header (20px) plus the py-1 padding.
          SESSION_ROW_HEIGHT is centralised in constants so the
          animation stays in sync if we ever bump the row height
          again.

          When a CONTEXT filter is active, matchingSessionIds names
          the subset of sessions that match. Non-matching sessions
          are hidden entirely (return null in the map below), so
          the maxHeight allocation uses visibleSessionCount -- the
          expanded section collapses to the smaller subset size
          rather than leaving blank gaps for hidden rows. */}
      <div
        style={{
          maxHeight: expanded
            ? visibleSessionCount * SESSION_ROW_HEIGHT + 28
            : 0,
          opacity: expanded ? 1 : 0,
          overflow: "hidden",
          transition: "max-height 300ms ease, opacity 200ms ease",
          borderLeft: expanded ? "2px solid var(--accent)" : undefined,
          background: expanded ? "var(--surface)" : undefined,
        }}
      >
        {expanded && (
          <div className="py-1">
            {/* SESSIONS sub-header.
                Same flex pattern as the FLAVORS row above: a 240px
                sticky-left label slot pinned to the viewport's left
                edge, plus a filler that extends the row so the border
                draws across the timeline. The 32px paddingLeft inside
                the sticky slot indents the label to match the
                indented session row labels below. */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                height: 20,
                borderBottom: "1px solid var(--border-subtle)",
                background: "var(--surface)",
                width: leftPanelWidth + timelineWidth,
              }}
            >
              <div
                style={{
                  width: leftPanelWidth,
                  flexShrink: 0,
                  position: "sticky",
                  left: 0,
                  zIndex: 2,
                  background: "var(--surface)",
                  display: "flex",
                  alignItems: "center",
                  height: "100%",
                  paddingLeft: 32,
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
                  Sessions
                </span>
              </div>
              <div style={{ width: timelineWidth, flexShrink: 0 }} />
            </div>
            {sessions.map((session, sessionIndex) => {
              // Hide sessions that don't match the active CONTEXT
              // sidebar filter. matchingSessionIds === null means
              // no filters are active and every row is fully visible.
              // Non-matching sessions return null entirely rather
              // than rendering at 0.15 opacity -- the previous
              // dimming approach made the UI look broken ("why are
              // some rows ghosted?") rather than filtered. The
              // filter status bar in Fleet.tsx surfaces the count
              // and a clear button so the user knows sessions are
              // hidden by intent.
              if (
                matchingSessionIds !== null &&
                !matchingSessionIds.has(session.session_id)
              ) {
                return null;
              }
              return (
                <SessionEventRow
                  key={session.session_id}
                  session={session}
                  sessionIndex={sessionIndex}
                  scale={scale}
                  onClick={(eventId, event) =>
                    onSessionClick(session.session_id, eventId, event)
                  }
                  timelineWidth={timelineWidth}
                  leftPanelWidth={leftPanelWidth}
                  activeFilter={activeFilter}
                  version={sessionVersions?.[session.session_id] ?? 0}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export const SwimLane = memo(SwimLaneComponent, (prev, next) => {
  if (prev.flavor !== next.flavor) return false;
  if (prev.sessions !== next.sessions) return false;
  if (prev.expanded !== next.expanded) return false;
  if (prev.activeFilter !== next.activeFilter) return false;
  if (prev.sessionVersions !== next.sessionVersions) return false;
  if (prev.timelineWidth !== next.timelineWidth) return false;
  if (prev.leftPanelWidth !== next.leftPanelWidth) return false;
  if (prev.matchingSessionIds !== next.matchingSessionIds) return false;
  // Only re-render for scale changes > 1 second. Compare BOTH ends of
  // the domain: `scaleEnd` drifts in lockstep with wall-clock time, but
  // `start = scaleEnd - rangeMs` jumps by minutes when the user switches
  // time window. Gating on scaleEnd alone froze the swimlane after a
  // 1h→1m switch because scaleEnd barely moved, so the memo bailed out
  // and the new (tighter) domain never reached the clip/x-position memo.
  const domainDeltaEnd = Math.abs(
    next.scale.domain()[1].getTime() - prev.scale.domain()[1].getTime()
  );
  const domainDeltaStart = Math.abs(
    next.scale.domain()[0].getTime() - prev.scale.domain()[0].getTime()
  );
  if (domainDeltaEnd < 1000 && domainDeltaStart < 1000) return true;
  return false;
});

/**
 * Aggregate "ALL" row that sits above the FLAVORS section. Renders a
 * single non-expandable lane whose event circles are merged from every
 * session across every flavor, so operators get a fleet-wide view of
 * activity without scanning each flavor row.
 *
 * Unlike SwimLane, this row:
 *   - has no expand chevron, no active count, no kill controls
 *   - is shorter (36px vs 48px) to signal "summary, not a flavor"
 *   - is NOT affected by the CONTEXT sidebar filter (always shows
 *     everything -- it's a fleet-wide overview)
 *   - DOES respect the event-type filter bar, like SwimLane does,
 *     because dimming filtered event types is a per-circle concern
 *     handled inside EventNode via `isVisible`
 *
 * No new API or WebSocket subscriptions: AggregatedSessionEvents reads
 * the same per-session events cache populated by the per-flavor rows.
 */
interface AllSwimLaneProps {
  flavors: { flavor: string; sessions: Session[] }[];
  scale: ScaleTime<number, number>;
  onSessionClick: (sessionId: string, eventId?: string, event?: AgentEvent) => void;
  timelineWidth: number;
  leftPanelWidth: number;
  activeFilter?: string | null;
  sessionVersions?: Record<string, number>;
  /**
   * True when any session (regardless of state) has at least one
   * cached event inside the current [scaleStart, scaleEnd] domain.
   * Timeline.tsx computes this once for the whole fleet and hands it
   * down so the ALL row's hide rule matches what the user sees -- a
   * row full of circles from closed sessions still surfaces, and an
   * empty time window hides even while sessions are active.
   */
  hasVisibleEventsInWindow: boolean;
}

function AllSwimLaneComponent({
  flavors,
  scale,
  onSessionClick,
  timelineWidth,
  leftPanelWidth,
  activeFilter,
  sessionVersions,
  hasVisibleEventsInWindow,
}: AllSwimLaneProps) {
  // Hide the ALL row only when there is literally nothing to draw in
  // the current [scaleStart, scaleEnd] domain. The previous rule
  // gated on liveSessionCount (active|idle|stale) and incorrectly
  // hid the row while closed-session circles were still inside the
  // visible window -- which is exactly when operators need the
  // fleet-wide summary to stay visible. See Timeline.tsx for the
  // shared hasVisibleEventsInWindow calculation.
  if (!hasVisibleEventsInWindow) return null;

  return (
    <div
      data-testid="swimlane-all"
      style={{
        display: "flex",
        alignItems: "center",
        height: 36,
        borderBottom: "1px solid var(--border-subtle)",
        background: "var(--bg)",
      }}
    >
      <div
        style={{
          width: leftPanelWidth,
          flexShrink: 0,
          height: "100%",
          background: "var(--surface)",
          borderRight: "1px solid var(--border)",
          position: "sticky",
          left: 0,
          zIndex: 2,
          display: "flex",
          alignItems: "center",
          paddingLeft: 12,
        }}
      >
        <span
          data-testid="swimlane-all-label"
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: "0.08em",
            color: "var(--text-muted)",
            textTransform: "uppercase",
            fontFamily: "var(--font-ui)",
          }}
        >
          All
        </span>
      </div>
      <div
        className="relative flex items-center px-1"
        style={{
          width: timelineWidth,
          flexShrink: 0,
          height: "100%",
          overflow: "hidden",
        }}
      >
        {flavors.flatMap((f) =>
          f.sessions.map((session) => (
            <AggregatedSessionEvents
              key={`${f.flavor}:${session.session_id}`}
              session={session}
              scale={scale}
              onSessionClick={onSessionClick}
              flavor={f.flavor}
              activeFilter={activeFilter}
              version={sessionVersions?.[session.session_id] ?? 0}
            />
          )),
        )}
      </div>
    </div>
  );
}

/**
 * Memoised wrapper for the ALL row. Mirrors SwimLane.memo's custom
 * equality: bail out for sub-second domain deltas so rAF-driven
 * Timeline re-renders don't propagate into the ALL row's per-session
 * event mapping. Without this, the ALL row re-rendered at the full
 * rAF cadence (~10x/sec) while per-flavor SwimLanes dampened to ~1/s.
 */
export const AllSwimLane = memo(AllSwimLaneComponent, (prev, next) => {
  if (prev.flavors !== next.flavors) return false;
  if (prev.activeFilter !== next.activeFilter) return false;
  if (prev.sessionVersions !== next.sessionVersions) return false;
  if (prev.timelineWidth !== next.timelineWidth) return false;
  if (prev.leftPanelWidth !== next.leftPanelWidth) return false;
  if (prev.onSessionClick !== next.onSessionClick) return false;
  if (prev.hasVisibleEventsInWindow !== next.hasVisibleEventsInWindow) return false;
  // Both domain ends must be stable; see the SwimLane memo above for
  // why checking only scaleEnd froze the row after time-range changes.
  const domainDeltaEnd = Math.abs(
    next.scale.domain()[1].getTime() - prev.scale.domain()[1].getTime(),
  );
  const domainDeltaStart = Math.abs(
    next.scale.domain()[0].getTime() - prev.scale.domain()[0].getTime(),
  );
  if (domainDeltaEnd < 1000 && domainDeltaStart < 1000) return true;
  return false;
});

/** Shows aggregated 20px event circles from all sessions of a flavor. */
function AggregatedSwimLane({
  sessions,
  scale,
  onSessionClick,
  flavor,
  activeFilter,
  sessionVersions,
}: {
  sessions: Session[];
  scale: ScaleTime<number, number>;
  onSessionClick: (sessionId: string, eventId?: string, event?: AgentEvent) => void;
  flavor: string;
  activeFilter?: string | null;
  sessionVersions?: Record<string, number>;
}) {
  return (
    <div className="relative h-full w-full">
      {sessions.map((session) => (
        <AggregatedSessionEvents
          key={session.session_id}
          session={session}
          scale={scale}
          onSessionClick={onSessionClick}
          flavor={flavor}
          activeFilter={activeFilter}
          version={sessionVersions?.[session.session_id] ?? 0}
        />
      ))}
    </div>
  );
}

function AggregatedSessionEvents({
  session,
  scale,
  onSessionClick,
  flavor,
  activeFilter,
  version = 0,
}: {
  session: Session;
  scale: ScaleTime<number, number>;
  onSessionClick: (sessionId: string, eventId?: string, event?: AgentEvent) => void;
  flavor: string;
  activeFilter?: string | null;
  version?: number;
}) {
  const isActive = session.state === "active";
  const { events } = useSessionEvents(session.session_id, isActive, version);

  // Clip events to the current scale domain before building nodes.
  // useSessionEvents caches every event ever fetched for a session, so
  // without this filter a 50-session fleet at a 1-minute view could
  // render thousands of EventNodes whose x positions lie outside the
  // 0..timelineWidth canvas -- the circles were clipped visually by
  // overflow:hidden but still cost full style recalc. Filtering here
  // keeps them out of the DOM entirely.
  //
  // Attachments are sampled inside the memo on the same fetch path
  // as events so a fresh cache populates both atomically. See
  // SessionEventRow for the same pattern.
  const nodes = useMemo(() => {
    const [domainStart, domainEnd] = scale.domain();
    const startMs = domainStart.getTime();
    const endMs = domainEnd.getTime();
    const attachments = attachmentsCache.get(session.session_id) ?? [];
    return events
      .filter((event) => {
        const t = new Date(event.occurred_at).getTime();
        return t >= startMs && t <= endMs;
      })
      .map((event) => ({
        id: event.id,
        x: scale(new Date(event.occurred_at)),
        eventType: event.event_type,
        model: event.model,
        toolName: event.tool_name,
        tokensTotal: event.tokens_total,
        latencyMs: event.latency_ms,
        occurredAt: event.occurred_at,
        directiveName: event.payload?.directive_name,
        directiveStatus: event.payload?.directive_status,
        isAttachment: isAttachmentStartEvent(event, attachments),
      }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, scale, session.session_id, version]);

  return (
    <>
      {nodes.map((node) => (
        <EventNode
          key={node.id}
          x={node.x}
          eventType={node.eventType}
          sessionId={session.session_id}
          flavor={flavor}
          model={node.model}
          toolName={node.toolName}
          tokensTotal={node.tokensTotal}
          latencyMs={node.latencyMs}
          occurredAt={node.occurredAt}
          eventId={node.id}
          directiveName={node.directiveName}
          directiveStatus={node.directiveStatus}
          onClick={(eid) => {
            const fullEvent = events.find((e) => e.id === eid);
            onSessionClick(session.session_id, eid, fullEvent);
          }}
          size={EVENT_CIRCLE_SIZE}
          isVisible={isEventVisible(node.eventType, activeFilter)}
          isAttachment={node.isAttachment}
        />
      ))}
    </>
  );
}

