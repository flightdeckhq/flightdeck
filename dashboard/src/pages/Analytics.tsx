import { useState } from "react";
import { Button } from "@/components/ui/button";
import { SummaryCards } from "@/components/analytics/SummaryCards";
import { TokenUsageOverTime } from "@/components/analytics/TokenUsageOverTime";
import { ProviderBarChart } from "@/components/analytics/ProviderBarChart";
import { ModelBarChart } from "@/components/analytics/ModelBarChart";
import { CostChart } from "@/components/analytics/CostChart";
import { LatencyDistribution } from "@/components/analytics/LatencyDistribution";
import { DimensionChart } from "@/components/analytics/DimensionChart";
import { PROVIDER_META, type Provider } from "@/lib/models";

type RangePreset = "today" | "7d" | "30d" | "90d" | "custom";

/**
 * Analytics v2 -- provider breakdown, cost estimation, latency
 * distribution, and framework chart. Six rows total, all driven by
 * the shared time-range picker at the top plus an optional provider
 * filter promoted from the summary cards in row 1.
 *
 * Each chart fetches /v1/analytics independently via useAnalytics, so
 * changing the time range triggers a parallel refresh across the page
 * without one row blocking another. The filter provider threads into
 * every chart via `filter_provider`; the backend applies it as an
 * extra WHERE clause on the provider SQL CASE expression.
 */
export function Analytics() {
  const [rangePreset, setRangePreset] = useState<RangePreset>("30d");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [filterProvider, setFilterProvider] = useState<Provider | null>(null);

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
          {(["today", "7d", "30d", "90d"] as const).map((preset) => (
            <Button
              key={preset}
              variant={rangePreset === preset ? "default" : "outline"}
              size="sm"
              onClick={() => setRangePreset(preset)}
            >
              {preset === "today" ? "Today" : preset}
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
          {filterProvider && (
            <div className="ml-auto flex items-center gap-2 text-xs text-text-muted">
              <span>
                Filter: provider =
                <span className="ml-1 font-medium text-text">
                  {PROVIDER_META[filterProvider].label}
                </span>
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setFilterProvider(null)}
              >
                Clear
              </Button>
            </div>
          )}
        </div>

        {/* Row 1 -- summary cards */}
        <SummaryCards
          range={range ?? ""}
          from={from}
          to={to}
          filterProvider={filterProvider}
          onSelectProvider={setFilterProvider}
        />

        {/* Row 2 -- tokens over time */}
        <TokenUsageOverTime
          range={range}
          from={from}
          to={to}
          filterProvider={filterProvider}
        />

        {/* Row 3 -- provider + model breakdown */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <ProviderBarChart
            range={range}
            from={from}
            to={to}
            filterProvider={filterProvider}
          />
          <ModelBarChart
            range={range}
            from={from}
            to={to}
            filterProvider={filterProvider}
          />
        </div>

        {/* Row 4 -- estimated cost */}
        <CostChart
          range={range}
          from={from}
          to={to}
          filterProvider={filterProvider}
        />

        {/* Row 5 -- latency. The latency card keeps its dimension
            selector (the only chart on the page where regrouping is
            meaningful); the title updates to match the live dimension
            via renderTitle. */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <DimensionChart
            title="Avg Latency by Model"
            renderTitle={(dimLabel) => `Avg Latency by ${dimLabel}`}
            metric="latency_avg"
            defaultGroupBy="model"
            chartType="area"
            range={range}
            from={from}
            to={to}
            filterProvider={filterProvider}
          />
          <LatencyDistribution
            range={range}
            from={from}
            to={to}
            filterProvider={filterProvider}
          />
        </div>

        {/* Row 6 -- framework + sessions + agent type. These three
            cards encode the dimension in their title ("Framework
            Distribution", "Sessions by Model", "Agent Type
            Distribution") so the dimension picker is hidden --
            swapping it would make the title lie. */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <DimensionChart
            title="Framework Distribution"
            metric="sessions"
            defaultGroupBy="framework"
            chartType="donut"
            className="min-h-[280px]"
            range={range}
            from={from}
            to={to}
            filterProvider={filterProvider}
            showDimensionPicker={false}
          />
          <DimensionChart
            title="Sessions by Model"
            metric="sessions"
            defaultGroupBy="model"
            chartType="bar"
            className="min-h-[280px]"
            range={range}
            from={from}
            to={to}
            filterProvider={filterProvider}
            showDimensionPicker={false}
          />
          <DimensionChart
            title="Agent Type Distribution"
            metric="sessions"
            defaultGroupBy="agent_type"
            chartType="donut"
            className="min-h-[280px]"
            range={range}
            from={from}
            to={to}
            filterProvider={filterProvider}
            showDimensionPicker={false}
          />
        </div>
      </div>
    </div>
  );
}
