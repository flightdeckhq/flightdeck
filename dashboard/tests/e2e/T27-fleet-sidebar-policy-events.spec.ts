import { test, expect } from "@playwright/test";
import { waitForFleetReady } from "./_fixtures";

// T27 — Fleet sidebar POLICY EVENTS panel. Pre-PR #30 the sidebar
// rendered an unconditional "No policy events yet." stub even though
// policy_warn / policy_block / policy_degrade events flow through the
// live feed and through every other Flightdeck surface (swimlane
// badge, Investigate POLICY facet, drawer detail row). This spec
// covers the single user journey the wiring exists for: a fleet with
// recent policy events surfaces them in the sidebar.
//
// Canonical fixture context: tests/e2e-fixtures/canonical.json
// declares the ``policy-active`` role on the coding agent. The
// seeder's post-fleet-visibility re-emit branch (seed.py
// ``role == "policy-active"``) fires one each of policy_warn /
// policy_degrade / policy_block at NOW-30s / -20s / -10s every
// invocation. The spec switches to the ``1h`` time range so
// feedEvents covers those events with a 5+ minute margin — robust to
// the Rule 40c.1 twice-in-a-row run cadence (default 5m would age
// out between the two runs; 1h doesn't).
//
// The empty-state inverse is covered at the FleetPanel boundary by
// the unit test in dashboard/tests/unit/FleetPanel.test.tsx, so this
// spec stays a single-assertion journey.
//
// Theme-agnostic per Rule 40c.3 -- selectors are testids only, no
// computed colours, no theme-specific class names. Runs under both
// neon-dark and clean-light Playwright projects.
test.describe("T27 — Fleet sidebar Policy Events panel", () => {
  test("header + rows render once feedEvents include policy events", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForFleetReady(page);

    // Switch to the 1-hour time range so useHistoricalEvents pulls
    // the canonical policy-active session's enforcement events into
    // feedEvents with a generous safety margin. The seeder re-emits
    // those events at NOW-30/-20/-10s on every seed run, so even the
    // Rule 40c.1 second sequential run (typically ~5 minutes after
    // the first) finds them well inside the window. The buttons live
    // in the Fleet header strip (Fleet.tsx :: TIME_RANGES) and have
    // no testid, so we anchor on the literal label.
    await page.getByRole("button", { name: "1h" }).click();

    // Header surfaces.
    const header = page.locator('[data-testid="policy-events-header"]');
    await expect(
      header,
      "POLICY EVENTS header must render once feedEvents contain policy_warn / policy_block / policy_degrade",
    ).toBeVisible();

    // At least one row whose top line carries the deterministic
    // getEventDetail string. The regex covers all three enforcement
    // detail variants -- which one the panel surfaces first is a
    // function of seed-time event ordering, but at least one will be
    // present given the canonical fixture seeds all three. ``.first()``
    // keeps the assertion compatible with stacked re-emits (each
    // ``make seed-e2e`` invocation appends a fresh trio): Playwright
    // strict mode rejects multi-element matches on ``.toBeVisible()``,
    // and the panel intentionally surfaces the most-recent five.
    const sidebar = page.locator('[data-testid="fleet-sidebar"]');
    await expect(
      sidebar.getByText(/warn at \d+%|degraded from|blocked at/).first(),
      "POLICY EVENTS panel must render at least one row with a getEventDetail-shaped top line",
    ).toBeVisible();
  });
});
