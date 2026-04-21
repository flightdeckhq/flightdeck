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
import { PROVIDER_COLOR, PROVIDER_META, type Provider } from "@/lib/models";
import { ProviderIconSvg } from "@/components/ui/provider-icon-svg";
import type { AnalyticsParams } from "@/lib/types";

interface ProviderBarChartProps {
  range?: string;
  from?: string;
  to?: string;
  filterProvider: string | null;
}

const KNOWN_PROVIDERS = new Set<Provider>([
  "anthropic",
  "openai",
  "google",
  "xai",
  "mistral",
  "meta",
  "other",
  "unknown",
]);

function colorForProvider(name: string): string {
  if (KNOWN_PROVIDERS.has(name as Provider)) {
    return PROVIDER_COLOR[name as Provider];
  }
  return "var(--text-muted)";
}

/** Row 3 left -- horizontal bar chart of tokens per provider over the
 *  active period, sorted descending. Shares the provider color map so
 *  the anthropic / openai bars match the areas in the chart above. */
export function ProviderBarChart({
  range,
  from,
  to,
  filterProvider,
}: ProviderBarChartProps) {
  const params = useMemo<AnalyticsParams>(
    () => ({
      metric: "tokens",
      group_by: "provider",
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
      .map((s) => ({
        // `key` is the raw provider id ("anthropic" etc.) used by the
        // custom Y-axis tick below to pick the right ProviderLogo and
        // capitalised label, and by colorForProvider for the bar
        // fill. The Y-axis `dataKey` also points at `key` rather than
        // a pre-formatted `name`, so the tick component sees the raw
        // id and does the formatting itself.
        key: s.dimension,
        total: s.total,
      }))
      .sort((a, b) => b.total - a.total);
  }, [data]);

  /** Custom Y-axis tick: renders the provider brand-mark next to the
   *  capitalised label via ``ProviderIconSvg`` so the icon source of
   *  truth stays in ``provider-icons.ts``. Recharts hands us
   *  ``(x, y)`` at the axis line intersection with the row centreline;
   *  we draw to the left with ``text-anchor="end"`` so the label's
   *  right edge sits 6px clear of the axis and the icon hugs the
   *  label's leading edge. Unknown dimensions render a muted circle
   *  fallback (provided by ProviderIconSvg for null icons). */
  const ProviderTick = ({
    x,
    y,
    payload,
  }: {
    x?: number;
    y?: number;
    payload?: { value: string };
  }) => {
    const value = payload?.value ?? "";
    const isKnown = value in PROVIDER_META;
    const label = isKnown ? PROVIDER_META[value as Provider].label : value;
    const cx = x ?? 0;
    const cy = y ?? 0;
    return (
      <g>
        <ProviderIconSvg
          provider={value as Provider}
          x={cx - 18}
          y={cy - 6}
          size={12}
        />
        <text
          x={cx - 22}
          y={cy}
          dy={4}
          textAnchor="end"
          fill="var(--text-muted)"
          fontSize={10}
        >
          {label}
        </text>
      </g>
    );
  };

  return (
    <ChartCard
      title="Tokens by Provider"
      loading={loading}
      error={error}
      onRetry={refetch}
      empty={!loading && rows.length === 0}
    >
      <ResponsiveContainer width="100%" height={260}>
        <BarChart
          data={rows}
          layout="vertical"
          margin={{ top: 4, right: 12, left: 0, bottom: 0 }}
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
            dataKey="key"
            tick={<ProviderTick />}
            tickLine={false}
            axisLine={false}
            width={110}
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
              <Cell key={r.key} fill={colorForProvider(r.key)} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
