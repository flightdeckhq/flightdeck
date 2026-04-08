import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import type { AnalyticsSeries } from "@/lib/types";

/** Palette using CSS variable colors via getComputedStyle. */
const SERIES_COLORS = [
  "var(--primary)",
  "var(--accent)",
  "var(--warning)",
  "var(--danger)",
  "var(--node-idle)",
  "var(--text-muted)",
];

interface TimeSeriesChartProps {
  series: AnalyticsSeries[];
}

export function TimeSeriesChart({ series }: TimeSeriesChartProps) {
  // Build a unified dataset keyed by date
  const dateMap = new Map<string, Record<string, number>>();

  for (const s of series) {
    for (const pt of s.data) {
      const row = dateMap.get(pt.date) ?? {};
      row[s.dimension] = pt.value;
      dateMap.set(pt.date, row);
    }
  }

  const chartData = Array.from(dateMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, values]) => ({ date, ...values }));

  return (
    <ResponsiveContainer width="100%" height={260}>
      <AreaChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
        <XAxis
          dataKey="date"
          tick={{ fill: "var(--text-muted)", fontSize: 10 }}
          tickLine={false}
          axisLine={{ stroke: "var(--border)" }}
          tickFormatter={(v: string) => {
            const d = new Date(v);
            return `${d.getMonth() + 1}/${d.getDate()}`;
          }}
        />
        <YAxis
          tick={{ fill: "var(--text-muted)", fontSize: 10 }}
          tickLine={false}
          axisLine={false}
          width={50}
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
        {series.map((s, i) => (
          <Area
            key={s.dimension}
            type="monotone"
            dataKey={s.dimension}
            stackId="1"
            stroke={SERIES_COLORS[i % SERIES_COLORS.length]}
            fill={SERIES_COLORS[i % SERIES_COLORS.length]}
            fillOpacity={0.3}
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}
