import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend } from "recharts";
import type { AnalyticsSeries } from "@/lib/types";
import { getProvider } from "@/lib/models";
import { ProviderLogo } from "@/components/ui/provider-logo";

const COLORS = [
  "var(--primary)",
  "var(--accent)",
  "var(--warning)",
  "var(--danger)",
  "var(--node-idle)",
  "var(--text-muted)",
];

interface DonutChartProps {
  series: AnalyticsSeries[];
}

export function DonutChart({ series }: DonutChartProps) {
  const chartData = series.map((s) => ({
    name: s.dimension,
    value: s.total,
  }));

  return (
    <ResponsiveContainer width="100%" height={260}>
      <PieChart>
        <Pie
          data={chartData}
          cx="50%"
          cy="50%"
          innerRadius={60}
          outerRadius={90}
          paddingAngle={2}
          dataKey="value"
        >
          {chartData.map((_, i) => (
            <Cell key={i} fill={COLORS[i % COLORS.length]} />
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
              {value}
            </span>
          )}
        />
      </PieChart>
    </ResponsiveContainer>
  );
}
