/**
 * T76 — a legacy `/events?session=<id>` URL is migrated to
 * `?run=<id>`.
 *
 * Phase 4 wave 2 contract: the Events-page drawer deep-link
 * parameter renamed from `?session=` to `?run=`; an old bookmark
 * is transparently rewritten so it keeps resolving.
 *
 * Theme-agnostic — structural locators only.
 */
import { test, expect } from "@playwright/test";

test.describe("T76 — /events ?session= → ?run= migration", () => {
  test("a legacy ?session= URL is rewritten to ?run=", async ({ page }) => {
    await page.goto(
      "/events?session=11111111-2222-3333-4444-555555555555",
    );
    await expect(page.locator('[data-testid="events-page"]')).toBeVisible();

    // The legacy param is rewritten to ?run= with the same id.
    await expect(page).toHaveURL(
      /run=11111111-2222-3333-4444-555555555555/,
    );
    await expect(page).not.toHaveURL(/session=/);
  });
});
