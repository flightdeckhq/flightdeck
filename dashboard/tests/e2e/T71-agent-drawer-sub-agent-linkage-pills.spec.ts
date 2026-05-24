/**
 * T71 — the agent drawer header surfaces sub-agent linkage pills
 * for an agent that is part of a sub-agent graph.
 *
 * Phase 4 contract: a parent agent's header lists a clickable
 * chip per child agent; a child agent's header carries a
 * "← parent:" pill. The seeded canonical fixtures include
 * parent / child agents (`data-agent-topology` ≠ "lone").
 *
 * Theme-agnostic — structural locators only.
 */
import { test, expect } from "@playwright/test";

test.describe("T71 — agent drawer sub-agent linkage pills", () => {
  test("a non-lone agent's drawer renders linkage pills", async ({ page }) => {
    await page.goto("/agents");

    // A parent / child topology row — its agent participates in a
    // sub-agent relationship, so the drawer derives linkage pills.
    const linkedRow = page
      .locator(
        '[data-testid^="agent-row-"][data-agent-id]:not([data-agent-topology="lone"])',
      )
      .first();
    await expect(linkedRow).toBeVisible({ timeout: 10_000 });
    await linkedRow.click();

    await expect(page.locator('[data-testid="agent-drawer"]')).toBeVisible();
    await expect(
      page.locator('[data-testid="agent-drawer-linkage"]'),
    ).toBeVisible();

    // At least one pill — parent or child — is present and clickable.
    const pills = page.locator(
      '[data-testid="agent-drawer-parent-pill"], [data-testid="agent-drawer-child-pill"]',
    );
    await expect(pills.first()).toBeVisible();
  });
});
