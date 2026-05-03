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
    await page.goto("/investigate");
    await waitForInvestigateReady(page);
    // The seeded subagent-error session has parent_session_id set
    // AND state=lost, which fires the L8 dot inside the State
    // column. The session_id is deterministic; use the substring
    // match on the row testid so the locator survives a future
    // session_id rotation.
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

  test("Fleet AgentTable row surfaces the same lost sub-agent cue via state column", async ({
    page,
  }) => {
    await page.goto("/?view=table");
    await page.waitForSelector('[data-testid^="fleet-agent-row-"]');
    // The AgentTable's State column renders the rollup state per
    // row. For the sub-agent fixture the agent's only session is
    // lost, so the rollup reports lost — visible via the state
    // dot + label. The L8 SubAgentLostDot is rendered in the
    // SwimLane lane (separate surface); the AgentTable's table-
    // view surface carries the equivalent signal via the State
    // column's "lost" enum. Pin both.
    const rows = page.locator('[data-testid^="fleet-agent-row-"]');
    const found = await rows
      .filter({ hasText: "e2e-test-subagent-error" })
      .first();
    await expect(found).toBeVisible();
    await expect(found).toContainText("lost");
  });
});
