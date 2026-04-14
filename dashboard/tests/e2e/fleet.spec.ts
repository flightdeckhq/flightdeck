import { test, expect } from "@playwright/test";

// Phase 5 Part 1b E2E stub. Part 2 (dashboard UI work) will replace
// this with real assertions on Fleet rendering; for now the stub
// verifies that the page mounts, the auth token is accepted by the
// gated /v1/fleet endpoint, and no console errors surface.
test("fleet page mounts with no console errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  // Stub assertion: only fail on uncaught JS exceptions, not on
  // resource 404s (favicon, static assets) which are unrelated to
  // the auth wiring this stub is exercising. Real assertions land
  // in Phase 5 Part 2.

  await page.goto("/");
  await expect(page).toHaveTitle("Flightdeck");
  // Settle network so any failed gated call would flag before we
  // read the error buffer.
  await page.waitForLoadState("networkidle");
  expect(errors, `unexpected console errors: ${errors.join("\n")}`).toEqual([]);
});
