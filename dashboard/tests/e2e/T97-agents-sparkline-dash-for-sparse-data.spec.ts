import { test, expect } from "@playwright/test";

/**
 * T97 — /agents sparkline renders the neutral dash placeholder
 * when a row's KPI series has fewer than two non-zero points.
 *
 * Pre-fix a single non-zero bucket rendered as a stray
 * accent-coloured dot (the recharts ``LineChart`` reduces a
 * one-point series to a degenerate single mark). The polish
 * collapses any "sparse" case (zero or one non-zero data points)
 * into the same neutral placeholder dash that the empty-series
 * case already uses, so the column reads consistently regardless
 * of seed-data density.
 *
 * Fixture: ``e2e-test-ancient-agent``. The canonical seed gives
 * this agent a single ancient session with a small handful of
 * events all on the same day, so its 7-day KPI series carries
 * at most one non-zero bucket on each axis. The row therefore
 * exercises the dash path deterministically.
 *
 * Theme-agnostic; runs under both Playwright projects. The
 * chart-renders case is covered by the unit test
 * (``AgentSparkline.test.tsx``) — per the directive this E2E
 * asserts only the dash case so we don't need to seed an
 * additional dense fixture solely for the chart path.
 */
test.describe("T97 — /agents sparkline dash for sparse data", () => {
  test("ancient-only fixture row renders the dash placeholder, not a chart", async ({
    page,
  }) => {
    await page.goto("/agents");
    await expect(
      page.locator('[data-testid^="agent-row-"]').first(),
    ).toBeVisible({ timeout: 10_000 });

    // Find the ancient fixture row. ``ancient-only`` is its only
    // seeded role and is intentionally outside the live 7-day
    // window for most KPI axes, so the row's sparkline cells
    // should all collapse to the placeholder dash.
    const row = page
      .locator('[data-testid^="agent-row-"]')
      .filter({ hasText: "e2e-test-ancient-agent" })
      .first();
    await row.scrollIntoViewIfNeeded();
    await expect(row).toBeVisible();

    // The row mounts five KPI cells (tokens / latency / errors /
    // sessions / cost), and the sparkline tile lives inside each
    // KPI cell. Every visible sparkline mount on this row must
    // be the dash placeholder, not the chart variant. Polling
    // because ``useAgentSummary`` resolves asynchronously after
    // the row mounts.
    const sparkLines = row.locator('[data-testid="agent-sparkline"]');
    const placeholders = row.locator('[data-testid="agent-sparkline-empty"]');
    await expect
      .poll(async () => placeholders.count(), { timeout: 10_000 })
      .toBeGreaterThan(0);
    // Zero recharts mounts on this row's sparkline cells.
    await expect(sparkLines).toHaveCount(0);
  });
});
