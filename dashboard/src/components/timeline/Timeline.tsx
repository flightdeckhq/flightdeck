import { useMemo, useRef, useState, useCallback } from "react";
import { scaleTime } from "d3-scale";
import type { FlavorSummary } from "@/lib/types";
import { TimeAxis } from "./TimeAxis";
import { SwimLane } from "./SwimLane";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";

type TimeRange = "5m" | "15m" | "30m" | "1h" | "6h";

const TIME_RANGE_MS: Record<TimeRange, number> = {
  "5m": 5 * 60 * 1000,
  "15m": 15 * 60 * 1000,
  "30m": 30 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
};

const TIME_RANGES: TimeRange[] = ["5m", "15m", "30m", "1h", "6h"];

interface TimelineProps {
  flavors: FlavorSummary[];
  flavorFilter?: string | null;
  onNodeClick: (sessionId: string) => void;
}

export function Timeline({ flavors, flavorFilter, onNodeClick }: TimelineProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [timeRange, setTimeRange] = useState<TimeRange>("30m");

  const filteredFlavors = useMemo(() => {
    if (!flavorFilter) return flavors;
    return flavors.filter((f) => f.flavor === flavorFilter);
  }, [flavors, flavorFilter]);

  const { start, end } = useMemo(() => {
    const now = new Date();
    return {
      start: new Date(now.getTime() - TIME_RANGE_MS[timeRange]),
      end: now,
    };
  }, [timeRange]);

  const width = 800;

  const scale = useMemo(
    () => scaleTime().domain([start, end]).range([0, width]),
    [start, end, width]
  );

  const handleTimeRangeChange = useCallback((range: TimeRange) => {
    setTimeRange(range);
  }, []);

  if (flavors.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center text-text-muted">
        No agents connected. Start an agent with flightdeck_sensor.init() to
        see it here.
      </div>
    );
  }

  return (
    <TooltipProvider>
      <div className="flex flex-col gap-2">
        {/* Time range selector */}
        <div className="flex items-center gap-1">
          <span className="text-[11px] text-text-muted mr-1">Range:</span>
          {TIME_RANGES.map((range) => (
            <Button
              key={range}
              size="sm"
              variant={timeRange === range ? "default" : "ghost"}
              className="h-6 px-2 text-[11px]"
              onClick={() => handleTimeRangeChange(range)}
            >
              {range}
            </Button>
          ))}
        </div>

        <div ref={containerRef} className="overflow-x-auto">
          <div style={{ minWidth: width + 160 }}>
            <div className="pl-40">
              <TimeAxis start={start} end={end} width={width} />
            </div>
            {filteredFlavors.map((f) => (
              <SwimLane
                key={f.flavor}
                flavor={f.flavor}
                activeCount={f.active_count}
                sessions={f.sessions}
                scale={scale}
                onSessionClick={onNodeClick}
              />
            ))}
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}
