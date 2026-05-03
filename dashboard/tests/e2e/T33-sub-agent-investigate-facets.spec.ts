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

  // D126 UX revision step 11.fix.fix — parent → expansion → child
  // rebind. The drawer follows the row click; the URL persists the
  // open session so a reload preserves it; the parent's inline
  // expansion stays open while the user inspects a child.
  test("parent row click opens drawer + expands; child row click rebinds drawer + keeps expansion", async ({
    page,
  }) => {
    await page.goto("/investigate");
    await waitForInvestigateReady(page);

    // Locate the first parent (a row with the ``→ N`` pill).
    const parentPill = page
      .locator('[data-testid^="investigate-row-parent-pill-"]')
      .first();
    await expect(parentPill).toBeVisible();
    const parentPillTestid = await parentPill.getAttribute("data-testid");
    const parentSessionId = parentPillTestid!.replace(
      "investigate-row-parent-pill-",
      "",
    );

    // Click the parent's SESSION cell to open the drawer + trigger
    // expansion.
    await page
      .locator(`[data-testid="investigate-row-session-${parentSessionId}"]`)
      .click();
    await expect(page.locator('[data-testid="session-drawer"]').first())
      .toBeVisible();
    // URL now carries the parent's session id (reload-preservation).
    await expect(page).toHaveURL(new RegExp(`session=${parentSessionId}`));

    // Wait for the inline expansion's first child row.
    await expect(
      page.locator('[data-testid^="investigate-child-row-"]').first(),
    ).toBeAttached();
    const childTr = page
      .locator('[data-testid^="investigate-child-row-"]')
      .first();
    const childTestid = await childTr.getAttribute("data-testid");
    const childSessionId = childTestid!.replace("investigate-child-row-", "");

    // Click the child sub-row's SESSION cell — scoped to the
    // ``investigate-child-row-`` ancestor so we don't accidentally
    // hit the same session_id's standalone row (a depth-2 child
    // that itself has descendants surfaces in the default-scope
    // listing AS WELL AS in its parent's expansion). ``force:
    // true`` because the AnimatePresence drawer mount briefly
    // overlaps the table during the slide-in animation.
    await childTr
      .locator(`[data-testid="investigate-row-session-${childSessionId}"]`)
      .click({ force: true });

    // URL flips to the child's session id.
    await expect(page).toHaveURL(new RegExp(`session=${childSessionId}`));
    // Expansion still open: at least one child row still attached.
    await expect(
      page.locator('[data-testid^="investigate-child-row-"]').first(),
    ).toBeAttached();
    // Drawer's exit animation completes — only one drawer remains.
    await expect.poll(async () =>
      page.locator('[data-testid="session-drawer"]').count(),
    ).toBe(1);
  });
});
