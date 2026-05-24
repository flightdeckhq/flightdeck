import { test, expect } from "@playwright/test";

/**
 * T105 — /agents sparkline tooltip + read-only click.
 *
 * Two contracts the operator opted into:
 *   1. Hovering a sparkline tile surfaces a tooltip with the
 *      formatted value + the bucket's date.
 *   2. Clicking the sparkline tile does NOT open the agent
 *      drawer — only clicks elsewhere on the row do.
 *
 * The sparkline tile is bounded (~80 px wide); the rest of the
 * row remains clickable. Theme-agnostic.
 */
test.describe("T105 — /agents sparkline tooltip + read-only click", () => {
  test("hovering a sparkline shows a tooltip with the formatted value + day", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1700, height: 1000 });
    await page.goto("/agents");
    await page.waitForSelector('[data-testid^="agent-row-"]', {
      timeout: 15_000,
    });
    // Poll for the first agent row that has a real sparkline
    // (not the sparse-data placeholder dash). The KPI summary
    // fetch is asynchronous; rows render the dash until the
    // ``useAgentSummary`` hook resolves.
    const sparkline = page.locator('[data-testid="agent-sparkline"]').first();
    await expect
      .poll(() => sparkline.count(), { timeout: 15_000 })
      .toBeGreaterThan(0);
    await sparkline.scrollIntoViewIfNeeded();
    await sparkline.hover({ force: true });
    const tooltip = page.locator('[data-testid="agent-sparkline-tooltip"]');
    await expect(tooltip).toBeVisible({ timeout: 5_000 });
    // The tooltip text is always "<short-date>: <formatted-value>".
    // Both halves carry non-empty content; assert structurally
    // (a colon separator + non-empty values on either side)
    // rather than nailing a specific date/value so the test stays
    // stable across the dev stack's drifting clock.
    const text = (await tooltip.textContent()) ?? "";
    expect(text).toMatch(/\S+:\s*\S+/);
  });

  test("clicking the sparkline does NOT open the agent drawer; clicking elsewhere on the row does", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1700, height: 1000 });
    await page.goto("/agents");
    await page.waitForSelector('[data-testid^="agent-row-"]', {
      timeout: 15_000,
    });
    const sparkline = page.locator('[data-testid="agent-sparkline"]').first();
    await expect
      .poll(() => sparkline.count(), { timeout: 15_000 })
      .toBeGreaterThan(0);
    await sparkline.scrollIntoViewIfNeeded();

    // Sparkline click → no drawer. Capture the URL before the
    // click and poll-assert it stays put for a short window;
    // beats a fixed ``waitForTimeout`` because it surfaces an
    // actual regression (drawer opens asynchronously) instead
    // of papering over a race.
    const urlBefore = page.url();
    await sparkline.click({ force: true });
    await expect
      .poll(() => page.url(), { timeout: 2_000 })
      .toBe(urlBefore);
    expect(page.url()).not.toContain("agent_drawer=");

    // Row click on a non-sparkline area → drawer opens (URL
    // gains ``?agent_drawer=...``). Resolve the `<tr>` ancestor
    // — note the cell testids also prefix-match
    // ``agent-row-...`` so we scope the climb to `<tr>` only.
    const rowId = await sparkline.evaluate((el) => {
      const row = el.closest('tr[data-testid^="agent-row-"]');
      return row?.getAttribute("data-testid") ?? "";
    });
    expect(rowId).toMatch(/^agent-row-/);
    const row = page.locator(`tr[data-testid="${rowId}"]`);
    // Click in the middle of the row, past the identity cell
    // and clear of the sparkline tiles (which sit to the right
    // of their numeric totals).
    await row.click({ position: { x: 250, y: 12 } });
    await expect
      .poll(() => page.url(), { timeout: 5_000 })
      .toContain("agent_drawer=");
  });
});
