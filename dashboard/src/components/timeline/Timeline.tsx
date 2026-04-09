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
  onNodeClick: (sessionId: string, eventId?: string, event?: import("@/lib/types").AgentEvent) => void;
  activeFilter?: string | null;
  paused?: boolean;
  pausedAt?: Date | null;
  sessionVersions?: Record<string, number>;
}

export function Timeline({
  flavors,
  flavorFilter,
  viewMode,
  timeRange,
  expandedFlavor,
  onExpandFlavor,
  onNodeClick,
  activeFilter,
  paused,
  pausedAt,
  sessionVersions,
}: TimelineProps) {
  // Live-updating "now" — throttled to 10fps (100ms) for performance
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (paused) return;
    let rafId: number;
    let lastUpdate = 0;
    const tick = (timestamp: number) => {
      if (timestamp - lastUpdate >= 100) {
        setNow(new Date());
        lastUpdate = timestamp;
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [paused]);

  const filteredFlavors = useMemo(() => {
    if (!flavorFilter) return flavors;
    return flavors.filter((f) => f.flavor === flavorFilter);
  }, [flavors, flavorFilter]);

  const rangeMs = TIME_RANGE_MS[timeRange];
  const scaleEnd = paused && pausedAt ? pausedAt : now;
  const start = useMemo(() => new Date(scaleEnd.getTime() - rangeMs), [scaleEnd, rangeMs]);
  const width = 800;

  const scale = useMemo(
    () => scaleTime().domain([start, scaleEnd]).range([0, width]),
    [start, scaleEnd, width]
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
        <TimeAxis start={start} end={scaleEnd} width={width} timeRange={timeRange} />
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
              end={scaleEnd}
              width={width + 240}
              activeFilter={activeFilter}
              sessionVersions={sessionVersions}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
