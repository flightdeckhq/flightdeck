import { test, expect } from "@playwright/test";
import {
  bringSwimlaneRowIntoView,
  waitForFleetReady,
} from "./_fixtures";

// T28 — Claude Code subagent fleet rendering. Seed an Explore-role
// child of e2e-test-coding-agent (claude-subagent fixture). Verify
// the child swimlane row appears with a relationship pill that
// labels it as a child of the coding-agent parent. Both themes
// per Rule 40c.3.
// Tall viewport so the swimlane virtualizer mounts every fixture
// row without scroll-eviction; see T29 for the same pattern.
test.use({ viewport: { width: 1280, height: 1800 } });

test.describe("T28 — Claude Code subagent fleet rendering", () => {
  test("child swimlane row carries a child-mode relationship pill pointing at the parent", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForFleetReady(page);

    // The child agent appears as its own swimlane row keyed on the
    // 6-tuple identity (D126 § 2). Its relationship pill renders
    // "↳ <parent_name>" — the parent here is e2e-test-coding-agent
    // (the coding-agent's fresh-active session is the parent_session_id
    // anchor for the child's session_start).
    const childRow = await bringSwimlaneRowIntoView(
      page,
      "e2e-test-claude-subagent",
    );
    await expect(childRow).toBeVisible();

    // Relationship pill — child mode → ↳ glyph + parent's name.
    // Stamped via SubAgentRolePill / RelationshipPill (the 7.fix
    // wiring). The pill's data-mode attribute pins the topology
    // contract.
    const pill = childRow.locator('[data-testid="swimlane-relationship-pill"]');
    await expect(pill).toBeVisible();
    await expect(pill).toHaveAttribute("data-mode", "child");
    await expect(pill).toContainText("↳");
    await expect(pill).toContainText("e2e-test-coding-agent");
  });
});
