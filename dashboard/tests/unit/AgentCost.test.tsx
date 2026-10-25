import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { AgentCost, costCaveats, isSubscriptionOnly } from "@/components/agents/AgentCost";

const totals = (over: Partial<Parameters<typeof costCaveats>[0]> = {}) => ({
  cost_usd: 3.5,
  partial_estimate: false,
  models_unpriced: [] as string[],
  billing_modes: ["metered"],
  ...over,
});

describe("isSubscriptionOnly", () => {
  it("is true only when every call ran on a subscription", () => {
    expect(isSubscriptionOnly(["subscription"])).toBe(true);
    expect(isSubscriptionOnly(["subscription", "metered"])).toBe(false);
    expect(isSubscriptionOnly(["local"])).toBe(false);
  });

  it("treats a window with no calls as not subscription-only", () => {
    expect(isSubscriptionOnly([])).toBe(false);
    expect(isSubscriptionOnly(undefined)).toBe(false);
  });
});

describe("costCaveats", () => {
  it("is empty for a complete metered total", () => {
    expect(costCaveats(totals())).toEqual([]);
  });

  it("names the unpriced models and the excluded subscription calls", () => {
    const caveats = costCaveats(
      totals({
        partial_estimate: true,
        models_unpriced: ["a-model", "b-model"],
        billing_modes: ["metered", "subscription"],
      }),
    );
    expect(caveats).toHaveLength(2);
    expect(caveats[0]).toContain("a-model, b-model");
    expect(caveats[1]).toContain("subscription");
  });

  it("tolerates a summary without the coverage lists", () => {
    expect(
      costCaveats({ cost_usd: 1 } as Parameters<typeof costCaveats>[0]),
    ).toEqual([]);
  });
});

describe("AgentCost", () => {
  it("renders an em-dash while there are no totals", () => {
    render(<AgentCost totals={null} testId="c" />);
    expect(screen.getByTestId("c")).toHaveTextContent("—");
  });

  it("renders Subscription when nothing was metered", () => {
    render(<AgentCost totals={totals({ cost_usd: 0, billing_modes: ["subscription"] })} testId="c" />);
    expect(screen.getByTestId("c")).toHaveTextContent("Subscription");
    expect(screen.getByTestId("c")).toHaveAttribute("data-cost-state", "subscription");
  });

  it("renders a complete amount without a marker", () => {
    render(<AgentCost totals={totals()} testId="c" />);
    expect(screen.getByTestId("c")).toHaveTextContent("$3.50");
    expect(screen.queryByTestId("c-partial")).toBeNull();
  });

  it("marks a mixed metered and subscription total as partial", () => {
    render(<AgentCost totals={totals({ billing_modes: ["metered", "subscription"] })} testId="c" />);
    expect(screen.getByTestId("c")).toHaveAttribute("data-cost-state", "partial");
    expect(screen.getByTestId("c-partial")).toHaveAttribute(
      "aria-label",
      expect.stringContaining("subscription plan"),
    );
  });

  it("renders a local-only agent as $0.00", () => {
    render(<AgentCost totals={totals({ cost_usd: 0, billing_modes: ["local"] })} testId="c" />);
    expect(screen.getByTestId("c")).toHaveTextContent("$0.00");
  });
});
