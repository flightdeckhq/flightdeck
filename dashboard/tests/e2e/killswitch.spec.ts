import { test, expect } from "@playwright/test";

test("directives page mounts with no console errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  // Stub assertion: only fail on uncaught JS exceptions, not on
  // resource 404s (favicon, static assets) which are unrelated to
  // the auth wiring this stub is exercising. Real assertions land
  // in Phase 5 Part 2.

  await page.goto("/directives");
  await expect(page).toHaveTitle("Flightdeck");
  await page.waitForLoadState("networkidle");
  expect(errors, `unexpected console errors: ${errors.join("\n")}`).toEqual([]);
});
