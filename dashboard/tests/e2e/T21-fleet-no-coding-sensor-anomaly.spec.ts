import { test, expect } from "@playwright/test";
import { waitForFleetReady } from "./_fixtures";
import { CLIENT_TYPE_META, CLIENT_TYPE_VALUES } from "../../src/lib/agent-identity";

// T21 — structural invariant: every agent's agent_type matches the
// agent_type its client type is expected to send (the client type
// registry's "Expected agent_type": coding for the hook-based coding
// agents, production for the sensor). Ingestion does not enforce the
// pairing, so a row that breaks it is the canonical "fleet anomaly":
// typically a misconfigured init() (a sensor SDK call setting
// agent_type="coding"), which corrupts every facet rollup that splits
// by agent_type or client_type. The seeded fleet must carry none.
//
// The unit-level fleet-store filtering test guards the in-memory
// data shape; this E2E guard is the browser-rendered surface, run
// against a realistic seeded fleet so a future renderer change
// that re-introduces the anomaly visually (e.g. a stray badge
// added to the wrong code path) trips the test even if the data
// stays clean.
test.describe("T21 — Fleet renders no coding+sensor anomaly", () => {
  test("every swimlane row's agent_type matches its client type's expected agent_type", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForFleetReady(page);

    const rows = page.locator('[data-testid^="swimlane-agent-row-"]');
    const count = await rows.count();
    expect(count).toBeGreaterThan(0); // sanity: fleet has agents

    let checked = 0;
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
      // A row with no client_type renders no pill; look for it before
      // reading its title so such a row costs no locator timeout.
      const pill = row.locator('[data-testid="swimlane-client-type-pill"]').first();
      const pillTitle = (await pill.count()) > 0 ? await pill.getAttribute("title") : "";

      // The pill's title is "client_type=<value>"; a row with no
      // client_type renders no pill and has nothing to check.
      const clientType = CLIENT_TYPE_VALUES.find(
        (c) => (pillTitle ?? "") === `client_type=${c}`,
      );
      if (!clientType) continue;
      const agentType = (badgeText ?? "").trim().toLowerCase();

      // Identifier for the failure message — derive from the testid.
      const testIdAttr = (await row.getAttribute("data-testid")) ?? "<unknown>";

      expect(
        agentType,
        `swimlane row ${testIdAttr}: client_type=${clientType} is expected to` +
          ` send agent_type=${CLIENT_TYPE_META[clientType].agentType} (fleet anomaly)`,
      ).toBe(CLIENT_TYPE_META[clientType].agentType);
      checked += 1;
    }
    // The seeded fleet has pill-bearing rows, so a run that compared
    // none means the pill's title format changed and the check went
    // vacuous.
    expect(checked, "rows with a client pill compared").toBeGreaterThan(0);
  });

});
