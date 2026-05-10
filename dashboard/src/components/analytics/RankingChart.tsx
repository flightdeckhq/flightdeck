import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import type { AnalyticsSeries } from "@/lib/types";
import { getProvider } from "@/lib/models";
import { ProviderIconSvg } from "@/components/ui/provider-icon-svg";

// Primary bar fill as a CSS custom-property reference. Recharts
// passes `fill` straight to the SVG element, and modern browsers
// honour `var(--name)` in SVG presentation attributes — so the bar
// re-paints on every theme toggle without re-resolving via
// getComputedStyle.
const PRIMARY_FILL = "var(--chart-1)";

/** Y-axis width and icon geometry. Sized for the longest model string
 *  the sensor emits (``claude-sonnet-4-5-20250929``, 26 chars @
 *  fontSize 10 ≈ 150 px) plus a 12 px provider-icon leader, a 4 px
 *  gap, and slack for kerning variance. Paired with ``margin.left=8``
 *  so the leading icon doesn't press against the card edge. */
const Y_AXIS_WIDTH = 190;
const ICON_SIZE = 12;
const ICON_GAP = 4;

interface RankingChartProps {
  series: AnalyticsSeries[];
}

export function RankingChart({ series }: RankingChartProps) {
  const chartData = series
    .map((s) => ({ name: s.dimension, total: s.total }))
    .sort((a, b) => b.total - a.total);

  /** Custom Y-axis tick: provider-icon leader + dimension label.
   *  ``getProvider`` maps model names to a provider; dimensions that
   *  aren't model-shaped (flavors, agent types on other ranking
   *  charts) resolve to ``unknown`` and ProviderIconSvg renders a
   *  muted circle bullet so the row still aligns with the icon
   *  column. */
  const DimensionTick = ({
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
    <ResponsiveContainer width="100%" height={260}>
      <BarChart
        data={chartData}
        layout="vertical"
        margin={{ top: 4, right: 8, left: 8, bottom: 0 }}
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
          tick={<DimensionTick />}
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
        />
        <Bar
          dataKey="total"
          fill={PRIMARY_FILL}
          radius={[0, 4, 4, 0]}
          barSize={28}
          maxBarSize={40}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}
