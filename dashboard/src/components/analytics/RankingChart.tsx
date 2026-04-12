import { useMemo } from "react";
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

function resolvePrimary(): string {
  if (typeof document === "undefined") return "#7c3aed";
  return getComputedStyle(document.documentElement).getPropertyValue("--chart-1").trim() || "#7c3aed";
}

interface RankingChartProps {
  series: AnalyticsSeries[];
}

export function RankingChart({ series }: RankingChartProps) {
  const primaryColor = useMemo(resolvePrimary, []);
  const chartData = series
    .map((s) => ({ name: s.dimension, total: s.total }))
    .sort((a, b) => b.total - a.total);

  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart
        data={chartData}
        layout="vertical"
        margin={{ top: 4, right: 8, left: 0, bottom: 0 }}
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
          tick={{ fill: "var(--text-muted)", fontSize: 10 }}
          tickLine={false}
          axisLine={false}
          width={80}
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
        <Bar dataKey="total" fill={primaryColor} radius={[0, 4, 4, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
