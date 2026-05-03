import { test, expect } from "@playwright/test";
import {
  CODING_AGENT,
  findAgentTableRow,
  investigateParamsFromUrl,
  waitForFleetReady,
  waitForInvestigateReady,
} from "./_fixtures";

// T8 — cross-page navigation preserves URL state. The Investigate
// URL parser (Investigate.tsx:32-105) owns 16 serialized dimensions;
// the Fleet→Investigate deep-link path (AgentTable.tsx:177-195)
// carries exactly agent_id + from + to. Browser back must restore
// the prior Fleet URL shape. Browser forward must re-enter the
// Investigate URL as-written. Locks both the deep-link contract
// and the history-preservation behaviour that a naive
// navigate(replace) would break.
test.describe("T8 — Cross-page navigation preserves URL state", () => {
  test("Fleet → Investigate (carries agent_id+from+to) → back (restores Fleet URL) → forward (restores Investigate URL)", async ({
    page,
  }) => {
    // Start on Fleet's table view with a known URL shape.
    await page.goto("/?view=table");
    await waitForFleetReady(page);
    const fleetUrlBefore = page.url();
    expect(fleetUrlBefore).toMatch(/view=table/);

    const row = findAgentTableRow(page, CODING_AGENT.name);
    // Click the agent_name cell — see T07 for rationale (the
    // D126 TOPOLOGY button at row centre stops propagation).
    await Promise.all([
      page.waitForURL(/\/investigate/),
      row.locator("td").first().click(),
    ]);
    const investigateUrlAfter = page.url();

    // The deep-link trio is present.
    const params = investigateParamsFromUrl(investigateUrlAfter);
    expect(params.agentId).not.toBeNull();
    expect(params.from).not.toBeNull();
    expect(params.to).not.toBeNull();

    // Let Investigate finish mounting so back-navigation has a
    // stable history entry to return to.
    await waitForInvestigateReady(page);

    // Browser back: Fleet URL must restore verbatim, including
    // view=table. A push navigation (not replace) is the
    // contract.
    await page.goBack();
    await expect
      .poll(() => page.url(), { message: "goBack should restore Fleet URL" })
      .toBe(fleetUrlBefore);
    await waitForFleetReady(page);

    // Browser forward: Investigate URL must restore byte-for-byte.
    // No truncated params, no dropped state.
    await page.goForward();
    await expect
      .poll(() => page.url(), {
        message: "goForward should restore Investigate URL",
      })
      .toBe(investigateUrlAfter);
  });
});
