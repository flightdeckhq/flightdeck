import { useMemo } from "react";
import type { ScaleTime } from "d3-scale";
import type { Session } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import type { SessionState } from "@/lib/types";

interface SwimLaneProps {
  flavor: string;
  activeCount: number;
  sessions: Session[];
  scale: ScaleTime<number, number>;
  onSessionClick: (sessionId: string) => void;
}

export function SwimLane({
  flavor,
  activeCount,
  sessions,
  scale,
  onSessionClick,
}: SwimLaneProps) {
  const sessionNodes = useMemo(
    () =>
      sessions.map((session) => ({
        id: session.session_id,
        x: scale(new Date(session.last_seen_at)),
        state: session.state,
        tokensUsed: session.tokens_used,
      })),
    [sessions, scale]
  );

  const stateColors: Record<SessionState, string> = {
    active: "var(--node-active)",
    idle: "var(--node-idle)",
    stale: "var(--node-stale)",
    closed: "var(--node-closed)",
    lost: "var(--node-lost)",
  };

  return (
    <div className="border-b border-border">
      {/* Flavor header row - 28px */}
      <div className="flex items-center h-7 bg-surface/50">
        <div className="w-40 shrink-0 truncate px-3 text-[11px] font-semibold text-text flex items-center gap-1.5">
          <span>{flavor}</span>
          <span className="text-[10px] font-normal text-text-muted">({activeCount})</span>
        </div>
      </div>

      {/* Session rows - 32px each */}
      {sessionNodes.map((node) => {
        return (
          <div
            key={node.id}
            className="flex items-center h-8 cursor-pointer hover:bg-surface-hover transition-colors"
            onClick={() => onSessionClick(node.id)}
          >
            <div className="w-40 shrink-0 px-3 flex items-center gap-1.5">
              <span className="font-mono text-[10px] text-text-muted">
                {node.id.slice(0, 8)}
              </span>
              <Badge variant={node.state as SessionState} className="text-[9px] px-1 py-0">
                {node.state}
              </Badge>
              <span className="text-[10px] text-text-muted ml-auto">
                {node.tokensUsed.toLocaleString()}
              </span>
            </div>
            <div className="relative h-full flex-1">
              <div
                className="absolute top-1/2 -translate-y-1/2 rounded-full"
                style={{
                  left: node.x,
                  width: 8,
                  height: 8,
                  backgroundColor: stateColors[node.state],
                  boxShadow: node.state === "active"
                    ? `0 0 6px ${stateColors[node.state]}`
                    : undefined,
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
