import { useState } from "react";
import { Button } from "@/components/ui/button";
import { SummaryCards } from "@/components/analytics/SummaryCards";
import { TokenUsageOverTime } from "@/components/analytics/TokenUsageOverTime";
import { ProviderBarChart } from "@/components/analytics/ProviderBarChart";
import { ModelBarChart } from "@/components/analytics/ModelBarChart";
import { CostChart } from "@/components/analytics/CostChart";
import { LatencyDistribution } from "@/components/analytics/LatencyDistribution";
import { DimensionChart } from "@/components/analytics/DimensionChart";
import { ParentChildBreakdownChart } from "@/components/analytics/ParentChildBreakdownChart";
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
  // D126 § 7.fix.J — sub-agent activity facet. Mirrors the
  // Investigate TOPOLOGY facet checkboxes (Has sub-agents / Is
  // sub-agent) for muscle memory across the two pages. Both
  // selectable simultaneously (server-side OR composition per
  // 7.fix.F). Applied to the ParentChildBreakdownChart below; the
  // upstream chart cards (Tokens / Cost / Latency / etc.) don't
  // currently expose a topology axis in their UI so the filter is
  // a no-op there — extending those charts to honour it is a
  // future-PR item, captured by the design doc § 6.4 note.
  const [topologyIsSubAgent, setTopologyIsSubAgent] = useState(false);
  const [topologyHasSubAgents, setTopologyHasSubAgents] = useState(false);

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

        {/* D126 § 7.fix.J — sub-agent activity facet. Two
            checkboxes mirror Investigate's TOPOLOGY facet so the
            two pages read as one set of controls. */}
        <div
          className="flex items-center gap-3 text-xs"
          data-testid="analytics-sub-agent-activity-facet"
        >
          <span className="font-medium text-text-muted">
            Sub-agent activity:
          </span>
          <label
            className="inline-flex items-center gap-1 cursor-pointer"
            data-testid="analytics-topology-is-sub-agent"
          >
            <input
              type="checkbox"
              checked={topologyIsSubAgent}
              onChange={(e) => setTopologyIsSubAgent(e.target.checked)}
            />
            <span>Is sub-agent</span>
          </label>
          <label
            className="inline-flex items-center gap-1 cursor-pointer"
            data-testid="analytics-topology-has-sub-agents"
          >
            <input
              type="checkbox"
              checked={topologyHasSubAgents}
              onChange={(e) => setTopologyHasSubAgents(e.target.checked)}
            />
            <span>Has sub-agents</span>
          </label>
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

        {/* Row 7 — D126 sub-agent breakdown. Renders only when the
            time window contains sub-agent sessions; the chart's own
            empty-state copy handles the no-activity case so the row
            never collapses awkwardly. The TOPOLOGY checkboxes above
            thread through into the chart's filter params; default
            (both unchecked) renders children-only so the (root)
            bucket doesn't wash out the per-parent bars. */}
        <ParentChildBreakdownChart
          range={range}
          from={from}
          to={to}
          filterProvider={filterProvider}
          filterIsSubAgent={topologyIsSubAgent}
          filterHasSubAgents={topologyHasSubAgents}
        />
      </div>
    </div>
  );
}
