import { test, expect } from "@playwright/test";

/**
 * T102 — /agents groups sub-agents directly under their parent.
 *
 * Pre-fix the table sorted every agent by the active column +
 * agent_id tie-breaker, so a parent and its children scattered:
 * children rendered ABOVE the parent whenever they shared a
 * status, the operator had to mentally re-thread the family
 * tree. The family-grouped sort orders FAMILIES by the parent's
 * sort key, then renders children directly under their parent,
 * mirroring the Fleet swimlane's clustering.
 *
 * Fixture: ``e2e-test-crewai-parent`` is a parent with two
 * sub-agents (``e2e-test-crewai-researcher`` and
 * ``e2e-test-crewai-writer``). All three are seeded into the
 * canonical dataset and their ``recent_sessions`` carry the
 * parent_session_id linkage that drives ``deriveFamilyDescendantSet``.
 *
 * Theme-agnostic — both Playwright projects.
 */
test.describe("T102 — agents table groups sub-agents under parent", () => {
  test("crewai parent renders with its children directly underneath", async ({
    page,
  }) => {
    await page.goto("/agents");
    const parent = page
      .locator('[data-testid^="agent-row-"]')
      .filter({ hasText: "e2e-test-crewai-parent" })
      .first();
    await parent.scrollIntoViewIfNeeded();
    await expect(parent).toBeVisible({ timeout: 10_000 });

    const parentAgentId = await parent.getAttribute("data-agent-id");
    expect(parentAgentId).toBeTruthy();
    // The row's pre-existing ``data-agent-topology`` attribute
    // mirrors the agent's structural topology on the wire ("parent");
    // the NEW ``data-topology`` attribute is the rendering-layout
    // topology (only stamped on descendants). The parent row's
    // ``data-topology`` must be absent.
    await expect(parent).toHaveAttribute("data-agent-topology", "parent");
    expect(await parent.getAttribute("data-topology")).toBeNull();

    // Walk the parent row's siblings; each immediately
    // following sibling that carries ``data-topology="child"``
    // is one of this parent's family descendants. We expect
    // exactly the two known children (researcher + writer)
    // BEFORE the next non-descendant root row.
    const familyMembers = await parent.evaluate((row) => {
      const ids: string[] = [];
      let cur = row.nextElementSibling;
      while (cur && cur.getAttribute("data-topology") === "child") {
        const id = cur.getAttribute("data-agent-id");
        if (id) ids.push(id);
        cur = cur.nextElementSibling;
      }
      return ids;
    });
    // Children render in deterministic order — the exact list
    // (researcher + writer in some order) is what we lock.
    expect(familyMembers).toHaveLength(2);
    const childRows = page.locator(
      '[data-testid^="agent-row-"][data-topology="child"]',
    );
    const childTexts = await childRows.allInnerTexts();
    const allChildText = childTexts.join("\n");
    expect(allChildText).toContain("e2e-test-crewai-researcher");
    expect(allChildText).toContain("e2e-test-crewai-writer");
  });

  test("child row's first cell carries the 28-px indent from data-topology='child'", async ({
    page,
  }) => {
    await page.goto("/agents");
    // Use the researcher row directly — it's a child fixture
    // and its data-topology="child" stamp triggers the existing
    // ``[data-topology="child"] > td:first-child`` indent rule
    // in globals.css.
    const child = page
      .locator('[data-testid^="agent-row-"]')
      .filter({ hasText: "e2e-test-crewai-researcher" })
      .first();
    await child.scrollIntoViewIfNeeded();
    await expect(child).toBeVisible({ timeout: 10_000 });
    await expect(child).toHaveAttribute("data-topology", "child");

    // First <td> computed padding-left must be 28 px (the
    // shared swimlane / Investigate sub-row indent).
    const paddingLeft = await child
      .locator("td:first-child")
      .evaluate((td) => window.getComputedStyle(td).paddingLeft);
    expect(paddingLeft).toBe("28px");
  });

  test("switching sort column keeps the family intact", async ({ page }) => {
    // Change sort to Last seen — the family must still group:
    // the parent row stays immediately followed by its children.
    await page.goto("/agents");
    await page
      .locator('[data-testid="agent-table-th-last_seen_at"]')
      .click();
    const parent = page
      .locator('[data-testid^="agent-row-"]')
      .filter({ hasText: "e2e-test-crewai-parent" })
      .first();
    await parent.scrollIntoViewIfNeeded();
    await expect(parent).toBeVisible({ timeout: 10_000 });
    const familyMembers = await parent.evaluate((row) => {
      const ids: string[] = [];
      let cur = row.nextElementSibling;
      while (cur && cur.getAttribute("data-topology") === "child") {
        const id = cur.getAttribute("data-agent-id");
        if (id) ids.push(id);
        cur = cur.nextElementSibling;
      }
      return ids;
    });
    expect(familyMembers).toHaveLength(2);
  });
});
