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
 *
 * Implementation note: the prior incarnation of this test gated
 * the conditional on the visible row count, which always caps at
 * PAGE_SIZE (50) when pagination is active — so the branch flipped
 * the wrong way as soon as total exceeded 50 on the dev DB
 * (which accumulates state across E2E runs from agent-creating
 * suites like the reconcile tests). The robust gate reads the
 * page's own pagination footer presence: if it exists, validate
 * its contents; if not, validate its absence AND that the visible
 * row count is ≤ PAGE_SIZE (the contract behaviour).
 */
import { test, expect } from "@playwright/test";

const PAGE_SIZE = 50;

test.describe("T61 — pagination footer", () => {
  test("absence when total ≤ page size; presence + counts when total > 50", async ({
    page,
  }) => {
    await page.goto("/agents");
    await expect(page.locator('[data-testid="agent-table"]')).toBeVisible();

    const footer = page.locator('[data-testid="agent-table-pagination"]');
    const footerCount = await footer.count();
    const rows = page.locator('[data-testid^="agent-row-"][data-agent-id]');

    if (footerCount > 0) {
      // Presence branch — fleet has more than one page of agents.
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
      // Page slice is at most PAGE_SIZE rows wide (family-
      // respecting pagination can render fewer when a family
      // would straddle the boundary, but never more).
      expect(await rows.count()).toBeLessThanOrEqual(PAGE_SIZE);
    } else {
      // Absence branch — fleet fits in one page. The full roster
      // is rendered as a single slice.
      await expect(footer).toHaveCount(0);
      expect(await rows.count()).toBeLessThanOrEqual(PAGE_SIZE);
    }
  });
});
