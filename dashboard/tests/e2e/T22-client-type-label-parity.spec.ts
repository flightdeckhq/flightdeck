import { test, expect } from "@playwright/test";
import {
  CODING_AGENT,
  SENSOR_AGENT,
  bringSwimlaneRowIntoView,
  waitForFleetReady,
  waitForInvestigateReady,
} from "./_fixtures";

// T22 — S-LBL vocabulary parity. F1 originally shipped a parallel
// shorthand (``CC`` / ``SDK``) on the /events AGENT facet pill
// that diverged from Fleet's canonical ``CLAUDE CODE`` / ``SENSOR``.
// This spec locks the labels at the rendered-DOM level so a future
// commit that re-introduces parallel vocabulary trips here even if
// the unit test drift is missed.
//
// Assertion: for each canonical client_type, the Fleet swimlane pill
// text and the /events AGENT facet pill text are byte-identical.
// Both themes (Rule 40c.3) — the labels must not depend on theme.
test.describe("T22 — client_type label parity Fleet ↔ Investigate", () => {
  for (const fixture of [
    { name: CODING_AGENT.name, expected: "CLAUDE CODE" },
    { name: SENSOR_AGENT.name, expected: "SENSOR" },
  ] as const) {
    test(`${fixture.name}: Fleet pill === Investigate AGENT facet pill === ${fixture.expected}`, async ({
      page,
    }) => {
      // ---- Fleet swimlane pill ----
      await page.goto("/");
      await waitForFleetReady(page);
      const row = await bringSwimlaneRowIntoView(page, fixture.name);
      await expect(row).toBeVisible();
      const fleetPill = row
        .locator('[data-testid="swimlane-client-type-pill"]')
        .first();
      const fleetText = (await fleetPill.textContent())?.trim().toUpperCase();

      // ---- /events AGENT facet pill (S-LBL ground truth) ----
      await page.goto("/events");
      await waitForInvestigateReady(page);

      // The AGENT facet pill is keyed on agent_id; specs operate on
      // agent_name. Find the facet button carrying the agent name,
      // then read its ClientTypePill child by testid. The seeded
      // fixtures ensure both agents appear in the AGENT facet.
      const facetButton = page
        .locator('[data-testid^="events-facet-pill-agent_id-"]')
        .filter({ hasText: fixture.name });
      await expect(facetButton).toBeVisible({ timeout: 10_000 });
      const facetPill = facetButton.locator(
        '[data-testid^="events-facet-client-type-"]',
      );
      await expect(facetPill).toBeVisible();
      const facetText = (await facetPill.textContent())?.trim().toUpperCase();

      // ---- Parity assertion ----
      expect(
        fleetText,
        `Fleet swimlane pill for ${fixture.name} should render ${fixture.expected}`,
      ).toBe(fixture.expected);
      expect(
        facetText,
        `Investigate AGENT facet pill for ${fixture.name} should render ${fixture.expected}`,
      ).toBe(fixture.expected);
      expect(
        facetText,
        `Investigate AGENT facet pill must use the SAME label as Fleet swimlane`,
      ).toBe(fleetText);
    });
  }
});
