import { useMemo } from "react";
import type { ScaleTime } from "d3-scale";
import type { Session } from "@/lib/types";
import type { ViewMode } from "@/pages/Fleet";
import { ChevronRight } from "lucide-react";
import { SessionEventRow } from "./SessionEventRow";
import { EventNode } from "./EventNode";
import { BarView } from "./BarView";
import { useSessionEvents } from "@/hooks/useSessionEvents";

interface SwimLaneProps {
  flavor: string;
  activeCount: number;
  sessions: Session[];
  scale: ScaleTime<number, number>;
  onSessionClick: (sessionId: string) => void;
  expanded: boolean;
  onToggleExpand: () => void;
  viewMode: ViewMode;
  start: Date;
  end: Date;
  width: number;
}

export function SwimLane({
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

        {/* Right panel — aggregated events */}
        <div className="relative h-full flex-1 flex items-center px-1">
          {viewMode === "swimlane" ? (
            <AggregatedSwimLane
              sessions={sessions}
              scale={scale}
              onSessionClick={onSessionClick}
              flavor={flavor}
            />
          ) : (
            <AggregatedBarView
              sessions={sessions}
              start={start}
              end={end}
              width={width - 240}
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
                onClick={() => onSessionClick(session.session_id)}
                viewMode={viewMode}
                start={start}
                end={end}
                width={width - 240}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Shows aggregated 20px event circles from all sessions of a flavor. */
function AggregatedSwimLane({
  sessions,
  scale,
  onSessionClick,
  flavor,
}: {
  sessions: Session[];
  scale: ScaleTime<number, number>;
  onSessionClick: (sessionId: string) => void;
  flavor: string;
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
}: {
  session: Session;
  scale: ScaleTime<number, number>;
  onClick: () => void;
  flavor: string;
}) {
  const isActive = session.state === "active";
  const { events } = useSessionEvents(session.session_id, isActive);

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
}: {
  sessions: Session[];
  start: Date;
  end: Date;
  width: number;
}) {
  // Collect all events from all sessions using hooks
  const eventArrays = sessions.map((s) => {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const { events } = useSessionEvents(s.session_id, s.state === "active");
    return events;
  });

  const allEvents = useMemo(() => eventArrays.flat(), [eventArrays]);

  return <BarView events={allEvents} start={start} end={end} width={Math.max(width, 100)} />;
}
