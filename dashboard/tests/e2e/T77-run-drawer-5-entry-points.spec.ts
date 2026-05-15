/**
 * T77 — the run drawer (SessionDrawer) opens from all five entry
 * points.
 *
 * Phase 4 contract — the run drawer is reachable from:
 *   1. a swimlane event circle (Fleet);
 *   2. a swimlane run-bracket glyph (Fleet);
 *   3. a row in the agent drawer's Runs tab;
 *   4. the "View entire run →" link in the event detail drawer;
 *   5. the run-badge column on the /events event table.
 *
 * Each entry point is asserted to mount `session-drawer`.
 * Theme-agnostic — structural locators only.
 */
import { test, expect } from "@playwright/test";
import {
  bringSwimlaneRowIntoView,
  CODING_AGENT,
  waitForFleetReady,
} from "./_fixtures";

test.use({ viewport: { width: 1280, height: 1800 } });

test.describe("T77 — run drawer opens from 5 entry points", () => {
  test("1: a swimlane event circle opens the run drawer", async ({ page }) => {
    await page.goto("/");
    await waitForFleetReady(page);
    await bringSwimlaneRowIntoView(page, CODING_AGENT.name);
    const circle = page.locator('[data-testid^="session-circle-"]').first();
    await expect(circle).toBeVisible({ timeout: 10_000 });
    await circle.click();
    await expect(page.locator('[data-testid="session-drawer"]')).toBeVisible({
      timeout: 10_000,
    });
  });

  test("2: a swimlane run-bracket glyph opens the run drawer", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForFleetReady(page);
    // Scope the bracket to the in-view row so it is on-screen and
    // not the sticky row label's first global match — the swimlane
    // re-renders on WebSocket pushes, so a global .first() can
    // resolve to an off-screen / label-occluded glyph.
    const row = await bringSwimlaneRowIntoView(page, CODING_AGENT.name);
    const bracket = row
      .locator('[data-testid^="swimlane-run-bracket-start-"]')
      .first();
    await expect(bracket).toBeVisible({ timeout: 10_000 });
    await bracket.click();
    await expect(page.locator('[data-testid="session-drawer"]')).toBeVisible({
      timeout: 10_000,
    });
  });

  test("3: an agent drawer Runs-tab row opens the run drawer", async ({
    page,
  }) => {
    await page.goto("/agents");
    const row = page
      .locator('[data-testid^="agent-row-"][data-agent-id]')
      .first();
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.click();
    await page.locator('[data-testid="agent-drawer-tab-runs"]').click();
    const runRow = page
      .locator('[data-testid^="agent-drawer-run-row-"]')
      .first();
    await expect(runRow).toBeVisible({ timeout: 10_000 });
    await runRow.click();
    await expect(page.locator('[data-testid="session-drawer"]')).toBeVisible({
      timeout: 10_000,
    });
  });

  test("4: the event drawer's View-entire-run link opens the run drawer", async ({
    page,
  }) => {
    await page.goto("/events");
    const firstRow = page.locator('[data-testid="events-row"]').first();
    await expect(firstRow).toBeVisible({ timeout: 10_000 });
    await firstRow.click();
    await expect(
      page.locator('[data-testid="event-detail-drawer"]'),
    ).toBeVisible();
    await page.locator('[data-testid="event-detail-view-run"]').click();
    await expect(page.locator('[data-testid="session-drawer"]')).toBeVisible({
      timeout: 10_000,
    });
  });

  test("5: the /events run badge opens the run drawer", async ({ page }) => {
    await page.goto("/events");
    await expect(
      page.locator('[data-testid="events-row"]').first(),
    ).toBeVisible({ timeout: 10_000 });
    await page
      .locator('[data-testid="events-row-run-badge"]')
      .first()
      .click();
    await expect(page.locator('[data-testid="session-drawer"]')).toBeVisible({
      timeout: 10_000,
    });
  });
});
