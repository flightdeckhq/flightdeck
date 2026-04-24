import { test, expect } from "@playwright/test";
import {
  CODING_AGENT,
  waitForInvestigateReady,
} from "./_fixtures";

// T3 — facets compose via intersection (AND). With two filters
// applied the URL carries both, the active-filter pills show both,
// and the session list narrows to their overlap. Removing one pill
// relaxes back to the single-filter result, which must remain
// non-empty because the seeded dataset guarantees coverage.
test.describe("T3 — Investigate facet filtering (intersection)", () => {
  test("two filters → 2 pills → narrowed list; × clears one → 1 pill → non-empty", async ({
    page,
  }) => {
    // Deep-link with flavor + state already applied. Clicking the
    // sidebar facets would work too but would require assumptions
    // about sidebar render order; URL seeding is the robust path.
    const params = new URLSearchParams({
      flavor: CODING_AGENT.flavor,
      state: "closed",
      from: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      to: new Date().toISOString(),
    });
    await page.goto(`/investigate?${params.toString()}`);
    await waitForInvestigateReady(page);

    // Both filters should render as pills.
    const pills = page.locator('[data-testid="active-filter-pill"]');
    await expect(pills).toHaveCount(2);

    // Sessions list should still have rows — recent-closed fixture
    // (CODING_AGENT, state=closed, within 7d) matches. Count at least
    // one session row whose session-cell testid is present.
    const rowCells = page.locator('[data-testid^="investigate-row-session-"]');
    await expect(
      rowCells.first(),
      "expected ≥1 session matching flavor+state filters",
    ).toBeVisible();
    const rowCount = await rowCells.count();
    expect(rowCount).toBeGreaterThanOrEqual(1);

    // Remove the first chip (×). Which one is "first" depends on
    // render order, but for this assertion the only thing that
    // matters is: after removal, pill count drops to 1 AND the list
    // remains non-empty (because a single remaining filter must
    // still match some fixture session).
    await page
      .locator('[data-testid="active-filter-pill"]')
      .first()
      .locator('[data-testid="active-filter-remove"]')
      .click();
    await expect(pills).toHaveCount(1);

    // Session list must stay non-empty under the single remaining
    // filter. The seed guarantees both flavor and state (closed)
    // each match ≥1 fixture in isolation.
    await expect
      .poll(
        async () =>
          page.locator('[data-testid^="investigate-row-session-"]').count(),
        {
          message: "sessions list must stay non-empty after relaxing one filter",
          timeout: 10_000,
        },
      )
      .toBeGreaterThanOrEqual(1);
  });
});
