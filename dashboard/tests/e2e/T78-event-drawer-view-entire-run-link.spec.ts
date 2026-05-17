/**
 * T78 — the event detail drawer's "View entire run →" link opens
 * the run drawer for the event's run.
 *
 * Phase 4 contract — run-drawer entry point 4: the event detail
 * drawer metadata section carries a link that hands off to the
 * run drawer.
 *
 * Theme-agnostic — structural locators only.
 */
import { test, expect } from "@playwright/test";

test.describe("T78 — event drawer View-entire-run link", () => {
  test("the link opens the run drawer and closes the event drawer", async ({
    page,
  }) => {
    await page.goto("/events");
    const firstRow = page.locator('[data-testid="events-row"]').first();
    await expect(firstRow).toBeVisible({ timeout: 10_000 });
    await firstRow.click();

    const eventDrawer = page.locator('[data-testid="event-detail-drawer"]');
    await expect(eventDrawer).toBeVisible();

    await page.locator('[data-testid="event-detail-view-run"]').click();

    // The run drawer opens; the event detail drawer hands off and
    // closes.
    await expect(page.locator('[data-testid="session-drawer"]')).toBeVisible({
      timeout: 10_000,
    });
    await expect(eventDrawer).toHaveCount(0);
  });
});
