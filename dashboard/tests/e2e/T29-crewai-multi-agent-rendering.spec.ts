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

    // Both child rows mount with the relationship pill in child
    // mode. The pill text identifies the parent agent by name.
    // We wait for the wrapper's data-rel-mode attribute to settle
    // before reading the inner pill — the SwimLane is virtualized
    // (IntersectionObserver-driven), so on first mount the
    // deriveRelationship pass races React's commit; the wrapper
    // attribute stabilizes once the relationship pass settles.
    const researcher = await bringSwimlaneRowIntoView(
      page,
      "e2e-test-crewai-researcher",
    );
    await expect(researcher).toBeVisible();
    const researcherWrapper = page.locator(
      '[data-agent-id]:has([data-testid="swimlane-agent-row-e2e-test-crewai-researcher"])',
    );
    await expect(researcherWrapper).toHaveAttribute("data-rel-mode", "child");
    await expect(
      researcherWrapper.locator('[data-testid="swimlane-relationship-pill"]'),
    ).toContainText("e2e-test-crewai-parent");

    const writer = await bringSwimlaneRowIntoView(
      page,
      "e2e-test-crewai-writer",
    );
    await expect(writer).toBeVisible();
    const writerWrapper = page.locator(
      '[data-agent-id]:has([data-testid="swimlane-agent-row-e2e-test-crewai-writer"])',
    );
    await expect(writerWrapper).toHaveAttribute("data-rel-mode", "child");

    // Parent row's pill reads → 2 — exactly two distinct child
    // agent_ids reference its session as parent_session_id.
    const parent = await bringSwimlaneRowIntoView(
      page,
      "e2e-test-crewai-parent",
    );
    await expect(parent).toBeVisible();
    const parentWrapper = page.locator(
      '[data-agent-id]:has([data-testid="swimlane-agent-row-e2e-test-crewai-parent"])',
    );
    await expect(parentWrapper).toHaveAttribute("data-rel-mode", "parent");
    const parentPill = parentWrapper.locator(
      '[data-testid="swimlane-relationship-pill"]',
    );
    await expect(parentPill).toContainText("→");
    await expect(parentPill).toContainText("2");
  });
});
