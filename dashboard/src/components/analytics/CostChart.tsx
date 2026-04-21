import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAnalytics } from "@/hooks/useAnalytics";
import { ChartCard } from "./ChartCard";
import { StackedSeriesChart } from "./StackedSeriesChart";
import type { AnalyticsParams } from "@/lib/types";

type CostGroupBy = "provider" | "model";

interface CostChartProps {
  range?: string;
  from?: string;
  to?: string;
  filterProvider: string | null;
}

/** Row 4 -- Estimated cost over time, stacked bars by provider (default)
 *  or model. Disclaimer banner sits above the chart whenever the period
 *  contains models outside the static pricing map (partial_estimate on
 *  the API response, D099). When the window has zero cost at all --
 *  typically because events were recorded before tokens_input and
 *  tokens_output started being split -- the card swaps its empty state
 *  for a dedicated message so the user knows the chart is blank by
 *  design rather than a data fetch failure. */
export function CostChart({ range, from, to, filterProvider }: CostChartProps) {
  const [groupBy, setGroupBy] = useState<CostGroupBy>("provider");

  const params = useMemo<AnalyticsParams>(
    () => ({
      metric: "estimated_cost",
      group_by: groupBy,
      range,
      from,
      to,
      filter_provider: filterProvider ?? undefined,
    }),
    [groupBy, range, from, to, filterProvider],
  );
  const { data, loading, error, refetch } = useAnalytics(params);

  const hasAnyCost =
    data?.series.some((s) => s.total > 0) ?? false;
  const empty = !loading && !!data && !hasAnyCost;

  const disclaimer = (
    <>
      <strong className="mr-1">Estimated cost.</strong>
      Based on public list prices. Excludes volume discounts,
      enterprise commitments, and cached-token rebates. Models without
      known pricing are excluded.
      {data?.partial_estimate && (
        <>
          {" "}
          <span className="font-semibold">
            Partial estimate — some models in this period have no pricing
            entry and are excluded.
          </span>
        </>
      )}
    </>
  );

  return (
    <ChartCard
      title="Estimated Cost"
      toolbar={
        <div className="flex gap-1">
          {(["provider", "model"] as const).map((option) => (
            <Button
              key={option}
              variant={groupBy === option ? "default" : "outline"}
              size="sm"
              onClick={() => setGroupBy(option)}
              className={cn(
                "capitalize",
                groupBy === option ? "pointer-events-none" : undefined,
              )}
            >
              By {option}
            </Button>
          ))}
        </div>
      }
      warning={disclaimer}
      loading={loading}
      error={error}
      onRetry={refetch}
      empty={empty}
      emptyMessage="Cost estimation requires input/output token breakdown. No data available for this period."
      contentHeight={320}
    >
      {data && hasAnyCost && (
        <StackedSeriesChart
          series={data.series}
          variant="bar"
          currency
          height={320}
        />
      )}
    </ChartCard>
  );
}
