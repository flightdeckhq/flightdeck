import { useMemo, useRef } from "react";
import { scaleTime } from "d3-scale";
import type { FlavorSummary } from "@/lib/types";
import { TimeAxis } from "./TimeAxis";
import { SwimLane } from "./SwimLane";
import { TooltipProvider } from "@/components/ui/tooltip";

interface TimelineProps {
  flavors: FlavorSummary[];
  onNodeClick: (sessionId: string) => void;
}

export function Timeline({ flavors, onNodeClick }: TimelineProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  const { start, end } = useMemo(() => {
    const now = new Date();
    return {
      start: new Date(now.getTime() - 30 * 60 * 1000), // 30 min ago
      end: now,
    };
  }, []);

  const width = 800; // Fixed for now, responsive in later iteration

  const scale = useMemo(
    () => scaleTime().domain([start, end]).range([0, width]),
    [start, end, width]
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
    <TooltipProvider>
      <div ref={containerRef} className="overflow-x-auto">
        <div style={{ minWidth: width + 160 }}>
          <div className="pl-40">
            <TimeAxis start={start} end={end} width={width} />
          </div>
          {flavors.map((f) => (
            <SwimLane
              key={f.flavor}
              flavor={f.flavor}
              sessions={f.sessions}
              scale={scale}
              onNodeClick={onNodeClick}
            />
          ))}
        </div>
      </div>
    </TooltipProvider>
  );
}
