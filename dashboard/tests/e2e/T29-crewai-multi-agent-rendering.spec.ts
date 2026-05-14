import { test, expect } from "@playwright/test";
import {
  bringSwimlaneRowIntoView,
  waitForFleetReady,
} from "./_fixtures";

// T29 — CrewAI multi-agent rendering. Crew kickoff (parent) +
// Researcher + Writer children. The parent row's relationship pill
// reads "→ 2" (two distinct child agents); each child renders its
// own swimlane row with a child-mode pill pointing back at the
// parent. Both themes per Rule 40c.3.
// Tall viewport so the seeded D126 fixtures all fit without
// IntersectionObserver virtualization evicting rows that are
// just-off-screen. The swimlane mounts ~16 agent rows + the ALL
// row + bucket dividers under our seed; 1800px gives them all a
// stable mount slot so the relationship-pill assertions don't race
// the virtualizer.
test.use({ viewport: { width: 1280, height: 1800 } });

test.describe("T29 — CrewAI multi-agent rendering", () => {
  test("Researcher and Writer children render with role pills + parent shows → 2", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForFleetReady(page);

    // Both child rows mount with ``data-topology="child"`` on the
    // row's outer div and the RelationshipPill renders inside the
    // label strip. The pill text identifies the parent agent by
    // name. We poll on data-topology so the deriveRelationship
    // pass has time to settle (the SwimLane is virtualized via
    // IntersectionObserver and the relationship walk runs after
    // React's first commit).
    const researcher = await bringSwimlaneRowIntoView(
      page,
      "e2e-test-crewai-researcher",
    );
    await expect(researcher).toBeVisible();
    await expect(researcher).toHaveAttribute("data-topology", "child");
    await expect(
      researcher.locator('[data-testid="swimlane-relationship-pill"]'),
    ).toContainText("e2e-test-crewai-parent");

    const writer = await bringSwimlaneRowIntoView(
      page,
      "e2e-test-crewai-writer",
    );
    await expect(writer).toBeVisible();
    await expect(writer).toHaveAttribute("data-topology", "child");

    // Parent row's pill reads → 2 — exactly two distinct child
    // agent_ids reference its session as parent_session_id. The
    // parent itself keeps ``data-topology="root"`` (only child
    // rows take the indent + bg tint); the parent-vs-lone signal
    // lives in the relationship pill text.
    const parent = await bringSwimlaneRowIntoView(
      page,
      "e2e-test-crewai-parent",
    );
    await expect(parent).toBeVisible();
    await expect(parent).toHaveAttribute("data-topology", "root");
    const parentPill = parent.locator(
      '[data-testid="swimlane-relationship-pill"]',
    );
    await expect(parentPill).toContainText("→");
    await expect(parentPill).toContainText("2");
  });
});
