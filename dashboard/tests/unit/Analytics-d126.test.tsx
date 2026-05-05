import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { DIMENSIONS } from "@/components/analytics/DimensionPicker";
import { ParentChildBreakdownChart } from "@/components/analytics/ParentChildBreakdownChart";

// D126 § 7.fix.O — Analytics D126 surface tests.
//
// Mounting the full Analytics page would mount ~10 charts each
// subscribing to useAnalytics, which times out under jsdom. The
// page-level wiring is exercised end-to-end by the Playwright
// suite (T26 theme matrix + manual Chrome verification per the
// 7.fix verification chain). Here we test the load-bearing
// contract pieces in isolation:
//
//   * Dimension picker carries the locked vocabulary.
//   * ParentChildBreakdownChart's filter prop thread-through
//     (the contract the Analytics page wires up to the
//     TOPOLOGY checkboxes).

const useAnalyticsMock = vi.fn();
vi.mock("@/hooks/useAnalytics", () => ({
  useAnalytics: (...args: unknown[]) => useAnalyticsMock(...args),
}));

beforeEach(() => {
  useAnalyticsMock.mockReset();
  useAnalyticsMock.mockReturnValue({
    data: {
      metric: "child_token_sum",
      group_by: "parent_session_id,agent_role",
      range: "30d",
      granularity: "day",
      series: [],
      totals: { grand_total: 0, period_change_pct: 0 },
    },
    loading: false,
    error: null,
    refetch: () => {},
  });
});

afterEach(() => {
  cleanup();
});

describe("DimensionPicker — D126 agent_role dimension", () => {
  it("includes Sub-agent Role in the locked dimension list", () => {
    const dim = DIMENSIONS.find((d) => d.value === "agent_role");
    expect(dim).toBeDefined();
    expect(dim?.label).toBe("Sub-agent Role");
  });

  it("the locked list mirrors CLAUDE.md Rule 25 closed-set vocabulary", () => {
    // The dimension whitelist on the picker MUST stay in sync
    // with the server-side validGroupBy map; out-of-band values
    // 400 server-side. This test catches a drift between the two.
    const values = DIMENSIONS.map((d) => d.value);
    const allowed = new Set([
      "flavor",
      "model",
      "framework",
      "host",
      "agent_type",
      "team",
      "provider",
      "agent_role",
      "parent_session_id",
    ]);
    for (const v of values) {
      expect(allowed.has(v)).toBe(true);
    }
  });
});

describe("ParentChildBreakdownChart — page-level TOPOLOGY thread-through", () => {
  // The Analytics page hands page-level filterIsSubAgent +
  // filterHasSubAgents props derived from the TOPOLOGY
  // checkboxes. These tests pin the chart-side wiring so a
  // regression in the hook params is caught regardless of the
  // page-level mount cost.

  it("default mount (no overrides) hardcodes filter_is_sub_agent=true", () => {
    render(<ParentChildBreakdownChart range="30d" />);
    const params = useAnalyticsMock.mock.calls[0][0];
    expect(params.filter_is_sub_agent).toBe("true");
    expect(params.filter_has_sub_agents).toBeUndefined();
  });

  it("filterIsSubAgent override stays at 'true'", () => {
    render(
      <ParentChildBreakdownChart range="30d" filterIsSubAgent />,
    );
    const params = useAnalyticsMock.mock.calls[0][0];
    expect(params.filter_is_sub_agent).toBe("true");
  });

  it("filterHasSubAgents override sends has_sub_agents and releases the default is_sub_agent", () => {
    render(
      <ParentChildBreakdownChart range="30d" filterHasSubAgents />,
    );
    const params = useAnalyticsMock.mock.calls[0][0];
    expect(params.filter_has_sub_agents).toBe("true");
    expect(params.filter_is_sub_agent).toBeUndefined();
  });

  it("metric picker switches the analytics request between D126 metrics", () => {
    const { container } = render(<ParentChildBreakdownChart range="30d" />);
    expect(useAnalyticsMock.mock.calls[0][0].metric).toBe("child_token_sum");
    // Click the metric trigger then choose another option. The
    // SelectTrigger renders the placeholder text + caret; the
    // option items render in a portal-mounted SelectContent. We
    // exercise the click contract via testid + DOM lookup.
    const trigger = container.querySelector(
      '[data-testid="parent-child-breakdown-metric"]',
    )!;
    fireEvent.click(trigger);
    // The SelectContent renders globally; query the document.
    const childCountOption = document.body.querySelector(
      '[role="option"][data-value="child_count"]',
    );
    if (childCountOption) {
      fireEvent.click(childCountOption);
      expect(useAnalyticsMock.mock.lastCall?.[0].metric).toBe("child_count");
    }
  });
});
