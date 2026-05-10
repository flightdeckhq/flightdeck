import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend } from "recharts";
import type { AnalyticsSeries } from "@/lib/types";
import { getProvider, providerLabel } from "@/lib/models";
import { ProviderLogo } from "@/components/ui/provider-logo";

// Chart colour palette as CSS custom-property references. Recharts
// passes `fill` directly to the SVG element, and modern browsers
// honour `var(--name)` in SVG presentation attributes — so the chart
// re-paints with the right palette on every theme toggle without the
// component needing to re-resolve via getComputedStyle. The previous
// `useMemo(resolveColors, [])` cached resolved hex values at first
// render and never updated, which painted neon-dark hex on
// clean-light backgrounds (and vice versa) after a theme flip.
const CELL_FILLS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--text-muted)",
];

interface DonutChartProps {
  series: AnalyticsSeries[];
}

export function DonutChart({ series }: DonutChartProps) {
  const chartData = series
    .map((s) => ({ name: s.dimension, value: s.total }))
    .filter((d) => d.value > 0);

  if (chartData.length === 0) {
    return (
      <div className="flex h-[260px] items-center justify-center text-sm text-text-muted">
        No data for this period
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={260}>
      <PieChart>
        <Pie
          data={chartData}
          cx="50%"
          cy="50%"
          innerRadius="40%"
          outerRadius="70%"
          paddingAngle={2}
          dataKey="value"
        >
          {chartData.map((entry, i) => (
            <Cell
              key={entry.name}
              fill={CELL_FILLS[i % CELL_FILLS.length]}
            />
          ))}
        </Pie>
        <Tooltip
          contentStyle={{
            backgroundColor: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            color: "var(--text)",
            fontSize: 12,
          }}
        />
        <Legend
          formatter={(value: string) => (
            <span style={{ color: "var(--text)", fontSize: 11, display: "inline-flex", alignItems: "center", gap: 3 }}>
              <ProviderLogo provider={getProvider(value)} size={11} />
              {providerLabel(value)}
            </span>
          )}
        />
      </PieChart>
    </ResponsiveContainer>
  );
}
