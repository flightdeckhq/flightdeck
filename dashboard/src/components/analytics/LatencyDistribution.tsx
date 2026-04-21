import { useMemo } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { useAnalytics } from "@/hooks/useAnalytics";
import { ChartCard } from "./ChartCard";
import { getProvider } from "@/lib/models";
import { ProviderIconSvg } from "@/components/ui/provider-icon-svg";
import type { AnalyticsParams } from "@/lib/types";

interface LatencyDistributionProps {
  range?: string;
  from?: string;
  to?: string;
  filterProvider: string | null;
}

const TOP_N = 8;

/** Row 5 right -- grouped bar chart showing p50 (lighter) and p95
 *  (accent) latency per model so the tail latency is immediately
 *  visible alongside the typical case. Uses the new latency_p50 and
 *  latency_p95 metrics added in this change; see ARCHITECTURE.md for
 *  the metric list and D099 notes in DECISIONS.md.
 *
 *  Two independent analytics queries are issued (p50 and p95) and the
 *  results are joined client-side on model name. p95 inherits the
 *  set of models from p50 so a model with only a p95 value (unlikely
 *  but possible under empty-row edge cases) is dropped to keep the
 *  bars aligned. */
export function LatencyDistribution({
  range,
  from,
  to,
  filterProvider,
}: LatencyDistributionProps) {
  const p50Params = useMemo<AnalyticsParams>(
    () => ({
      metric: "latency_p50",
      group_by: "model",
      range,
      from,
      to,
      filter_provider: filterProvider ?? undefined,
    }),
    [range, from, to, filterProvider],
  );
  const p95Params = useMemo<AnalyticsParams>(
    () => ({
      metric: "latency_p95",
      group_by: "model",
      range,
      from,
      to,
      filter_provider: filterProvider ?? undefined,
    }),
    [range, from, to, filterProvider],
  );

  const p50 = useAnalytics(p50Params);
  const p95 = useAnalytics(p95Params);

  const loading = p50.loading || p95.loading;
  const error = p50.error ?? p95.error;

  const rows = useMemo(() => {
    if (!p50.data || !p95.data) return [];
    const p95Map = new Map(p95.data.series.map((s) => [s.dimension, s.total]));
    return p50.data.series
      .map((s) => ({
        name: s.dimension,
        p50: s.total,
        p95: p95Map.get(s.dimension) ?? 0,
      }))
      .sort((a, b) => b.p95 - a.p95)
      .slice(0, TOP_N);
  }, [p50.data, p95.data]);

  /** Custom X-axis tick: provider brand-mark + rotated model label.
   *  Recharts hands us ``(x, y)`` at the tick intersection with the
   *  axis line; we rotate the whole group ``-35°`` around that point
   *  so the label flows up-left into free space above, then place the
   *  icon in pre-rotation local space to the left of the text's end
   *  anchor. Text width is estimated at ~6px per char at fontSize
   *  10 -- short labels get their icon close by, long names push the
   *  icon further out so the icon-to-text gap stays roughly
   *  consistent. */
  const ICON_SIZE = 12;
  const ICON_GAP = 4;
  const ModelXTick = ({
    x,
    y,
    payload,
  }: {
    x?: number;
    y?: number;
    payload?: { value: string };
  }) => {
    const value = payload?.value ?? "";
    const estTextWidth = value.length * 6;
    const iconX = -(estTextWidth + ICON_GAP + ICON_SIZE);
    const iconY = -ICON_SIZE / 2;
    const cx = x ?? 0;
    const cy = y ?? 0;
    return (
      <g transform={`translate(${cx},${cy}) rotate(-35)`}>
        <ProviderIconSvg
          provider={getProvider(value)}
          x={iconX}
          y={iconY}
          size={ICON_SIZE}
        />
        <text
          x={-2}
          y={0}
          dy={4}
          textAnchor="end"
          fill="var(--text-muted)"
          fontSize={10}
        >
          {value}
        </text>
      </g>
    );
  };

  return (
    <ChartCard
      title="Latency Distribution (p50 / p95)"
      loading={loading}
      error={error}
      onRetry={() => {
        p50.refetch();
        p95.refetch();
      }}
      empty={!loading && rows.length === 0}
    >
      <ResponsiveContainer width="100%" height={260}>
        <BarChart data={rows} margin={{ top: 4, right: 8, left: 0, bottom: 30 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis
            dataKey="name"
            tick={<ModelXTick />}
            tickLine={false}
            axisLine={{ stroke: "var(--border)" }}
            height={80}
            interval={0}
          />
          <YAxis
            tick={{ fill: "var(--text-muted)", fontSize: 10 }}
            tickLine={false}
            axisLine={false}
            width={60}
            tickFormatter={(v: number) => `${Math.round(v)}ms`}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              color: "var(--text)",
              fontSize: 12,
            }}
            formatter={(value) =>
              typeof value === "number"
                ? `${Math.round(value)}ms`
                : String(value)
            }
          />
          <Legend wrapperStyle={{ fontSize: 11, color: "var(--text)" }} />
          <Bar
            dataKey="p50"
            fill="var(--chart-2)"
            radius={[2, 2, 0, 0]}
            barSize={18}
            maxBarSize={28}
          />
          <Bar
            dataKey="p95"
            fill="var(--accent)"
            radius={[2, 2, 0, 0]}
            barSize={18}
            maxBarSize={28}
          />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
