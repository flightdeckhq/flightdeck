/**
 * T68 — clicking the agent name in the Fleet swimlane label strip
 * opens that agent's drawer inline (no route change).
 *
 * Phase 4 contract: the swimlane agent-name link sets the
 * `?agent_drawer=` URL param; the app-level AgentDrawerHost opens
 * the drawer over the still-mounted Fleet view. Replaces the
 * Phase 3 `/agents?focus=` cross-page jump.
 *
 * Theme-agnostic — structural locators only.
 */
import { test, expect } from "@playwright/test";
import {
  bringSwimlaneRowIntoView,
  CODING_AGENT,
  waitForFleetReady,
} from "./_fixtures";

// Tall viewport so the swimlane row is not virtualised off-screen.
test.use({ viewport: { width: 1280, height: 1800 } });

test.describe("T68 — agent drawer opens from the Fleet swimlane", () => {
  test("clicking the swimlane agent name opens the drawer", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForFleetReady(page);

    const row = await bringSwimlaneRowIntoView(page, CODING_AGENT.name);
    await expect(row).toBeVisible({ timeout: 10_000 });

    const link = row.locator('[data-testid="swimlane-agent-name-link"]');
    await expect(link).toBeAttached();
    // The link's bounding box can fall outside a clipped left strip;
    // trigger the click via the synthetic-event path (mirrors T66).
    await link.evaluate((el) => (el as HTMLAnchorElement).click());

    await expect(page).toHaveURL(/agent_drawer=/);
    await expect(page.locator('[data-testid="agent-drawer"]')).toBeVisible();
    // No cross-page navigation — the Fleet view stays mounted.
    await expect(page).not.toHaveURL(/\/agents/);
  });
});
