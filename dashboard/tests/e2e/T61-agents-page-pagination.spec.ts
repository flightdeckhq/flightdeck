/**
 * T61 — /agents pagination footer.
 *
 * The pagination footer is hidden when the visible set fits in
 * one page (default page size 50). On the canonical fixture
 * set the fleet is small enough that the footer doesn't render
 * — the assertion validates absence in that case, which is the
 * correct contract.
 *
 * A future fixture expansion past 50 agents would flip this
 * test's expectation to "footer renders with prev/next + 1-50
 * of N counts". The test is wired conditionally so it adapts:
 * if the footer DOES render, the test asserts the prev/next
 * buttons + the counts display; if not, it asserts absence.
 */
import { test, expect } from "@playwright/test";

test.describe("T61 — pagination footer", () => {
  test("absence when total ≤ page size; presence + counts when total > 50", async ({
    page,
  }) => {
    await page.goto("/agents");
    await expect(page.locator('[data-testid="agent-table"]')).toBeVisible();

    const rows = page.locator('[data-testid^="agent-row-"][data-agent-id]');
    const rowCount = await rows.count();

    const footer = page.locator('[data-testid="agent-table-pagination"]');
    if (rowCount > 50) {
      await expect(footer).toBeVisible();
      await expect(
        page.locator('[data-testid="agent-table-pagination-counts"]'),
      ).toContainText("of");
      await expect(
        page.locator('[data-testid="agent-table-page-prev"]'),
      ).toBeVisible();
      await expect(
        page.locator('[data-testid="agent-table-page-next"]'),
      ).toBeVisible();
    } else {
      await expect(footer).toHaveCount(0);
    }
  });
});
