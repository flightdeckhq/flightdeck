import { useMemo } from "react";
import { scaleTime } from "d3-scale";
import { timeSecond, timeMinute, type TimeInterval } from "d3-time";
import type { TimeRange } from "@/pages/Fleet";
import { formatTimeLabel } from "@/lib/time";

/**
 * Per-range tick interval. The previous "tick count + width" approach
 * silently broke at large widths (the 6h range generated zero ticks
 * across 324,000px) and produced minute-level ticks at 5m even when
 * there was clearly room for 30s ticks. Explicit intervals give
 * consistent label density across every range.
 *
 *   1m  → every 10s
 *   5m  → every 30s
 *   15m → every 1m
 *   30m → every 2m
 *   1h  → every 5m
 *   6h  → every 30m
 */
const TICK_INTERVAL: Record<TimeRange, TimeInterval> = {
  "1m": timeSecond.every(10) as TimeInterval,
  "5m": timeSecond.every(30) as TimeInterval,
  "15m": timeMinute.every(1) as TimeInterval,
  "30m": timeMinute.every(2) as TimeInterval,
  "1h": timeMinute.every(5) as TimeInterval,
  "6h": timeMinute.every(30) as TimeInterval,
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
  const includeSeconds = SHOW_SECONDS[timeRange] ?? false;
  const interval = TICK_INTERVAL[timeRange] ?? timeMinute.every(1) as TimeInterval;

  const scale = useMemo(
    () => scaleTime().domain([start, end]).range([0, width]),
    [start, end, width],
  );

  // Generate ticks at the explicit interval. Falls back to a count
  // if the interval rejects the domain (shouldn't happen, but safe).
  const ticks = useMemo(() => {
    const t = interval ? scale.ticks(interval) : scale.ticks(10);
    return t.length > 0 ? t : scale.ticks(10);
  }, [scale, interval]);

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
