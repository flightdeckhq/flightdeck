import { useMemo, useState } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAnalytics } from "@/hooks/useAnalytics";
import { DimensionPicker } from "./DimensionPicker";
import { TimeSeriesChart } from "./TimeSeriesChart";
import { RankingChart } from "./RankingChart";
import { DonutChart } from "./DonutChart";
import type { AnalyticsParams } from "@/lib/types";

interface DimensionChartProps {
  title: string;
  metric: string;
  defaultGroupBy: string;
  chartType: "area" | "bar" | "donut";
  range?: string;
  from?: string;
  to?: string;
  granularity?: string;
  className?: string;
}

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
}: DimensionChartProps) {
  const [groupBy, setGroupBy] = useState(defaultGroupBy);

  const params = useMemo<AnalyticsParams>(
    () => ({ metric, group_by: groupBy, range, from, to, granularity }),
    [metric, groupBy, range, from, to, granularity]
  );

  const { data, loading, error, refetch } = useAnalytics(params);

  return (
    <Card className={cn("flex flex-col", className)}>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>{title}</CardTitle>
        <DimensionPicker value={groupBy} onGroupByChange={setGroupBy} />
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
