import { useMemo, useState, useEffect } from "react";
import { scaleTime } from "d3-scale";
import type { FlavorSummary } from "@/lib/types";
import type { ViewMode, TimeRange } from "@/pages/Fleet";
import { TimeAxis } from "./TimeAxis";
import { SwimLane } from "./SwimLane";

const TIME_RANGE_MS: Record<TimeRange, number> = {
  "1m": 60 * 1000,
  "5m": 5 * 60 * 1000,
  "15m": 15 * 60 * 1000,
  "30m": 30 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
};

interface TimelineProps {
  flavors: FlavorSummary[];
  flavorFilter?: string | null;
  viewMode: ViewMode;
  timeRange: TimeRange;
  expandedFlavor: string | null;
  onExpandFlavor: (flavor: string) => void;
  onNodeClick: (sessionId: string) => void;
}

export function Timeline({
  flavors,
  flavorFilter,
  viewMode,
  timeRange,
  expandedFlavor,
  onExpandFlavor,
  onNodeClick,
}: TimelineProps) {
  // Live-updating "now" — refreshes every 10 seconds
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 10000);
    return () => clearInterval(interval);
  }, []);

  const filteredFlavors = useMemo(() => {
    if (!flavorFilter) return flavors;
    return flavors.filter((f) => f.flavor === flavorFilter);
  }, [flavors, flavorFilter]);

  const rangeMs = TIME_RANGE_MS[timeRange];
  const start = useMemo(() => new Date(now.getTime() - rangeMs), [now, rangeMs]);
  const width = 800;

  const scale = useMemo(
    () => scaleTime().domain([start, now]).range([0, width]),
    [start, now, width]
  );

  if (flavors.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center text-text-muted">
        No agents connected. Start an agent with flightdeck_sensor.init() to
        see it here.
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {/* Shared time axis */}
      <div className="pl-[240px]">
        <TimeAxis start={start} end={now} width={width} />
      </div>

      {/* Flavor rows */}
      {filteredFlavors.map((f) => (
        <div key={f.flavor} className="flex">
          <div className="flex-1">
            <SwimLane
              flavor={f.flavor}
              activeCount={f.active_count}
              sessions={f.sessions}
              scale={scale}
              onSessionClick={onNodeClick}
              expanded={expandedFlavor === f.flavor}
              onToggleExpand={() => onExpandFlavor(f.flavor)}
              viewMode={viewMode}
              start={start}
              end={now}
              width={width + 240}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
