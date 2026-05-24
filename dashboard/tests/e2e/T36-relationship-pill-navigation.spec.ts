import { test, expect } from "@playwright/test";
import {
  bringSwimlaneRowIntoView,
  waitForFleetReady,
} from "./_fixtures";

// T36 — Relationship pill navigation. Click on a child row's pill
// scrolls the parent row into view (and vice versa for parent →
// first-child). The handler uses the data-agent-id selector
// stamped on every SwimLane outermost wrapper.
test.use({ viewport: { width: 1280, height: 1800 } });

test.describe("T36 — Relationship pill navigation", () => {
  test("clicking a child's relationship pill moves the parent row into view", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForFleetReady(page);

    // Find the child row's pill. The CrewAI Researcher fixture
    // has a stable parent (e2e-test-crewai-parent), so the click
    // target is deterministic.
    const child = await bringSwimlaneRowIntoView(
      page,
      "e2e-test-crewai-researcher",
    );
    await expect(child).toBeVisible();
    await expect(child).toHaveAttribute("data-topology", "child");
    const pill = child.locator('[data-testid="swimlane-relationship-pill"]');
    await expect(pill).toBeVisible();
    await pill.click();

    // The click handler fires ``onScrollToAgent`` which invokes
    // scrollIntoView on the parent's [data-agent-id] node. After
    // the scroll, the parent's swimlane row should be in the
    // viewport (block: "center" keeps it mid-band).
    const parentRow = page.locator(
      '[data-testid="swimlane-agent-row-e2e-test-crewai-parent"]',
    );
    await expect(parentRow).toBeInViewport({ ratio: 0.1 });
  });

  test("clicking a parent's pill moves a child row into view", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForFleetReady(page);

    const parent = await bringSwimlaneRowIntoView(
      page,
      "e2e-test-crewai-parent",
    );
    const pill = parent.locator('[data-testid="swimlane-relationship-pill"]');
    await expect(pill).toHaveAttribute("data-mode", "parent");
    await pill.click();

    // The first-child target — onScrollToAgent fires
    // scrollToAgentRow(firstChildAgentId). For CrewAI the children
    // are Researcher + Writer; "first" here is whichever is first
    // in fleet store iteration order. Both candidates should be in
    // the viewport after click (the swimlane re-mounts whichever
    // hits the IntersectionObserver). Assert that AT LEAST one
    // child row is in view.
    // The first-child target is whichever child the fleet store
    // iterated to first. Either one passing the in-viewport check
    // satisfies the contract — assert at least one matches with
    // ``.first()`` so strict mode doesn't trip on the
    // either-or shape.
    const candidates = page
      .locator(
        '[data-testid="swimlane-agent-row-e2e-test-crewai-researcher"], [data-testid="swimlane-agent-row-e2e-test-crewai-writer"]',
      )
      .first();
    await expect(candidates).toBeInViewport({ ratio: 0.1 });
  });
});
