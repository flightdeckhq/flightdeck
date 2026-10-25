/**
 * T89 — /agents cost column follows the calls' billing modes.
 *
 * The `/agents` page renders a left facet sidebar and a Cost (7d)
 * column whose reading comes from the window's billing modes, not
 * the client type:
 *   - An agent whose calls all ran on a subscription shows
 *     "Subscription" (the seeded Claude Code agent: its calls carry
 *     no billing mode, which reads as subscription for claude_code).
 *   - A metered agent shows a dollar figure ("$0.00" when nothing
 *     accrued, never an em-dash).
 *
 * Theme-agnostic: every assertion is a structural locator or a
 * text comparison, so the spec runs unchanged under neon-dark and
 * clean-light. Fixtures are the canonical seed — CODING_AGENT is
 * a `claude_code` client, SENSOR_AGENT is a `flightdeck_sensor`
 * client.
 */
import { test, expect } from "@playwright/test";
import { CODING_AGENT, SENSOR_AGENT } from "./_fixtures";

/**
 * Locate an agent's table row by its agent_name. The identity
 * cell renders the name in its own element; the row is the `<tr>`
 * carrying `data-agent-id`. Returns the row's cost cell locator.
 *
 * The row is matched by an EXACT-text name element, not a
 * substring `hasText`: the canonical seed has rows whose content
 * references another agent's name, so a substring match resolves
 * several rows. Exact text pins the one row whose identity cell
 * shows precisely this agent_name.
 */
function costCellForAgent(
  page: import("@playwright/test").Page,
  agentName: string,
) {
  const row = page
    .locator('[data-testid^="agent-row-"][data-agent-id]')
    .filter({ has: page.getByText(agentName, { exact: true }) });
  // Restrict to the `<td>` so the prefix selector doesn't also
  // match the inner total `<span data-testid="agent-row-cost-total-…">`
  // that the cost cell renders alongside its sparkline. The TD is
  // the cell element the assertions operate on; the inner span
  // carries the numeric readout.
  return row.locator('td[data-testid^="agent-row-cost-"]');
}

test.describe("T89 — cost column follows the billing modes", () => {
  test("the facet sidebar renders on /agents", async ({ page }) => {
    await page.goto("/agents");
    await expect(
      page.locator('[data-testid="agents-facet-sidebar"]'),
    ).toBeVisible();
    // The four facet groups are present.
    for (const group of [
      "agent-filter-state-group",
      "agent-filter-agent-type-group",
      "agent-filter-client-type-group",
    ]) {
      await expect(page.locator(`[data-testid="${group}"]`)).toBeVisible();
    }
  });

  test("a subscription-only agent's cost cell shows Subscription", async ({
    page,
  }) => {
    await page.goto("/agents");
    await expect(page.locator('[data-testid="agent-table"]')).toBeVisible();

    const cell = costCellForAgent(page, CODING_AGENT.name);
    await expect(cell).toBeVisible();
    // Web-first assertion: retries until the per-row summary fetch
    // settles the cell.
    await expect(cell).toHaveText("Subscription");
  });

  test("a metered agent's cost cell shows a dollar amount", async ({
    page,
  }) => {
    await page.goto("/agents");
    await expect(page.locator('[data-testid="agent-table"]')).toBeVisible();

    const cell = costCellForAgent(page, SENSOR_AGENT.name);
    await expect(cell).toBeVisible();
    await expect(cell).toHaveText(/^<?\$\d/);
  });

  test("the cost header carries an info affordance", async ({ page }) => {
    await page.goto("/agents");
    await expect(
      page.locator('[data-testid="agent-table-th-cost_usd_7d"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="agent-table-cost-info"]'),
    ).toBeVisible();
  });
});
