import { test, expect } from "@playwright/test";
import { E2E_PREFIX, waitForFleetReady } from "./_fixtures";

// T9 — swimlane and table view are two presentations of the same
// fleet set. Any discrepancy between the two (swimlane has N
// agents, table has M) means one of the views is dropping rows or
// the view-toggle is rewiring the query. Count our e2e-test-*
// agents under each view and assert parity.
test.describe("T9 — Swimlane and table view render the same agent set", () => {
  test("swimlane agent count for e2e-test-* == table agent count for e2e-test-*", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForFleetReady(page);

    // Count distinct E2E agent rows in swimlane view.
    const swimlaneCount = await page
      .locator(`[data-testid^="swimlane-agent-row-${E2E_PREFIX}"]`)
      .count();
    expect(
      swimlaneCount,
      `swimlane should render all 3 seeded e2e-test-* fixtures`,
    ).toBeGreaterThanOrEqual(3);

    // Flip to table view.
    await page.locator('[data-testid="fleet-view-toggle-table"]').click();
    await expect(
      page
        .locator('[data-testid^="fleet-agent-row-"]')
        .first(),
    ).toBeVisible();

    // Table rows are keyed by agent_id (unknown to the test) — filter
    // by visible text containing the E2E prefix. The name text is
    // rendered in-cell so `filter({ hasText })` matches correctly.
    const tableCount = await page
      .locator('[data-testid^="fleet-agent-row-"]')
      .filter({ hasText: E2E_PREFIX })
      .count();
    expect(
      tableCount,
      `table view should render the same 3 e2e-test-* fixtures as swimlane`,
    ).toBeGreaterThanOrEqual(3);

    expect(
      tableCount,
      `swimlane and table views must render the same count of e2e-test-* ` +
        `agents (swimlane=${swimlaneCount}, table=${tableCount}). ` +
        `A mismatch means one presentation is dropping rows.`,
    ).toBe(swimlaneCount);
  });
});
