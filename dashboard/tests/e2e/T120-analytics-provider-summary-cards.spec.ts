import { test, expect } from "@playwright/test";

// T120 — the Analytics summary row has one card per provider that used
// tokens in the window, derived from a single group_by=provider query,
// and a provider card toggles the page's provider filter.
//
// The seed holds Anthropic (Claude Code, sensor) and OpenAI (sensor)
// calls, so both cards exist. Card order follows token volume, which a
// dev stack's own sessions can change, so it is not asserted here
// (unit coverage in SummaryCards.test.tsx). Theme-agnostic per Rule
// 40c.3: assertions read test ids and text.

test.describe("T120 — analytics provider summary cards", () => {
  test("a card per provider comes from the provider breakdown", async ({ page }) => {
    const byProvider = page.waitForResponse(
      (r) =>
        r.url().includes("/v1/analytics") &&
        r.url().includes("metric=tokens") &&
        r.url().includes("group_by=provider") &&
        !r.url().includes("filter_provider"),
    );
    await page.goto("/analytics");
    const body = (await (await byProvider).json()) as {
      series: { dimension: string; total: number }[];
    };
    const used = body.series.filter((s) => s.total > 0).map((s) => s.dimension);
    expect(used).toEqual(expect.arrayContaining(["anthropic", "openai"]));

    for (const provider of used) {
      await expect(page.getByTestId(`summary-card-provider-${provider}`)).toBeVisible();
    }
  });

  test("a provider card toggles the page's provider filter", async ({ page }) => {
    await page.goto("/analytics");
    const card = page.getByTestId("summary-card-provider-openai");
    await card.click();
    await expect(page.getByTestId("analytics-provider-filter")).toContainText("OpenAI");
    await expect(card).toHaveAttribute("data-active", "true");

    await card.click();
    await expect(page.getByTestId("analytics-provider-filter")).toHaveCount(0);
  });
});
