/**
 * T80 — the POLICY facet on `/events` filters the event table by
 * policy-enforcement event type and round-trips through the URL.
 *
 * Phase 4 wave 2 contract: the event-grain facet sidebar derives a
 * POLICY group by classifying the `event_type` facet's
 * policy-enforcement values; clicking a POLICY pill writes the
 * shared `event_type` filter. Replaces the deleted session-grain
 * T17 policy-filter journey.
 *
 * Theme-agnostic — structural locators only.
 */
import { test, expect } from "@playwright/test";
import { waitForInvestigateReady } from "./_fixtures";

test.describe("T80 — /events POLICY facet", () => {
  test("clicking a POLICY pill filters the table and updates the URL", async ({
    page,
  }) => {
    await page.goto("/events");
    await waitForInvestigateReady(page);

    const facet = page.locator(
      '[data-testid="events-facet-policy_event_type"]',
    );
    await expect(
      facet,
      "POLICY facet must render when the window carries policy events",
    ).toBeVisible({ timeout: 10_000 });

    // Click the first policy pill, whichever policy type the seed
    // emitted — the filter journey is identical for every value.
    const pill = facet
      .locator('[data-testid^="events-facet-pill-policy_event_type-"]')
      .first();
    await expect(pill).toBeVisible();
    const testId = await pill.getAttribute("data-testid");
    const value = testId!.replace(
      "events-facet-pill-policy_event_type-",
      "",
    );

    await pill.click();

    // POLICY pills write the shared event_type filter dimension.
    await expect(page).toHaveURL(new RegExp(`event_type=${value}`));
    await expect(pill).toHaveAttribute("data-active", "true");
  });
});
