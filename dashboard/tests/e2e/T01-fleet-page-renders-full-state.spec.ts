import { test, expect } from "@playwright/test";
import {
  ALL_FIXTURE_AGENTS,
  CODING_AGENT,
  SENSOR_AGENT,
  TRUNCATION_AGENT,
  findSwimlaneRow,
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

    // Every seeded agent appears in the swimlane. Semantic presence
    // of the fixture-keyed row is the contract — a missing row means
    // the seed didn't land or the fleet endpoint dropped it on the
    // floor.
    for (const agent of ALL_FIXTURE_AGENTS) {
      await expect(
        findSwimlaneRow(page, agent.name),
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

    // Canonical-pair invariant. Scan every swimlane row: the
    // client-type pill (SENSOR or CODING AGENT) and the agent-type
    // badge (e.g. "production", "coding") must never be the
    // anomaly combo (SENSOR + coding). Read the two sibling nodes
    // inside each row's left panel. The CODING_AGENT fixture is
    // client_type=claude_code (pill text "CODING AGENT", badge
    // "coding"); the SENSOR_AGENT fixture is flightdeck_sensor +
    // "production". The truncation fixture is production too.
    const rows = await page
      .locator('[data-testid^="swimlane-agent-row-"]')
      .all();
    expect(rows.length, "swimlane must have ≥3 agent rows").toBeGreaterThanOrEqual(3);
    for (const row of rows) {
      const pill = row.locator('[data-testid="swimlane-client-type-pill"]');
      const badge = row.locator('[data-testid="swimlane-agent-type-badge"]');
      const pillText = (await pill.textContent({ timeout: 2000 }).catch(() => null))?.trim().toUpperCase() ?? "";
      const badgeText = (await badge.textContent({ timeout: 2000 }).catch(() => null))?.trim().toLowerCase() ?? "";
      const isSensorPlusCoding = pillText.includes("SENSOR") && badgeText === "coding";
      expect(
        isSensorPlusCoding,
        `anomaly row: client_type=SENSOR paired with agent_type=coding — ` +
          `seen on row with pill='${pillText}' badge='${badgeText}'. ` +
          `Canonical pairs only.`,
      ).toBeFalsy();
    }

    // Spot-check each fixture's identity pill wiring -- CODING_AGENT
    // must render as CODING AGENT; both sensor fixtures must render
    // as SENSOR. Cheap sanity that seed → UI didn't swap labels.
    {
      const codingPill = findSwimlaneRow(page, CODING_AGENT.name).locator(
        '[data-testid="swimlane-client-type-pill"]',
      );
      await expect(codingPill).toContainText(/CLAUDE CODE/i);
      const sensorPill = findSwimlaneRow(page, SENSOR_AGENT.name).locator(
        '[data-testid="swimlane-client-type-pill"]',
      );
      await expect(sensorPill).toContainText(/SENSOR/i);
      const truncPill = findSwimlaneRow(page, TRUNCATION_AGENT.name).locator(
        '[data-testid="swimlane-client-type-pill"]',
      );
      await expect(truncPill).toContainText(/SENSOR/i);
    }
  });
});
