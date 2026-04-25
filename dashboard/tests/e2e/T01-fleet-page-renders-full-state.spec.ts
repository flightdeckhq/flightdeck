import { test, expect } from "@playwright/test";
import {
  ALL_FIXTURE_AGENTS,
  CODING_AGENT,
  SENSOR_AGENT,
  TRUNCATION_AGENT,
  bringSwimlaneRowIntoView,
  waitForFleetReady,
} from "./_fixtures";

// T1 — Fleet renders the seeded fleet end-to-end. Canonical-pair
// invariant is the regression guard: no row may show the
// anomaly-producing client_type=flightdeck_sensor +
// agent_type=coding pair (the pre-Phase-2 default that produced
// phantom CODING sensors throughout the Fleet UI). The canonical
// ALLOWED_PAIRS are: claude_code→coding, flightdeck_sensor→
// production|coding-as-user-override. No seeded fixture uses the
// anomaly pair, and no runtime path should synthesise it either.
test.describe("T1 — Fleet renders full seeded state", () => {
  test("all 3 fixture agents surface, sidebar shows CONTEXT, no CODING+SENSOR anomaly row", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForFleetReady(page);

    // Every seeded agent appears in the swimlane. The swimlane is
    // virtualized -- under realistic data volume a fixture may
    // start off-screen even though it exists. ``bringSwimlaneRow
    // IntoView`` scrolls the parent container until the row mounts
    // (resilience pattern P2: don't assume first-page visibility).
    for (const agent of ALL_FIXTURE_AGENTS) {
      const row = await bringSwimlaneRowIntoView(page, agent.name);
      await expect(
        row,
        `swimlane row missing for ${agent.name}`,
      ).toBeVisible();
    }

    // Sidebar scaffolding: the CONTEXT facet panel is the section
    // T7 exercises and T3 leans on. Verify the panel mounts.
    await expect(
      page.locator('[data-testid="fleet-sidebar"]'),
      "fleet sidebar should mount",
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="fleet-panel-context"]'),
      "CONTEXT facet panel should render",
    ).toBeVisible();

    // Canonical-pair invariant. Scan the seeded fixtures' swimlane
    // rows: the client-type pill (SENSOR or CODING AGENT) and the
    // agent-type badge (e.g. "production", "coding") must never be
    // the anomaly combo (SENSOR + coding). The CODING_AGENT fixture
    // is client_type=claude_code (pill text "CODING AGENT", badge
    // "coding"); the SENSOR_AGENT fixture is flightdeck_sensor +
    // "production". The truncation fixture is production too.
    //
    // Pre-virtualization the test scanned every mounted swimlane
    // row indiscriminately. Under the virtualizer that scan races
    // against off-screen rows that never mount; targeting the
    // seeded fixtures by name is both more correct (we know which
    // pairs they should produce) and resilience-pattern compliant
    // (P1: find-my-fixture).
    for (const agent of ALL_FIXTURE_AGENTS) {
      const row = await bringSwimlaneRowIntoView(page, agent.name);
      const pill = row.locator('[data-testid="swimlane-client-type-pill"]');
      const badge = row.locator('[data-testid="swimlane-agent-type-badge"]');
      const pillText = (await pill.textContent({ timeout: 2000 }).catch(() => null))?.trim().toUpperCase() ?? "";
      const badgeText = (await badge.textContent({ timeout: 2000 }).catch(() => null))?.trim().toLowerCase() ?? "";
      const isSensorPlusCoding = pillText.includes("SENSOR") && badgeText === "coding";
      expect(
        isSensorPlusCoding,
        `anomaly row for ${agent.name}: client_type=SENSOR paired ` +
          `with agent_type=coding — pill='${pillText}' badge='${badgeText}'. ` +
          `Canonical pairs only.`,
      ).toBeFalsy();
    }

    // Spot-check each fixture's identity pill wiring -- CODING_AGENT
    // must render as CODING AGENT; both sensor fixtures must render
    // as SENSOR. Cheap sanity that seed → UI didn't swap labels.
    // Each row is brought into view first because earlier scrolling
    // may have unmounted it from the virtualizer's window.
    {
      const codingRow = await bringSwimlaneRowIntoView(page, CODING_AGENT.name);
      await expect(
        codingRow.locator('[data-testid="swimlane-client-type-pill"]'),
      ).toContainText(/CLAUDE CODE/i);
      const sensorRow = await bringSwimlaneRowIntoView(page, SENSOR_AGENT.name);
      await expect(
        sensorRow.locator('[data-testid="swimlane-client-type-pill"]'),
      ).toContainText(/SENSOR/i);
      const truncRow = await bringSwimlaneRowIntoView(page, TRUNCATION_AGENT.name);
      await expect(
        truncRow.locator('[data-testid="swimlane-client-type-pill"]'),
      ).toContainText(/SENSOR/i);
    }
  });
});
