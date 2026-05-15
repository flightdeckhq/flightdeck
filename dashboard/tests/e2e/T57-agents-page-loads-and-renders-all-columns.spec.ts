/**
 * T57 — /agents page loads and every locked column header
 * renders.
 *
 * Phase 3 contract: the page mounts on `/agents`; the table
 * header row carries every column from the locked Phase 3
 * design (identity, topology, tokens 7d, latency p95 7d,
 * errors 7d, sessions 7d, cost USD 7d, last seen, status).
 *
 * Theme-agnostic — every assertion is a structural locator
 * (data-testid) so the spec runs unchanged under neon-dark
 * and clean-light.
 */
import { test, expect } from "@playwright/test";

test.describe("T57 — /agents page renders every column", () => {
  test("page mounts and every column header is visible", async ({ page }) => {
    await page.goto("/agents");
    await expect(page.locator('[data-testid="agents-page"]')).toBeVisible();
    await expect(page.locator('[data-testid="agent-table"]')).toBeVisible();

    for (const col of [
      "agent_name",
      "topology",
      "tokens_7d",
      "latency_p95_7d",
      "errors_7d",
      "sessions_7d",
      "cost_usd_7d",
      "last_seen_at",
      "state",
    ]) {
      await expect(
        page.locator(`[data-testid="agent-table-th-${col}"]`),
      ).toBeVisible();
    }
  });

  test("at least one canonical agent row materialises", async ({ page }) => {
    await page.goto("/agents");
    await expect(
      page.locator('[data-testid^="agent-row-"][data-agent-id]'),
    ).not.toHaveCount(0, { timeout: 10_000 });
  });
});
