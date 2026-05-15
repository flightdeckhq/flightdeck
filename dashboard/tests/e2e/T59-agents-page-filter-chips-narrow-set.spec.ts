/**
 * T59 — /agents page filter chips narrow the visible set.
 *
 * Toggling a state chip removes rows whose state doesn't match.
 * The assertion is "post-toggle row count is strictly less
 * than pre-toggle row count" — robust to the canonical
 * fixture set evolving as long as it carries at least one
 * agent in each state bucket.
 */
import { test, expect } from "@playwright/test";

test.describe("T59 — filter chips narrow the rendered set", () => {
  test("toggling state=active reduces the visible row count", async ({
    page,
  }) => {
    await page.goto("/agents");
    await expect(page.locator('[data-testid="agent-table"]')).toBeVisible();

    const rows = page.locator('[data-testid^="agent-row-"][data-agent-id]');
    const beforeCount = await rows.count();
    expect(beforeCount).toBeGreaterThan(1);

    await page.locator('[data-testid="agent-filter-state-active"]').click();

    // Poll for the row count to settle below the unfiltered total.
    await expect
      .poll(async () => rows.count(), { timeout: 5_000 })
      .toBeLessThan(beforeCount);
  });

  test("active chip reflects its toggle via data-active", async ({ page }) => {
    await page.goto("/agents");
    const chip = page.locator('[data-testid="agent-filter-state-closed"]');
    await chip.click();
    await expect(chip).toHaveAttribute("data-active", "true");
    await chip.click();
    await expect(chip).toHaveAttribute("data-active", "false");
  });

  test("toggling a framework chip reduces the visible row count", async ({
    page,
  }) => {
    await page.goto("/agents");
    await expect(page.locator('[data-testid="agent-table"]')).toBeVisible();

    // The framework chip group renders only once at least one
    // agent carries a recent-session framework attribution. The
    // canonical seed runs agents on langchain / crewai / langgraph,
    // so the group — and a langchain chip — are present.
    await expect(
      page.locator('[data-testid="agent-filter-framework-group"]'),
    ).toBeVisible();
    const langchainChip = page.locator(
      '[data-testid="agent-filter-framework-langchain"]',
    );
    await expect(langchainChip).toBeVisible();

    const rows = page.locator('[data-testid^="agent-row-"][data-agent-id]');
    const beforeCount = await rows.count();
    expect(beforeCount).toBeGreaterThan(1);

    await langchainChip.click();

    await expect
      .poll(async () => rows.count(), { timeout: 5_000 })
      .toBeLessThan(beforeCount);
  });
});
