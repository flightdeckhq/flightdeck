import { test, expect } from "@playwright/test";
import {
  ALL_FIXTURE_AGENTS,
  E2E_PREFIX,
  bringSwimlaneRowIntoView,
  bringTableRowIntoView,
  waitForFleetReady,
} from "./_fixtures";

// T9 — swimlane and table view are two presentations of the same
// fleet set. Any discrepancy between the two (swimlane has N
// fixtures, table has M) means one of the views is dropping rows
// or the view-toggle is rewiring the query.
//
// Resilience pattern P1: target each canonical fixture by name
// rather than counting an unbounded ``[testid^=...]`` selector
// against the swimlane's virtualizer (off-screen rows aren't in
// the DOM, so a naive count under realistic data volume reports
// a fraction of the actual fixtures). Pin every ALL_FIXTURE_AGENTS
// entry as visible in BOTH views — that's the actual contract:
// every fixture surfaces under both presentations.
test.describe("T9 — Swimlane and table view render the same agent set", () => {
  test("every e2e-test-* fixture surfaces in both swimlane and table view", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForFleetReady(page);

    // Swimlane: each fixture must mount when scrolled into view.
    for (const agent of ALL_FIXTURE_AGENTS) {
      const row = await bringSwimlaneRowIntoView(page, agent.name);
      await expect(
        row,
        `swimlane missing fixture ${agent.name}`,
      ).toBeVisible();
    }

    // Flip to table view.
    await page.locator('[data-testid="fleet-view-toggle-table"]').click();
    await expect(
      page.locator('[data-testid^="fleet-agent-row-"]').first(),
    ).toBeVisible();

    // Table view paginates rather than virtualizes; bringTableRow
    // walks page-next until the fixture appears (capped at 10
    // pages = 500 rows of headroom). Same parity contract as
    // swimlane: every fixture must be reachable.
    for (const agent of ALL_FIXTURE_AGENTS) {
      const row = await bringTableRowIntoView(page, agent.name);
      await expect(
        row,
        `table view missing fixture ${agent.name}`,
      ).toBeVisible();
    }

    // Sanity guard against a future fixture-set drift: confirm the
    // canonical prefix invariant still holds (every ALL_FIXTURE_
    // AGENTS name starts with E2E_PREFIX). If the canonical set
    // ever picks up a non-prefixed entry the swimlane/table
    // discriminator on the prefix breaks silently — fail here.
    for (const agent of ALL_FIXTURE_AGENTS) {
      expect(
        agent.name.startsWith(E2E_PREFIX),
        `canonical fixture ${agent.name} must start with ${E2E_PREFIX}`,
      ).toBe(true);
    }
  });
});
