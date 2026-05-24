/**
 * T70 — the agent drawer's Runs tab populates with the agent's
 * runs.
 *
 * Phase 4 contract: switching to the Runs tab lists the agent's
 * runs (sessions) newest-first, backed by
 * `GET /v1/sessions?agent_id=`, with sortable column headers.
 *
 * Theme-agnostic — structural locators only.
 */
import { test, expect } from "@playwright/test";

test.describe("T70 — agent drawer Runs tab", () => {
  test("the Runs tab lists the agent's runs and headers sort", async ({
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
    await expect(
      page.locator('[data-testid="agent-drawer-runs-tab"]'),
    ).toBeVisible();

    // Every /agents agent has at least one session.
    await expect
      .poll(
        async () =>
          page
            .locator('[data-testid^="agent-drawer-run-row-"]')
            .count(),
        { timeout: 10_000 },
      )
      .toBeGreaterThan(0);

    // A sortable header toggles its aria-sort.
    const tokensHeader = page.locator(
      '[data-testid="agent-drawer-runs-th-tokens_used"]',
    );
    await tokensHeader.click();
    await expect(tokensHeader).toHaveAttribute("aria-sort", /ascending|descending/);
  });
});
