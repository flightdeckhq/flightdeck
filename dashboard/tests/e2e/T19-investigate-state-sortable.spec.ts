import { test, expect } from "@playwright/test";
import { CODING_AGENT, waitForInvestigateReady } from "./_fixtures";

// T19 — Phase 4.5 S-TBL-2: "State" column on the Investigate session
// table sorts by a custom severity ordinal: ascending = active → idle
// → stale → lost → closed (most-needs-attention first); descending
// reverses. The SQL CASE expression lives in
// api/internal/store/sessions.go::allowedSorts.
//
// Anchor: the coding-agent fixture covers active and closed roles
// (fresh-active, recent-closed, aged-closed, stale, error-active,
// policy-active). The test asserts URL state and that the order is
// the severity ordinal, not alphabetical.
test.describe("T19 — State column sortable with severity ordinal", () => {
  test("click 'State' sorts by severity (active first), click again reverses", async ({
    page,
  }) => {
    const params = new URLSearchParams({
      from: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      to: new Date().toISOString(),
      flavor: CODING_AGENT.flavor,
    });
    await page.goto(`/investigate?${params.toString()}`);
    await waitForInvestigateReady(page);

    const header = page.locator('[data-testid="investigate-th-state"]');
    await expect(header).toBeVisible();
    await header.click();
    await expect(page).toHaveURL(/sort=state/);
    // First click → desc by handleSort default; coding agent has
    // closed sessions so the test should observe closed first when
    // descending.
    await expect(page).not.toHaveURL(/order=asc/);

    // Snapshot the rendered states (text in the StateBadge cells).
    const stateBadges = page.locator(
      'tr[class*="cursor-pointer"] td:last-child',
    );
    const desc = await stateBadges.allTextContents();

    // Click again to flip to ascending.
    await header.click();
    await expect(page).toHaveURL(/order=asc/);
    const asc = await stateBadges.allTextContents();

    // The two orderings differ — the asc/desc toggle had effect.
    expect(asc.join("|")).not.toBe(desc.join("|"));

    // Severity ordinal verification: in ASC mode, the first row's
    // state must come before the last row's state in the order
    // {active, idle, stale, lost, closed}. The fixture guarantees at
    // least one active and one closed across the rows.
    const ORDINAL: Record<string, number> = {
      active: 0,
      idle: 1,
      stale: 2,
      lost: 3,
      closed: 4,
    };
    const ascOrdinals = asc
      .map((t) => ORDINAL[(t.match(/active|idle|stale|lost|closed/) ?? [""])[0]])
      .filter((n): n is number => n !== undefined);
    // Non-decreasing (asc) — every consecutive pair has ord[i] <= ord[i+1].
    for (let i = 1; i < ascOrdinals.length; i++) {
      expect(
        ascOrdinals[i],
        `ASC severity ordinal must be non-decreasing across rows; saw ${ascOrdinals.join(",")}`,
      ).toBeGreaterThanOrEqual(ascOrdinals[i - 1]);
    }
  });
});
