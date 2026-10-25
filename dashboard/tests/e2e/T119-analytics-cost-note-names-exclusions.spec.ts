import { test, expect } from "@playwright/test";

// T119 — the Analytics Estimated Cost card says what its figure leaves
// out. The seeded window holds metered sensor calls and subscription
// Claude Code calls, so the API's billing_modes lists both and the
// card's note says subscription calls are not included. The partial
// (unpriced-model) note has unit coverage in CostChart.test.tsx: the
// seed prices every model it uses.
//
// Theme-agnostic per Rule 40c.3: assertions read test ids and text.

test.describe("T119 — analytics cost note names what it excludes", () => {
  test("the Estimated Cost card notes that subscription calls are not included", async ({
    page,
  }) => {
    const cost = page.waitForResponse(
      (r) => r.url().includes("/v1/analytics") && r.url().includes("metric=estimated_cost"),
    );
    await page.goto("/analytics");
    const body = (await (await cost).json()) as { billing_modes?: string[] };
    expect(body.billing_modes).toContain("subscription");

    await expect(page.getByTestId("cost-chart-subscription-note")).toContainText(
      "Subscription calls have no per-call cost",
    );
    await expect(page.getByText(/Metered calls, priced from the cost a client reported/)).toBeVisible();
  });
});
