import { test, expect } from "@playwright/test";
import { CODING_AGENT, waitForInvestigateReady } from "./_fixtures";

// T18 — Phase 4.5 S-TBL-1: "Last Seen" column on the Investigate
// session table is sortable. Click reorders by last_seen_at DESC
// (newest first); click again reorders ASC.
//
// Anchor: the coding-agent fixture has six sessions with varied
// last_seen_at across roles (fresh-active is recent, ancient-only on
// the dedicated agent is days old). The test asserts the relative-
// time labels appear and the URL gains ?sort=last_seen_at on click.
test.describe("T18 — Last seen column sortable", () => {
  test("click 'Last seen' header sorts by recency, click again reverses", async ({
    page,
  }) => {
    const params = new URLSearchParams({
      from: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      to: new Date().toISOString(),
      flavor: CODING_AGENT.flavor,
    });
    await page.goto(`/investigate?${params.toString()}`);
    await waitForInvestigateReady(page);

    // The header carries the testid investigate-th-last-seen.
    const header = page.locator('[data-testid="investigate-th-last-seen"]');
    await expect(header).toBeVisible();
    // Click to activate sort. Default first click → desc per
    // handleSort's implementation.
    await header.click();
    await expect(page).toHaveURL(/sort=last_seen_at/);
    // ``order=desc`` is the default; buildUrlParams omits when default.
    await expect(page).not.toHaveURL(/order=asc/);

    // Click again toggles to ascending.
    await header.click();
    await expect(page).toHaveURL(/sort=last_seen_at/);
    await expect(page).toHaveURL(/order=asc/);
  });

  test("Last seen cells render relative-time labels", async ({ page }) => {
    const params = new URLSearchParams({
      from: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      to: new Date().toISOString(),
      flavor: CODING_AGENT.flavor,
    });
    await page.goto(`/investigate?${params.toString()}`);
    await waitForInvestigateReady(page);

    const cells = page.locator(
      '[data-testid^="investigate-row-last-seen-"]',
    );
    expect(await cells.count()).toBeGreaterThanOrEqual(1);
    // Spot-check a cell's text matches the relative-time pattern
    // ``\d+(s|m|h|d) ago``.
    const text = (await cells.first().textContent()) ?? "";
    expect(text).toMatch(/\d+(s|m|h|d) ago/);
  });
});
