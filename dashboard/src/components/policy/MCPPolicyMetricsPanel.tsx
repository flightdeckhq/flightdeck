import { useEffect, useMemo, useState } from "react";
import { Activity } from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
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
} from "@/lib/types";

type Period = "24h" | "7d" | "30d";

const PERIODS: { value: Period; label: string }[] = [
  { value: "24h", label: "Last 24h" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
];

const COLOUR_BLOCK = "var(--danger)";
const COLOUR_WARN = "var(--warning, #d97706)";

export interface MCPPolicyMetricsPanelProps {
  flavorOrGlobal: string;
  scopeKey: string;
}

interface Row {
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
 * renders the warn / block aggregate per server as a horizontal
 * stacked bar (red=block, amber=warn). The architecture sketch
 * called for a per-server sparkline ``LineChart`` but the API
 * returns aggregate counts, not time-series, so the chart shape
 * is bar-per-server with the count breakdown inline. The chart
 * shape is honest about the data the API actually emits rather
 * than mocking up a sparkline from a single number.
 *
 * Empty state pre-step-4 emission: "No enforcement events
 * recorded yet for this period." matches the ARCHITECTURE.md
 * guidance verbatim.
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

  const rows = useMemo<Row[]>(() => {
    if (!metrics) return [];
    const map = new Map<string, Row>();
    for (const b of metrics.blocks_per_server) {
      addBucket(map, b, "blocks");
    }
    for (const b of metrics.warns_per_server) {
      addBucket(map, b, "warns");
    }
    return [...map.values()].sort((a, b) => b.total - a.total);
  }, [metrics]);

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
        ) : rows.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="space-y-3">
            <Legend />
            <ChartBlock rows={rows} />
            <Summary rows={rows} />
          </div>
        )}
      </div>
    </section>
  );
}

function addBucket(
  map: Map<string, Row>,
  bucket: MCPPolicyMetricsBucket,
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

function Legend() {
  return (
    <div className="flex items-center gap-4 text-[11px]" aria-hidden="true">
      <LegendDot colour={COLOUR_BLOCK} label="Blocks" />
      <LegendDot colour={COLOUR_WARN} label="Warns" />
    </div>
  );
}

function LegendDot({ colour, label }: { colour: string; label: string }) {
  return (
    <span
      className="inline-flex items-center gap-1.5"
      style={{ color: "var(--text-muted)" }}
    >
      <span
        className="inline-block h-2 w-2 rounded-sm"
        style={{ background: colour }}
      />
      {label}
    </span>
  );
}

function ChartBlock({ rows }: { rows: Row[] }) {
  // Cap chart height so a 30-server scope doesn't stretch the page;
  // each row is ~28px which leaves the labels readable. Recharts
  // supports vertical bar charts (horizontal-orientation in
  // 2D-axis terms) with ``layout="vertical"``.
  const height = Math.max(rows.length * 28 + 40, 120);

  return (
    <div style={{ height }} data-testid="mcp-policy-metrics-chart">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={rows}
          layout="vertical"
          margin={{ top: 8, right: 16, bottom: 8, left: 8 }}
        >
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="var(--border)"
            horizontal={false}
          />
          <XAxis
            type="number"
            stroke="var(--text-muted)"
            tick={{ fontSize: 11 }}
            allowDecimals={false}
          />
          <YAxis
            type="category"
            dataKey="server_name"
            stroke="var(--text-muted)"
            tick={{ fontSize: 11 }}
            width={120}
          />
          <RechartsTooltip
            cursor={{ fill: "color-mix(in srgb, var(--accent) 8%, transparent)" }}
            contentStyle={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              fontSize: 12,
              color: "var(--text)",
            }}
            labelStyle={{ color: "var(--text)" }}
            formatter={(value, name) => {
              const v = typeof value === "number" ? value : 0;
              const key = String(name);
              if (key === "blocks") return [v, "Blocks"];
              if (key === "warns") return [v, "Warns"];
              return [v, key];
            }}
          />
          <Bar dataKey="blocks" stackId="counts">
            {rows.map((row) => (
              <Cell key={`b-${row.fingerprint}`} fill={COLOUR_BLOCK} />
            ))}
          </Bar>
          <Bar dataKey="warns" stackId="counts">
            {rows.map((row) => (
              <Cell key={`w-${row.fingerprint}`} fill={COLOUR_WARN} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function Summary({ rows }: { rows: Row[] }) {
  const totals = rows.reduce(
    (acc, r) => ({
      blocks: acc.blocks + r.blocks,
      warns: acc.warns + r.warns,
    }),
    { blocks: 0, warns: 0 },
  );
  return (
    <div
      className="flex items-center gap-6 border-t pt-3 text-[12px]"
      style={{ borderColor: "var(--border)" }}
    >
      <span style={{ color: "var(--text-muted)" }}>
        Servers: <span style={{ color: "var(--text)" }}>{rows.length}</span>
      </span>
      <span style={{ color: "var(--text-muted)" }}>
        Blocks:{" "}
        <span style={{ color: "var(--danger)", fontWeight: 600 }}>
          {totals.blocks}
        </span>
      </span>
      <span style={{ color: "var(--text-muted)" }}>
        Warns:{" "}
        <span
          style={{ color: "var(--warning, #d97706)", fontWeight: 600 }}
        >
          {totals.warns}
        </span>
      </span>
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
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="h-7 w-full animate-pulse rounded"
          style={{
            background: "color-mix(in srgb, var(--text-muted) 10%, transparent)",
          }}
        />
      ))}
    </div>
  );
}
