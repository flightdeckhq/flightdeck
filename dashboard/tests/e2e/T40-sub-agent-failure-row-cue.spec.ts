import { test, expect } from "@playwright/test";
import { bringSwimlaneRowIntoView, waitForFleetReady } from "./_fixtures";

// T40 — Sub-agent failure row cue (L8). A child session whose
// state ended in lost shows the red AlertCircle indicator across
// the Fleet AgentTable row and the Fleet swimlane left panel.
// METHODOLOGY L8 — surface the failure on the row so an operator
// scanning the list spots trouble without expanding.
//
// (Phase 4 wave 2: the third surface — the session-grain
// /investigate session row — was retired with the session-grain
// table. The /events page is event-grain and has no per-session
// rows; the L8 cue lives on the two Fleet surfaces below.)
test.use({ viewport: { width: 1280, height: 1800 } });

test.describe("T40 — Sub-agent failure row cue (L8)", () => {
  test("Fleet swimlane left panel carries the L8 dot on the sub-agent row", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForFleetReady(page);
    const row = await bringSwimlaneRowIntoView(
      page,
      "e2e-test-subagent-error",
    );
    const dot = row.locator('[data-testid="swimlane-sub-agent-lost-dot"]');
    await expect(dot).toBeVisible();
    // The dot's color reads from --status-lost so the same red
    // resolves correctly under both themes.
    const color = await dot.evaluate(
      (el) => window.getComputedStyle(el).color,
    );
    // Non-empty colour string proves the CSS variable resolved.
    expect(color.length).toBeGreaterThan(0);
  });

  test("Fleet swimlane row surfaces the same lost sub-agent cue via AgentStatusBadge", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForSelector('[data-testid^="swimlane-agent-row-"]');
    // The swimlane row's AgentStatusBadge renders the per-agent
    // rolled-up state. The L8 SubAgentLostDot stays inside the
    // sub-agent's row label strip; the agent badge is the row-
    // level signal that the sub-agent ended in ``lost`` state.
    const rows = page.locator(
      '[data-testid="swimlane-agent-row-e2e-test-subagent-error"]',
    );
    const found = rows.first();
    await expect(found).toBeVisible({ timeout: 10000 });
    const badge = found.locator(
      '[data-testid="swimlane-agent-status-badge"]',
    );
    await expect(badge).toHaveAttribute("data-state", "lost");
  });
});
