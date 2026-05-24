import { test, expect } from "@playwright/test";

/**
 * T101 — Agent drawer header redesign.
 *
 * Item A turns the four-row header into a clearer-to-read layout:
 *
 *   Row 1 — identity + close × (unchanged structure).
 *   Row 2 — status DOT + label + topology DESCRIPTOR (no agent
 *           names; plain muted text, NOT link-styled).
 *   Row 3 — bordered icon + label BUTTONS for swimlane / events.
 *   Row 4 — labelled PARENT and SUB-AGENTS sections (one or both,
 *           never duplicating the descriptor in row 2).
 *
 * The anti-duplication contract is the key behavioural change:
 * row 2 describes the topology shape (``sub-agent`` /
 * ``spawns N`` / both), row 4 names the linked agents. The two
 * never overlap. Row-ordering regression is covered by T98; T101
 * locks the content semantics + button affordance.
 *
 * Theme-agnostic — runs under both Playwright projects.
 */
test.describe("T101 — Agent drawer header redesign", () => {
  test("parent row 2 reads 'spawns N', row 4 shows SUB-AGENTS section only", async ({
    page,
  }) => {
    await page.goto("/agents");
    const row = page
      .locator('[data-testid^="agent-row-"]')
      .filter({ hasText: "e2e-test-crewai-parent" })
      .first();
    await row.scrollIntoViewIfNeeded();
    await row.click();

    const drawer = page.locator('[data-testid="agent-drawer"]');
    await expect(drawer).toBeVisible({ timeout: 10_000 });

    // Row 2 — descriptor is name-free.
    const descriptor = drawer.locator(
      '[data-testid="agent-drawer-topology-descriptor"]',
    );
    await expect(descriptor).toBeVisible();
    await expect(descriptor).toHaveText(/spawns \d+/);
    // No agent names leak into the descriptor.
    await expect(descriptor).not.toHaveText(/crewai|researcher|writer/i);

    // Row 4 — SUB-AGENTS section present, PARENT section absent.
    await expect(
      drawer.locator(
        '[data-testid="agent-drawer-linkage-children-section"]',
      ),
    ).toBeVisible();
    await expect(
      drawer.locator(
        '[data-testid="agent-drawer-linkage-parent-section"]',
      ),
    ).toHaveCount(0);
  });

  test("child row 2 reads 'sub-agent' without the parent name; row 4 shows PARENT section only", async ({
    page,
  }) => {
    // First land on /agents so the fleet store is populated +
    // the AgentDrawerHost is mounted at the app level. Then
    // read the child fixture's agent_id off its row attribute
    // and open the drawer via the ``?agent_drawer=`` URL param
    // — avoids the row-below-fold flake where the row needs
    // scroll-into-view + a stable click target.
    await page.goto("/agents");
    const row = page
      .locator('[data-testid^="agent-row-"]')
      .filter({ hasText: "e2e-test-crewai-researcher" })
      .first();
    await row.scrollIntoViewIfNeeded();
    await expect(row).toBeVisible({ timeout: 10_000 });
    const agentId = await row.getAttribute("data-agent-id");
    expect(agentId).toBeTruthy();
    await page.goto(`/agents?agent_drawer=${encodeURIComponent(agentId!)}`);

    const drawer = page.locator('[data-testid="agent-drawer"]');
    await expect(drawer).toBeVisible({ timeout: 10_000 });

    const descriptor = drawer.locator(
      '[data-testid="agent-drawer-topology-descriptor"]',
    );
    await expect(descriptor).toBeVisible();
    await expect(descriptor).toHaveText("sub-agent");

    // PARENT section is the only linkage cluster. The parent
    // name lives exclusively in the pill, never in row 2.
    await expect(
      drawer.locator(
        '[data-testid="agent-drawer-linkage-parent-section"]',
      ),
    ).toBeVisible();
    await expect(
      drawer.locator(
        '[data-testid="agent-drawer-linkage-children-section"]',
      ),
    ).toHaveCount(0);
    await expect(
      drawer.locator('[data-testid="agent-drawer-parent-pill"]'),
    ).toContainText("crewai-parent");
  });

  test("action buttons are bordered, not bare text", async ({ page }) => {
    await page.goto("/agents");
    const row = page.locator('[data-testid^="agent-row-"]').first();
    await row.scrollIntoViewIfNeeded();
    await row.click();

    const drawer = page.locator('[data-testid="agent-drawer"]');
    await expect(drawer).toBeVisible({ timeout: 10_000 });

    for (const tid of [
      "agent-drawer-open-swimlane",
      "agent-drawer-open-in-events",
    ]) {
      const el = drawer.locator(`[data-testid="${tid}"]`);
      await expect(el).toBeVisible();
      // The pre-fix style had ``border: none``; the new style
      // applies ``1px solid var(--border)``. Computed
      // ``border-top-width`` is ``1px`` for the new style and
      // ``0px`` for the old.
      const borderWidth = await el.evaluate(
        (node) => window.getComputedStyle(node as Element).borderTopWidth,
      );
      expect(borderWidth).toBe("1px");
    }
  });
});
