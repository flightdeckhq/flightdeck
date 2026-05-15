/**
 * T64 — per-agent swimlane modal time-range picker.
 *
 * The picker exposes 5m / 15m / 30m / 1h / 24h and defaults
 * to 1h on open. Clicking a different bucket sets the
 * data-active flag on the chosen pill and clears it on the
 * prior default.
 */
import { test, expect } from "@playwright/test";

test.describe("T64 — modal time-range picker", () => {
  test("picker defaults to 1h; clicking 5m flips data-active", async ({
    page,
  }) => {
    await page.goto("/agents");
    await expect(page.locator('[data-testid="agent-table"]')).toBeVisible();

    const firstStatus = page
      .locator('[data-testid^="agent-row-open-swimlane-modal-"]')
      .first();
    await firstStatus.click();

    const btn1h = page.locator(
      '[data-testid="per-agent-swimlane-modal-time-1h"]',
    );
    const btn5m = page.locator(
      '[data-testid="per-agent-swimlane-modal-time-5m"]',
    );
    await expect(btn1h).toBeVisible();
    await expect(btn1h).toHaveAttribute("data-active", "true");
    await expect(btn5m).not.toHaveAttribute("data-active", "true");

    await btn5m.click();
    await expect(btn5m).toHaveAttribute("data-active", "true");
    await expect(btn1h).not.toHaveAttribute("data-active", "true");
  });
});
