import { test, expect } from "@playwright/test";
import { waitForInvestigateReady } from "./_fixtures";

// T23 — Investigate left sidebar resize. Drag handle widens the
// sidebar; localStorage persists the width across page reload.
// Both themes — the resize plumbing must not depend on theme.
test.describe("T23 — Investigate sidebar is resizable + persists", () => {
  test("drag handle widens the sidebar and width survives reload", async ({
    page,
  }) => {
    await page.goto("/investigate");
    await waitForInvestigateReady(page);
    // Clear any prior persisted width AFTER the initial mount so
    // this test starts at the default width. Using page.evaluate()
    // (not addInitScript) so the clear runs once and the reload
    // mid-test reads the value persisted by the drag, not a fresh
    // empty localStorage.
    await page.evaluate(() =>
      localStorage.removeItem("flightdeck.investigate.sidebarWidth"),
    );
    await page.reload();
    await waitForInvestigateReady(page);

    const sidebar = page.locator('[data-testid="investigate-sidebar"]');
    const handle = page.locator(
      '[data-testid="investigate-sidebar-resize-handle"]',
    );
    await expect(sidebar).toBeVisible();
    await expect(handle).toBeVisible();

    const initialBox = await sidebar.boundingBox();
    expect(initialBox).not.toBeNull();
    const initialWidth = initialBox!.width;

    // Drag the handle 120 px to the right to widen the sidebar.
    // Use mouse.move(...) + mouse.down/up so the move-listener
    // attached on document fires (page.dragTo wouldn't reliably
    // hit the document-level mousemove the handler binds).
    const handleBox = await handle.boundingBox();
    expect(handleBox).not.toBeNull();
    const startX = handleBox!.x + handleBox!.width / 2;
    const startY = handleBox!.y + handleBox!.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 120, startY, { steps: 10 });
    await page.mouse.up();

    const widenedBox = await sidebar.boundingBox();
    expect(widenedBox).not.toBeNull();
    expect(widenedBox!.width).toBeGreaterThan(initialWidth + 80);

    // Read the persisted width directly so the test confirms the
    // localStorage round-trip rather than relying on visual
    // re-measurement after reload.
    const persisted = await page.evaluate(() =>
      localStorage.getItem("flightdeck.investigate.sidebarWidth"),
    );
    expect(persisted).not.toBeNull();
    const persistedNum = parseInt(persisted!, 10);
    expect(persistedNum).toBeGreaterThan(initialWidth + 80);

    // Reload and confirm the sidebar comes back at the persisted
    // width, not the default. The reload re-runs the lazy useState
    // initialiser which calls readPersistedInvestigateSidebarWidth.
    await page.reload();
    await waitForInvestigateReady(page);
    const reloadedBox = await sidebar.boundingBox();
    expect(reloadedBox).not.toBeNull();
    // Allow small rounding when comparing across a reload.
    expect(Math.abs(reloadedBox!.width - persistedNum)).toBeLessThan(4);
  });

  test("sidebar cannot be dragged below MIN_WIDTH (180)", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.removeItem("flightdeck.investigate.sidebarWidth");
    });
    await page.goto("/investigate");
    await waitForInvestigateReady(page);

    const sidebar = page.locator('[data-testid="investigate-sidebar"]');
    const handle = page.locator(
      '[data-testid="investigate-sidebar-resize-handle"]',
    );
    const handleBox = await handle.boundingBox();
    expect(handleBox).not.toBeNull();
    const startX = handleBox!.x + handleBox!.width / 2;
    const startY = handleBox!.y + handleBox!.height / 2;
    // Drag far to the left — way below any reasonable floor.
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX - 600, startY, { steps: 10 });
    await page.mouse.up();

    const finalBox = await sidebar.boundingBox();
    expect(finalBox).not.toBeNull();
    // The clamp should pin the sidebar at or above 180.
    expect(finalBox!.width).toBeGreaterThanOrEqual(180);
  });
});
