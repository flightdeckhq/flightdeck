import { useMemo } from "react";
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

/** CSS variable names for the palette. Resolved at render time via
 *  getComputedStyle so recharts receives actual hex/rgb values for
 *  SVG fill and stroke attributes. */
const SERIES_CSS_VARS = [
  "--chart-1",
  "--chart-2",
  "--chart-3",
  "--chart-4",
  "--chart-5",
  "--text-muted",
];

function resolveColors(): string[] {
  if (typeof document === "undefined") return SERIES_CSS_VARS.map(() => "#888");
  const style = getComputedStyle(document.documentElement);
  return SERIES_CSS_VARS.map((v) => style.getPropertyValue(v).trim() || "#888");
}

interface TimeSeriesChartProps {
  series: AnalyticsSeries[];
}

export function TimeSeriesChart({ series }: TimeSeriesChartProps) {
  const colors = useMemo(resolveColors, []);
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
            stroke={colors[i % colors.length]}
            fill={colors[i % colors.length]}
            fillOpacity={0.3}
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}
