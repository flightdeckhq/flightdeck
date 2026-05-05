import { test, expect } from "@playwright/test";
import { waitForInvestigateReady } from "./_fixtures";

// T33 — Sub-agent Investigate facets. TOPOLOGY (Has sub-agents /
// Is sub-agent) + ROLE multi-select. ROLE + PARENT columns surface
// in the session table; click-to-filter on PARENT sets the URL
// filter and narrows the result set.
test.describe("T33 — Sub-agent Investigate facets", () => {
  test("TOPOLOGY facet renders both checkboxes and Is sub-agent filters", async ({
    page,
  }) => {
    await page.goto("/investigate");
    await waitForInvestigateReady(page);

    // The TOPOLOGY facet section is always visible per the
    // 7.fix.F contract — the user can widen the view by toggling
    // Has sub-agents on a result set with no visible sub-agents.
    const sidebar = page.locator('[data-testid="investigate-sidebar"]');
    await expect(sidebar).toContainText("TOPOLOGY");
    await expect(sidebar).toContainText("is_sub_agent");
    await expect(sidebar).toContainText("has_sub_agents");
  });

  test("ROLE facet lists distinct seeded roles", async ({ page }) => {
    // D126 UX revision 2026-05-03 — Investigate's default scope
    // hides pure children. The ROLE facet computed from the
    // visible result set is empty by default; sub-agent roles
    // populate it only once the user activates the "Is sub-agent"
    // override which flips the listing to children-only. Land on
    // the page with the override already on so the facet has
    // sub-agents to compute roles from.
    await page.goto("/investigate?is_sub_agent=true");
    await waitForInvestigateReady(page);
    const sidebar = page.locator('[data-testid="investigate-sidebar"]');
    await expect(sidebar).toContainText("ROLE");
    await expect(sidebar).toContainText("Researcher");
    await expect(sidebar).toContainText("Writer");
  });

  test("ROLE column + PARENT column render in the session table", async ({
    page,
  }) => {
    await page.goto("/investigate");
    await waitForInvestigateReady(page);
    // Headers exist on the sticky thead row regardless of which
    // sessions render; locking the column presence catches a
    // regression where the columns get accidentally dropped.
    await expect(
      page.locator('[data-testid="investigate-th-role"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="investigate-th-parent"]'),
    ).toBeVisible();
  });

  test("clicking a PARENT cell sets parent_session_id filter", async ({
    page,
  }) => {
    await page.goto("/investigate");
    await waitForInvestigateReady(page);
    // Find any session row whose PARENT cell carries a click
    // affordance (sub-agent rows have one; root rows render an
    // em-dash). The first such cell drives the filter assertion.
    // ``is_sub_agent=true`` query lifts the default scope so child
    // rows (the only ones whose PARENT cell carries a button)
    // surface in the table.
    await page.goto("/investigate?is_sub_agent=true");
    await waitForInvestigateReady(page);
    const parentCell = page
      .locator('[data-testid^="investigate-row-parent-"] button')
      .first();
    await expect(parentCell).toBeVisible();
    await parentCell.click();
    // URL gains parent_session_id after the click.
    await expect(page).toHaveURL(/parent_session_id=/);
    // Active-filter chip surfaces in the top bar. The
    // ``is_sub_agent=true`` chip from the page-load URL is also
    // present, so locate the parent pill specifically by its
    // ``parent:`` prefix rather than reading the first chip.
    const parentChip = page.locator(
      '[data-testid="active-filter-pill"][title^="parent:"]',
    );
    await expect(parentChip).toBeVisible();
  });

  // D126 UX revision step 11.fix.fix.fix — parent → expansion →
  // child rebind. The drawer follows the row click; the URL
  // persists the open session so a reload preserves it; the
  // parent's inline expansion stays open while the user inspects a
  // child. Crucially, the drawer's RENDERED CONTENT (the
  // session-metadata-bar's Agent field, the session_id at the
  // header, the events feed) must reflect the child's data — not
  // just the URL. The Block from manual Chrome step 11.fix.fix was
  // exactly this: URL flipped but drawer stayed showing the
  // parent's content. The assertions below pin the drawer's
  // rendered Agent field to the expected value at each step.
  //
  // Uses the canonical e2e-crewai-parent / e2e-crewai-researcher
  // fixture pair so the assertions read concrete agent names rather
  // than "first available pill" — the Supervisor reproduced the
  // Block specifically against this pair, and pinning the test to
  // it lets a future regression compare against the same workflow
  // they exercised manually.
  test("parent → child rebind syncs drawer's rendered Agent field with the URL", async ({
    page,
  }) => {
    await page.goto("/investigate");
    await waitForInvestigateReady(page);

    // Locate the parent row by its e2e-crewai-parent flavor text.
    const parentRow = page
      .locator("tr", { has: page.locator("text=e2e-crewai-parent") })
      .first();
    await expect(parentRow).toBeVisible();

    // Click the parent's SESSION cell (no buttons there, click
    // bubbles cleanly to the row's onClick handler).
    await parentRow
      .locator('[data-testid^="investigate-row-session-"]')
      .click();

    // Drawer opens with the parent's metadata.
    const drawer = page.locator('[data-testid="session-drawer"]').first();
    await expect(drawer).toBeVisible();
    await expect(
      drawer.locator('[data-testid="session-metadata-bar"]'),
    ).toContainText("e2e-crewai-parent");
    await expect(page).toHaveURL(/session=[a-f0-9-]+/);

    // Inline expansion materialises with the children.
    await expect(
      page.locator('[data-testid^="investigate-child-row-"]').first(),
    ).toBeAttached();

    // Locate the e2e-crewai-researcher child sub-row inside the
    // parent's expansion. The pure-child case (no descendants
    // anywhere else) means the locator is unambiguous.
    const researcherRow = page
      .locator('[data-testid^="investigate-child-row-"]', {
        has: page.locator("text=e2e-crewai-researcher"),
      })
      .first();
    await expect(researcherRow).toBeAttached();

    // Click the researcher row's SESSION cell. ``force: true``
    // because the AnimatePresence drawer mount briefly overlaps
    // the table during the slide-in animation.
    await researcherRow
      .locator('[data-testid^="investigate-row-session-"]')
      .click({ force: true });

    // URL flips to the child's session id.
    await expect(page).toHaveURL(/session=3f9d2b65/);
    // Expansion still open.
    await expect(
      page.locator('[data-testid^="investigate-child-row-"]').first(),
    ).toBeAttached();
    // Drawer rebinds — its rendered Agent field flips to the
    // researcher. Polling on the drawer's bar text ensures we
    // wait for both the AnimatePresence exit-animation completion
    // AND the new motion.div's content to settle.
    await expect.poll(async () => {
      const drawers = page.locator('[data-testid="session-drawer"]');
      const count = await drawers.count();
      if (count !== 1) return null;
      return await drawers
        .first()
        .locator('[data-testid="session-metadata-bar"]')
        .textContent();
    }).toContain("e2e-crewai-researcher");

    // Click the parent row again — drawer should rebind back to
    // the parent. Pins the round-trip behaviour.
    await parentRow
      .locator('[data-testid^="investigate-row-session-"]')
      .click({ force: true });
    await expect.poll(async () => {
      const drawers = page.locator('[data-testid="session-drawer"]');
      const count = await drawers.count();
      if (count !== 1) return null;
      return await drawers
        .first()
        .locator('[data-testid="session-metadata-bar"]')
        .textContent();
    }).toContain("e2e-crewai-parent");
    await expect(page).toHaveURL(/session=e69d1efb/);
  });

  // D126 UX revision 2026-05-04 — Issue 1: clicking a different
  // parent row collapses the previously-expanded parent's inline
  // children. Pre-fix the expandedParents Set accumulated, so
  // clicking parent A then parent B left BOTH expanded (5 inline
  // children where the active parent's pill said "→ 3").
  test("clicking a different parent collapses the previously-expanded parent's inline children", async ({
    page,
  }) => {
    await page.goto("/investigate");
    await waitForInvestigateReady(page);

    // The seeded fixture set has e2e-crewai-parent (2 children:
    // researcher + writer) and e2e-test-langgraph-parent (1
    // child: research_node) within the default 7-day window. Both
    // are parents-with-children so they render in the parents-
    // only default scope. Pre-fix click parent A then parent B
    // accumulated children in expandedParents Set. Post-fix B's
    // click resets the set to {B} only.
    const parentA = page
      .locator("tr", { has: page.locator("text=e2e-crewai-parent") })
      .first();
    // Match the existing crewai-parent locator's pattern — use
    // the visible FLAVOR string (column-rendered) rather than
    // the agent_name. ``e2e-langgraph-parent`` IS the flavor;
    // ``e2e-test-langgraph-parent`` is the agent_name and
    // appears in a different column.
    const parentB = page
      .locator("tr", { has: page.locator("text=e2e-langgraph-parent") })
      .first();
    await expect(parentA).toBeVisible();
    await expect(parentB).toBeVisible();

    // Expand parent A. Its researcher / writer children appear.
    await parentA
      .locator('[data-testid^="investigate-row-session-"]')
      .click();
    await expect(
      page.locator('[data-testid^="investigate-child-row-"]', {
        has: page.locator("text=e2e-crewai-researcher"),
      }),
    ).toBeAttached();

    // Click parent B. Force-click because the AnimatePresence
    // drawer mount briefly overlaps the table during slide-in.
    await parentB
      .locator('[data-testid^="investigate-row-session-"]')
      .click({ force: true });

    // After the swap, parent A's children must be GONE — assert
    // via the e2e-crewai-researcher child specifically (a known
    // child of parent A only). Poll until the swap settles
    // (React batches the expansion + drawer rebind across a few
    // frames).
    await expect
      .poll(async () => {
        return await page
          .locator('[data-testid^="investigate-child-row-"]', {
            has: page.locator("text=e2e-crewai-researcher"),
          })
          .count();
      })
      .toBe(0);
  });
});
