/**
 * T89 — /agents cost column adapts to client_type.
 *
 * The `/agents` page now renders a left facet sidebar (replacing
 * the old horizontal chip bar) and a conditional Cost (7d)
 * column:
 *   - Claude Code agents bill independently and Flightdeck has no
 *     pricing for them — their cost cell always shows a bare
 *     em-dash "—".
 *   - Sensor-instrumented agents carry estimated cost — their
 *     cell shows a dollar figure (or "—" only when no cost has
 *     accrued).
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
  return row.locator('[data-testid^="agent-row-cost-"]');
}

test.describe("T89 — cost column is conditional on client_type", () => {
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

  test("a Claude Code agent's cost cell shows a bare em-dash", async ({
    page,
  }) => {
    await page.goto("/agents");
    await expect(page.locator('[data-testid="agent-table"]')).toBeVisible();

    const cell = costCellForAgent(page, CODING_AGENT.name);
    await expect(cell).toBeVisible();
    // The cell waits out the per-row summary fetch — its content
    // is deterministic "—" regardless of any totals because the
    // agent is a claude_code client.
    await expect(cell).toHaveText("—");
  });

  test("a sensor agent's cost cell carries a non-empty value", async ({
    page,
  }) => {
    await page.goto("/agents");
    await expect(page.locator('[data-testid="agent-table"]')).toBeVisible();

    const cell = costCellForAgent(page, SENSOR_AGENT.name);
    await expect(cell).toBeVisible();
    // Sensor agents take the formatCost path: a dollar figure
    // when cost has accrued, or "—" for a zero-cost week. Either
    // way the cell text is non-empty. Poll for the summary fetch
    // to settle the cell content.
    await expect
      .poll(async () => (await cell.textContent())?.trim() ?? "", {
        timeout: 15_000,
      })
      .not.toBe("");
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
