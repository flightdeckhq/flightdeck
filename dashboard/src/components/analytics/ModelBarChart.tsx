import { useMemo } from "react";
import {
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { useAnalytics } from "@/hooks/useAnalytics";
import { ChartCard } from "./ChartCard";
import { getProvider, PROVIDER_COLOR } from "@/lib/models";
import { ProviderIconSvg } from "@/components/ui/provider-icon-svg";
import type { AnalyticsParams } from "@/lib/types";

const TOP_N = 8;

/** Y-axis label column width, in pixels. Needs to fit the longest
 *  model string the sensor emits (``claude-sonnet-4-5-20250929``, 26
 *  chars @ fontSize 10 ≈ 150 px text) plus a 12 px provider icon
 *  leader and a 4 px gap, with a little slack for kerning variance
 *  across fonts. Paired with ``margin.left=8`` on the BarChart so the
 *  icon doesn't press against the card edge. */
const Y_AXIS_WIDTH = 170;
const ICON_SIZE = 12;
const ICON_GAP = 4;

interface ModelBarChartProps {
  range?: string;
  from?: string;
  to?: string;
  filterProvider: string | null;
}

/** Row 3 right -- horizontal bar chart of tokens per model, capped
 *  at top N (8) to keep the card readable on large fleets. Each bar
 *  is colored by the model's provider so the reader can see which
 *  provider dominates at a glance without scanning labels. The Y-axis
 *  tick renders the provider brand-mark next to the model name via
 *  ``ProviderIconSvg`` so the provider is readable even when two
 *  models have identical suffixes (e.g. ``-4-6``). */
export function ModelBarChart({
  range,
  from,
  to,
  filterProvider,
}: ModelBarChartProps) {
  const params = useMemo<AnalyticsParams>(
    () => ({
      metric: "tokens",
      group_by: "model",
      range,
      from,
      to,
      filter_provider: filterProvider ?? undefined,
    }),
    [range, from, to, filterProvider],
  );
  const { data, loading, error, refetch } = useAnalytics(params);

  const rows = useMemo(() => {
    if (!data) return [];
    return data.series
      .map((s) => ({ name: s.dimension, total: s.total }))
      .sort((a, b) => b.total - a.total)
      .slice(0, TOP_N);
  }, [data]);

  /** Custom Y-axis tick: provider icon (left) + model name. Recharts
   *  hands us ``(x, y)`` at the axis line intersection with the row
   *  centreline; we anchor the icon at the far-left edge of the
   *  reserved width and the text right after it with
   *  ``text-anchor: start`` so short and long labels both read left
   *  to right from under the icon. */
  const ModelTick = ({
    x,
    y,
    payload,
  }: {
    x?: number;
    y?: number;
    payload?: { value: string };
  }) => {
    const value = payload?.value ?? "";
    const cx = x ?? 0;
    const cy = y ?? 0;
    const iconX = cx - Y_AXIS_WIDTH + 2;
    const textX = iconX + ICON_SIZE + ICON_GAP;
    return (
      <g>
        <ProviderIconSvg
          provider={getProvider(value)}
          x={iconX}
          y={cy - ICON_SIZE / 2}
          size={ICON_SIZE}
        />
        <text
          x={textX}
          y={cy}
          dy={4}
          textAnchor="start"
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
      title={`Tokens by Model (Top ${TOP_N})`}
      loading={loading}
      error={error}
      onRetry={refetch}
      empty={!loading && rows.length === 0}
    >
      <ResponsiveContainer width="100%" height={260}>
        <BarChart
          data={rows}
          layout="vertical"
          margin={{ top: 4, right: 12, left: 8, bottom: 0 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
          <XAxis
            type="number"
            tick={{ fill: "var(--text-muted)", fontSize: 10 }}
            tickLine={false}
            axisLine={{ stroke: "var(--border)" }}
          />
          <YAxis
            type="category"
            dataKey="name"
            tick={<ModelTick />}
            tickLine={false}
            axisLine={false}
            width={Y_AXIS_WIDTH}
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
              typeof value === "number" ? value.toLocaleString() : String(value)
            }
          />
          <Bar
            dataKey="total"
            radius={[0, 4, 4, 0]}
            barSize={28}
            maxBarSize={40}
          >
            {rows.map((r) => (
              <Cell key={r.name} fill={PROVIDER_COLOR[getProvider(r.name)]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
