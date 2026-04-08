import type { ScaleTime } from "d3-scale";
import type { Session } from "@/lib/types";
import { SessionEventRow } from "./SessionEventRow";

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
  return (
    <div className="border-b border-border">
      {/* Flavor header row - 28px */}
      <div className="flex items-center h-7 bg-surface/50">
        <div className="w-40 shrink-0 truncate px-3 text-[11px] font-semibold text-text flex items-center gap-1.5">
          <span>{flavor}</span>
          <span className="text-[10px] font-normal text-text-muted">({activeCount})</span>
        </div>
      </div>

      {/* Session rows - 32px each, with per-event circles */}
      {sessions.map((session) => (
        <SessionEventRow
          key={session.session_id}
          session={session}
          scale={scale}
          onClick={() => onSessionClick(session.session_id)}
        />
      ))}
    </div>
  );
}
