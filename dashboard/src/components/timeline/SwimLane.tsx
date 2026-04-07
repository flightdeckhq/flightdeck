import { useMemo } from "react";
import type { ScaleTime } from "d3-scale";
import type { Session } from "@/lib/types";
import { EventNode } from "./EventNode";

interface SwimLaneProps {
  flavor: string;
  sessions: Session[];
  scale: ScaleTime<number, number>;
  onNodeClick: (sessionId: string) => void;
}

export function SwimLane({
  flavor,
  sessions,
  scale,
  onNodeClick,
}: SwimLaneProps) {
  const nodes = useMemo(
    () =>
      sessions.map((session) => ({
        id: session.session_id,
        x: scale(new Date(session.last_seen_at)),
        state: session.state,
        flavor: session.flavor,
        tokensUsed: session.tokens_used,
      })),
    [sessions, scale]
  );

  return (
    <div className="flex items-center border-b border-border">
      <div className="w-40 shrink-0 truncate px-3 py-2 text-xs font-medium text-text-muted">
        {flavor}
      </div>
      <div className="relative h-10 flex-1">
        {nodes.map((node) => (
          <EventNode
            key={node.id}
            x={node.x}
            state={node.state}
            sessionId={node.id}
            flavor={node.flavor}
            tokensUsed={node.tokensUsed}
            onClick={() => onNodeClick(node.id)}
          />
        ))}
      </div>
    </div>
  );
}
