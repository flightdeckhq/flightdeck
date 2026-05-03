import { test, expect } from "@playwright/test";
import {
  bringSwimlaneRowIntoView,
  waitForFleetReady,
} from "./_fixtures";

// T30 — LangGraph multi-node rendering. Two named agent-bearing
// nodes (research_node + writer_node) under one runner parent.
// Each node renders as its own swimlane row with the node-name as
// the role; the parent fans out to both via "→ 2".
test.use({ viewport: { width: 1280, height: 1800 } });

test.describe("T30 — LangGraph multi-node rendering", () => {
  test("research_node and writer_node render as distinct agent rows under the runner parent", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForFleetReady(page);

    const research = await bringSwimlaneRowIntoView(
      page,
      "e2e-test-langgraph-research",
    );
    await expect(research).toBeVisible();
    const researchPill = research.locator(
      '[data-testid="swimlane-relationship-pill"]',
    );
    await expect(researchPill).toHaveAttribute("data-mode", "child");
    await expect(researchPill).toContainText("e2e-test-langgraph-parent");

    const writer = await bringSwimlaneRowIntoView(
      page,
      "e2e-test-langgraph-writer",
    );
    await expect(writer).toBeVisible();
    const writerPill = writer.locator(
      '[data-testid="swimlane-relationship-pill"]',
    );
    await expect(writerPill).toHaveAttribute("data-mode", "child");

    // The runner parent's relationship pill counts both nodes.
    // Distinct agent_ids per D126 § 2 because agent_role joins
    // the 6-tuple input — the count therefore reflects distinct
    // logical agents, not raw session count.
    const parent = await bringSwimlaneRowIntoView(
      page,
      "e2e-test-langgraph-parent",
    );
    const parentPill = parent.locator(
      '[data-testid="swimlane-relationship-pill"]',
    );
    await expect(parentPill).toHaveAttribute("data-mode", "parent");
    await expect(parentPill).toContainText("→");
    await expect(parentPill).toContainText("2");
  });
});
