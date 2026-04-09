import { useMemo } from "react";
import type { TimeRange } from "@/pages/Fleet";
import { createTimeScale, getTimeTicks, formatTimeLabel } from "@/lib/time";

const TICK_COUNTS: Record<TimeRange, number> = {
  "1m": 6,
  "5m": 5,
  "15m": 5,
  "30m": 6,
  "1h": 6,
  "6h": 6,
};

const SHOW_SECONDS: Record<TimeRange, boolean> = {
  "1m": true,
  "5m": true,
  "15m": false,
  "30m": false,
  "1h": false,
  "6h": false,
};

interface TimeAxisProps {
  start: Date;
  end: Date;
  width: number;
  timeRange: TimeRange;
}

export function TimeAxis({ start, end, width, timeRange }: TimeAxisProps) {
  const tickCount = TICK_COUNTS[timeRange] ?? 5;
  const includeSeconds = SHOW_SECONDS[timeRange] ?? false;

  const ticks = useMemo(() => getTimeTicks(start, end, tickCount), [start, end, tickCount]);
  const scale = useMemo(() => createTimeScale(start, end, width), [start, end, width]);

  return (
    <div
      className="relative h-7"
      style={{
        background: "var(--bg)",
        borderBottom: "1px solid var(--border-subtle)",
      }}
    >
      {ticks.map((tick) => {
        const x = scale(tick);
        return (
          <span
            key={tick.getTime()}
            className="absolute top-1 font-mono text-[11px] -translate-x-1/2"
            style={{ left: x, color: "var(--text-muted)" }}
          >
            {formatTimeLabel(tick, includeSeconds)}
          </span>
        );
      })}

      {/* "now" marker at right edge */}
      <div
        className="absolute top-0 h-full w-px"
        style={{ left: width, background: "var(--status-active)", opacity: 0.6 }}
      />
      <span
        className="absolute font-mono"
        style={{
          left: width - 14,
          top: 0,
          color: "var(--status-active)",
          fontSize: 10,
        }}
      >
        now
      </span>
    </div>
  );
}
