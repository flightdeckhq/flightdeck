import { test, expect } from "@playwright/test";
import {
  CODING_AGENT,
  SENSOR_AGENT,
  bringSwimlaneRowIntoView,
  waitForFleetReady,
  waitForInvestigateReady,
} from "./_fixtures";

// T22 — S-LBL vocabulary parity. F1 originally shipped a parallel
// shorthand (``CC`` / ``SDK``) on the Investigate AGENT facet pill
// that diverged from Fleet's canonical ``CLAUDE CODE`` / ``SENSOR``.
// This spec locks the labels at the rendered-DOM level so a future
// commit that re-introduces parallel vocabulary trips here even if
// the unit test drift is missed.
//
// Assertion: for each canonical client_type, the Fleet swimlane pill
// text and the Investigate AGENT facet pill text are byte-identical.
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

      // ---- Investigate AGENT facet pill (S-LBL ground truth) ----
      await page.goto("/investigate");
      await waitForInvestigateReady(page);

      // The facet pill testid is keyed on agent_id, but specs
      // operate on agent_name. Resolve via the row's title attr —
      // ClientTypePill always sets ``title=client_type=<wire>`` so
      // the facet row containing the agent name has a sibling pill
      // we can address by combining a hasText filter with a CSS
      // descendant selector.
      const facetPill = page
        .locator('[data-testid^="investigate-agent-facet-pill-"]')
        .filter({
          has: page.locator(`xpath=//ancestor::button[contains(., "${fixture.name}")]`),
        })
        .first()
        .or(
          // Fallback locator: just the first facet pill whose
          // sibling agent_name text matches. The hierarchy is
          //   <button>
          //     <span>...<TruncatedText name/>... <pill /></span>
          //     <span class="count" />
          //   </button>
          // so a button with the agent name and a child pill is
          // the unambiguous handle.
          page
            .locator("button", { hasText: fixture.name })
            .locator('[data-testid^="investigate-agent-facet-pill-"]')
            .first(),
        );

      // The facet may not be open by default — wait for the pill
      // to materialise via the agent's presence in the result set.
      // The seeded fixtures ensure both agents always appear.
      await expect(facetPill).toBeVisible({ timeout: 10_000 });
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
