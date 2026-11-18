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

    // Every row mounted right now, read in one browser evaluation: its
    // testid, its client-type pill's title ("client_type=<value>"; a
    // row with no client_type renders no pill) and its agent-type
    // badge, all at the same moment. A scan of one locator call per row
    // and field costs a page round trip each, and reads a list the
    // Fleet keeps re-rendering underneath it: the first render mounts
    // every row before the observer swaps those out of view for
    // placeholders, and rows move as agents change activity bucket, so
    // the row counted first need not be there when its fields are read.
    const rows = await page
      .locator('[data-testid^="swimlane-agent-row-"]')
      .evaluateAll((els) =>
        els.map((row) => ({
          testId: row.getAttribute("data-testid") ?? "<unknown>",
          pillTitle:
            row
              .querySelector('[data-testid="swimlane-client-type-pill"]')
              ?.getAttribute("title") ?? "",
          agentType:
            row
              .querySelector('[data-testid="swimlane-agent-type-badge"]')
              ?.textContent?.trim()
              .toLowerCase() ?? "",
        })),
      );
    expect(rows.length).toBeGreaterThan(0); // sanity: fleet has agents

    let checked = 0;
    for (const { testId, pillTitle, agentType } of rows) {
      // The pill's title is "client_type=<value>"; a row with no
      // client_type renders no pill and has nothing to check.
      const clientType = CLIENT_TYPE_VALUES.find(
        (c) => pillTitle === `client_type=${c}`,
      );
      if (!clientType) continue;
      expect(
        agentType,
        `swimlane row ${testId}: client_type=${clientType} is expected to` +
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
