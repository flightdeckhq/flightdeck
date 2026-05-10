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
import { getProvider } from "@/lib/models";
import { PROVIDER_ICONS } from "@/components/ui/provider-icons";
import { ProviderLogo } from "@/components/ui/provider-logo";

// Series palette as CSS custom-property references. Recharts passes
// `stroke` / `fill` directly to the SVG element, and modern browsers
// honour `var(--name)` in SVG presentation attributes — so the chart
// re-paints with the right palette on every theme toggle without the
// component needing to re-resolve via getComputedStyle. The previous
// `useMemo(resolveColors, [])` cached resolved hex values at first
// render and never updated, which painted neon-dark hex on
// clean-light backgrounds (and vice versa) after a theme flip.
const SERIES_FILLS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--text-muted)",
];

interface TimeSeriesChartProps {
  series: AnalyticsSeries[];
}

/** Tooltip payload entry shape we actually depend on. Recharts' own
 *  generic type drags in a lot of chart-flavor-specific plumbing that
 *  is not worth carrying through -- we only read ``name``, ``value``,
 *  and ``color`` (the stroke colour of the series line). */
interface TooltipEntry {
  name?: string | number;
  value?: number | string;
  color?: string;
}

interface CustomTooltipProps {
  active?: boolean;
  payload?: ReadonlyArray<TooltipEntry>;
  label?: string | number;
}

/** Tooltip content for the Avg Latency area chart. Renders each
 *  series with the provider brand-mark when the dimension resolves
 *  to a provider we ship an icon for (anthropic, openai). Dimensions
 *  that map to ``unknown`` or a provider without bespoke art
 *  (flavors, frameworks, or xai/mistral/meta/other before we add
 *  their marks) fall back to the inline colour swatch alone -- we
 *  deliberately do not render the ``Sparkles`` fallback here because
 *  a tooltip row is narrower than a legend chip and the generic
 *  pictogram adds noise without information.
 *
 *  The visual style mirrors the default recharts tooltip that used
 *  to live inline (``var(--surface)`` background, 1px border,
 *  fontSize 12, 6px radius) so the rest of the page stays visually
 *  consistent. Values are formatted with ``toLocaleString`` and
 *  suffixed with ``ms`` -- the only ``chartType="area"`` consumer of
 *  this component today is the Avg Latency card, and its metric
 *  (``latency_avg``) is always milliseconds. A future area chart in
 *  another unit should add a formatter prop rather than reusing this
 *  suffix. */
function CustomTooltip({ active, payload, label }: CustomTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div
      style={{
        backgroundColor: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 6,
        color: "var(--text)",
        fontSize: 12,
        padding: "8px 10px",
        minWidth: 140,
      }}
    >
      <div
        style={{
          color: "var(--text-muted)",
          fontSize: 11,
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      {payload.map((entry) => {
        const name = String(entry.name ?? "");
        const provider = getProvider(name);
        const hasIcon = PROVIDER_ICONS[provider] != null;
        const valueText =
          typeof entry.value === "number"
            ? `${Math.round(entry.value).toLocaleString()}ms`
            : String(entry.value ?? "");
        return (
          <div
            key={name}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "2px 0",
            }}
          >
            {hasIcon ? (
              <ProviderLogo provider={provider} size={12} />
            ) : (
              <span
                aria-hidden="true"
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 2,
                  backgroundColor: entry.color ?? "var(--text-muted)",
                  display: "inline-block",
                }}
              />
            )}
            <span style={{ flex: 1 }}>{name}</span>
            <span style={{ fontWeight: 500 }}>{valueText}</span>
          </div>
        );
      })}
    </div>
  );
}

export function TimeSeriesChart({ series }: TimeSeriesChartProps) {
  // Merge all series into a single date-keyed array. Every row contains
  // a key for every dimension — null where that dimension has no data on
  // that date. This gives recharts a continuous dataset so Area paths
  // connect across the full date range instead of rendering isolated
  // slivers per data point.
  const chartData = useMemo(() => {
    const dimensions = series.map((s) => s.dimension);
    const dateMap = new Map<string, Record<string, number | null>>();

    // Seed every date with null for all dimensions
    for (const s of series) {
      for (const pt of s.data) {
        if (!dateMap.has(pt.date)) {
          const row: Record<string, number | null> = {};
          for (const d of dimensions) row[d] = null;
          dateMap.set(pt.date, row);
        }
      }
    }

    // Fill in actual values
    for (const s of series) {
      for (const pt of s.data) {
        dateMap.get(pt.date)![s.dimension] = pt.value;
      }
    }

    return Array.from(dateMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, values]) => ({ date, ...values }));
  }, [series]);

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
        <Tooltip content={<CustomTooltip />} />
        {series.map((s, i) => (
          <Area
            key={s.dimension}
            type="monotone"
            dataKey={s.dimension}
            connectNulls
            stroke={SERIES_FILLS[i % SERIES_FILLS.length]}
            fill={SERIES_FILLS[i % SERIES_FILLS.length]}
            fillOpacity={0.3}
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}
