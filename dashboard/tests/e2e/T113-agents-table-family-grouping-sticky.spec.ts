import { test, expect, type Page } from "@playwright/test";

/**
 * T113 — /agents family grouping sticks under any sort column.
 *
 * Pre-fix the /agents table sorted every agent independently by
 * the active column, so a parent and its children scattered
 * whenever the column's per-row values diverged. The fix lives
 * at two layers:
 *
 *   1. ``sortAgentsWithFamilies`` in ``lib/agents-sort.ts``
 *      groups families by the root's sort key and renders
 *      children directly under their parent.
 *   2. ``resolveParents`` combines ``AgentSummary.recent_sessions``
 *      with ``useFleetStore.flavors`` so a busy parent that has
 *      spawned 5+ sessions since starting a sub-agent still
 *      resolves the linkage (the per-agent recent_sessions cap is
 *      5; the fleet flavors view carries the broader
 *      /v1/sessions window).
 *
 * T102 already locks family grouping under the default STATE
 * DESC sort and a single column-toggle (Last seen). T113 extends
 * the surface to STATUS DESC explicitly (the most common operator
 * default), AGENT name ASC (a textual column where children's
 * names typically diverge from the parent's), and TOKENS_7D DESC
 * (the column where a busy child would naively sort above its
 * idle parent).
 *
 * Fixture: the canonical seed at ``tests/e2e-fixtures/canonical.json``
 * supplies TWO parents each with TWO children, plus lone agents
 * — matching the brief's seed shape:
 *   * ``e2e-test-crewai-parent`` → ``e2e-test-crewai-researcher``
 *     + ``e2e-test-crewai-writer``
 *   * ``e2e-test-langgraph-parent`` → ``e2e-test-langgraph-research``
 *     + ``e2e-test-langgraph-writer``
 *
 * Theme-agnostic — assertions read DOM attributes
 * (``data-testid``, ``data-agent-id``, ``data-topology``,
 * ``data-agent-topology``) only. Runs under both Playwright theme
 * projects per Rule 40c.3.
 */

const FAMILIES: Array<{
  parent: string;
  children: string[];
}> = [
  {
    parent: "e2e-test-crewai-parent",
    children: ["e2e-test-crewai-researcher", "e2e-test-crewai-writer"],
  },
  {
    parent: "e2e-test-langgraph-parent",
    children: ["e2e-test-langgraph-research", "e2e-test-langgraph-writer"],
  },
];

/**
 * Walk the parent row's siblings and collect every immediately-
 * following row that carries ``data-topology="child"`` (the
 * rendering-layout-topology stamp set by ``AgentTableRow`` only
 * when the row's agent is in ``deriveFamilyDescendantSet``'s
 * output). Returns the ordered list of child agent_ids that
 * appear directly under the parent — empty when none, which by
 * the family-grouping contract means the family is broken.
 */
async function descendantAgentIdsBelow(
  page: Page,
  parentAgentName: string,
): Promise<string[]> {
  const parent = page
    .locator('[data-testid^="agent-row-"]')
    .filter({ hasText: parentAgentName })
    .first();
  await parent.scrollIntoViewIfNeeded();
  await expect(parent).toBeVisible({ timeout: 10_000 });
  return parent.evaluate((row) => {
    const ids: string[] = [];
    let cur = row.nextElementSibling;
    while (cur && cur.getAttribute("data-topology") === "child") {
      const id = cur.getAttribute("data-agent-id");
      if (id) ids.push(id);
      cur = cur.nextElementSibling;
    }
    return ids;
  });
}

/**
 * Resolve a seeded agent's runtime ``agent_id`` from its
 * ``agent_name``. The seed assigns deterministic agent_ids, but
 * we don't hard-code them here — the spec stays agnostic to UUID
 * format and just reads the row's stamped attribute.
 */
async function agentIdFromName(
  page: Page,
  agentName: string,
): Promise<string> {
  const row = page
    .locator('[data-testid^="agent-row-"]')
    .filter({ hasText: agentName })
    .first();
  await row.scrollIntoViewIfNeeded();
  await expect(row).toBeVisible({ timeout: 10_000 });
  const id = await row.getAttribute("data-agent-id");
  expect(id, `agent_id missing on row for ${agentName}`).toBeTruthy();
  return id!;
}

