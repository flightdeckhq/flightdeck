import { useMemo } from "react";
import { createTimeScale, getTimeTicks, formatTimeLabel } from "@/lib/time";

interface TimeAxisProps {
  start: Date;
  end: Date;
  width: number;
}

export function TimeAxis({ start, end, width }: TimeAxisProps) {
  const ticks = useMemo(() => getTimeTicks(start, end, 8), [start, end]);
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
            {formatTimeLabel(tick)}
          </span>
        );
      })}

      {/* "now" marker at right edge */}
      <div
        className="absolute top-0 h-full w-px"
        style={{ left: width, background: "var(--status-active)", opacity: 0.6 }}
      />
      <span
        className="absolute font-mono text-[11px]"
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
