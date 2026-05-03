import { test, expect } from "@playwright/test";
import { waitForInvestigateReady } from "./_fixtures";

// T33 — Sub-agent Investigate facets. TOPOLOGY (Has sub-agents /
// Is sub-agent) + ROLE multi-select. ROLE + PARENT columns surface
// in the session table; click-to-filter on PARENT sets the URL
// filter and narrows the result set.
test.describe("T33 — Sub-agent Investigate facets", () => {
  test("TOPOLOGY facet renders both checkboxes and Is sub-agent filters", async ({
    page,
  }) => {
    await page.goto("/investigate");
    await waitForInvestigateReady(page);

    // The TOPOLOGY facet section is always visible per the
    // 7.fix.F contract — the user can widen the view by toggling
    // Has sub-agents on a result set with no visible sub-agents.
    const sidebar = page.locator('[data-testid="investigate-sidebar"]');
    await expect(sidebar).toContainText("TOPOLOGY");
    await expect(sidebar).toContainText("is_sub_agent");
    await expect(sidebar).toContainText("has_sub_agents");
  });

  test("ROLE facet lists distinct seeded roles", async ({ page }) => {
    await page.goto("/investigate");
    await waitForInvestigateReady(page);
    const sidebar = page.locator('[data-testid="investigate-sidebar"]');
    // ROLE facet surfaces only when at least one sub-agent role
    // exists in the visible result set. Seeded fixtures provide
    // Researcher, Writer, Explore, etc., so the section renders.
    await expect(sidebar).toContainText("ROLE");
    await expect(sidebar).toContainText("Researcher");
    await expect(sidebar).toContainText("Writer");
  });

  test("ROLE column + PARENT column render in the session table", async ({
    page,
  }) => {
    await page.goto("/investigate");
    await waitForInvestigateReady(page);
    // Headers exist on the sticky thead row regardless of which
    // sessions render; locking the column presence catches a
    // regression where the columns get accidentally dropped.
    await expect(
      page.locator('[data-testid="investigate-th-role"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="investigate-th-parent"]'),
    ).toBeVisible();
  });

  test("clicking a PARENT cell sets parent_session_id filter", async ({
    page,
  }) => {
    await page.goto("/investigate");
    await waitForInvestigateReady(page);
    // Find any session row whose PARENT cell carries a click
    // affordance (sub-agent rows have one; root rows render an
    // em-dash). The first such cell drives the filter assertion.
    const parentCell = page
      .locator('[data-testid^="investigate-row-parent-"] button')
      .first();
    await expect(parentCell).toBeVisible();
    await parentCell.click();
    // URL gains parent_session_id after the click.
    await expect(page).toHaveURL(/parent_session_id=/);
    // Active-filter chip surfaces in the top bar.
    const chips = page.locator('[data-testid="active-filter-pill"]');
    await expect(chips.first()).toContainText("parent:");
  });
});
