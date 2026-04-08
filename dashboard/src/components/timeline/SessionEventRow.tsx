import { useMemo } from "react";
import type { ScaleTime } from "d3-scale";
import type { Session, SessionState } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { EventNode } from "./EventNode";
import { useSessionEvents } from "@/hooks/useSessionEvents";

interface SessionEventRowProps {
  session: Session;
  scale: ScaleTime<number, number>;
  onClick: () => void;
}

export function SessionEventRow({ session, scale, onClick }: SessionEventRowProps) {
  const { events, loading } = useSessionEvents(session.session_id);

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
      className="flex items-center h-8 cursor-pointer hover:bg-surface-hover transition-colors"
      onClick={onClick}
    >
      {/* Left: session metadata */}
      <div className="w-40 shrink-0 px-3 flex items-center gap-1.5">
        <span className="font-mono text-[10px] text-text-muted">
          {session.session_id.slice(0, 8)}
        </span>
        <Badge variant={session.state as SessionState} className="text-[9px] px-1 py-0">
          {session.state}
        </Badge>
        <span className="text-[10px] text-text-muted ml-auto">
          {session.tokens_used.toLocaleString()}
        </span>
      </div>

      {/* Center: event circles on the time axis */}
      <div className="relative h-full flex-1">
        {loading && (
          // Loading skeleton: 3 placeholder circles
          <div className="flex items-center h-full gap-2 pl-4">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="w-2 h-2 rounded-full bg-border animate-pulse"
              />
            ))}
          </div>
        )}
        {!loading &&
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
              onClick={onClick}
            />
          ))}
      </div>
    </div>
  );
}
