import { test, expect } from "@playwright/test";

// T10 — every top-level page mounts, renders its title, and logs
// zero uncaught JS errors. Replaces the four Phase-5 Part-1b stub
// specs (analytics / fleet / killswitch / search) which were
// page-mount smoke tests each in their own file. Consolidating
// them into one dual-theme spec is cheaper at CI time (5 visits
// per theme instead of 5 full test setups) and removes the file-
// name-vs-URL mismatch that the prior stubs carried
// (killswitch.spec.ts hit /directives, search.spec.ts hit
// /investigate).
const PAGES: { name: string; path: string }[] = [
  { name: "Fleet", path: "/" },
  { name: "Investigate", path: "/investigate" },
  { name: "Analytics", path: "/analytics" },
  { name: "Directives", path: "/directives" },
  { name: "Policies", path: "/policies" },
  { name: "Settings", path: "/settings" },
];

test.describe("T10 — whole-dashboard smoke", () => {
  for (const { name, path } of PAGES) {
    test(`${name} (${path}) mounts with no console errors`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (err) => errors.push(err.message));

      await page.goto(path);
      await expect(page).toHaveTitle("Flightdeck");
      // Settle the auth-gated XHRs so any failed gated call surfaces
      // as a pageerror before we read the buffer. networkidle is
      // noisier than needed here but matches the prior stub's
      // behaviour — swap to a dashboard-ready signal if the
      // Phase-3 team sees flake under this.
      await page.waitForLoadState("networkidle");
      expect(
        errors,
        `unexpected console errors on ${path}: ${errors.join("\n")}`,
      ).toEqual([]);
    });
  }
});
