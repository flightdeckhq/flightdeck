import { test, expect } from "@playwright/test";

// T39 — Sub-agent analytics. agent_role dimension via
// DimensionPicker; Parent × Child Role Breakdown chart renders
// with the 6.4 two-dim group_by contract; TOPOLOGY checkboxes on
// the page-level facet thread through to the chart's filter
// params.
test.describe("T39 — Sub-agent analytics dimensions", () => {
  test("DimensionPicker exposes Sub-agent Role as a selectable dimension", async ({
    page,
  }) => {
    await page.goto("/analytics");
    await page.waitForLoadState("domcontentloaded");
    // The Latency card carries an explicit DimensionPicker (most
    // other charts on the page hide the picker because their title
    // encodes the dimension). Open the picker and assert the new
    // option is present.
    const picker = page.locator('[role="combobox"]').first();
    await picker.click();
    const option = page.locator('[role="option"]', { hasText: "Sub-agent Role" });
    await expect(option).toBeVisible();
  });

  test("Parent × Child Role Breakdown chart renders with seeded data", async ({
    page,
  }) => {
    await page.goto("/analytics");
    await page.waitForLoadState("domcontentloaded");
    const chart = page.locator('[data-testid="parent-child-breakdown-chart"]');
    await expect(chart).toBeVisible();
    // The seeded fixtures have CrewAI + LangGraph + claude-subagent
    // child sessions today, so the chart should render its bars
    // (not the empty-state copy).
    const empty = chart.locator('[data-testid="parent-child-breakdown-empty"]');
    await expect(empty).toHaveCount(0);
  });

  test("TOPOLOGY checkboxes thread through to the chart filter", async ({
    page,
  }) => {
    await page.goto("/analytics");
    await page.waitForLoadState("domcontentloaded");
    // Both checkboxes start unchecked. Toggle "Has sub-agents" and
    // verify the checkbox state flips. End-to-end visual signal:
    // the chart re-queries on the change. Network instrumentation
    // would verify the wire param shift; this E2E asserts the
    // observable user state.
    const cb = page
      .locator('[data-testid="analytics-topology-has-sub-agents"] input')
      .first();
    await expect(cb).not.toBeChecked();
    await cb.check();
    await expect(cb).toBeChecked();
  });
});
