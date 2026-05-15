import { memo } from "react";
import { Line, LineChart, ResponsiveContainer } from "recharts";
import type { AgentSummarySeriesPoint } from "@/lib/types";

/**
 * One per-row sparkline tile rendered inside the `/agents` table.
 * Wraps recharts at a small size — no axes, no tooltip, no grid;
 * the tile is a visual cue, the numeric total beside it carries
 * the operator-actionable value.
 *
 * Renders a stable horizontal placeholder dash when the series
 * is empty so the column width doesn't shift between rows whose
 * agents have activity and rows whose agents are idle.
 */
interface AgentSparklineProps {
  series: AgentSummarySeriesPoint[];
  /** Which numeric field of the series point to plot. */
  axis: keyof Pick<
    AgentSummarySeriesPoint,
    "tokens" | "errors" | "sessions" | "cost_usd" | "latency_p95_ms"
  >;
  /** Pixel dimensions of the tile. */
  width?: number;
  height?: number;
}

function AgentSparklineImpl({
  series,
  axis,
  width = 80,
  height = 24,
}: AgentSparklineProps) {
  const data = series.map((p) => ({ v: p[axis] ?? 0 }));
  const isEmpty = data.length === 0 || data.every((d) => d.v === 0);

  if (isEmpty) {
    return (
      <div
        data-testid="agent-sparkline-empty"
        style={{
          width,
          height,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div
          style={{
            width: width * 0.6,
            height: 1,
            background: "var(--border)",
          }}
        />
      </div>
    );
  }

  return (
    <div
      data-testid="agent-sparkline"
      style={{ width, height }}
      aria-hidden="true"
    >
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
          <Line
            type="monotone"
            dataKey="v"
            stroke="var(--accent)"
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export const AgentSparkline = memo(AgentSparklineImpl);
