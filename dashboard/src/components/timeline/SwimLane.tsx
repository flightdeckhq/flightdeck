import { memo, useMemo } from "react";
import type { ScaleTime } from "d3-scale";
import type { Session, AgentEvent } from "@/lib/types";
import type { ViewMode } from "@/pages/Fleet";
import { LEFT_PANEL_WIDTH } from "@/lib/constants";
import { ChevronRight } from "lucide-react";
import { SessionEventRow } from "./SessionEventRow";
import { EventNode } from "./EventNode";
import { BarView } from "./BarView";
import { useSessionEvents } from "@/hooks/useSessionEvents";
import { isEventVisible } from "@/lib/events";

interface SwimLaneProps {
  flavor: string;
  activeCount: number;
  sessions: Session[];
  scale: ScaleTime<number, number>;
  onSessionClick: (sessionId: string, eventId?: string, event?: AgentEvent) => void;
  expanded: boolean;
  onToggleExpand: () => void;
  viewMode: ViewMode;
  start: Date;
  end: Date;
  /**
   * Width of the event-circles area in pixels. The full row width is
   * LEFT_PANEL_WIDTH + timelineWidth. The right (event circles) panel
   * is sized exactly to this value so xScale.range = [0, timelineWidth]
   * and circles cannot escape into adjacent layout space.
   */
  timelineWidth: number;
  activeFilter?: string | null;
  sessionVersions?: Record<string, number>;
}

function SwimLaneComponent({
  flavor,
  activeCount,
  sessions,
  scale,
  onSessionClick,
  expanded,
  onToggleExpand,
  viewMode,
  start,
  end,
  timelineWidth,
  activeFilter,
  sessionVersions,
}: SwimLaneProps) {
  // A flavor is "inactive" when none of its sessions are active or
  // idle -- only stale, closed, or lost. Inactive flavors render as
  // a compact 28px row (no chevron, no event circles, muted text)
  // so they sink to the bottom of the swimlane and stop blocking
  // active flavors from view. (FIX 3 -- part B)
  const isInactive = useMemo(
    () =>
      sessions.length > 0 &&
      !sessions.some((s) => s.state === "active" || s.state === "idle"),
    [sessions],
  );

  // Pick a single representative summary state for the inactive
  // label so the user knows why the flavor is dim. Priority:
  // stale > closed > lost.
  const inactiveSummary = useMemo(() => {
    if (!isInactive) return "";
    const states = new Set(sessions.map((s) => s.state));
    if (states.has("stale")) return "(stale)";
    if (states.has("closed")) return "(closed)";
    if (states.has("lost")) return "(lost)";
    return "(inactive)";
  }, [isInactive, sessions]);

  // Compact 28px inactive row -- no chevron, no event circles,
  // muted text, subtle border. The collapsed view never expands.
  if (isInactive) {
    return (
      <div
        className="flex items-center"
        style={{
          height: 28,
          borderBottom: "1px solid var(--border-subtle)",
          background: "var(--bg)",
        }}
        data-testid="swimlane-inactive"
      >
        <div
          className="flex h-full items-center gap-2 px-3"
          style={{
            width: LEFT_PANEL_WIDTH,
            flexShrink: 0,
            background: "var(--surface)",
            borderRight: "1px solid var(--border-subtle)",
            position: "sticky",
            left: 0,
            zIndex: 2,
            overflow: "hidden",
          }}
        >
          <span
            className="text-[12px] font-mono"
            style={{ color: "var(--text-muted)" }}
          >
            {flavor}
          </span>
          <span
            className="font-mono text-[11px]"
            style={{ color: "var(--text-muted)" }}
          >
            {inactiveSummary}
          </span>
        </div>
        <div
          className="relative h-full"
          style={{ width: timelineWidth, flexShrink: 0 }}
        />
      </div>
    );
  }

  return (
    <div style={{ borderBottom: "1px solid var(--border-subtle)" }}>
      {/* Collapsed flavor header — 48px */}
      <div
        className="flex h-12 cursor-pointer items-center"
        style={{ background: expanded ? "var(--bg-elevated)" : "var(--bg)" }}
        onClick={onToggleExpand}
      >
        {/* Left panel — sticky so it stays pinned during horizontal scroll */}
        <div
          className="flex h-full items-center gap-2 px-3"
          style={{
            width: LEFT_PANEL_WIDTH,
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
          <span className="text-[13px] font-medium" style={{ color: "var(--text)" }}>
            {flavor}
          </span>
          <span className="font-mono text-[11px]" style={{ color: "var(--status-active)" }}>
            {activeCount} active
          </span>
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
          {viewMode === "swimlane" ? (
            <AggregatedSwimLane
              sessions={sessions}
              scale={scale}
              onSessionClick={onSessionClick}
              flavor={flavor}
              activeFilter={activeFilter}
              sessionVersions={sessionVersions}
            />
          ) : (
            <AggregatedBarView
              sessions={sessions}
              start={start}
              end={end}
              width={timelineWidth}
              activeFilter={activeFilter}
            />
          )}
        </div>
      </div>

      {/* Expanded session rows. The +28 in maxHeight reserves space
          for the SESSIONS sub-header (20px) plus the py-1 padding. */}
      <div
        style={{
          maxHeight: expanded ? sessions.length * 40 + 28 : 0,
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
                width: LEFT_PANEL_WIDTH + timelineWidth,
              }}
            >
              <div
                style={{
                  width: LEFT_PANEL_WIDTH,
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
            {sessions.map((session) => (
              <SessionEventRow
                key={session.session_id}
                session={session}
                scale={scale}
                onClick={(eventId, event) => onSessionClick(session.session_id, eventId, event)}
                viewMode={viewMode}
                start={start}
                end={end}
                timelineWidth={timelineWidth}
                activeFilter={activeFilter}
                version={sessionVersions?.[session.session_id] ?? 0}
              />
            ))}
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
  if (prev.viewMode !== next.viewMode) return false;
  if (prev.activeFilter !== next.activeFilter) return false;
  if (prev.sessionVersions !== next.sessionVersions) return false;
  if (prev.timelineWidth !== next.timelineWidth) return false;
  // Only re-render for scale changes > 1 second
  const domainDelta = Math.abs(
    next.scale.domain()[1].getTime() - prev.scale.domain()[1].getTime()
  );
  if (domainDelta < 1000) return true;
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

  const nodes = useMemo(
    () =>
      events.map((event) => ({
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
      })),
    [events, scale]
  );

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
          size={20}
          isVisible={isEventVisible(node.eventType, activeFilter)}
        />
      ))}
    </>
  );
}

function AggregatedBarView({
  sessions,
  start,
  end,
  width,
  activeFilter,
}: {
  sessions: Session[];
  start: Date;
  end: Date;
  width: number;
  activeFilter?: string | null;
}) {
  // Collect all events from all sessions using hooks
  const eventArrays = sessions.map((s) => {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const { events } = useSessionEvents(s.session_id, s.state === "active");
    return events;
  });

  const allEvents = useMemo(() => eventArrays.flat(), [eventArrays]);

  return <BarView events={allEvents} start={start} end={end} width={Math.max(width, 100)} activeFilter={activeFilter} />;
}
