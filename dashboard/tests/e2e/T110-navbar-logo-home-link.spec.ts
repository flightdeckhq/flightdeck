/**
 * T110 — navbar lockup is visible, links to Fleet, and the
 * document head carries a favicon link.
 *
 * Runs under both Playwright theme projects so per-theme parity
 * is locked (Rule 40c.3); assertions are structural only — the
 * lockup img src CHOICE between dark/light is unit-tested
 * (src/__tests__/Nav.test.tsx); here we only assert the link,
 * visibility, navigation, and head wiring.
 */
import { test, expect } from "@playwright/test";

test.describe("T110 — navbar lockup + favicon", () => {
  test("lockup is visible and clicking it lands on Fleet", async ({ page }) => {
    await page.goto("/agents");
    const lockup = page.getByTestId("nav-lockup");
    await expect(lockup).toBeVisible();
    // Wrapped in a link to "/" — the brand-to-home convention.
    const link = page.getByTestId("nav-lockup-link");
    await expect(link).toHaveAttribute("href", "/");
    await link.click();
    await expect(page).toHaveURL(/\/$/);
    // Fleet anchor remains in the nav (mount signal that the
    // route loaded, not just that the URL changed).
    await expect(page.locator('nav a:has-text("Fleet")')).toBeVisible();
  });

  test("document head exposes a favicon link", async ({ page }) => {
    await page.goto("/");
    // A rel="icon" link is in <head>. The href ("/assets/favicon-*.png")
    // is verified separately by the asset-cache CI smoke; here we just
    // lock that index.html ships the tag at all.
    const iconHref = await page
      .locator('head link[rel="icon"]')
      .first()
      .getAttribute("href");
    expect(iconHref).toBeTruthy();
    expect(iconHref).toMatch(/favicon/);
  });
});
