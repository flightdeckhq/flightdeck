/**
 * T67 — clicking a row on the /agents table opens that agent's
 * drawer.
 *
 * Phase 4 contract: the row click is the primary affordance — it
 * sets the `?agent_drawer=<agent_id>` URL param and the app-level
 * AgentDrawerHost renders the drawer.
 *
 * Theme-agnostic — every assertion is a structural locator.
 */
import { test, expect } from "@playwright/test";

test.describe("T67 — agent drawer opens on /agents row click", () => {
  test("clicking an agent row opens the drawer and sets the URL param", async ({
    page,
  }) => {
    await page.goto("/agents");
    const firstRow = page
      .locator('[data-testid^="agent-row-"][data-agent-id]')
      .first();
    await expect(firstRow).toBeVisible({ timeout: 10_000 });

    await firstRow.click();

    await expect(page.locator('[data-testid="agent-drawer"]')).toBeVisible();
    await expect(page).toHaveURL(/agent_drawer=/);
    await expect(
      page.locator('[data-testid="agent-drawer-name"]'),
    ).toBeVisible();
  });

  test("the close button dismisses the drawer and clears the param", async ({
    page,
  }) => {
    await page.goto("/agents");
    const firstRow = page
      .locator('[data-testid^="agent-row-"][data-agent-id]')
      .first();
    await expect(firstRow).toBeVisible({ timeout: 10_000 });
    await firstRow.click();
    await expect(page.locator('[data-testid="agent-drawer"]')).toBeVisible();

    await page.locator('[data-testid="agent-drawer-close"]').click();

    await expect(page.locator('[data-testid="agent-drawer"]')).toHaveCount(0);
    await expect(page).not.toHaveURL(/agent_drawer=/);
  });
});
