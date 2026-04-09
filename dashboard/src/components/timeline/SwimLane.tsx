import { useMemo, memo } from "react";
import type { ScaleTime } from "d3-scale";
import type { Session, AgentEvent } from "@/lib/types";
import type { ViewMode } from "@/pages/Fleet";
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
  width: number;
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
  width,
  activeFilter,
  sessionVersions,
}: SwimLaneProps) {
  return (
    <div style={{ borderBottom: "1px solid var(--border-subtle)" }}>
      {/* Collapsed flavor header — 48px */}
      <div
        className="flex h-12 cursor-pointer items-center"
        style={{ background: expanded ? "var(--bg-elevated)" : "var(--bg)" }}
        onClick={onToggleExpand}
      >
        {/* Left panel */}
        <div
          className="flex h-full w-[240px] shrink-0 items-center gap-2 px-3"
          style={{
            background: "var(--surface)",
            borderRight: "1px solid var(--border)",
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

        {/* Right panel — aggregated events (overflow hidden prevents circles leaking into left panel) */}
        <div className="relative h-full flex-1 flex items-center px-1 overflow-hidden">
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
              width={width - 240}
              activeFilter={activeFilter}
            />
          )}
        </div>
      </div>

      {/* Expanded session rows */}
      <div
        style={{
          maxHeight: expanded ? sessions.length * 40 + 8 : 0,
          opacity: expanded ? 1 : 0,
          overflow: "hidden",
          transition: "max-height 300ms ease, opacity 200ms ease",
          borderLeft: expanded ? "2px solid var(--accent)" : undefined,
          background: expanded ? "var(--surface)" : undefined,
        }}
      >
        {expanded && (
          <div className="py-1">
            {sessions.map((session) => (
              <SessionEventRow
                key={session.session_id}
                session={session}
                scale={scale}
                onClick={(eventId, event) => onSessionClick(session.session_id, eventId, event)}
                viewMode={viewMode}
                start={start}
                end={end}
                width={width - 240}
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
          onClick={() => onSessionClick(session.session_id)}
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
  onClick,
  flavor,
  activeFilter,
  version = 0,
}: {
  session: Session;
  scale: ScaleTime<number, number>;
  onClick: () => void;
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
          onClick={onClick}
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
