import type { FlavorSummary } from "@/lib/types";

interface SessionStateCounts {
  active: number;
  idle: number;
  stale: number;
  closed: number;
  lost: number;
}

interface SessionStateBarProps {
  flavors: FlavorSummary[];
  /**
   * Optional pre-computed counts. When provided, the bar uses them
   * directly so it stays in sync with the parent's useMemo result.
   * Falls back to deriving from flavors when omitted (kept for
   * existing tests). FIX 1.
   */
  counts?: SessionStateCounts;
}

const states = [
  { key: "active", label: "active", colorVar: "var(--status-active)" },
  { key: "idle", label: "idle", colorVar: "var(--status-idle)" },
  { key: "stale", label: "stale", colorVar: "var(--status-stale)" },
  { key: "closed", label: "closed", colorVar: "var(--text-muted)" },
  { key: "lost", label: "lost", colorVar: "var(--status-lost)" },
] as const;

export function SessionStateBar({ flavors, counts: countsProp }: SessionStateBarProps) {
  const counts = countsProp ?? deriveCounts(flavors);

  return (
    <div className="flex gap-4">
      {states.map((s) => (
        <div key={s.key} className="flex flex-col items-center">
          <span
            className="text-[22px] font-bold"
            style={{ color: s.colorVar }}
            data-testid={`state-count-${s.key}`}
          >
            {counts[s.key]}
          </span>
          <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
            {s.label}
          </span>
        </div>
      ))}
    </div>
  );
}

function deriveCounts(flavors: FlavorSummary[]): SessionStateCounts {
  const counts: SessionStateCounts = { active: 0, idle: 0, stale: 0, closed: 0, lost: 0 };
  for (const f of flavors) {
    for (const s of f.sessions) {
      if (s.state in counts) {
        counts[s.state as keyof SessionStateCounts]++;
      }
    }
  }
  return counts;
}
