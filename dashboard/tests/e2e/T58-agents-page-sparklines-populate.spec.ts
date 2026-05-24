/**
 * T58 — /agents page sparkline tiles populate.
 *
 * Each KPI column on the table carries a 30-bucket day-
 * granularity sparkline sourced from
 * `GET /v1/agents/:id/summary?period=7d&bucket=day`. The
 * sparkline tile renders one of two shapes:
 *   - `[data-testid="agent-sparkline"]` — recharts chart for
 *     a non-empty series.
 *   - `[data-testid="agent-sparkline-empty"]` — placeholder
 *     dash for an empty series.
 *
 * The test asserts every visible row's tokens column carries
 * one of those two shapes — never absent. Validating both
 * branches in the same assertion prevents the spec from
 * failing when the canonical fleet happens to include an
 * idle agent with a zero-token week.
 */
import { test, expect } from "@playwright/test";

test.describe("T58 — sparkline tiles populate", () => {
  test("every visible row carries a sparkline (chart or empty placeholder)", async ({
    page,
  }) => {
    await page.goto("/agents");
    await expect(page.locator('[data-testid="agent-table"]')).toBeVisible();

    // Wait for at least one row to materialise + its summary
    // fetch to land. The summary fetch is per-row; rows mount
    // before their summary lands, then re-render once the fetch
    // resolves. The poll covers that lag without a fixed sleep.
    await expect
      .poll(
        async () =>
          (await page
            .locator(
              '[data-testid="agent-sparkline"], [data-testid="agent-sparkline-empty"]',
            )
            .count()) > 0,
        { timeout: 15_000 },
      )
      .toBe(true);

    const rows = page.locator('[data-testid^="agent-row-"][data-agent-id]');
    const rowCount = await rows.count();
    for (let i = 0; i < rowCount; i++) {
      const row = rows.nth(i);
      // Every row has 3 sparkline columns (tokens, latency p95,
      // errors). Assert at least one resolves to either shape.
      const sparklineCount = await row
        .locator(
          '[data-testid="agent-sparkline"], [data-testid="agent-sparkline-empty"]',
        )
        .count();
      expect(sparklineCount).toBeGreaterThanOrEqual(1);
    }
  });
});
