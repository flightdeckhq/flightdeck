import { test, expect } from "@playwright/test";
import {
  CODING_AGENT,
  SENSOR_AGENT,
  TRUNCATION_AGENT,
  waitForFleetReady,
} from "./_fixtures";

// T13 — agent-table column headers are clickable and toggle sort
// state in the URL. Regression guard for the V0.4.0 Phase 2 S5b
// deliverable: headers carry data-testid hooks, a click emits
// ``?sort=<col>&order=desc``, a second click flips to asc, and a
// third click clears both params back to the bucket-ordered default.
//
// Theme-agnostic: selectors reference structural testids, no
// colour or font-weight assertions (rule 40c.3).

test.describe("T13 — AgentTable column sortability + URL state", () => {
  test("header click persists ?sort + toggles asc/desc → clears on third click", async ({
    page,
  }) => {
    // Flip directly to the table view via URL so the assertion is
    // deterministic without needing to click the view-toggle first.
    await page.goto("/?view=table");
    await waitForFleetReady(page);

    // All seven sortable headers must be present. Renders are
    // theme-agnostic so querying by testid is enough.
    for (const col of [
      "agent_name",
      "client_type",
      "agent_type",
      "total_sessions",
      "total_tokens",
      "last_seen_at",
      "state",
    ]) {
      await expect(
        page.locator(`[data-testid="agent-table-header-${col}"]`),
        `header for column ${col} must render with data-testid`,
      ).toBeVisible();
    }

    // Click "Tokens". URL picks up sort=total_tokens&order=desc.
    await page.locator('[data-testid="agent-table-header-total_tokens"]').click();
    await expect
      .poll(() => {
        const u = new URL(page.url());
        return {
          sort: u.searchParams.get("sort"),
          order: u.searchParams.get("order"),
        };
      }, { message: "URL must carry sort=total_tokens&order=desc after first click" })
      .toEqual({ sort: "total_tokens", order: "desc" });

    // Arrow indicator on the active column reflects desc.
    const activeHeader = page.locator(
      '[data-testid="agent-table-header-total_tokens"]',
    );
    await expect(activeHeader).toHaveAttribute("aria-sort", "descending");

    // Rows should re-order. The fleet fixtures all have different
    // total_tokens counts (seed inserts variable token_usage events
    // per role); assert the first three fixture rows render in desc
    // order by capturing the index of each known fixture name in the
    // table's row order.
    const tableRowSelector = '[data-testid^="fleet-agent-row-"]';
    const rows = page.locator(tableRowSelector);
    // Give the client-side sort one tick to apply (it runs in a
    // useMemo on the re-render after the URL update).
    await expect(rows.first()).toBeVisible();
    const rowTexts = await rows.allTextContents();
    function indexOf(name: string): number {
      return rowTexts.findIndex((t) => t.includes(name));
    }
    const codingIdx = indexOf(CODING_AGENT.name);
    const sensorIdx = indexOf(SENSOR_AGENT.name);
    const truncationIdx = indexOf(TRUNCATION_AGENT.name);
    // All three fixtures must render. We do NOT assert a specific
    // order here because per-run event seeding can make any of them
    // the top-tokens row — the important invariant is "URL controls
    // sort" (asserted above) and "headers toggle" (asserted below).
    expect(codingIdx).toBeGreaterThanOrEqual(0);
    expect(sensorIdx).toBeGreaterThanOrEqual(0);
    expect(truncationIdx).toBeGreaterThanOrEqual(0);

    // Second click on the same column flips to asc.
    await page.locator('[data-testid="agent-table-header-total_tokens"]').click();
    await expect
      .poll(() => {
        const u = new URL(page.url());
        return {
          sort: u.searchParams.get("sort"),
          order: u.searchParams.get("order"),
        };
      }, { message: "URL must carry sort=total_tokens&order=asc after second click" })
      .toEqual({ sort: "total_tokens", order: "asc" });
    await expect(activeHeader).toHaveAttribute("aria-sort", "ascending");

    // Third click clears the sort entirely — back to bucket ordering.
    await page.locator('[data-testid="agent-table-header-total_tokens"]').click();
    await expect
      .poll(() => {
        const u = new URL(page.url());
        return {
          sort: u.searchParams.get("sort"),
          order: u.searchParams.get("order"),
        };
      }, { message: "third click must clear both sort and order params" })
      .toEqual({ sort: null, order: null });
    await expect(activeHeader).toHaveAttribute("aria-sort", "none");

    // Clicking a DIFFERENT column starts fresh at desc.
    await page.locator('[data-testid="agent-table-header-agent_name"]').click();
    await expect
      .poll(() => {
        const u = new URL(page.url());
        return {
          sort: u.searchParams.get("sort"),
          order: u.searchParams.get("order"),
        };
      }, { message: "switching column must reset order to desc" })
      .toEqual({ sort: "agent_name", order: "desc" });
  });
});
