import { test, expect } from "@playwright/test";
import {
  CODING_AGENT,
  findAgentTableRow,
  investigateParamsFromUrl,
  viewFromUrl,
  waitForFleetReady,
} from "./_fixtures";

// T2 — the view toggle persists to URL, and a table-row click deep
// links to Investigate with agent_id + from + to. The 7-day window
// is explicit (AgentTable.tsx:189-195) so the deep-linked URL is
// self-describing — matches Investigate's default range and keeps
// "what the user sees" invariant across a shared link.
test.describe("T2 — Fleet view toggle and table→investigate navigation", () => {
  test("view=table persists; row click lands on /investigate with agent_id and ~7-day window", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForFleetReady(page);

    // Flip to table view.
    await page.locator('[data-testid="fleet-view-toggle-table"]').click();
    await expect
      .poll(() => viewFromUrl(page.url()), {
        message: "expected ?view=table after toggle click",
      })
      .toBe("table");

    // Table view renders fleet-agent-row-<agent_id> rows. Pick the
    // CODING_AGENT fixture by name-text filter (agent_id isn't known
    // to the test ahead of time).
    const row = findAgentTableRow(page, CODING_AGENT.name);
    await expect(row, "table row for coding fixture must be visible").toBeVisible();

    // Click the row and wait for navigation to /investigate.
    // Click the agent_name cell explicitly — see T07 for the
    // D126 TOPOLOGY-button propagation rationale.
    await Promise.all([
      page.waitForURL(/\/investigate/),
      row.locator("td").first().click(),
    ]);

    const params = investigateParamsFromUrl(page.url());
    expect(params.agentId, "agent_id param must be present").not.toBeNull();
    expect(params.agentId, "agent_id must be non-empty").not.toBe("");
    expect(params.from, "from param must be present").not.toBeNull();
    expect(params.to, "to param must be present").not.toBeNull();

    // Window should be ~7 days. Allow a ±1-day tolerance to absorb
    // any rounding between the click and the URL write.
    const fromMs = Date.parse(params.from ?? "");
    const toMs = Date.parse(params.to ?? "");
    expect(Number.isFinite(fromMs), "from must parse as a date").toBeTruthy();
    expect(Number.isFinite(toMs), "to must parse as a date").toBeTruthy();
    const spanDays = (toMs - fromMs) / (1000 * 60 * 60 * 24);
    expect(
      spanDays,
      `deep-link time window should be ~7 days (got ${spanDays.toFixed(2)})`,
    ).toBeGreaterThan(6);
    expect(spanDays).toBeLessThan(8);
  });
});
