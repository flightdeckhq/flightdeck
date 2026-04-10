import { useMemo } from "react";
import { scaleTime } from "d3-scale";
import { timeSecond, timeMinute, type TimeInterval } from "d3-time";
import type { TimeRange } from "@/pages/Fleet";
import { formatTimeLabel } from "@/lib/time";

/**
 * Per-range tick interval.
 *
 * The proportional timeline width keeps pixel-per-second density
 * constant (15 px/s, since base width is 900px for 60s). This means
 * the visible viewport always shows the same amount of wall-clock
 * time -- typically ~100 seconds for a ~1500px viewport -- regardless
 * of the selected range. So the tick interval has to produce labels
 * dense enough to fall inside that ~100s window.
 *
 * The previous spec used coarser intervals at wider ranges (every
 * 30 minutes at 6h), which produced one label every 27,000 px and
 * zero labels in the visible viewport almost all the time. The fixed
 * intervals here always put 1-6 labels in any ~1500px window:
 *
 *   1m  → every 10s  →   6 ticks total, ~6 visible
 *   5m  → every 30s  →  10 ticks total, ~3 visible
 *   15m → every 1m   →  15 ticks total, ~1-2 visible
 *   30m → every 1m   →  30 ticks total, ~1-2 visible
 *   1h  → every 1m   →  60 ticks total, ~1-2 visible
 *   6h  → every 1m   → 360 ticks total, ~1-2 visible
 */
const TICK_INTERVAL: Record<TimeRange, TimeInterval> = {
  "1m": timeSecond.every(10) as TimeInterval,
  "5m": timeSecond.every(30) as TimeInterval,
  "15m": timeMinute.every(1) as TimeInterval,
  "30m": timeMinute.every(1) as TimeInterval,
  "1h": timeMinute.every(1) as TimeInterval,
  "6h": timeMinute.every(1) as TimeInterval,
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
