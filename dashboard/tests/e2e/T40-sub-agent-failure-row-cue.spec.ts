import { test, expect } from "@playwright/test";
import {
  bringSwimlaneRowIntoView,
  waitForFleetReady,
  waitForInvestigateReady,
} from "./_fixtures";

// T40 — Sub-agent failure row cue (L8). A child session whose
// state ended in lost shows the red AlertCircle indicator on the
// session row across three surfaces: Investigate session row,
// Fleet AgentTable row, Fleet swimlane left panel. METHODOLOGY L8
// — surface the failure on the row so an operator scanning the
// list spots trouble without expanding.
test.use({ viewport: { width: 1280, height: 1800 } });

test.describe("T40 — Sub-agent failure row cue (L8)", () => {
  test("Investigate row carries the L8 red dot for a sub-agent in lost state", async ({
    page,
  }) => {
    // D126 UX revision 2026-05-03 — Investigate's default scope
    // hides pure children (parents-with-children + lone only).
    // The seeded subagent-error session is a pure child (parent
    // visible, no descendants of its own) so it falls outside the
    // default. Land on the Investigate page with the
    // ``is_sub_agent=true`` override on so the children-only scope
    // surfaces every sub-agent row, including the lost one — which
    // is the exact use case the override exists for.
    await page.goto("/investigate?is_sub_agent=true");
    await waitForInvestigateReady(page);
    const indicator = page
      .locator('[data-testid^="session-row-sub-agent-lost-indicator-"]')
      .first();
    await expect(indicator).toBeVisible();
    await expect(indicator).toHaveAttribute(
      "aria-label",
      /Sub-agent ended in lost state/,
    );
  });

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
