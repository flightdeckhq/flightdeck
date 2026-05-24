import { test, expect } from "@playwright/test";

/**
 * T98 — Agent drawer header renders four rows in a fixed
 * vertical order: identity / status / action-links / sub-agents.
 *
 * Pre-fix the action links shared a row with the status badge
 * and topology cell, right-aligned via ``marginLeft: auto`` +
 * ``flexWrap``. A wide topology label or the presence of
 * sub-agent linkage badges would push the action links onto a
 * wrapping line — their position drifted between agents. The
 * polish restructures the header into four sibling rows so each
 * has its own container; the action links no longer share
 * geometry with anything that varies per agent.
 *
 * This spec opens the drawer for two contrasting fixtures and
 * locks the row ordering + the action-link row's vertical
 * position relative to the others. Theme-agnostic; runs under
 * both Playwright projects.
 */
test.describe("T98 — Agent drawer header fixed four-row layout", () => {
  test("action links render below status, regardless of sub-agent linkage", async ({
    page,
  }) => {
    await page.goto("/agents");
    await expect(
      page.locator('[data-testid^="agent-row-"]').first(),
    ).toBeVisible({ timeout: 10_000 });

    // Helper closure — opens the drawer for the row matching
    // ``agentName`` and asserts the four-row vertical contract.
    const assertHeaderOrder = async (
      agentName: string,
      opts: { expectSubagents: boolean },
    ) => {
      const row = page
        .locator('[data-testid^="agent-row-"]')
        .filter({ hasText: agentName })
        .first();
      await row.scrollIntoViewIfNeeded();
      await expect(row).toBeVisible();
      await row.click();

      const drawer = page.locator('[data-testid="agent-drawer"]');
      await expect(drawer).toBeVisible({ timeout: 10_000 });

      const identity = drawer.locator(
        '[data-testid="agent-drawer-header-identity"]',
      );
      const status = drawer.locator(
        '[data-testid="agent-drawer-header-status"]',
      );
      const actions = drawer.locator(
        '[data-testid="agent-drawer-header-actions"]',
      );
      await expect(identity).toBeVisible();
      await expect(status).toBeVisible();
      await expect(actions).toBeVisible();

      const identityBox = await identity.boundingBox();
      const statusBox = await status.boundingBox();
      const actionsBox = await actions.boundingBox();
      expect(identityBox).not.toBeNull();
      expect(statusBox).not.toBeNull();
      expect(actionsBox).not.toBeNull();
      // Strict vertical ordering: identity above status above
      // actions. Sub-agent linkage row, when present, lives
      // strictly below the action row.
      expect(identityBox!.y).toBeLessThan(statusBox!.y);
      expect(statusBox!.y).toBeLessThan(actionsBox!.y);

      const subagents = drawer.locator(
        '[data-testid="agent-drawer-header-subagents"]',
      );
      if (opts.expectSubagents) {
        await expect(subagents).toBeVisible();
        const subagentsBox = await subagents.boundingBox();
        expect(subagentsBox).not.toBeNull();
        expect(actionsBox!.y).toBeLessThan(subagentsBox!.y);
      } else {
        await expect(subagents).toHaveCount(0);
      }

      // Action-link row contents are stable regardless of the
      // sub-agent row's presence.
      await expect(
        actions.locator('[data-testid="agent-drawer-open-swimlane"]'),
      ).toBeVisible();
      await expect(
        actions.locator('[data-testid="agent-drawer-open-in-events"]'),
      ).toBeVisible();

      // Close the drawer for the next iteration.
      await drawer.locator('[data-testid="agent-drawer-close"]').click();
      await expect(drawer).toHaveCount(0);
    };

    // Fixture with sub-agent linkage — the crewai parent has two
    // seeded children, exercising the four-row case.
    await assertHeaderOrder("e2e-test-crewai-parent", {
      expectSubagents: true,
    });

    // Fixture without sub-agent linkage — the ancient-only agent
    // is a lone fixture; the sub-agent row must be absent and
    // the action-link row's vertical position must be unchanged
    // relative to its sibling rows above.
    await assertHeaderOrder("e2e-test-ancient-agent", {
      expectSubagents: false,
    });
  });
});
