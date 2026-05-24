/**
 * T75 — clicking the run-badge column on an /events row opens the
 * run drawer, not the event detail drawer.
 *
 * Phase 4 wave 2 contract: the run badge is the run-drawer entry
 * point on the event table; its click is isolated from the row's
 * event-detail click.
 *
 * Theme-agnostic — structural locators only.
 */
import { test, expect } from "@playwright/test";

test.describe("T75 — /events run badge opens the run drawer", () => {
  test("clicking a run badge opens the run drawer, not the event drawer", async ({
    page,
  }) => {
    await page.goto("/events");
    const firstRow = page.locator('[data-testid="events-row"]').first();
    await expect(firstRow).toBeVisible({ timeout: 10_000 });

    await page
      .locator('[data-testid="events-row-run-badge"]')
      .first()
      .click();

    await expect(page.locator('[data-testid="session-drawer"]')).toBeVisible({
      timeout: 10_000,
    });
    // The badge click must not bubble to the row's event-detail
    // handler.
    await expect(
      page.locator('[data-testid="event-detail-drawer"]'),
    ).toHaveCount(0);
  });
});
