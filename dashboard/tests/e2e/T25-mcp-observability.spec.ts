import { test, expect, type Page } from "@playwright/test";
import { MCP_FIXTURE, SENSOR_AGENT, waitForInvestigateReady } from "./_fixtures";

// T25 — Phase 5: MCP observability rendering.
//
// The canonical seed (tests/e2e-fixtures/canonical.json + seed.py)
// includes an ``mcp-active`` role on the sensor agent that:
//   * connected to two MCP servers (one stdio, one http) so
//     ``context.mcp_servers`` is populated and the listing surfaces
//     ``mcp_server_names: ["fixture-stdio-server",
//     "fixture-http-server"]``.
//   * emitted one event of each Phase 5 type (mcp_tool_list,
//     mcp_tool_call, mcp_resource_list, mcp_resource_read,
//     mcp_prompt_list, mcp_prompt_get) with capture_prompts=true so
//     MCPEventDetails can render arguments / result / content /
//     rendered.
//
// Theme-agnostic: every assertion reads structural attributes
// (data-testid / textContent / class membership for lucide icons),
// never computed colours. Runs under both ``neon-dark`` and
// ``clean-light`` Playwright projects per Rule 40c.3.
//
// Sub-cases mapped to S-MCP-9 T25 plan:
//   T25-1 / -2 / -3 / -4 / -5 / -6: each MCP event row carries the
//     correct badge + icon. One it() per event type.
//   T25-7: expanded row exposes input/output/server/duration. Picks
//     the mcp_tool_call row (capture-on so arguments + result are
//     visible) as the canonical case.
//   T25-8: MCP SERVER facet in Investigate sidebar; click filters
//     and round-trips through the URL.
//   T25-9: live-feed style filter pill "MCP" exists.
//   T25-10: session-drawer header MCP SERVERS panel renders both
//     servers + expand-to-fingerprint affordance works.

const MCP_EVENT_TYPES = [
  "mcp_tool_call",
  "mcp_tool_list",
  "mcp_resource_read",
  "mcp_resource_list",
  "mcp_prompt_get",
  "mcp_prompt_list",
] as const;

// B-4 — verb labels match what the agent actually did
// (called, read, fetched, discovered). The "MCP" prefix is dropped
// from the badge text because the colour family + the swimlane
// shared-ring + the timeline detail header all already attribute the
// row as MCP. Pre-B-4 labels (MCP TOOL / MCP TOOLS / etc.) collided
// on a single plural-s and confused operators at scan time.
const BADGE_LABELS: Record<(typeof MCP_EVENT_TYPES)[number], string> = {
  mcp_tool_call: "TOOL CALL",
  mcp_tool_list: "TOOLS DISCOVERED",
  mcp_resource_read: "RESOURCE READ",
  mcp_resource_list: "RESOURCES DISCOVERED",
  mcp_prompt_get: "PROMPT FETCHED",
  mcp_prompt_list: "PROMPTS DISCOVERED",
};

// Icon glyph contract is pinned by tests/unit/EventNode-mcp.test.tsx,
// not here. The Investigate drawer's event-row renders only the badge +
// detail-text — the lucide circles live on the Fleet swimlane via
// <EventNode>, which Investigate does not mount. Asserting icon
// presence at this URL would either time out or accidentally match an
// unrelated icon elsewhere on the page (e.g. lucide-file-text used by
// the capture indicator), so the row tests focus on what is actually
// in the drawer DOM at this navigation: the badge label, the row
// container, and the server-name attribution string.

