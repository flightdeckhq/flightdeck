/**
 * T114 — the per-agent swimlane modal's ``Cost (7d)`` tile reads the
 * agent's billing modes, the same way the Agents table's cost cell
 * does.
 *
 * The tile is always present. An agent whose calls in the window all
 * ran on a subscription shows ``Subscription`` (the seeded Claude Code
 * agent: its calls carry no billing mode, which reads as subscription
 * for claude_code sessions); a metered agent shows a dollar amount.
 * Sibling unit coverage lives in
 * ``dashboard/tests/unit/PerAgentSwimlaneModal.test.tsx`` and
 * ``dashboard/tests/unit/AgentCost.test.tsx``. Agents are pinned by
 * name because other claude_code agents on a dev stack may be metered.
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
import { CODING_AGENT, SENSOR_AGENT } from "./_fixtures";

async function openModalFor(page: Page, agentName: string): Promise<Locator> {
  await page.goto("/agents");
  await expect(page.locator('[data-testid="agent-table"]')).toBeVisible();
  const row = page
    .locator('[data-testid^="agent-row-"][data-agent-id]')
    .filter({ has: page.getByText(agentName, { exact: true }) });
  await row.locator('[data-testid^="agent-row-open-swimlane-modal-"]').click();
  const modal = page.locator('[data-testid="per-agent-swimlane-modal"]');
  await expect(modal).toBeVisible();
  return modal;
}

test.describe("T114 — per-agent modal Cost tile follows the billing modes", () => {
  test("subscription-only agent: the Cost tile reads Subscription", async ({ page }) => {
    const modal = await openModalFor(page, CODING_AGENT.name);
    await expect(
      modal.locator('[data-testid="per-agent-swimlane-modal-kpi-tile"]'),
    ).toHaveCount(5);
    await expect(
      modal.locator('[data-testid="per-agent-swimlane-modal-cost"]'),
    ).toHaveText("Subscription");
  });

  test("metered agent: the Cost tile shows a dollar amount", async ({ page }) => {
    const modal = await openModalFor(page, SENSOR_AGENT.name);
    await expect(
      modal.locator('[data-testid="per-agent-swimlane-modal-kpi-tile"]'),
    ).toHaveCount(5);
    await expect(
      modal.locator('[data-testid="per-agent-swimlane-modal-cost"]'),
    ).toHaveText(/^<?\$\d/);
  });
});
