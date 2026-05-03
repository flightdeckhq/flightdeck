import { test, expect } from "@playwright/test";

// T37 — Fleet AgentTable ROLE + TOPOLOGY columns. The TABLE view
// (Fleet ?view=table) renders one row per agent with the ROLE
// column showing the agent_role pill on sub-agents and the
// TOPOLOGY column showing the relationship label (⤴ spawns N for
// parents, ↳ child of {name} for children, lone for unrelated).
test.describe("T37 — Fleet table ROLE + TOPOLOGY columns", () => {
  test("ROLE column surfaces seeded sub-agent roles", async ({ page }) => {
    await page.goto("/?view=table");
    await page.waitForSelector('[data-testid^="fleet-agent-row-"]');

    // Researcher fixture row carries ROLE=Researcher.
    const allRows = page.locator('[data-testid^="fleet-agent-row-"]');
    // Walk every visible row and assert at least one carries the
    // expected role text. The table view paginates at 50 rows
    // per page; the seeded fixtures fit in page 1 on a clean DB.
    const visibleText = await allRows.allInnerTexts();
    const hasResearcher = visibleText.some((t) => t.includes("Researcher"));
    const hasWriter = visibleText.some((t) => t.includes("Writer"));
    expect(hasResearcher).toBe(true);
    expect(hasWriter).toBe(true);
  });

  test("TOPOLOGY parent renders ⤴ spawns N", async ({ page }) => {
    await page.goto("/?view=table");
    await page.waitForSelector('[data-testid^="fleet-agent-row-"]');
    // Walk all parent-mode TopologyCells; at least the CrewAI
    // parent fixture should produce a "⤴ spawns" label with a
    // count >= 1.
    const parentPills = page.locator(
      '[data-testid^="agent-table-topology-pill-parent-"]',
    );
    await expect(parentPills.first()).toBeVisible();
    await expect(parentPills.first()).toContainText("⤴");
    await expect(parentPills.first()).toContainText("spawns");
  });

  test("TOPOLOGY child renders ↳ child of <parent_name>", async ({ page }) => {
    await page.goto("/?view=table");
    await page.waitForSelector('[data-testid^="fleet-agent-row-"]');
    const childPills = page.locator(
      '[data-testid^="agent-table-topology-pill-child-"]',
    );
    await expect(childPills.first()).toBeVisible();
    await expect(childPills.first()).toContainText("↳");
    await expect(childPills.first()).toContainText("child of");
  });

  test("agent_name column sort still works after the new column additions", async ({
    page,
  }) => {
    await page.goto("/?view=table");
    await page.waitForSelector('[data-testid^="fleet-agent-row-"]');
    // Click the Agent header to drive an ASC sort. The header's
    // testid is stable across releases (validated by
    // tests/unit/AgentTable-sort.test.tsx). The two new columns
    // (ROLE / TOPOLOGY) are intentionally NOT sortable and the
    // existing sort behaviour must keep working through them.
    const header = page.locator('[data-testid="agent-table-header-agent_name"]');
    await header.click();
    await expect(header).toHaveAttribute("aria-sort", /ascending|descending/);
  });
});
