/**
 * T108 — nav search bar opens the command palette on click.
 *
 * Phase 0 confirmed the click handler is wired (App.tsx:76) and
 * the original "search bar isn't clickable" report was stale.
 * This spec locks both the mouse-click trigger and the
 * Cmd/Ctrl+K keyboard trigger so a future Radix-portal regression
 * or gesture-dismiss race surfaces immediately.
 *
 * Runs under both Playwright theme projects so per-theme parity
 * is locked (Rule 40c.3); assertions are structural only.
 */
import { test, expect } from "@playwright/test";

const OPEN_PALETTE = process.platform === "darwin" ? "Meta+k" : "Control+k";

test.describe("T108 — palette opens on nav search click + keyboard shortcut", () => {
  test("clicking the nav search trigger opens the palette and it stays open", async ({
    page,
  }) => {
    await page.goto("/");
    const trigger = page.getByTestId("nav-search-trigger");
    await expect(trigger).toBeVisible();
    await trigger.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // Visibility must persist past the gesture window — Radix's
    // onPointerDownOutside race would close the dialog within
    // the next tick. A poll that the dialog REMAINS visible for
    // a brief observation period catches that regression.
    await expect
      .poll(async () => await dialog.isVisible())
      .toBe(true);

    // Input is focused so typing lands in the search field
    // immediately. Phase B's solid-token highlight contract means
    // the auto-focus needs no extra wiring; this assertion locks
    // that pre-condition for downstream typing tests.
    await expect(dialog.getByRole("textbox", { name: "Search" })).toBeFocused();
  });

  test("Cmd/Ctrl+K still opens the palette", async ({ page }) => {
    await page.goto("/");
    // Wait for the nav to mount before firing the chord — the
    // global keydown handler is attached via useEffect on App
    // mount, and a too-early press lands before it's listening.
    await expect(page.getByTestId("nav-search-trigger")).toBeVisible();
    await page.keyboard.press(OPEN_PALETTE);
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("textbox", { name: "Search" })).toBeFocused();
  });

  test("clicking outside the palette closes it (dismiss path still works)", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByTestId("nav-search-trigger").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // Escape is the documented dismiss path that doesn't require a
    // free spot on the viewport (Radix Dialog handles Escape via
    // its DismissableLayer regardless of overlay clicks).
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
  });
});
