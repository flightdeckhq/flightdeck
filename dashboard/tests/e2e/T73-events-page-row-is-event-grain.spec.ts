/**
 * T73 — the /events page is event-grain: one row per event, and
 * the facet sidebar narrows the set.
 *
 * Phase 4 wave 2 contract: /events lists individual events (not
 * sessions); each row carries a run badge; clicking a facet chip
 * filters the set server-side.
 *
 * Theme-agnostic — structural locators only.
 */
import { test, expect } from "@playwright/test";

test.describe("T73 — /events is event-grain + filterable", () => {
  test("the page lists event rows with run badges", async ({ page }) => {
    await page.goto("/events");
    await expect(page.locator('[data-testid="events-page"]')).toBeVisible();
    await expect(page.locator('[data-testid="events-table"]')).toBeVisible();

    await expect
      .poll(async () => page.locator('[data-testid="events-row"]').count(), {
        timeout: 10_000,
      })
      .toBeGreaterThan(0);

    // Each row deep-links its run via the run badge.
    await expect(
      page.locator('[data-testid="events-row-run-badge"]').first(),
    ).toBeVisible();
  });

  test("clicking a facet chip narrows the event set", async ({ page }) => {
    await page.goto("/events");
    await expect(page.locator('[data-testid="events-table"]')).toBeVisible();
    const rows = page.locator('[data-testid="events-row"]');
    await expect.poll(async () => rows.count()).toBeGreaterThan(1);
    const before = await rows.count();

    // The EVENT TYPE facet group is present once events have loaded;
    // click its first chip to filter.
    const facetGroup = page.locator('[data-testid="events-facet-event_type"]');
    await expect(facetGroup).toBeVisible();
    const firstChip = facetGroup
      .locator('[data-testid^="events-facet-pill-event_type-"]')
      .first();
    await expect(firstChip).toBeVisible();
    await firstChip.click();

    await expect(firstChip).toHaveAttribute("data-active", "true");
    // The filtered total is a subset of the unfiltered total.
    await expect
      .poll(async () => rows.count(), { timeout: 5_000 })
      .toBeLessThanOrEqual(before);
  });
});
