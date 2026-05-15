/**
 * T62 — clicking the status badge on an /agents row opens the
 * per-agent swimlane modal.
 *
 * The modal mounts via Radix Dialog at ~80vw × 80vh and
 * carries the agent's name + topology pill + status badge in
 * its header.
 */
import { test, expect } from "@playwright/test";

test.describe("T62 — per-agent swimlane modal opens on status click", () => {
  test("modal mounts when the status badge button is clicked", async ({
    page,
  }) => {
    await page.goto("/agents");
    await expect(page.locator('[data-testid="agent-table"]')).toBeVisible();

    const firstStatusBtn = page
      .locator('[data-testid^="agent-row-open-swimlane-modal-"]')
      .first();
    await expect(firstStatusBtn).toBeVisible();
    await firstStatusBtn.click();

    const modal = page.locator('[data-testid="per-agent-swimlane-modal"]');
    await expect(modal).toBeVisible();
    await expect(
      page.locator('[data-testid="per-agent-swimlane-modal-header"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="per-agent-swimlane-modal-name"]'),
    ).toBeVisible();
  });
});
