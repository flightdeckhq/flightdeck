import { useEffect, useMemo, useState } from "react";
import { Activity } from "lucide-react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from "recharts";

import { ApiError, getMCPPolicyMetrics } from "@/lib/api";
import { cn } from "@/lib/utils";
import type {
  MCPPolicyMetrics,
  MCPPolicyMetricsBucket,
  MCPPolicyServerCountBucket,
} from "@/lib/types";

type Period = "24h" | "7d" | "30d";

const PERIODS: { value: Period; label: string }[] = [
  { value: "24h", label: "Last 24h" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
];

// Stable palette for sparkline lines. Cycle if a scope has more
// than eight servers — sparklines are a trend signal, not a
// per-server colour key, so cycling is acceptable.
const SERIES_PALETTE = [
  "#3b82f6", // blue
  "#22c55e", // green
  "#a855f7", // purple
  "#f97316", // orange
  "#06b6d4", // cyan
  "#ec4899", // pink
  "#eab308", // yellow
  "#14b8a6", // teal
];

const COLOUR_BLOCK = "var(--danger)";
const COLOUR_WARN = "var(--warning, #d97706)";

export interface MCPPolicyMetricsPanelProps {
  flavorOrGlobal: string;
  scopeKey: string;
}

interface SparklineRow {
  /** ISO timestamp at the bucket start. Used as the X axis category. */
  timestamp: string;
  /** Per-server total counts for this bucket. Keys are server fingerprints
   *  to disambiguate two servers that share a display name. */
  [seriesKey: string]: number | string;
}

interface ServerSeries {
  fingerprint: string;
  server_name: string;
  colour: string;
  /** seriesKey on each ``SparklineRow`` (``server_<fingerprint>``). */
  seriesKey: string;
}

interface AggregateRow {
  fingerprint: string;
  server_name: string;
  blocks: number;
  warns: number;
  total: number;
}

/**
 * Real-time enforcement metrics for a single MCP Protection
 * Policy scope. Calls
 * ``GET /v1/mcp-policies/:flavorOrGlobal/metrics?period=`` and
 * renders the time-bucketed series as one Recharts ``LineChart``
 * with one line per server (Y axis = block_count + warn_count
 * summed at each bucket — total enforcement events per server
 * over time, the sparkline's job is trend, not warn/block
 * ratio). Below the sparklines, the per-server aggregate counts
 * render as a small table with the warn vs block split (the
 * table's job is the ratio).
 *
 * Empty buckets are zero-filled server-side via
 * ``generate_series`` so the chart shows honest "no events"
 * valleys — sparse data on a security dashboard would render
 * 3 days of nothing followed by a spike as a gradual ramp,
 * which misleads the operator.
 *
 * Empty pre-emission state copy is verbatim from architecture:
 * "No enforcement events recorded yet for this period."
 */
export function MCPPolicyMetricsPanel({
  flavorOrGlobal,
  scopeKey,
}: MCPPolicyMetricsPanelProps) {
  const [period, setPeriod] = useState<Period>("24h");
  const [metrics, setMetrics] = useState<MCPPolicyMetrics | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getMCPPolicyMetrics(flavorOrGlobal, period)
      .then((m) => {
        if (cancelled) return;
        setMetrics(m);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setMetrics(null);
        if (err instanceof ApiError && err.status === 403) {
          setError("Admin token required to view metrics.");
        } else {
          setError(err instanceof Error ? err.message : "Failed to load metrics");
        }
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [flavorOrGlobal, period]);

  const aggregateRows = useMemo<AggregateRow[]>(() => {
    if (!metrics) return [];
    const map = new Map<string, AggregateRow>();
    for (const b of metrics.blocks_per_server) {
      addAggregate(map, b, "blocks");
    }
    for (const b of metrics.warns_per_server) {
      addAggregate(map, b, "warns");
    }
    return [...map.values()].sort((a, b) => b.total - a.total);
  }, [metrics]);

  const series = useMemo<ServerSeries[]>(() => {
    return aggregateRows.map((row, idx) => ({
      fingerprint: row.fingerprint,
      server_name: row.server_name,
      colour: SERIES_PALETTE[idx % SERIES_PALETTE.length],
      seriesKey: `server_${row.fingerprint}`,
    }));
  }, [aggregateRows]);

  const chartRows = useMemo<SparklineRow[]>(
    () => bucketsToSparklineRows(metrics?.buckets ?? [], series),
    [metrics?.buckets, series],
  );

  return (
    <section
      className="rounded-md border"
      style={{ borderColor: "var(--border)", background: "var(--surface)" }}
      data-testid={`mcp-policy-metrics-${scopeKey}`}
    >
      <header
        className="flex items-center justify-between gap-2 border-b px-4 py-3"
        style={{ borderColor: "var(--border)" }}
      >
        <div className="flex items-center gap-2">
          <Activity
            className="h-4 w-4"
            style={{ color: "var(--text-muted)" }}
            aria-hidden="true"
          />
          <h2
            className="text-sm font-semibold"
            style={{ color: "var(--text)" }}
          >
            Enforcement metrics
          </h2>
          {metrics ? (
            <span
              className="text-[11px]"
              style={{ color: "var(--text-muted)" }}
            >
              {metrics.granularity}-bucketed sparkline · per-server
              warn/block split below
            </span>
          ) : null}
        </div>
        <PeriodPicker
          value={period}
          onChange={setPeriod}
          scopeKey={scopeKey}
        />
      </header>

      <div className="p-4">
        {error ? (
          <ErrorState message={error} />
        ) : loading && !metrics ? (
          <SkeletonChart />
        ) : aggregateRows.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="space-y-4">
            <SparklineBlock
              rows={chartRows}
              series={series}
              granularity={metrics?.granularity ?? "hour"}
            />
            <AggregateTable rows={aggregateRows} series={series} scopeKey={scopeKey} />
          </div>
        )}
      </div>
    </section>
  );
}

function addAggregate(
  map: Map<string, AggregateRow>,
  bucket: MCPPolicyServerCountBucket,
  axis: "blocks" | "warns",
) {
  const existing = map.get(bucket.fingerprint);
  if (existing) {
    existing[axis] += bucket.count;
    existing.total += bucket.count;
    return;
  }
  map.set(bucket.fingerprint, {
    fingerprint: bucket.fingerprint,
    server_name: bucket.server_name,
    blocks: axis === "blocks" ? bucket.count : 0,
    warns: axis === "warns" ? bucket.count : 0,
    total: bucket.count,
  });
}

function bucketsToSparklineRows(
  buckets: MCPPolicyMetricsBucket[],
  series: ServerSeries[],
): SparklineRow[] {
  return buckets.map((bucket) => {
    const row: SparklineRow = { timestamp: bucket.timestamp };
    // Initialise every series at zero so a server that skipped a
    // bucket renders a flat line at zero rather than dropping out.
    for (const s of series) {
      row[s.seriesKey] = 0;
    }
    for (const b of bucket.blocks) {
      const s = series.find((entry) => entry.fingerprint === b.fingerprint);
      if (!s) continue;
      row[s.seriesKey] = (row[s.seriesKey] as number) + b.count;
    }
    for (const w of bucket.warns) {
      const s = series.find((entry) => entry.fingerprint === w.fingerprint);
      if (!s) continue;
      row[s.seriesKey] = (row[s.seriesKey] as number) + w.count;
    }
    return row;
  });
}

function PeriodPicker({
  value,
  onChange,
  scopeKey,
}: {
  value: Period;
  onChange: (next: Period) => void;
  scopeKey: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Metrics period"
      className="inline-flex rounded-md border p-0.5"
      style={{
        borderColor: "var(--border)",
        background: "var(--background-elevated)",
      }}
      data-testid={`mcp-policy-metrics-period-${scopeKey}`}
    >
      {PERIODS.map((p) => (
        <button
          key={p.value}
          type="button"
          role="radio"
          aria-checked={value === p.value}
          onClick={() => onChange(p.value)}
          className={cn(
            "rounded px-2.5 py-1 text-[11px] font-medium transition-colors",
            "focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
            value === p.value
              ? "bg-[var(--surface)] text-[var(--text)]"
              : "text-[var(--text-muted)] hover:text-[var(--text)]",
          )}
          data-testid={`mcp-policy-metrics-period-${scopeKey}-${p.value}`}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}

function SparklineBlock({
  rows,
  series,
  granularity,
}: {
  rows: SparklineRow[];
  series: ServerSeries[];
  granularity: string;
}) {
  return (
    <div data-testid="mcp-policy-metrics-sparkline">
      <div
        className="mb-2 text-[11px]"
        style={{ color: "var(--text-muted)" }}
      >
        Total enforcement events per server, {granularity}-bucketed.
      </div>
      <div style={{ height: 180 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={rows}
            margin={{ top: 8, right: 16, bottom: 4, left: 4 }}
          >
            <CartesianGrid
              strokeDasharray="3 3"
              stroke="var(--border)"
              vertical={false}
            />
            <XAxis
              dataKey="timestamp"
              stroke="var(--text-muted)"
              tick={{ fontSize: 10 }}
              tickFormatter={(value: string) => formatTick(value, granularity)}
              minTickGap={32}
            />
            <YAxis
              stroke="var(--text-muted)"
              tick={{ fontSize: 10 }}
              allowDecimals={false}
              width={28}
            />
            <RechartsTooltip
              cursor={{ stroke: "var(--accent)", strokeWidth: 1 }}
              contentStyle={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                fontSize: 12,
                color: "var(--text)",
              }}
              labelFormatter={(label) => formatTooltipLabel(String(label), granularity)}
              formatter={(value, name) => {
                const v = typeof value === "number" ? value : 0;
                const s = series.find((entry) => entry.seriesKey === name);
                return [v, s?.server_name ?? String(name)];
              }}
            />
            {series.map((s) => (
              <Line
                key={s.seriesKey}
                type="monotone"
                dataKey={s.seriesKey}
                name={s.seriesKey}
                stroke={s.colour}
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function AggregateTable({
  rows,
  series,
  scopeKey,
}: {
  rows: AggregateRow[];
  series: ServerSeries[];
  scopeKey: string;
}) {
  return (
    <div
      className="rounded-md border"
      style={{
        borderColor: "var(--border)",
        background: "var(--background-elevated)",
      }}
      data-testid={`mcp-policy-metrics-aggregate-${scopeKey}`}
    >
      <table className="w-full text-sm">
        <thead>
          <tr
            className="border-b text-left"
            style={{
              borderColor: "var(--border)",
              color: "var(--text-muted)",
            }}
          >
            <th className="w-2 px-3 py-2"></th>
            <th className="px-3 py-2 text-[10px] font-medium uppercase tracking-wide">
              Server
            </th>
            <th
              className="w-24 px-3 py-2 text-right text-[10px] font-medium uppercase tracking-wide"
              style={{ color: COLOUR_BLOCK }}
            >
              Blocks
            </th>
            <th
              className="w-24 px-3 py-2 text-right text-[10px] font-medium uppercase tracking-wide"
              style={{ color: COLOUR_WARN }}
            >
              Warns
            </th>
            <th className="w-24 px-3 py-2 text-right text-[10px] font-medium uppercase tracking-wide">
              Total
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const colour =
              series.find((s) => s.fingerprint === row.fingerprint)?.colour ??
              "var(--text-muted)";
            return (
              <tr
                key={row.fingerprint}
                className="border-b last:border-0"
                style={{ borderColor: "var(--border)" }}
                data-testid={`mcp-policy-metrics-aggregate-row-${row.fingerprint}`}
              >
                <td className="px-3 py-1.5">
                  <span
                    className="inline-block h-2 w-2 rounded-sm"
                    style={{ background: colour }}
                    aria-hidden="true"
                  />
                </td>
                <td
                  className="px-3 py-1.5 font-medium"
                  style={{ color: "var(--text)" }}
                >
                  {row.server_name}
                </td>
                <td
                  className="px-3 py-1.5 text-right font-mono"
                  style={{ color: COLOUR_BLOCK }}
                >
                  {row.blocks}
                </td>
                <td
                  className="px-3 py-1.5 text-right font-mono"
                  style={{ color: COLOUR_WARN }}
                >
                  {row.warns}
                </td>
                <td
                  className="px-3 py-1.5 text-right font-mono"
                  style={{ color: "var(--text)" }}
                >
                  {row.total}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div
      className="rounded-md border px-3 py-3 text-xs"
      style={{
        borderColor: "var(--danger)",
        background: "color-mix(in srgb, var(--danger) 10%, transparent)",
        color: "var(--danger)",
      }}
      data-testid="mcp-policy-metrics-error"
    >
      {message}
    </div>
  );
}

function EmptyState() {
  return (
    <div
      className="rounded-md border px-4 py-6 text-center text-sm"
      style={{
        borderColor: "var(--border)",
        background: "var(--background-elevated)",
        color: "var(--text-muted)",
      }}
      data-testid="mcp-policy-metrics-empty"
    >
      No enforcement events recorded yet for this period.
    </div>
  );
}

function SkeletonChart() {
  return (
    <div className="space-y-2" data-testid="mcp-policy-metrics-skeleton">
      <div
        className="h-44 w-full animate-pulse rounded"
        style={{
          background: "color-mix(in srgb, var(--text-muted) 10%, transparent)",
        }}
      />
      <div
        className="h-12 w-full animate-pulse rounded"
        style={{
          background: "color-mix(in srgb, var(--text-muted) 10%, transparent)",
        }}
      />
    </div>
  );
}

function formatTick(iso: string, granularity: string): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return iso;
  if (granularity === "hour") {
    return t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return t.toLocaleDateString([], { month: "short", day: "2-digit" });
}

function formatTooltipLabel(iso: string, granularity: string): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return iso;
  if (granularity === "hour") {
    return t.toLocaleString([], {
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  return t.toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "2-digit",
  });
}
