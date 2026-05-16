/**
 * T64 — per-agent swimlane modal time-range picker.
 *
 * The picker exposes the five Fleet ranges 1m / 5m / 15m / 30m /
 * 1h and defaults to 1m on open (the shared DEFAULT_TIME_RANGE).
 * Clicking a different bucket sets the data-active flag on the
 * chosen pill and clears it on the prior default.
 */
import { test, expect } from "@playwright/test";

test.describe("T64 — modal time-range picker", () => {
  test("picker defaults to 1m; clicking 5m flips data-active", async ({
    page,
  }) => {
    await page.goto("/agents");
    await expect(page.locator('[data-testid="agent-table"]')).toBeVisible();

    const firstStatus = page
      .locator('[data-testid^="agent-row-open-swimlane-modal-"]')
      .first();
    await firstStatus.click();

    const btn1m = page.locator(
      '[data-testid="per-agent-swimlane-modal-time-1m"]',
    );
    const btn5m = page.locator(
      '[data-testid="per-agent-swimlane-modal-time-5m"]',
    );
    await expect(btn1m).toBeVisible();
    await expect(btn1m).toHaveAttribute("data-active", "true");
    await expect(btn5m).not.toHaveAttribute("data-active", "true");

    // 24h was dropped — the modal mirrors Fleet's five ranges.
    await expect(
      page.locator('[data-testid="per-agent-swimlane-modal-time-24h"]'),
    ).toHaveCount(0);

    await btn5m.click();
    await expect(btn5m).toHaveAttribute("data-active", "true");
    await expect(btn1m).not.toHaveAttribute("data-active", "true");
  });
});
