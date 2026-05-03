import { useMemo } from "react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "@/components/ui/card";
import { useAnalytics } from "@/hooks/useAnalytics";
import { RankingChart } from "./RankingChart";
import type { AnalyticsParams } from "@/lib/types";

/**
 * D126 — sub-agent tokens broken down by role. Renders one bar per
 * agent_role bucket with the bar height showing child_token_sum
 * (total tokens consumed by every sub-agent session of that role
 * across the time window). Sessions with null agent_role bucket as
 * ``(root)`` server-side, but the ``filter_is_sub_agent=true`` we
 * pass restricts the result to actual children — the (root) bucket
 * stays empty, so the visible bars are exclusively sub-agent roles.
 *
 * The original spec called for "one bar per parent, segments per
 * child role" (true per-parent stacking). The /v1/analytics endpoint
 * groups by a single dimension at a time, so a faithful per-parent
 * breakdown would require a second dimension (parent_session_id) on
 * the wire — not in this phase. The role-level rollup is the
 * single-dimension approximation that answers the same operator
 * question ("which sub-agent roles eat the most tokens?") without
 * introducing a new analytics shape.
 *
 * Operators who need per-parent data deep-link to the SubAgentsTab
 * via the agent_role facet on Investigate (Step 7's ROLE column +
 * facet); the analytics card is the fleet-wide rollup, the
 * Investigate flow is the per-parent drill-in.
 */
export function ParentChildBreakdownChart({
  range,
  from,
  to,
  filterProvider,
}: {
  range?: string;
  from?: string;
  to?: string;
  filterProvider?: string | null;
}) {
  const params = useMemo<AnalyticsParams>(
    () => ({
      metric: "child_token_sum",
      group_by: "agent_role",
      range,
      from,
      to,
      filter_provider: filterProvider ?? undefined,
      filter_is_sub_agent: "true",
    }),
    [range, from, to, filterProvider],
  );

  const { data, loading, error } = useAnalytics(params);

  return (
    <Card data-testid="parent-child-breakdown-chart" className="flex flex-col">
      <CardHeader>
        <CardTitle>Tokens by Sub-agent Role</CardTitle>
      </CardHeader>
      <CardContent className="flex-1">
        {loading && (
          <div className="flex h-[260px] items-center justify-center">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        )}
        {error && !loading && (
          <div className="flex h-[260px] items-center justify-center text-sm text-danger">
            {error}
          </div>
        )}
        {!loading && !error && data && data.series.length === 0 && (
          <div className="flex h-[260px] items-center justify-center text-sm text-text-muted">
            No sub-agent activity in this period.
          </div>
        )}
        {!loading && !error && data && data.series.length > 0 && (
          <RankingChart series={data.series} />
        )}
      </CardContent>
    </Card>
  );
}
