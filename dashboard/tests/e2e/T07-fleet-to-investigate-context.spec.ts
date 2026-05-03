import { test, expect } from "@playwright/test";
import {
  CODING_AGENT,
  findAgentTableRow,
  investigateParamsFromUrl,
  waitForFleetReady,
} from "./_fixtures";

// T7 — Fleet CONTEXT filters are in-memory (Fleet.tsx's local
// useState), not URL-persisted. The decision is locked: applying
// a CONTEXT facet in Fleet, then navigating to Investigate via an
// agent row click, MUST emit an Investigate URL containing the
// fleet deep-link params (agent_id + from + to) and NOT the
// CONTEXT key. Carrying the CONTEXT filter across pages was
// explicitly not chosen in Phase 3 planning (see audit-phase-3.md
// V5.T7 decision). This test locks the current behaviour so a
// future change surfaces here and can be deliberated rather than
// drifted into.
test.describe("T7 — Fleet CONTEXT filter does not leak into Investigate deep-link", () => {
  test("CONTEXT filter applied in Fleet → row click → Investigate URL carries agent_id but no context params", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForFleetReady(page);

    // Apply an OS CONTEXT filter. The seeded fixtures all run with
    // OS "Linux" (DEFAULT_TEST_CONTEXT). Click the Linux facet
    // value — toggles the local contextFilters state.
    const linuxFacet = page.locator(
      '[data-testid="context-value-os-Linux"]',
    );
    await expect(linuxFacet, "Linux CONTEXT facet should render").toBeVisible();
    await linuxFacet.click();

    // Flip to table view so a row click is the navigation trigger.
    // Swimlane rows don't navigate on click — they expand. The
    // Investigate deep-link lives on AgentTable (Fleet.tsx:214).
    await page.locator('[data-testid="fleet-view-toggle-table"]').click();

    const tableRow = findAgentTableRow(page, CODING_AGENT.name);
    await expect(tableRow).toBeVisible();
    // Click the agent_name cell explicitly. Clicking the row's
    // centre lands on the D126 TOPOLOGY button which stops
    // propagation (its own click target is "scroll to related
    // agent"); the row's navigate-to-Investigate handler fires
    // from any other cell.
    await Promise.all([
      page.waitForURL(/\/investigate/),
      tableRow.locator("td").first().click(),
    ]);

    // Investigate deep-link must carry the fleet trio.
    const params = investigateParamsFromUrl(page.url());
    expect(params.agentId, "agent_id must be set").not.toBeNull();
    expect(params.from, "from must be set").not.toBeNull();
    expect(params.to, "to must be set").not.toBeNull();

    // But NOT the CONTEXT key. Decision rationale locked here:
    // Fleet's CONTEXT filter narrows the fleet view only. It is
    // semantically distinct from Investigate's context facets
    // (which are URL-backed filter dimensions, not Fleet's
    // in-memory scratchpad). Leaking Fleet state into Investigate
    // would conflate the two and produce confusing deep links.
    const url = new URL(page.url());
    expect(
      url.searchParams.get("os"),
      "Fleet's CONTEXT os filter must NOT leak into the Investigate URL",
    ).toBeNull();
  });
});
