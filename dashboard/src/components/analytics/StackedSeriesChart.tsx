import { useMemo } from "react";
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import type { AnalyticsSeries } from "@/lib/types";
import {
  PROVIDER_COLOR,
  PROVIDER_META,
  providerLabel,
  type Provider,
} from "@/lib/models";
import { ProviderLogo } from "@/components/ui/provider-logo";

/** Fallback palette for series that don't map to a provider -- e.g.
 *  flavors or model names -- pulled from the shared chart-N CSS vars
 *  so both themes stay in sync. */
const FALLBACK_VARS = [
  "--chart-1",
  "--chart-2",
  "--chart-3",
  "--chart-4",
  "--chart-5",
  "--text-muted",
];

const PROVIDERS = new Set<Provider>([
  "anthropic",
  "openai",
  "google",
  "xai",
  "mistral",
  "meta",
  "other",
  "unknown",
]);

function colorForDimension(dimension: string, fallbackIndex: number): string {
  if (PROVIDERS.has(dimension as Provider)) {
    return PROVIDER_COLOR[dimension as Provider];
  }
  return `var(${FALLBACK_VARS[fallbackIndex % FALLBACK_VARS.length]})`;
}

interface StackedSeriesChartProps {
  series: AnalyticsSeries[];
  /** "area" stacks semi-transparent fills for time-series; "bar"
   *  renders stacked bars for period totals like the cost chart. */
  variant: "area" | "bar";
  /** Dollar-format the Y-axis and tooltip values when true. Used by
   *  the cost chart. */
  currency?: boolean;
  height?: number;
}

/** Stacked multi-series chart keyed on date, used by the Tokens Over
 *  Time (area) and Estimated Cost (bar) rows of the Analytics v2 page.
 *
 *  Merges every series onto a single date-keyed record and passes the
 *  merged dataset to recharts so stacks line up even when some series
 *  are sparse. Series whose dimension matches a Provider name pick up
 *  PROVIDER_COLOR so the visual mapping (anthropic=purple, openai=
 *  cyan, …) stays consistent across every chart on the page. Non-
 *  provider dimensions (flavors, models) fall back to the generic
 *  chart-N palette. */
