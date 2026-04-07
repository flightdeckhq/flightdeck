import { useMemo } from "react";
import { createTimeScale, getTimeTicks, formatTimeLabel } from "@/lib/time";

interface TimeAxisProps {
  start: Date;
  end: Date;
  width: number;
}

export function TimeAxis({ start, end, width }: TimeAxisProps) {
  const ticks = useMemo(
    () => getTimeTicks(start, end, 8),
    [start, end]
  );

  const scale = useMemo(
    () => createTimeScale(start, end, width),
    [start, end, width]
  );

  return (
    <div className="relative h-6 border-b border-border">
      {ticks.map((tick) => {
        const x = scale(tick);
        return (
          <span
            key={tick.getTime()}
            className="absolute top-0 text-[10px] text-text-muted -translate-x-1/2"
            style={{ left: x }}
          >
            {formatTimeLabel(tick)}
          </span>
        );
      })}
    </div>
  );
}
