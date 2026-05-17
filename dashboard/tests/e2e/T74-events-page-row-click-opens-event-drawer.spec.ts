/**
 * T74 — clicking an /events row opens the event detail drawer.
 *
 * Phase 4 wave 2 contract: a row click opens the existing
 * EventDetailDrawer for that event.
 *
 * Theme-agnostic — structural locators only.
 */
import { test, expect } from "@playwright/test";

test.describe("T74 — /events row opens the event detail drawer", () => {
  test("clicking an event row mounts the event detail drawer", async ({
    page,
  }) => {
    await page.goto("/events");
    const firstRow = page.locator('[data-testid="events-row"]').first();
    await expect(firstRow).toBeVisible({ timeout: 10_000 });

    await firstRow.click();

    await expect(
      page.locator('[data-testid="event-detail-drawer"]'),
    ).toBeVisible();
  });
});
