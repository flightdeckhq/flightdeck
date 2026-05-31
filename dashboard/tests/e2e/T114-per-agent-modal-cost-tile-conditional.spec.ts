/**
 * T114 — the per-agent swimlane modal's KPI header shows the
 * ``Cost (7d)`` tile only for clients whose LLM usage incurs
 * metered, per-call cost on the operator's bill.
 *
 * Subscription-style coding agents (Claude Code today; Codex /
 * Cursor / Windsurf in the future) bill independently of per-call
 * usage, so the tile is hidden entirely rather than rendered as a
 * placeholder em-dash. Sensor-instrumented agents call paid LLM
 * APIs directly, so the tile is meaningful and present.
 *
 * The single source of truth for the rule is the
 * ``clientIncursMeteredCost`` predicate in
 * ``dashboard/src/lib/agent-identity.ts``; adding a new
 * ``ClientType`` defaults to subscription-style (Cost hidden) until
 * the predicate is explicitly extended. Sibling unit coverage in
 * ``dashboard/tests/unit/PerAgentSwimlaneModal.test.tsx`` locks the
 * 4-vs-5-tile split; this E2E spec locks the same contract against
 * the seeded dev stack so a future regression in the live render
 * surfaces here instead of only in unit-test isolation.
 */
import { test, expect, type Locator } from "@playwright/test";

async function findAgentRow(
  page: Locator | import("@playwright/test").Page,
  clientType: "claude_code" | "flightdeck_sensor",
): Promise<Locator | null> {
  const rows = page
    .locator(`[data-testid^="agent-row-"][data-agent-id]`)
    .filter({
      has: page.locator(`[title="client_type=${clientType}"]`),
    });
  const count = await rows.count();
  if (count === 0) return null;
  return rows.first();
}

async function openModalFor(
  page: import("@playwright/test").Page,
  clientType: "claude_code" | "flightdeck_sensor",
): Promise<Locator | null> {
  await page.goto("/agents");
  await expect(page.locator('[data-testid="agent-table"]')).toBeVisible();
  const row = await findAgentRow(page, clientType);
  if (row == null) return null;
  await row.locator('[data-testid^="agent-row-open-swimlane-modal-"]').click();
  const modal = page.locator('[data-testid="per-agent-swimlane-modal"]');
  await expect(modal).toBeVisible();
  return modal;
}

test.describe("T114 — per-agent modal Cost tile conditional on client_type", () => {
  test("Claude Code agent: 4 KPI tiles and no Cost (7d) label", async ({
    page,
  }) => {
    const modal = await openModalFor(page, "claude_code");
    test.skip(
      modal == null,
      "no claude_code agent in the seeded fleet — nothing to assert",
    );
    const tiles = modal!.locator(
      '[data-testid="per-agent-swimlane-modal-kpi-tile"]',
    );
    await expect(tiles).toHaveCount(4);
    await expect(modal!).not.toContainText("Cost (7d)");
  });

  test("sensor agent: 5 KPI tiles including Cost (7d) label", async ({
    page,
  }) => {
    const modal = await openModalFor(page, "flightdeck_sensor");
    test.skip(
      modal == null,
      "no flightdeck_sensor agent in the seeded fleet — nothing to assert",
    );
    const tiles = modal!.locator(
      '[data-testid="per-agent-swimlane-modal-kpi-tile"]',
    );
    await expect(tiles).toHaveCount(5);
    await expect(modal!).toContainText("Cost (7d)");
  });
});
