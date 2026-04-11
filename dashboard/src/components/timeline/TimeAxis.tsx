import { useMemo } from "react";
import { scaleTime } from "d3-scale";
import type { TimeRange } from "@/pages/Fleet";
import { TIMELINE_RANGE_MS } from "@/lib/constants";
import { formatRelativeLabel } from "@/lib/time";

/**
 * Number of evenly spaced labels to render on the time axis.
 *
 * The previous implementation used d3-time tick generators
 * (timeSecond.every / timeMinute.every) to produce absolute
 * timestamps like "12:06:30 PM". That approach broke at wide
 * proportional widths -- the visible viewport at 6h showed zero
 * labels because the per-range interval put one tick every
 * thousands of pixels.
 *
 * The new approach is range-agnostic: always render exactly six
 * labels evenly distributed across the timeline width, formatted
 * as relative durations from the right edge ("now" / "paused"):
 *
 *   1m   60s 48s 36s 24s 12s now
 *   5m   5m  4m  3m  2m  1m  now
 *   15m  15m 12m 9m  6m  3m  now
 *   30m  30m 24m 18m 12m 6m  now
 *   1h   1h  48m 36m 24m 12m now
 */
const NUM_LABELS = 6;

interface TimeAxisProps {
  start: Date;
  end: Date;
  width: number;
  timeRange: TimeRange;
  paused?: boolean;
}

export function TimeAxis({ start, end, width, timeRange, paused = false }: TimeAxisProps) {
  const scale = useMemo(
    () => scaleTime().domain([start, end]).range([0, width]),
    [start, end, width],
  );

  const rangeMs = TIMELINE_RANGE_MS[timeRange] ?? 60_000;

  // Build six evenly spaced labels. i=0 is the leftmost (oldest)
  // edge of the timeline, i=NUM_LABELS-1 is the rightmost ("now"
  // / "paused"). xPos uses the d3 scale so the "now" label sits
  // exactly at the right edge regardless of width.
  const labels = useMemo(() => {
    const referenceTime = end;
    return Array.from({ length: NUM_LABELS }, (_, i) => {
      const fraction = i / (NUM_LABELS - 1);
      const msAgo = Math.round(rangeMs * (1 - fraction));
      const xPos = scale(new Date(referenceTime.getTime() - msAgo));
      const label =
        msAgo === 0
          ? paused
            ? "paused"
            : "now"
          : formatRelativeLabel(msAgo);
      return { xPos, label, isNow: msAgo === 0, index: i };
    });
  }, [scale, rangeMs, end, paused]);

  return (
    <div
      className="relative h-7"
      style={{
        background: "var(--bg)",
        borderBottom: "1px solid var(--border-subtle)",
      }}
    >
      {labels.map(({ xPos, label, isNow, index }) => {
        // Anchor the leftmost label to its left edge and the
        // rightmost to its right edge so neither overflows the
        // axis. Middle labels are centered on their position.
        const transform = getLabelTransform(index, NUM_LABELS);
        const isPausedNow = isNow && paused;
        const color = isNow && !paused
          ? "var(--accent)"
          : "var(--text-muted)";
        const fontWeight = isNow && !paused ? 600 : 400;
        return (
          <span
            key={index}
            className="absolute font-mono text-[11px]"
            style={{
              top: 4,
              left: xPos,
              transform,
              color,
              fontWeight,
              whiteSpace: "nowrap",
              userSelect: "none",
            }}
            data-testid={isNow ? (isPausedNow ? "axis-label-paused" : "axis-label-now") : undefined}
          >
            {label}
          </span>
        );
      })}

      {/* The "now" vertical line is rendered by the grid line overlay
          in Timeline.tsx so it spans the full height of the swimlane.
          Previously this row also rendered its own short "now" marker
          here, which doubled up with the grid line and made the line
          appear thicker and more saturated. */}
    </div>
  );
}

function getLabelTransform(i: number, total: number): string {
  if (i === 0) return "translateX(0%)";
  if (i === total - 1) return "translateX(-100%)";
  return "translateX(-50%)";
}
