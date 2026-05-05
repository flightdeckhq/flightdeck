import { useMemo, useState } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "@/components/ui/card";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { useAnalytics } from "@/hooks/useAnalytics";
import type { AnalyticsParams, AnalyticsSeries } from "@/lib/types";

/**
 * D126 § 7.fix.I — per-parent stacked bar chart. Each bar
 * represents one parent session; each stacked segment one child
 * role. Driven by the 6.4 ``group_by=parent_session_id,agent_role``
 * two-dim contract: the API returns one series per parent, with
 * each series carrying per-DataPoint breakdowns by role.
 *
 * Metric variants supported via the inline picker:
 *   * ``child_token_sum`` — total tokens consumed by sub-agent
 *     descendants per parent / role.
 *   * ``child_count`` — number of distinct child sessions per
 *     parent / role.
 *   * ``parent_to_first_child_latency_ms`` — average latency
 *     between parent start and first child start.
 *
 * The "error-rate" metric mentioned in the original design doc is
 * not yet a server-side analytics metric (D126's locked metric
 * list does not include it); when it lands the picker gains a
 * fourth option without a chart-shape change.
 *
 * ``filter_is_sub_agent=true`` is hard-coded so the primary axis
 * (parent UUIDs) carries only sub-agent rows under their actual
 * parent's UUID rather than ``(root)`` buckets for unrelated root
 * sessions.
 */

const METRIC_OPTIONS = [
  { value: "child_token_sum", label: "Child Tokens" },
  { value: "child_count", label: "Child Count" },
  { value: "parent_to_first_child_latency_ms", label: "Parent → First Child Latency (ms)" },
] as const;
type MetricValue = (typeof METRIC_OPTIONS)[number]["value"];

// Role palette — chart-N CSS vars resolve under both themes. A
// deterministic hash of the role string maps each role to one of
// six slots so the same role always gets the same colour across
// session opens / page reloads.
const ROLE_VARS = [
  "--chart-1",
  "--chart-2",
  "--chart-3",
  "--chart-4",
  "--chart-5",
  "--text-muted",
];

function colorForRole(role: string): string {
  let h = 0;
  for (let i = 0; i < role.length; i += 1) {
    h = (h * 31 + role.charCodeAt(i)) >>> 0;
  }
  return `var(${ROLE_VARS[h % ROLE_VARS.length]})`;
}

// ROOT_BUCKET_LABEL mirrors the server-side COALESCE-to-(root)
// label baked into the agent_role and parent_session_id dimensions
// in store/analytics.go. Surfacing it here as a constant keeps the
// dashboard rendering in lock-step with the server.
const ROOT_BUCKET_LABEL = "(root)";

