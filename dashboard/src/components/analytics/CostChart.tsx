import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAnalytics } from "@/hooks/useAnalytics";
import { ChartCard } from "./ChartCard";
import { StackedSeriesChart } from "./StackedSeriesChart";
import type { AnalyticsParams } from "@/lib/types";
import { costEmptyMessage } from "@/lib/cost";

type CostGroupBy = "provider" | "model";

interface CostChartProps {
  range?: string;
  from?: string;
  to?: string;
  filterProvider: string | null;
}

/** Row 4 -- Estimated cost over time, stacked bars by provider (default)
 *  or model. The note above the chart says what the figure covers and,
 *  from the response's ``billing_modes`` and ``models_unpriced`` (both
 *  over the whole window, not the chart's filters), what it leaves out:
 *  subscription calls, and calls to models with no price. */
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

  const unpriced = data?.models_unpriced ?? [];
  const disclaimer = (
    <>
      <strong className="mr-1">Estimated cost.</strong>
      Metered calls, priced from the cost a client reported or from
      list prices. Excludes volume discounts and enterprise
      commitments.
      {data?.billing_modes?.includes("subscription") && (
        <span data-testid="cost-chart-subscription-note">
          {" "}
          Subscription calls have no per-call cost and are not included.
        </span>
      )}
      {data?.partial_estimate && unpriced.length > 0 && (
        <span className="font-semibold" data-testid="cost-chart-partial-note">
          {" "}
          Partial estimate: calls to {unpriced.join(", ")} have no price
          and are not included.
        </span>
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
      emptyMessage={costEmptyMessage(data?.billing_modes)}
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
