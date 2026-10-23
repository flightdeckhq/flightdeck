import { test, expect } from "@playwright/test";

/**
 * T117 — Live Feed type pills keep their label inside the pill.
 *
 * Guarded regression: the Type column's pill is a fixed-height box in
 * a resizable column, and long labels such as "MCP PROMPT FETCHED"
 * wrapped onto a second line that spilled out of the pill. Labels now
 * stay on one line and end in an ellipsis when the column is narrow.
 *
 * The seed's MCP fixtures put long-label events into the feed.
 * Theme-agnostic; runs under both Playwright projects.
 */
test.describe("T117 — Live Feed type pill fits its label", () => {
  test("every feed pill renders its label on one line inside the pill", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "1h", exact: true }).click();
    // A long MCP label is the case that overflowed.
    await expect(
      page.locator('[data-testid="feed-badge"]', { hasText: /^MCP / }).first(),
    ).toBeVisible({ timeout: 15_000 });

    const overflowing = await page
      .locator('[data-testid="feed-badge"]')
      .evaluateAll((badges) =>
        badges.flatMap((badge) => {
          const label = badge.firstElementChild as HTMLElement | null;
          if (!label) return [`${badge.textContent}: no label element`];
          const b = badge.getBoundingClientRect();
          const l = label.getBoundingClientRect();
          return l.height > b.height || l.top < b.top - 1 || l.bottom > b.bottom + 1
            ? [`${badge.textContent}: label ${Math.round(l.height)}px tall in a ${Math.round(b.height)}px pill`]
            : [];
        }),
      );
    expect(overflowing).toEqual([]);
  });
});
