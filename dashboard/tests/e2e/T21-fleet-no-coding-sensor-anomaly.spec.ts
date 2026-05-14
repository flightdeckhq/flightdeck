import { test, expect } from "@playwright/test";
import { waitForFleetReady } from "./_fixtures";

// T21 — structural invariant: no agent renders both a CODING-agent
// signal AND a SENSOR client_type signal. The two are mutually
// exclusive by design — coding agents are observed via the Claude
// Code plugin (client_type=claude_code), production agents via the
// Python sensor (client_type=flightdeck_sensor). A row carrying
// both is the canonical "fleet anomaly" the original Phase 1 brief
// flagged: it indicates a misconfigured init() (probably a sensor
// SDK call setting agent_type="coding") and corrupts every facet
// rollup that splits by agent_type or client_type.
//
// The unit-level fleet-store filtering test guards the in-memory
// data shape; this E2E guard is the browser-rendered surface, run
// against a realistic seeded fleet so a future renderer change
// that re-introduces the anomaly visually (e.g. a stray badge
// added to the wrong code path) trips the test even if the data
// stays clean.
test.describe("T21 — Fleet renders no coding+sensor anomaly", () => {
  test("no swimlane row carries both 'coding' agent_type AND a sensor client pill", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForFleetReady(page);

    const rows = page.locator('[data-testid^="swimlane-agent-row-"]');
    const count = await rows.count();
    expect(count).toBeGreaterThan(0); // sanity: fleet has agents

    for (let i = 0; i < count; i += 1) {
      const row = rows.nth(i);
      // Pull the immediate row container's siblings via XPath up to
      // the parent flavor wrapper so we hit the badge/pill that
      // SwimLane renders next to the row. The badge and pill are
      // children of the row's left panel, so a direct .locator()
      // descend works.
      const badgeText = await row
        .locator('[data-testid="swimlane-agent-type-badge"]')
        .first()
        .textContent()
        .catch(() => "");
      const pillTitle = await row
        .locator('[data-testid="swimlane-client-type-pill"]')
        .first()
        .getAttribute("title")
        .catch(() => "");

      const isCoding = (badgeText ?? "").trim().toLowerCase() === "coding";
      const isSensor = (pillTitle ?? "").includes("flightdeck_sensor");

      // Identifier for the failure message — derive from the testid.
      const testIdAttr = (await row.getAttribute("data-testid")) ?? "<unknown>";

      expect(
        isCoding && isSensor,
        `swimlane row ${testIdAttr}: agent_type=coding combined with` +
          " client_type=flightdeck_sensor (canonical fleet anomaly)",
      ).toBe(false);
    }
  });

});
