import { useMemo } from "react";
import type { ScaleTime } from "d3-scale";
import type { Session } from "@/lib/types";
import type { ViewMode } from "@/pages/Fleet";
import { EventNode } from "./EventNode";
import { BarView } from "./BarView";
import { useSessionEvents } from "@/hooks/useSessionEvents";
import { isEventVisible } from "@/lib/events";

const stateBadgeColors: Record<string, { bg: string; color: string }> = {
  active: { bg: "rgba(34,197,94,0.15)", color: "var(--status-active)" },
  idle: { bg: "rgba(234,179,8,0.15)", color: "var(--status-idle)" },
  stale: { bg: "rgba(249,115,22,0.15)", color: "var(--status-stale)" },
  closed: { bg: "rgba(100,100,100,0.15)", color: "var(--text-muted)" },
  lost: { bg: "rgba(239,68,68,0.15)", color: "var(--status-lost)" },
};

interface SessionEventRowProps {
  session: Session;
  scale: ScaleTime<number, number>;
  onClick: (eventId?: string) => void;
  viewMode: ViewMode;
  start: Date;
  end: Date;
  width: number;
  activeFilter?: string | null;
  version?: number;
}

export function SessionEventRow({ session, scale, onClick, viewMode, start, end, width, activeFilter, version = 0 }: SessionEventRowProps) {
  const isActive = session.state === "active";
  const { events, loading } = useSessionEvents(session.session_id, isActive, version);
  const badge = stateBadgeColors[session.state] ?? stateBadgeColors.closed;

  const eventNodes = useMemo(
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
    <div
      className="flex h-10 cursor-pointer items-center transition-colors hover:bg-surface-hover"
      style={{ borderBottom: "1px solid var(--border-subtle)" }}
      onClick={() => onClick()}
    >
      {/* Left panel — 240px, indented */}
      <div className="flex h-full w-[240px] shrink-0 items-center gap-1.5 pl-7 pr-3">
        {isActive && <div className="pulse-dot" />}
        <span className="font-mono text-xs" style={{ color: "var(--text-secondary)" }}>
          {session.session_id.slice(0, 8)}
        </span>
        <span
          className="rounded font-mono text-[10px] px-[5px] py-[1px]"
          style={{
            background: badge.bg,
            color: badge.color,
            border: `1px solid ${badge.color}30`,
          }}
        >
          {session.state}
        </span>
        <span className="ml-auto font-mono text-[11px]" style={{ color: "var(--text-muted)" }}>
          {session.tokens_used.toLocaleString()}
        </span>
      </div>

      {/* Right panel — events */}
      <div className="relative h-full flex-1 flex items-center px-1">
        {loading && (
          <div className="flex items-center h-full gap-2 pl-4">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="w-2 h-2 rounded-full bg-border animate-pulse"
              />
            ))}
          </div>
        )}
        {!loading && viewMode === "swimlane" &&
          eventNodes.map((node) => (
            <EventNode
              key={node.id}
              x={node.x}
              eventType={node.eventType}
              sessionId={session.session_id}
              flavor={session.flavor}
              model={node.model}
              toolName={node.toolName}
              tokensTotal={node.tokensTotal}
              latencyMs={node.latencyMs}
              occurredAt={node.occurredAt}
              eventId={node.id}
              onClick={onClick}
              size={24}
              isVisible={isEventVisible(node.eventType, activeFilter)}
            />
          ))}
        {!loading && viewMode === "bars" && (
          <BarView events={events} start={start} end={end} width={Math.max(width, 100)} />
        )}
      </div>
    </div>
  );
}
