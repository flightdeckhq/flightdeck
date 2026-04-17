import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useAnalytics } from "@/hooks/useAnalytics";
import { ChartCard } from "./ChartCard";
import { StackedSeriesChart } from "./StackedSeriesChart";
import type { AnalyticsParams } from "@/lib/types";

type TokenGroupBy = "provider" | "model" | "flavor";

interface TokenUsageOverTimeProps {
  range?: string;
  from?: string;
  to?: string;
  filterProvider: string | null;
}

/** Row 2 of the Analytics v2 page -- full-width stacked area chart of
 *  tokens over time with a By Provider / By Model / By Flavor toggle
 *  in the card toolbar. All three share the same metric=tokens query
 *  with only the group_by switched, so the page does not refetch the
 *  summary cards or any other row when the user toggles dimension. */
export function TokenUsageOverTime({
  range,
  from,
  to,
  filterProvider,
}: TokenUsageOverTimeProps) {
  const [groupBy, setGroupBy] = useState<TokenGroupBy>("provider");

  const params = useMemo<AnalyticsParams>(
    () => ({
      metric: "tokens",
      group_by: groupBy,
      range,
      from,
      to,
      filter_provider: filterProvider ?? undefined,
    }),
    [groupBy, range, from, to, filterProvider],
  );

  const { data, loading, error, refetch } = useAnalytics(params);

  return (
    <ChartCard
      title="Token Usage Over Time"
      toolbar={
        <div className="flex gap-1">
          {(["provider", "model", "flavor"] as const).map((option) => (
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
              By {option === "flavor" ? "agent" : option}
            </Button>
          ))}
        </div>
      }
      loading={loading}
      error={error}
      onRetry={refetch}
      empty={!loading && !!data && data.series.length === 0}
      contentHeight={320}
    >
      {data && <StackedSeriesChart series={data.series} variant="area" height={320} />}
    </ChartCard>
  );
}
