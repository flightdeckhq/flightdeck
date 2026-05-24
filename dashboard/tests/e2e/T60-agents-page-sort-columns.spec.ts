/**
 * T60 — /agents page column sort toggles direction.
 *
 * Clicking a column header sets it as the active sort column
 * and applies the column's default direction (DESC for
 * numeric columns, ASC for textual). A second click on the
 * same header flips the direction. The sort indicator
 * surfaces through ``data-sort-active`` + ``data-sort-direction``
 * attributes on the header cell.
 */
import { test, expect } from "@playwright/test";

test.describe("T60 — column header click toggles sort direction", () => {
  test("first click on tokens header sets DESC, second flips to ASC", async ({
    page,
  }) => {
    await page.goto("/agents");
    await expect(page.locator('[data-testid="agent-table"]')).toBeVisible();

    const header = page.locator('[data-testid="agent-table-th-tokens_7d"]');
    await header.click();
    await expect(header).toHaveAttribute("data-sort-active", "true");
    await expect(header).toHaveAttribute("data-sort-direction", "desc");

    await header.click();
    await expect(header).toHaveAttribute("data-sort-direction", "asc");
  });

  test("clicking a different column moves the active flag", async ({
    page,
  }) => {
    await page.goto("/agents");
    const tokens = page.locator('[data-testid="agent-table-th-tokens_7d"]');
    const latency = page.locator(
      '[data-testid="agent-table-th-latency_p95_7d"]',
    );
    await tokens.click();
    await expect(tokens).toHaveAttribute("data-sort-active", "true");
    await latency.click();
    await expect(latency).toHaveAttribute("data-sort-active", "true");
    await expect(tokens).not.toHaveAttribute("data-sort-active", "true");
  });
});