async function fetchMCPSessionId(page: Page): Promise<string> {
  // The mcp-active role lands on the sensor agent. Filter on flavor
  // + mcp_server so a stale dev DB with other sessions doesn't
  // accidentally produce a non-mcp result.
  const sp = new URLSearchParams({
    flavor: SENSOR_AGENT.flavor,
    mcp_server: MCP_FIXTURE.servers[0].name,
    from: "2020-01-01T00:00:00Z",
    limit: "100",
  });
  const resp = await page.request.get(
    `http://localhost:4000/api/v1/sessions?${sp.toString()}`,
    { headers: { Authorization: "Bearer tok_dev" } },
  );
  expect(resp.ok(), "sessions API call must succeed").toBe(true);
  const body = await resp.json();
  const sessions = (body.sessions ?? []) as Array<{
    session_id: string;
    mcp_server_names?: string[];
  }>;
  expect(
    sessions.length,
    "API must return ≥1 session for the mcp-active fixture role",
  ).toBeGreaterThanOrEqual(1);
  // Pick the first row carrying both fixture server names (defensive
  // against a partial seed).
  const target = sessions.find(
    (s) =>
      Array.isArray(s.mcp_server_names) &&
      MCP_FIXTURE.servers.every((srv) => s.mcp_server_names!.includes(srv.name)),
  );
  expect(
    target,
    "expected a session whose mcp_server_names[] includes both fixture servers",
  ).toBeDefined();
  return target!.session_id;
}

async function openMCPSession(page: Page): Promise<string> {
  const sid = await fetchMCPSessionId(page);
  const params = new URLSearchParams({
    from: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    to: new Date().toISOString(),
    flavor: SENSOR_AGENT.flavor,
    session: sid,
  });
  await page.goto(`/investigate?${params.toString()}`);
  await waitForInvestigateReady(page);
  await expect(page.locator('[data-testid="session-drawer"]')).toBeVisible();
  return sid;
}

