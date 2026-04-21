import { useMemo, useState } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAnalytics } from "@/hooks/useAnalytics";
import { DimensionPicker, dimensionLabel } from "./DimensionPicker";
import { TimeSeriesChart } from "./TimeSeriesChart";
import { RankingChart } from "./RankingChart";
import { DonutChart } from "./DonutChart";
import type { AnalyticsParams } from "@/lib/types";

interface DimensionChartProps {
  /** Static title, used when the selector is hidden or the caller
   *  doesn't want a dynamic title. Ignored if ``renderTitle`` is set. */
  title: string;
  metric: string;
  defaultGroupBy: string;
  chartType: "area" | "bar" | "donut";
  range?: string;
  from?: string;
  to?: string;
  granularity?: string;
  className?: string;
  /** Optional provider filter threaded through from the Analytics
   *  page so per-row charts honor the filter the user clicked into
   *  on the summary cards. */
  filterProvider?: string | null;
  /** When false, the ``[Group by: X ▾]`` dropdown in the top-right
   *  is not rendered and the chart stays pinned to ``defaultGroupBy``.
   *  Use this on charts whose title encodes the dimension (e.g.
   *  "Framework Distribution", "Sessions by Model") where letting the
   *  user change the dimension would make the title lie. Default
   *  ``true`` to preserve the prior behavior. */
  showDimensionPicker?: boolean;
  /** Optional dynamic-title callback. Receives the human-readable
   *  label for the currently selected ``groupBy`` (e.g. ``"Model"``
   *  for ``groupBy="model"``) and returns the title text to show on
   *  the card. When omitted, ``title`` is rendered as-is. Paired with
   *  ``showDimensionPicker=true`` on charts like "Avg Latency by
   *  {dim}" so the title reflects the live selection. */
  renderTitle?: (dimLabel: string) => string;
}

/** Generic card for one analytics query rendered as an area / bar /
 *  donut chart. A single ``/v1/analytics`` call is shared across all
 *  three chart types -- the rendering component swaps on
 *  ``chartType`` -- and the top-right dimension selector swaps the
 *  ``group_by`` param on the same query. */
export function DimensionChart({
  title,
  metric,
  defaultGroupBy,
  chartType,
  range,
  from,
  to,
  granularity,
  className,
  filterProvider,
  showDimensionPicker = true,
  renderTitle,
}: DimensionChartProps) {
  const [groupBy, setGroupBy] = useState(defaultGroupBy);

  const params = useMemo<AnalyticsParams>(
    () => ({
      metric,
      group_by: groupBy,
      range,
      from,
      to,
      granularity,
      filter_provider: filterProvider ?? undefined,
    }),
    [metric, groupBy, range, from, to, granularity, filterProvider]
  );

  const { data, loading, error, refetch } = useAnalytics(params);

  const resolvedTitle = renderTitle
    ? renderTitle(dimensionLabel(groupBy))
    : title;

  return (
    <Card className={cn("flex flex-col", className)}>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>{resolvedTitle}</CardTitle>
        {showDimensionPicker && (
          <DimensionPicker value={groupBy} onGroupByChange={setGroupBy} />
        )}
      </CardHeader>
      <CardContent className="flex-1">
        {loading && (
          <div className="flex h-[260px] items-center justify-center">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        )}
        {error && !loading && (
          <div className="flex h-[260px] flex-col items-center justify-center gap-2">
            <span className="text-sm text-danger">{error}</span>
            <Button variant="outline" size="sm" onClick={refetch}>
              Retry
            </Button>
          </div>
        )}
        {!loading && !error && data && data.series.length === 0 && (
          <div className="flex h-[260px] items-center justify-center text-sm text-text-muted">
            No data for this period
          </div>
        )}
        {!loading && !error && data && data.series.length > 0 && (
          <>
            {chartType === "area" && <TimeSeriesChart series={data.series} />}
            {chartType === "bar" && <RankingChart series={data.series} />}
            {chartType === "donut" && <DonutChart series={data.series} />}
          </>
        )}
      </CardContent>
    </Card>
  );
}
