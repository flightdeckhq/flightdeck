import { test, expect } from "@playwright/test";
import {
  ALL_FIXTURE_AGENTS,
  readSwimlaneRows,
  waitForFleetReady,
  type SwimlaneRowLabels,
} from "./_fixtures";

// The client-type pill each fixture's row must show, written out here
// rather than taken from the client-type registry, so a registry that
// swapped two labels fails this spec instead of agreeing with itself.
// The pill's CSS shows it upper-case; the comparison ignores case.
const EXPECTED_PILL: Record<(typeof ALL_FIXTURE_AGENTS)[number]["clientType"], string> = {
  claude_code: "CLAUDE CODE",
  flightdeck_sensor: "SENSOR",
};

// How long the rows get to show what the seed gave them. After the
// first row shows, the page stays busy for a few seconds under load
// (the observer swapping the rows out of view, the window's events
// landing), and a walk to a row below the fold takes a second or two
// more. 15 s is several times that, and beside the first render it
// still fits the 30 s test budget, so a row that never shows fails this
// assertion, by name, rather than the test timeout.
const ROWS_SETTLE_TIMEOUT_MS = 15_000;

/** A row's labels with their case folded: the pill upper-case, as CSS
 *  shows it, and the badge lower-case, as the fixtures name agent types. */
function normalised(labels: SwimlaneRowLabels | null) {
  if (!labels) return null;
  return {
    visible: labels.visible,
    clientTypePill: labels.clientTypePill?.toUpperCase() ?? null,
    agentTypeBadge: labels.agentTypeBadge?.toLowerCase() ?? null,
  };
}

// T1 — Fleet renders the seeded fleet end-to-end. Canonical-pair
// invariant is the regression guard: no row may show the
// anomaly-producing client_type=flightdeck_sensor +
// agent_type=coding pair (a default that produced
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

    // Every seeded agent has a visible swimlane row whose client-type
    // pill and agent-type badge are the fixture's canonical pair: the
    // coding fixture reads CLAUDE CODE + coding, the two sensor
    // fixtures SENSOR + production. The expected pairs are canonical,
    // so an anomaly row (SENSOR + coding) fails the equality, as does
    // a seed → UI label swap.
    //
    // The swimlane is virtualized and the page keeps re-rendering: the
    // first render mounts every row before the observer swaps those
    // out of view for placeholders, and rows move as agents change
    // activity bucket. So each attempt finds every row and reads its
    // labels in one browser evaluation (walking the scroller to a row
    // below the fold: resilience pattern P2), and the poll repeats the
    // whole lookup until the rows read right. A row that never mounts
    // reads null.
    const expected = Object.fromEntries(
      ALL_FIXTURE_AGENTS.map((agent) => [
        agent.name,
        {
          visible: true,
          clientTypePill: EXPECTED_PILL[agent.clientType],
          agentTypeBadge: agent.agentType,
        },
      ]),
    );
    await expect
      .poll(
        async () => {
          const rows = await readSwimlaneRows(
            page,
            ALL_FIXTURE_AGENTS.map((agent) => agent.name),
          );
          return Object.fromEntries(
            Object.entries(rows).map(([name, labels]) => [name, normalised(labels)]),
          );
        },
        {
          message:
            "every fixture agent's swimlane row is visible with its canonical " +
            "client-type pill and agent-type badge (received: each row's labels, " +
            "null for a row that never mounted). Canonical pairs only.",
          timeout: ROWS_SETTLE_TIMEOUT_MS,
        },
      )
      .toEqual(expected);

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
  });
});