export function StackedSeriesChart({
  series,
  variant,
  currency = false,
  height = 280,
}: StackedSeriesChartProps) {
  const { chartData, dimensions } = useMemo(() => {
    const dims = series.map((s) => s.dimension);
    const dateMap = new Map<string, Record<string, number>>();
    for (const s of series) {
      for (const pt of s.data) {
        if (!dateMap.has(pt.date)) {
          const row: Record<string, number> = {};
          for (const d of dims) row[d] = 0;
          dateMap.set(pt.date, row);
        }
      }
    }
    for (const s of series) {
      for (const pt of s.data) {
        dateMap.get(pt.date)![s.dimension] = pt.value;
      }
    }
    return {
      chartData: Array.from(dateMap.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, values]) => ({ date, ...values })),
      dimensions: dims,
    };
  }, [series]);

  // Dollar tick / tooltip formatter. Tiers:
  //   0        → "$0.00"  (special case -- avoids $0.000000 on empty
  //                         buckets, which was the original bug)
  //   ≥ $10    → whole dollars
  //   ≥ $0.01  → two decimals (covers the $0.90 / $0.45 daily range
  //              the user pointed out; previously these bucketed into
  //              the four-decimal tier and rendered as $0.9000)
  //   < $0.01  → four decimals for sub-penny precision (single runs
  //              on a cheap model are still meaningful at $0.0012)
  const formatCurrency = (v: number) => {
    if (v === 0) return "$0.00";
    const abs = Math.abs(v);
    if (abs >= 10) return `$${Math.round(v)}`;
    if (abs >= 0.01) return `$${v.toFixed(2)}`;
    return `$${v.toFixed(4)}`;
  };

  const formatValue = (v: number) =>
    currency ? formatCurrency(v) : v.toLocaleString();

  /** Legend / tooltip label: surface the friendly provider name
   *  (“Anthropic” instead of “anthropic”) while leaving non-provider
   *  dimensions (flavors, models) untouched. */
  const formatLabel = (dim: string) => providerLabel(dim);

  // Area chart always stays an area chart even with a single point
  // per series -- recharts renders nothing visible without a
  // connecting path, so we turn on `dot` (+ a larger `activeDot` for
  // hover) so the lone observation shows up as a coloured dot on the
  // baseline instead of disappearing. The bar variant (cost chart)
  // is unaffected: it's always a bar chart and its bar size is
  // capped with BAR_SIZE / BAR_MAX below.
  const showPointMarkers = series.every((s) => s.data.length <= 1);
  const BAR_SIZE = 28;
  const BAR_MAX = 40;

  // When every series dimension is a known provider name, the legend
  // swaps to a custom renderer that draws the ProviderLogo instead of
  // recharts' default coloured square. The color cue is already
  // carried by the logo itself (each ProviderLogo SVG has its own
  // brand fill), so no separate swatch is needed.
  const isProviderDimension = dimensions.every((d) => d in PROVIDER_META);

  // Recharts' legend content callback type is generic over the chart
  // flavour and not worth dragging into the signature; accept the
  // `payload` shape we need inline.
  const ProviderLegend = (props: {
    payload?: ReadonlyArray<{ value?: unknown }>;
  }) => {
    const entries = props.payload ?? [];
    return (
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "center",
          gap: 12,
          paddingTop: 6,
          fontSize: 11,
          color: "var(--text)",
        }}
      >
        {entries.map((entry) => {
          const key = String(entry.value ?? "") as Provider;
          const meta = PROVIDER_META[key];
          return (
            <span
              key={key}
              style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
            >
              <ProviderLogo provider={key} size={12} />
              <span>{meta ? meta.label : String(entry.value ?? "")}</span>
            </span>
          );
        })}
      </div>
    );
  };

  const tickFormatter = (v: string) => {
    const d = new Date(v);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  };

  const tooltipStyle = {
    backgroundColor: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: 6,
    color: "var(--text)",
    fontSize: 12,
  } as const;

  if (variant === "area") {
    return (
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis
            dataKey="date"
            tick={{ fill: "var(--text-muted)", fontSize: 10 }}
            tickLine={false}
            axisLine={{ stroke: "var(--border)" }}
            tickFormatter={tickFormatter}
          />
          <YAxis
            tick={{ fill: "var(--text-muted)", fontSize: 10 }}
            tickLine={false}
            axisLine={false}
            width={60}
            tickFormatter={(v: number) => formatValue(v)}
          />
          <Tooltip
            contentStyle={tooltipStyle}
            formatter={(value, name) => [
              typeof value === "number" ? formatValue(value) : String(value),
              formatLabel(String(name)),
            ]}
          />
          {isProviderDimension ? (
            <Legend content={ProviderLegend} />
          ) : (
            <Legend
              wrapperStyle={{ fontSize: 11, color: "var(--text)" }}
              formatter={(value) => formatLabel(String(value))}
            />
          )}
          {dimensions.map((d, i) => (
            <Area
              key={d}
              type="monotone"
              dataKey={d}
              stackId="1"
              stroke={colorForDimension(d, i)}
              fill={colorForDimension(d, i)}
              fillOpacity={0.4}
              dot={showPointMarkers}
              activeDot={showPointMarkers ? { r: 5 } : undefined}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
        <XAxis
          dataKey="date"
          tick={{ fill: "var(--text-muted)", fontSize: 10 }}
          tickLine={false}
          axisLine={{ stroke: "var(--border)" }}
          tickFormatter={tickFormatter}
        />
        <YAxis
          tick={{ fill: "var(--text-muted)", fontSize: 10 }}
          tickLine={false}
          axisLine={false}
          width={70}
          tickFormatter={(v: number) => formatValue(v)}
        />
        <Tooltip
          contentStyle={tooltipStyle}
          formatter={(value, name) => [
            typeof value === "number" ? formatValue(value) : String(value),
            formatLabel(String(name)),
          ]}
        />
        {isProviderDimension ? (
          <Legend content={ProviderLegend} />
        ) : (
          <Legend
            wrapperStyle={{ fontSize: 11, color: "var(--text)" }}
            formatter={(value) => formatLabel(String(value))}
          />
        )}
        {dimensions.map((d, i) => (
          <Bar
            key={d}
            dataKey={d}
            stackId="cost"
            fill={colorForDimension(d, i)}
            barSize={BAR_SIZE}
            maxBarSize={BAR_MAX}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}
