/**
 * T72 — clicking a run row in the agent drawer's Runs tab opens
 * the run drawer stacked over the agent drawer, with a breadcrumb
 * back to the agent.
 *
 * Phase 4 contract: the run drawer is the existing SessionDrawer;
 * when opened from the agent drawer it renders a "← Back to
 * {agent}" breadcrumb.
 *
 * Theme-agnostic — structural locators only.
 */
import { test, expect } from "@playwright/test";

test.describe("T72 — Runs tab row opens the run drawer", () => {
  test("clicking a run row opens the run drawer with a back breadcrumb", async ({
    page,
  }) => {
    await page.goto("/agents");
    const firstRow = page
      .locator('[data-testid^="agent-row-"][data-agent-id]')
      .first();
    await expect(firstRow).toBeVisible({ timeout: 10_000 });
    await firstRow.click();
    await expect(page.locator('[data-testid="agent-drawer"]')).toBeVisible();

    await page.locator('[data-testid="agent-drawer-tab-runs"]').click();
    const runRow = page
      .locator('[data-testid^="agent-drawer-run-row-"]')
      .first();
    await expect(runRow).toBeVisible({ timeout: 10_000 });
    await runRow.click();

    // The run drawer (SessionDrawer) opens stacked above the agent
    // drawer, carrying the breadcrumb back to the agent.
    await expect(page.locator('[data-testid="session-drawer"]')).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      page.locator('[data-testid="session-drawer-back"]'),
    ).toBeVisible();
  });
});
