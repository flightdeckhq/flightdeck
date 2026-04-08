import { useState } from "react";
import { Button } from "@/components/ui/button";
import { KpiRow } from "@/components/analytics/KpiRow";
import { DimensionChart } from "@/components/analytics/DimensionChart";

type RangePreset = "7d" | "30d" | "90d" | "custom";

export function Analytics() {
  const [rangePreset, setRangePreset] = useState<RangePreset>("30d");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");

  const isCustom = rangePreset === "custom";
  const range = isCustom ? undefined : rangePreset;
  const from = isCustom && customFrom ? customFrom : undefined;
  const to = isCustom && customTo ? customTo : undefined;

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="mx-auto flex max-w-7xl flex-col gap-6">
        {/* Time range picker */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-medium text-text-muted">Time range:</span>
          {(["7d", "30d", "90d"] as const).map((preset) => (
            <Button
              key={preset}
              variant={rangePreset === preset ? "default" : "outline"}
              size="sm"
              onClick={() => setRangePreset(preset)}
            >
              {preset}
            </Button>
          ))}
          <Button
            variant={isCustom ? "default" : "outline"}
            size="sm"
            onClick={() => setRangePreset("custom")}
          >
            Custom
          </Button>
          {isCustom && (
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
                className="h-7 rounded-md border border-border bg-surface px-2 text-xs text-text"
              />
              <span className="text-xs text-text-muted">to</span>
              <input
                type="date"
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
                className="h-7 rounded-md border border-border bg-surface px-2 text-xs text-text"
              />
            </div>
          )}
        </div>

        {/* KPI Row */}
        <KpiRow range={range ?? ""} from={from} to={to} />

        {/* Row 1: Full-width token usage over time */}
        <DimensionChart
          title="Token Usage Over Time"
          metric="tokens"
          defaultGroupBy="flavor"
          chartType="area"
          range={range}
          from={from}
          to={to}
        />

        {/* Row 2: Tokens by dimension (bar) + Sessions over time (area) */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <DimensionChart
            title="Tokens by Dimension"
            metric="tokens"
            defaultGroupBy="flavor"
            chartType="bar"
            range={range}
            from={from}
            to={to}
          />
          <DimensionChart
            title="Sessions Over Time"
            metric="sessions"
            defaultGroupBy="flavor"
            chartType="area"
            range={range}
            from={from}
            to={to}
          />
        </div>

        {/* Row 3: Token distribution (donut) + Policy events over time (area) */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <DimensionChart
            title="Token Distribution by Model"
            metric="tokens"
            defaultGroupBy="model"
            chartType="donut"
            range={range}
            from={from}
            to={to}
          />
          <DimensionChart
            title="Policy Events Over Time"
            metric="policy_events"
            defaultGroupBy="flavor"
            chartType="area"
            range={range}
            from={from}
            to={to}
          />
        </div>
      </div>
    </div>
  );
}
