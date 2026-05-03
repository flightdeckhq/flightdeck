import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import type { AnalyticsResponse, AnalyticsSeries } from "@/lib/types";
import {
  ParentChildBreakdownChart,
  pivotByParent,
} from "@/components/analytics/ParentChildBreakdownChart";

// D126 § 7.fix.L — ParentChildBreakdownChart suite. Covers the
// per-parent stacked rendering, metric variants, empty data, the
// (root) bucket label, the request parameter shape, and the
// page-level TOPOLOGY override.

const useAnalyticsMock = vi.fn();
vi.mock("@/hooks/useAnalytics", () => ({
  useAnalytics: (...args: unknown[]) => useAnalyticsMock(...args),
}));

const noopAnalyticsResponse: AnalyticsResponse = {
  metric: "child_token_sum",
  group_by: "parent_session_id,agent_role",
  range: "30d",
  granularity: "day",
  series: [],
  totals: { grand_total: 0, period_change_pct: 0 },
};

beforeEach(() => {
  useAnalyticsMock.mockReset();
  useAnalyticsMock.mockReturnValue({
    data: noopAnalyticsResponse,
    loading: false,
    error: null,
    refetch: () => {},
  });
});

describe("pivotByParent (pure)", () => {
  it("aggregates breakdown across data points into one row per parent", () => {
    const series: AnalyticsSeries[] = [
      {
        dimension: "parent-uuid-1",
        total: 350,
        data: [
          {
            date: "2026-05-01",
            value: 200,
            breakdown: [
              { key: "Researcher", value: 150 },
              { key: "Writer", value: 50 },
            ],
          },
          {
            date: "2026-05-02",
            value: 150,
            breakdown: [
              { key: "Researcher", value: 100 },
              { key: "Writer", value: 50 },
            ],
          },
        ],
      },
    ];
    const { bars, roles } = pivotByParent(series);
    expect(bars.length).toBe(1);
    // Per-role values sum across data points: Researcher = 150+100,
    // Writer = 50+50. The chart renders one bar per parent with
    // these stacked segments.
    expect(bars[0].Researcher).toBe(250);
    expect(bars[0].Writer).toBe(100);
    expect(bars[0].parentLabel).toBe("parent-u"); // 8-char prefix
    // Roles list is sorted so legend order is deterministic.
    expect(roles).toEqual(["Researcher", "Writer"]);
  });

  it("renders the (root) bucket verbatim instead of slicing UUID prefix", () => {
    const series: AnalyticsSeries[] = [
      {
        dimension: "(root)",
        total: 10,
        data: [
          {
            date: "2026-05-01",
            value: 10,
            breakdown: [{ key: "Researcher", value: 10 }],
          },
        ],
      },
    ];
    const { bars } = pivotByParent(series);
    expect(bars[0].parentLabel).toBe("(root)");
    expect(bars[0].parentId).toBe("(root)");
  });

  it("collects every distinct role across parents (missing-role rows still slot in)", () => {
    const series: AnalyticsSeries[] = [
      {
        dimension: "parent-A",
        total: 10,
        data: [
          {
            date: "2026-05-01",
            value: 10,
            breakdown: [{ key: "Researcher", value: 10 }],
          },
        ],
      },
      {
        dimension: "parent-B",
        total: 5,
        data: [
          {
            date: "2026-05-01",
            value: 5,
            breakdown: [{ key: "Writer", value: 5 }],
          },
        ],
      },
    ];
    const { bars, roles } = pivotByParent(series);
    expect(roles).toEqual(["Researcher", "Writer"]);
    // parent-A has no Writer entry; the chart code emits 0 in
    // recharts (omitted from the row → recharts shows 0 segment).
    expect(bars[0].Researcher).toBe(10);
    expect(bars[0].Writer).toBeUndefined();
    expect(bars[1].Researcher).toBeUndefined();
    expect(bars[1].Writer).toBe(5);
  });

  it("returns an empty pivot for an empty series array", () => {
    const { bars, roles } = pivotByParent([]);
    expect(bars).toEqual([]);
    expect(roles).toEqual([]);
  });
});

describe("ParentChildBreakdownChart (component)", () => {
  it("issues a 2-dim group_by query against the canonical pair", () => {
    render(<ParentChildBreakdownChart range="30d" />);
    expect(useAnalyticsMock).toHaveBeenCalled();
    const params = useAnalyticsMock.mock.calls[0][0];
    expect(params.group_by).toBe("parent_session_id,agent_role");
    expect(params.metric).toBe("child_token_sum");
    // Default behaviour: filter to children only so the chart
    // doesn't get washed out by the (root) bucket on root-only
    // result sets.
    expect(params.filter_is_sub_agent).toBe("true");
  });

  it("metric picker swaps the request metric without changing dimensions", () => {
    render(<ParentChildBreakdownChart range="30d" />);
    // Default metric is child_token_sum; first hook call carries it.
    expect(useAnalyticsMock.mock.calls[0][0].metric).toBe("child_token_sum");
    // Change selection — the underlying hook re-fires with new metric.
    const trigger = screen.getByTestId("parent-child-breakdown-metric");
    fireEvent.click(trigger);
    const option = screen.getByText("Child Count");
    fireEvent.click(option);
    expect(useAnalyticsMock.mock.lastCall?.[0].metric).toBe("child_count");
    // group_by stays pinned to the canonical pair.
    expect(useAnalyticsMock.mock.lastCall?.[0].group_by).toBe(
      "parent_session_id,agent_role",
    );
  });

  it("renders the empty-state copy when the API returns no series", async () => {
    useAnalyticsMock.mockReturnValue({
      data: noopAnalyticsResponse,
      loading: false,
      error: null,
      refetch: () => {},
    });
    render(<ParentChildBreakdownChart range="30d" />);
    expect(
      screen.getByTestId("parent-child-breakdown-empty"),
    ).toBeTruthy();
  });

  it("renders the loading spinner while the hook reports loading=true", () => {
    useAnalyticsMock.mockReturnValue({
      data: null,
      loading: true,
      error: null,
      refetch: () => {},
    });
    render(<ParentChildBreakdownChart range="30d" />);
    // Empty-state copy is suppressed during load so the user sees
    // a clean spinner instead of "no activity" flicker on mount.
    expect(
      screen.queryByTestId("parent-child-breakdown-empty"),
    ).toBeNull();
  });

  it("page-level filterIsSubAgent override threads through to the hook", () => {
    render(
      <ParentChildBreakdownChart
        range="30d"
        filterIsSubAgent
      />,
    );
    const params = useAnalyticsMock.mock.calls[0][0];
    expect(params.filter_is_sub_agent).toBe("true");
  });

  it("page-level filterHasSubAgents override threads through to the hook (default suppressed)", async () => {
    render(
      <ParentChildBreakdownChart
        range="30d"
        filterHasSubAgents
      />,
    );
    const params = useAnalyticsMock.mock.calls[0][0];
    expect(params.filter_has_sub_agents).toBe("true");
    // When the page-level override is set, the chart's hardcoded
    // ``filter_is_sub_agent=true`` default releases so the user's
    // facet choice drives the filter rather than fighting it.
    expect(params.filter_is_sub_agent).toBeUndefined();
  });
});
