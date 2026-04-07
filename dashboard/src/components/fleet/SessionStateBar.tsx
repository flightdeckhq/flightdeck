import type { FlavorSummary } from "@/lib/types";
import { Badge } from "@/components/ui/badge";

interface SessionStateBarProps {
  flavors: FlavorSummary[];
}

export function SessionStateBar({ flavors }: SessionStateBarProps) {
  const counts = { active: 0, idle: 0, stale: 0, closed: 0, lost: 0 };

  for (const f of flavors) {
    for (const s of f.sessions) {
      if (s.state in counts) {
        counts[s.state as keyof typeof counts]++;
      }
    }
  }

  return (
    <div className="flex gap-2 text-xs">
      <Badge variant="active">{counts.active} active</Badge>
      <Badge variant="idle">{counts.idle} idle</Badge>
      <Badge variant="stale">{counts.stale} stale</Badge>
      <Badge variant="closed">{counts.closed} closed</Badge>
      <Badge variant="lost">{counts.lost} lost</Badge>
    </div>
  );
}
