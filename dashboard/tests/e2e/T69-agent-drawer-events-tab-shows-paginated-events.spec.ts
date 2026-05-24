/**
 * T69 — the agent drawer's Events tab populates with the agent's
 * events.
 *
 * Phase 4 contract: the Events tab is the default tab; it lists
 * the agent's events newest-first, backed by
 * `GET /v1/events?agent_id=`. Each row carries a run badge.
 *
 * Theme-agnostic — structural locators only.
 */
import { test, expect } from "@playwright/test";

test.describe("T69 — agent drawer Events tab", () => {
  test("the Events tab lists the agent's events with run badges", async ({
    page,
  }) => {
    await page.goto("/agents");
    const firstRow = page
      .locator('[data-testid^="agent-row-"][data-agent-id]')
      .first();
    await expect(firstRow).toBeVisible({ timeout: 10_000 });
    await firstRow.click();

    await expect(page.locator('[data-testid="agent-drawer"]')).toBeVisible();
    // Events is the default tab.
    await expect(
      page.locator('[data-testid="agent-drawer-events-tab"]'),
    ).toBeVisible();

    // Every canonical /agents agent has at least one session, so the
    // agent-scoped event query returns rows.
    await expect
      .poll(
        async () =>
          page.locator('[data-testid="agent-drawer-event-row"]').count(),
        { timeout: 10_000 },
      )
      .toBeGreaterThan(0);

    // Each row carries a run badge that deep-links to the run.
    await expect(
      page.locator('[data-testid="agent-drawer-event-run-badge"]').first(),
    ).toBeVisible();
  });
});