export function ParentChildBreakdownChart({
  range,
  from,
  to,
  filterProvider,
  filterIsSubAgent,
  filterHasSubAgents,
}: {
  range?: string;
  from?: string;
  to?: string;
  filterProvider?: string | null;
  /** D126 § 7.fix.J — page-level "Sub-agent activity" facet. When
   *  either is set, overrides the chart's default
   *  ``filter_is_sub_agent=true`` so the operator's facet choice
   *  drives the filter rather than a hardcoded default. */
  filterIsSubAgent?: boolean;
  filterHasSubAgents?: boolean;
}) {
  const [metric, setMetric] = useState<MetricValue>("child_token_sum");

  const params = useMemo<AnalyticsParams>(() => {
    // Default to children-only when the page-level facet is
    // unset; an unfiltered breakdown would include the (root)
    // bucket which dominates and washes out the per-parent bars.
    const useDefault = !filterIsSubAgent && !filterHasSubAgents;
    return {
      metric,
      group_by: "parent_session_id,agent_role",
      range,
      from,
      to,
      filter_provider: filterProvider ?? undefined,
      filter_is_sub_agent:
        useDefault || filterIsSubAgent ? "true" : undefined,
      filter_has_sub_agents: filterHasSubAgents ? "true" : undefined,
    };
  }, [metric, range, from, to, filterProvider, filterIsSubAgent, filterHasSubAgents]);

  const { data, loading, error } = useAnalytics(params);

  // Pivot the API response into one row per parent with per-role
  // numeric columns. Keys → role strings → values. Recharts
  // BarChart consumes this shape directly with one ``<Bar
  // dataKey={role} stackId="parent"/>`` per role.
  const pivoted = useMemo(() => pivotByParent(data?.series ?? []), [data]);

  const renderBody = () => {
    if (loading) {
      return (
        <div className="flex h-[260px] items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      );
    }
    if (error) {
      return (
        <div className="flex h-[260px] items-center justify-center text-sm text-danger">
          {error}
        </div>
      );
    }
    if (!data || pivoted.bars.length === 0) {
      return (
        <div
          className="flex h-[260px] items-center justify-center text-sm text-text-muted"
          data-testid="parent-child-breakdown-empty"
        >
          No sub-agent activity in this period.
        </div>
      );
    }
    return (
      <ResponsiveContainer width="100%" height={300}>
        <BarChart
          data={pivoted.bars}
          margin={{ top: 8, right: 16, bottom: 24, left: 8 }}
        >
          <CartesianGrid stroke="var(--border-subtle)" vertical={false} />
          <XAxis
            dataKey="parentLabel"
            stroke="var(--text-muted)"
            fontSize={10}
            interval={0}
            angle={-30}
            textAnchor="end"
            height={50}
          />
          <YAxis stroke="var(--text-muted)" fontSize={10} />
          <Tooltip
            contentStyle={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: 4,
              fontSize: 11,
            }}
            formatter={(value, key) => {
              const num = typeof value === "number" ? value : 0;
              return [num.toLocaleString(), String(key ?? "")];
            }}
          />
          <Legend
            wrapperStyle={{ fontSize: 11, color: "var(--text)" }}
          />
          {pivoted.roles.map((role) => (
            <Bar
              key={role}
              dataKey={role}
              stackId="parent"
              fill={colorForRole(role)}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    );
  };

  return (
    <Card data-testid="parent-child-breakdown-chart" className="flex flex-col">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Parent × Child Role Breakdown</CardTitle>
        <Select
          value={metric}
          onValueChange={(v) => setMetric(v as MetricValue)}
        >
          <SelectTrigger className="w-[260px]" data-testid="parent-child-breakdown-metric">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {METRIC_OPTIONS.map((m) => (
              <SelectItem key={m.value} value={m.value}>
                {m.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </CardHeader>
      <CardContent className="flex-1">{renderBody()}</CardContent>
    </Card>
  );
}

interface PivotResult {
  bars: Array<Record<string, string | number>>;
  roles: string[];
}

/**
 * Pivot the 2-dim analytics response into a recharts-friendly
 * shape: one row per parent, one numeric column per role. Roles
 * are collected across every bar so a missing role on a particular
 * parent still slots in as 0 (recharts skips missing keys but
 * surfacing 0 keeps the legend stable). Exported for unit testing.
 */
export function pivotByParent(series: AnalyticsSeries[]): PivotResult {
  const allRoles = new Set<string>();
  const bars: Array<Record<string, string | number>> = [];

  for (const s of series) {
    const row: Record<string, string | number> = {
      parentId: s.dimension,
      // Truncated 8-char UUID prefix for the X-axis label; the
      // (root) pseudo-bucket renders verbatim so an operator can
      // tell at a glance which bar represents non-parent sessions
      // (only relevant when filter_is_sub_agent is off).
      parentLabel:
        s.dimension === ROOT_BUCKET_LABEL
          ? ROOT_BUCKET_LABEL
          : s.dimension.slice(0, 8),
    };
    // Aggregate breakdown values across every data point in the
    // series so each parent gets a single bar height per role
    // (instead of N bars per parent — one per time bucket). The
    // chart shows totals over the analytics window.
    for (const pt of s.data) {
      const breakdown = pt.breakdown ?? [];
      for (const b of breakdown) {
        allRoles.add(b.key);
        row[b.key] = ((row[b.key] as number) ?? 0) + b.value;
      }
    }
    bars.push(row);
  }
  return {
    bars,
    roles: Array.from(allRoles).sort(),
  };
}