test.describe("T25 — MCP observability rendering", () => {
  // T25-1 .. T25-6: per-event-type row + badge.
  for (const eventType of MCP_EVENT_TYPES) {
    test(`row for ${eventType} carries ${BADGE_LABELS[eventType]} badge + server attribution`, async ({
      page,
    }) => {
      await openMCPSession(page);
      const drawer = page.locator('[data-testid="session-drawer"]');
      const row = drawer.locator(`[data-event-type="${eventType}"]`).first();
      await expect(
        row,
        `expected one drawer row for event_type=${eventType}`,
      ).toBeVisible();
      // Badge label is the user-visible signal that this row is MCP.
      await expect(row.locator('[data-testid="event-badge"]')).toHaveText(
        BADGE_LABELS[eventType],
      );
      // Server name appears in the row's detail text (per the
      // ``getEventDetail`` MCP branch). Confirms the row binds the
      // MCP-payload-extras projection on the worker side end-to-end
      // through the dashboard.
      const detail = (await row.textContent()) ?? "";
      expect(detail).toContain(MCP_FIXTURE.servers[0].name);
    });
  }

  // T25-7 — expanded row: arguments + result + server + duration.
  test("T25-7: expanded mcp_tool_call row shows arguments, result, server attribution, duration", async ({
    page,
  }) => {
    await openMCPSession(page);
    const drawer = page.locator('[data-testid="session-drawer"]');
    const row = drawer.locator('[data-event-type="mcp_tool_call"]').first();
    await expect(row).toBeVisible();
    await row.click();
    // The expanded body renders MCPEventDetails. Click the accordion
    // to expose the structured payload.
    const detailsToggle = drawer.locator(
      '[data-testid^="mcp-event-details-toggle-"]',
    );
    await detailsToggle.first().click();
    // Arguments + result code blocks are now visible. The fixture
    // emits ``arguments={"text": "phase5-fixture"}`` and the
    // mirrored result.
    const argumentsBlock = drawer.locator(
      '[data-testid^="mcp-event-detail-arguments-"]',
    );
    await expect(argumentsBlock.first()).toBeVisible();
    expect(await argumentsBlock.first().textContent()).toContain(
      "phase5-fixture",
    );
    const resultBlock = drawer.locator(
      '[data-testid^="mcp-event-detail-result-"]',
    );
    await expect(resultBlock.first()).toBeVisible();
    expect(await resultBlock.first().textContent()).toContain(
      "phase5-fixture",
    );
    // Server attribution + duration sit above the accordion as
    // summary rows. Read by visible text on the row container.
    const expanded = (await row.textContent()) ?? "";
    expect(expanded).toContain(MCP_FIXTURE.servers[0].name);
    expect(expanded).toContain(MCP_FIXTURE.servers[0].transport);
    expect(expanded).toMatch(/\d+ms/);
  });

  // T25-8 — Investigate MCP SERVER facet appears + filter round-trip.
  test("T25-8: MCP SERVER facet appears, click filters the table, URL round-trips", async ({
    page,
  }) => {
    const params = new URLSearchParams({
      from: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      to: new Date().toISOString(),
      flavor: SENSOR_AGENT.flavor,
    });
    await page.goto(`/investigate?${params.toString()}`);
    await waitForInvestigateReady(page);

    const facet = page.locator(
      '[data-testid="investigate-mcp-server-facet"]',
    );
    await expect(
      facet,
      "MCP SERVER facet must render when a visible session has mcp_server_names",
    ).toBeVisible();
    await expect(facet).toContainText("MCP SERVER");

    const pillName = MCP_FIXTURE.servers[0].name;
    const pill = page.locator(
      `[data-testid="investigate-mcp-server-pill-${pillName}"]`,
    );
    await expect(pill).toBeVisible();
    await pill.click();
    await expect(page).toHaveURL(new RegExp(`mcp_server=${pillName}`));
    // Active filter chip surfaces with the same name.
    const activeFiltersText = (await page.textContent("body")) ?? "";
    expect(activeFiltersText).toContain(`mcp_server:${pillName}`);
  });

  // T25-9 — Live feed-style MCP filter pill exists in EventFilterBar.
  test("T25-9: MCP filter pill renders in the event filter bar (Fleet)", async ({
    page,
  }) => {
    await page.goto("/");
    // The fleet page mounts the EventFilterBar above the live feed.
    const bar = page.locator('[data-testid="event-filter-bar"]');
    await expect(bar).toBeVisible();
    const mcpPill = page.locator('[data-testid="filter-pill-MCP"]');
    await expect(
      mcpPill,
      "EVENT_FILTER_PILLS must include the MCP entry on Fleet's filter bar",
    ).toBeVisible();
    await expect(mcpPill).toContainText("MCP");
  });

  // T25-11 (B-1) — MCP SERVER facet renders on default Investigate URL
  // (no flavor filter) when any visible session has mcp_server_names.
  // Pre-B-1 the facet was hidden at the very bottom of an 18-facet
  // sidebar; the seeded mcp-active session is enough to surface it.
  test("T25-11: MCP SERVER facet renders on default Investigate URL", async ({
    page,
  }) => {
    const params = new URLSearchParams({
      from: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      to: new Date().toISOString(),
    });
    await page.goto(`/investigate?${params.toString()}`);
    await waitForInvestigateReady(page);
    const facet = page.locator(
      '[data-testid="investigate-mcp-server-facet"]',
    );
    await expect(
      facet,
      "MCP SERVER facet must render on default Investigate URL when seeded mcp-active session is in the result set",
    ).toBeVisible();
    // B-1: facet sits between FRAMEWORK and the scalar-context block.
    // Assert ordering by reading every facet's data-testid in DOM
    // order and checking the MCP_SERVER index.
    const allFacetSections = await page
      .locator('[data-testid="investigate-sidebar"] > div')
      .all();
    let mcpIdx = -1;
    let osIdx = -1;
    for (let i = 0; i < allFacetSections.length; i++) {
      const tid =
        (await allFacetSections[i].getAttribute("data-testid")) ?? "";
      const txt = (await allFacetSections[i].textContent()) ?? "";
      if (tid === "investigate-mcp-server-facet") mcpIdx = i;
      // The OS section has no testid; identify by its leading label
      // text. We just need it to come after MCP SERVER.
      if (txt.startsWith("OS") && osIdx === -1) osIdx = i;
    }
    expect(mcpIdx).toBeGreaterThan(-1);
    expect(osIdx).toBeGreaterThan(-1);
    expect(mcpIdx).toBeLessThan(osIdx);
  });

  // T25-12 (B-2) — Row-level MCP indicator dot on session listings.
  test("T25-12: session row carries MCP indicator dot when mcp_server_names is non-empty", async ({
    page,
  }) => {
    const sid = await fetchMCPSessionId(page);
    const params = new URLSearchParams({
      from: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      to: new Date().toISOString(),
      flavor: SENSOR_AGENT.flavor,
    });
    await page.goto(`/investigate?${params.toString()}`);
    await waitForInvestigateReady(page);
    const indicator = page.locator(
      `[data-testid="session-row-mcp-indicator-${sid}"]`,
    );
    await expect(indicator).toBeVisible();
    const aria = await indicator.getAttribute("aria-label");
    expect(aria).toContain("fixture-stdio-server");
    expect(aria).toContain("fixture-http-server");
  });

  // T25-13 (B-5b) — Fleet swimlane renders MCP events as HEXAGONS
  // (not circles with rings). The mcp-active fixture role is
  // refreshed on every seed run with six fresh MCP events landing
  // in the last ~50s, comfortably inside the 1m default swimlane
  // window — see seed.py's mcp-active branch. T25-13 asserts the
  // data-event-shape="hexagon" + data-mcp-family="true" markers
  // are visible on the Fleet swimlane, both themes.
  test("T25-13: Fleet swimlane renders MCP events as hexagons (not circles)", async ({
    page,
  }) => {
    page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    // Click the 5m time-range pill so a slightly aged seed (events
    // are seeded at NOW-50s but the full-suite playwright run can
    // execute T25-13 minutes after the globalSetup seed) still
    // lands every MCP event inside the swimlane window.
    // Operators using the default 1m view will still see fresh MCP
    // hexagons in normal use — this widening exists to make the
    // test robust against full-suite time drift, not because the
    // production UX needs it.
    await page.getByRole("button", { name: "5m" }).first().click();
    const mcpHexagons = page.locator(
      '[data-testid^="session-circle-"][data-mcp-family="true"][data-event-shape="hexagon"]',
    );
    await expect(
      mcpHexagons.first(),
      "Fleet swimlane must render at least one MCP-family hexagon",
    ).toBeVisible({ timeout: 10000 });
    // Regression guard: at least one non-MCP circle is also rendered
    // alongside the hexagons (the canonical fixture seeds non-MCP
    // sessions with fresh activity), and they retain the circle
    // shape — i.e. the hexagon override does NOT spill onto every
    // event.
    const nonMcpCircles = page.locator(
      '[data-testid^="session-circle-"][data-event-shape="circle"]',
    );
    await expect(
      nonMcpCircles.first(),
      "Fleet swimlane must continue to render circles for non-MCP events",
    ).toBeVisible();
  });

  // T25-10 — Session drawer header MCP SERVERS panel.
  test("T25-10: session-drawer header MCP SERVERS panel lists both servers + expand-to-fingerprint works", async ({
    page,
  }) => {
    await openMCPSession(page);
    const panel = page.locator('[data-testid="mcp-servers-panel"]');
    await expect(panel).toBeVisible();
    // At-rest summary lists every fixture server name.
    const summary = page.locator('[data-testid="mcp-servers-panel-summary"]');
    await expect(summary).toBeVisible();
    for (const srv of MCP_FIXTURE.servers) {
      await expect(summary).toContainText(srv.name);
    }
    // Expand toggles the full fingerprint grid.
    await page.locator('[data-testid="mcp-servers-panel-toggle"]').click();
    const grid = page.locator('[data-testid="mcp-servers-panel-grid"]');
    await expect(grid).toBeVisible();
    // Each server has a row; the fingerprint shows version + transport.
    for (const srv of MCP_FIXTURE.servers) {
      const row = page.locator(`[data-testid="mcp-server-row-${srv.name}"]`);
      await expect(row).toBeVisible();
      await expect(
        page.locator(`[data-testid="mcp-server-name-${srv.name}"]`),
      ).toHaveText(srv.name);
      await expect(
        page.locator(`[data-testid="mcp-server-transport-${srv.name}"]`),
      ).toHaveText(srv.transport);
      await expect(
        page.locator(`[data-testid="mcp-server-version-${srv.name}"]`),
      ).toHaveText(srv.version);
    }
  });
});