async function assertFamilyContiguous(
  page: Page,
  family: { parent: string; children: string[] },
): Promise<void> {
  const descendantIds = await descendantAgentIdsBelow(page, family.parent);
  const childIds = await Promise.all(
    family.children.map((name) => agentIdFromName(page, name)),
  );
  // EXACT count — no other rows interleave between parent and
  // its children.
  expect(
    descendantIds,
    `family ${family.parent} expected exactly ${family.children.length} descendants, ` +
      `got ${descendantIds.length} (${descendantIds.join(", ")})`,
  ).toHaveLength(family.children.length);
  // Child set membership — the order within a family depends on
  // the active sort column's per-child values; structural
  // membership (sorted) is the stable contract.
  expect([...descendantIds].sort()).toEqual([...childIds].sort());
}

test.describe("T113 — /agents family grouping sticks under any sort", () => {
  test("STATUS DESC: both seeded families stay contiguous under their parent", async ({
    page,
  }) => {
    await page.goto("/agents");
    // STATUS is the default sort; click once to make the
    // direction explicit (the test should not rely on default
    // state). The toggle on the active column flips ASC → DESC
    // or DESC → ASC; the default is DESC so a single click would
    // flip to ASC. To force DESC explicitly, click twice if the
    // current direction is ASC.
    const statusHead = page.locator('[data-testid="agent-table-th-state"]');
    await expect(statusHead).toBeVisible({ timeout: 10_000 });
    // Ensure DESC: poll the data-sort-direction attribute until
    // it reads "desc"; click the header up to twice to flip into
    // the right state (clicks beyond that are unnecessary because
    // the toggle has only two states once active).
    await expect
      .poll(
        async () => {
          const dir = await statusHead.getAttribute("data-sort-direction");
          if (dir === "desc") return "desc";
          await statusHead.click();
          return statusHead.getAttribute("data-sort-direction");
        },
        { timeout: 5_000 },
      )
      .toBe("desc");

    for (const family of FAMILIES) {
      await assertFamilyContiguous(page, family);
    }
  });

  test("AGENT name ASC: both seeded families stay contiguous under their parent", async ({
    page,
  }) => {
    await page.goto("/agents");
    const nameHead = page.locator('[data-testid="agent-table-th-agent_name"]');
    await expect(nameHead).toBeVisible({ timeout: 10_000 });
    // AGENT name defaults to ASC on first click (the column's
    // default direction is ASC per ``defaultDirection`` in
    // agents-sort.ts). Click once to activate ASC; if it's
    // already active under some prior state, the poll below
    // settles on ASC explicitly.
    await expect
      .poll(
        async () => {
          const active =
            (await nameHead.getAttribute("data-sort-active")) === "true";
          const dir = await nameHead.getAttribute("data-sort-direction");
          if (active && dir === "asc") return "asc";
          await nameHead.click();
          return nameHead.getAttribute("data-sort-direction");
        },
        { timeout: 5_000 },
      )
      .toBe("asc");

    for (const family of FAMILIES) {
      await assertFamilyContiguous(page, family);
    }
  });

  test("TOKENS_7D DESC: families stay contiguous even when a child has higher tokens than its parent", async ({
    page,
  }) => {
    await page.goto("/agents");
    const tokensHead = page.locator('[data-testid="agent-table-th-tokens_7d"]');
    await expect(tokensHead).toBeVisible({ timeout: 10_000 });
    // TOKENS_7D defaults to DESC on activation (numeric column).
    await expect
      .poll(
        async () => {
          const active =
            (await tokensHead.getAttribute("data-sort-active")) === "true";
          const dir = await tokensHead.getAttribute("data-sort-direction");
          if (active && dir === "desc") return "desc";
          await tokensHead.click();
          return tokensHead.getAttribute("data-sort-direction");
        },
        { timeout: 5_000 },
      )
      .toBe("desc");

    for (const family of FAMILIES) {
      await assertFamilyContiguous(page, family);
    }
  });

  test("parent rows DO NOT carry data-topology='child' under any sort", async ({
    page,
  }) => {
    // The ``data-topology="child"`` stamp is the rendering-layout
    // topology — only set on rows that render as a descendant of
    // a parent above them in the table. Parents themselves must
    // never carry it; if they did, a parent row would itself
    // pick up the 28-px indent rule and the visual hierarchy
    // would collapse. Asserted under STATUS DESC since that's
    // the page's default sort.
    await page.goto("/agents");
    for (const family of FAMILIES) {
      const parent = page
        .locator('[data-testid^="agent-row-"]')
        .filter({ hasText: family.parent })
        .first();
      await parent.scrollIntoViewIfNeeded();
      await expect(parent).toBeVisible({ timeout: 10_000 });
      await expect(parent).toHaveAttribute("data-agent-topology", "parent");
      expect(await parent.getAttribute("data-topology")).toBeNull();
    }
  });
});
