import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { AnalyticsResponse } from "@/lib/types";
import { CostChart } from "@/components/analytics/CostChart";
import { costEmptyMessage } from "@/lib/cost";

let response: Partial<AnalyticsResponse> = {};
vi.mock("@/hooks/useAnalytics", () => ({
  useAnalytics: () => ({
    data: { metric: "estimated_cost", group_by: "provider", range: "7d", granularity: "day", totals: { grand_total: 0, period_change_pct: 0 }, series: [], ...response },
    loading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

describe("costEmptyMessage", () => {
  it("tells no calls, subscription only and nothing metered apart", () => {
    expect(costEmptyMessage([])).toBe("No LLM calls in this period.");
    expect(costEmptyMessage(["subscription"])).toContain("subscription plan");
    expect(costEmptyMessage(["metered"])).toBe("No metered cost in this period.");
  });
});

describe("CostChart", () => {
  it("notes subscription calls and names the unpriced models", () => {
    response = {
      billing_modes: ["metered", "subscription"],
      partial_estimate: true,
      models_unpriced: ["my-finetune"],
      series: [{ dimension: "anthropic", total: 1.25, data: [] }],
    };
    render(<CostChart range="7d" filterProvider={null} />);
    expect(screen.getByTestId("cost-chart-subscription-note")).toBeInTheDocument();
    expect(screen.getByTestId("cost-chart-partial-note")).toHaveTextContent("my-finetune");
  });

  it("explains an empty chart when every call ran on a subscription", () => {
    response = { billing_modes: ["subscription"], series: [] };
    render(<CostChart range="7d" filterProvider={null} />);
    expect(screen.getByText(/ran on a subscription plan, so there is no metered cost/)).toBeInTheDocument();
    expect(screen.queryByTestId("cost-chart-partial-note")).toBeNull();
  });
});
