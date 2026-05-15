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
//   T25-8: MCP SERVER facet in the /events sidebar; click filters
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

// Verb-based labels (CALL / READ / FETCHED / DISCOVERED) carry the
// invoked-vs-discovered distinction — the singular/plural-s pairs we
// considered (MCP TOOL / MCP TOOLS) collided on a single 's'.
// D123 restored the "MCP " prefix on top of the verb labels because
// Fleet's live feed table renders badges WITHOUT the swimlane hexagon
// shape, putting "TOOL CALL" right next to the non-MCP "TOOL" badge —
// that's verb-tense disambiguation, not category disambiguation.
// Prefix puts category back in the label where shape carries it in
// the swimlane.
const BADGE_LABELS: Record<(typeof MCP_EVENT_TYPES)[number], string> = {
  mcp_tool_call: "MCP TOOL CALL",
  mcp_tool_list: "MCP TOOLS DISCOVERED",
  mcp_resource_read: "MCP RESOURCE READ",
  mcp_resource_list: "MCP RESOURCES DISCOVERED",
  mcp_prompt_get: "MCP PROMPT FETCHED",
  mcp_prompt_list: "MCP PROMPTS DISCOVERED",
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
    run: sid,
  });
  await page.goto(`/events?${params.toString()}`);
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
    // Scope to a SUCCESSFUL mcp_tool_call (no MCPErrorIndicator
    // child). The seeded fixture emits both a success row (echo
    // tool with phase5-fixture arguments) and a failure row (the
    // MCPErrorIndicator anchor for T25-16). Without the negation,
    // .first() may resolve to the failure row whose arguments
    // payload differs and would fail the contains() assertion
    // below.
    const row = drawer
      .locator(
        '[data-event-type="mcp_tool_call"]:not(:has([data-testid^="mcp-error-indicator-"]))',
      )
      .first();
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

  // T25-8 — event-grain MCP SERVER facet appears + filter round-trip.
  // The /events facet sidebar is server-computed; the `mcp_server`
  // dimension is sourced from MCP events' payload `server_name`.
  test("T25-8: MCP SERVER facet appears on /events, click filters + URL round-trips", async ({
    page,
  }) => {
    await page.goto("/events");
    await waitForInvestigateReady(page);

    const facet = page.locator('[data-testid="events-facet-mcp_server"]');
    await expect(
      facet,
      "MCP SERVER facet must render when events carry an MCP server_name",
    ).toBeVisible({ timeout: 10_000 });
    await expect(facet).toContainText("MCP SERVER");

    const pillName = MCP_FIXTURE.servers[0].name;
    const pill = page.locator(
      `[data-testid="events-facet-pill-mcp_server-${pillName}"]`,
    );
    await expect(pill).toBeVisible();
    await pill.click();
    await expect(page).toHaveURL(new RegExp(`mcp_server=${pillName}`));
    await expect(pill).toHaveAttribute("data-active", "true");
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

  // T25-11 — MCP SERVER facet renders on the default /events URL
  // (no filter) when MCP events are present in the window.
  test("T25-11: MCP SERVER facet renders on the default /events URL", async ({
    page,
  }) => {
    await page.goto("/events");
    await waitForInvestigateReady(page);
    await expect(
      page.locator('[data-testid="events-facet-mcp_server"]'),
      "MCP SERVER facet must render on default /events when MCP events are present",
    ).toBeVisible({ timeout: 10_000 });
  });

  // (Phase 4 wave 2: the session-grain T25-12 / T25-17 session-row
  // MCP indicator dots were retired with the session-grain
  // /investigate table. At event grain an MCP event is its own row
  // on /events — surfaced directly rather than via a per-session
  // indicator — and the MCP SERVER facet (T25-8 / T25-11) plus the
  // event-detail drawer carry the MCP observability.)

  // T25-13 (B-5b) — Fleet swimlane renders MCP events as HEXAGONS
  // (not circles with rings). The mcp-active fixture role is
  // refreshed on every seed run with six fresh MCP events landing
  // in the last ~50s, comfortably inside the 1m default swimlane
  // window — see seed.py's mcp-active branch. T25-13 asserts the
  // data-event-shape="hexagon" + data-mcp-family="true" markers
  // are visible on the Fleet swimlane, both themes.
  // T25-14 (B-6) — large MCP content routes to event_content; drawer
  // shows Load Full Response affordance and the click fetches the
  // full body. The seeder lands one fresh has_content=true
  // mcp_resource_read each refresh — see seed.py's mcp-active branch.
  test("T25-14: large MCP content surfaces Load full response + fetch round-trips", async ({
    page,
  }) => {
    const sid = await fetchMCPSessionId(page);
    const params = new URLSearchParams({
      from: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      to: new Date().toISOString(),
      flavor: SENSOR_AGENT.flavor,
      run: sid,
    });
    await page.goto(`/events?${params.toString()}`);
    await waitForInvestigateReady(page);
    const drawer = page.locator('[data-testid="session-drawer"]');
    // Find the resource-read row whose data-event-type is set AND
    // whose has_content attribute reflects overflow. The drawer's
    // ``mcp-event-row-<id>`` testid wraps each MCP row regardless of
    // overflow state; we identify the overflowed one via the
    // resource_uri text "mem://big-log" the seeder uses for the
    // overflow fixture.
    const overflowRow = drawer
      .locator('[data-event-type="mcp_resource_read"]')
      .filter({ hasText: "mem://big-log" })
      .first();
    await expect(overflowRow).toBeVisible();
    await overflowRow.click();
    // Open the MCP details accordion on the same row.
    const accordion = overflowRow
      .locator('xpath=following-sibling::*[1]')
      .locator('[data-testid^="mcp-event-details-toggle-"]')
      .first();
    // Fallback: the accordion may be a sibling of the row container.
    // Use a less-fragile approach: pick the accordion belonging to
    // ANY MCP details block visible after the row click.
    const detailsToggle = drawer
      .locator('[data-testid^="mcp-event-details-toggle-"]')
      .last();
    await detailsToggle.click().catch(() => accordion.click());
    // The "Load full response" affordance appears for the truncated
    // content field. Locate by its placeholder testid suffix.
    const loadButton = drawer
      .locator(
        '[data-testid$="-truncated"] button',
      )
      .filter({ hasText: /Load full/ })
      .first();
    await expect(
      loadButton,
      "expected Load full response button on the overflow row",
    ).toBeVisible();
    await loadButton.click();
    // After fetch, the placeholder is replaced by the CodeBlock
    // <pre> carrying the testid ``mcp-event-detail-content-<id>``
    // (un-suffixed; the suffixed variants -truncated and -capped
    // belong to the placeholder + capped-notice paths). Wait for the
    // unsuffixed pre to materialise and assert the body text.
    const loadedBody = drawer.locator(
      "pre[data-testid^=\"mcp-event-detail-content-\"]:not([data-testid$=\"-truncated\"]):not([data-testid$=\"-capped\"])",
    ).first();
    await expect(loadedBody, "loaded body must be visible").toBeVisible({
      timeout: 5000,
    });
    // The 12 KiB body the seeder stamps starts with "x" repeats.
    expect((await loadedBody.textContent()) ?? "").toContain("xxxxx");
  });

  // T25-15 (B-7) — every Phase 5 MCP badge fits inside the pill.
  // The pill container's bounding rect must not be smaller than the
  // text span's bounding rect (i.e. no clip).
  test("T25-15: MCP badges fit on a single line (no clip)", async ({
    page,
  }) => {
    const sid = await fetchMCPSessionId(page);
    const params = new URLSearchParams({
      from: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      to: new Date().toISOString(),
      flavor: SENSOR_AGENT.flavor,
      run: sid,
    });
    await page.goto(`/events?${params.toString()}`);
    await waitForInvestigateReady(page);
    const drawer = page.locator('[data-testid="session-drawer"]');
    // Iterate every MCP event row's badge and confirm scrollWidth
    // <= clientWidth (no horizontal overflow / clip).
    const badges = drawer
      .locator('[data-event-type^="mcp_"] [data-testid="event-badge"]');
    const count = await badges.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      const badge = badges.nth(i);
      const overflow = await badge.evaluate(
        (el) => el.scrollWidth > el.clientWidth,
      );
      const text = await badge.textContent();
      expect(
        overflow,
        `badge "${text}" overflows its container (scrollWidth > clientWidth)`,
      ).toBe(false);
    }
  });

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

  // T25-16 — MCPErrorIndicator on a failed mcp_tool_call row.
  // The canonical seed includes one mcp_tool_call_failed extras tag on
  // the mcp-active session that emits an mcp_tool_call event with a
  // structured payload.error. The dashboard's MCPErrorIndicator
  // component renders a red AlertCircle inline immediately after the
  // badge whenever event_type is MCP and payload.error is populated;
  // see DECISIONS.md "MCP failure surfacing on event-feed rows".
  //
  // Theme-agnostic: asserts on data-testid + aria-label structure,
  // not colour. Indicator MUST render on the failed row, MUST NOT
  // render on a successful mcp_tool_call row (regression guard
  // against the indicator spilling onto every MCP row).
  test("T25-16: MCPErrorIndicator decorates only the failed mcp_tool_call row", async ({
    page,
  }) => {
    await openMCPSession(page);
    const drawer = page.locator('[data-testid="session-drawer"]');
    const indicators = drawer.locator(
      '[data-testid^="mcp-error-indicator-"]',
    );
    // At least one indicator on the seeded fixture. The keep-alive
    // watchdog re-emits the failed mcp_tool_call every 30 s so the
    // drawer's default 100-event window always carries the anchor;
    // each cycle adds one row, so an exact-count assertion would
    // race the watchdog. The regression guard ("indicator never
    // decorates a success row") below is the load-bearing
    // assertion.
    await expect(indicators.first()).toBeVisible({ timeout: 5000 });
    // aria-label format is the contract surfaced to screen readers
    // and the regression-guard for the message format change. The
    // seed posts message="Invalid SQL: 'banned' is not a recognized
    // status" via the canonical ``mcp_tool_call_failed`` extras tag.
    await expect(indicators.first()).toHaveAttribute(
      "aria-label",
      /^MCP call failed: Invalid SQL: 'banned' is not a recognized status$/,
    );
    // Regression guard: indicator scope is event-row-only, not
    // session-level. The synthetic row's containing event row must
    // be a mcp_tool_call (not, say, a sibling embeddings row that
    // happened to inherit the indicator).
    const decoratedRow = drawer.locator(
      '[data-event-type="mcp_tool_call"]:has([data-testid^="mcp-error-indicator-"])',
    );
    expect(await decoratedRow.count()).toBeGreaterThan(0);
    // Successful mcp_tool_call rows on the same session must NOT
    // carry the indicator. The seed emits at least one success row
    // alongside the failure; assert that any mcp_tool_call row
    // WITHOUT an indicator child also exists, so the decoration is
    // not spilling onto every MCP row in the family.
    const undecoratedRow = drawer.locator(
      '[data-event-type="mcp_tool_call"]:not(:has([data-testid^="mcp-error-indicator-"]))',
    );
    expect(await undecoratedRow.count()).toBeGreaterThan(0);
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

  // T25-18 (D122) — MCP discovery events hidden by default in Fleet's
  // live feed. Three sub-cases:
  //   * default state: discovery events absent from the feed even
  //     though the canonical seed emits them.
  //   * toggle on: every MCP event_type appears.
  //   * drawer: full timeline renders regardless of the Fleet
  //     toggle state — the drawer is the detail view and never
  //     applies the Fleet-level visibility decision.
  test("T25-18: discovery events hidden by default in Fleet live feed", async ({
    page,
    context,
  }) => {
    // Wipe any previous test's persisted preference so this run
    // starts from the documented default.
    await context.clearCookies();
    await page.goto("/");
    await page.evaluate(() =>
      localStorage.removeItem("flightdeck.feed.showDiscoveryEvents"),
    );
    await page.reload();
    await page.waitForLoadState("networkidle");
    // Widen the time range so the canonical fixture's mcp-active
    // session events (started ~240s ago) fall inside the visible
    // window. Default 1m is too narrow for the seeded data.
    await page.getByRole("button", { name: "5m" }).first().click();
    // Toggle exists and reads as off.
    const toggle = page.locator('[data-testid="filter-pill-show-discovery"]');
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-checked", "false");

    // Click the MCP filter pill so the feed narrows to MCP rows
    // only — this gives us a deterministic count to assert against
    // the canonical fixture (which seeds 6 MCP events on the
    // mcp-active session: 3 discovery + 3 usage, plus 1 failed
    // mcp_tool_call from the mcp_tool_call_failed extras tag).
    await page.locator('[data-testid="filter-pill-MCP"]').click();
    // Wait for the MCP-filtered feed to load — an MCP usage badge
    // proves the filter applied and the feed populated, so the
    // discovery-absent assertions below are meaningful rather than
    // trivially true against a not-yet-loaded feed.
    await expect(
      page
        .locator('[data-testid="feed-badge"]')
        .filter({ hasText: "MCP TOOL CALL" })
        .first(),
    ).toBeVisible({ timeout: 10_000 });
    // None of the discovery badge labels should be present.
    await expect(page.locator('[data-testid="feed-badge"]', { hasText: "MCP TOOLS DISCOVERED" })).toHaveCount(0);
    await expect(page.locator('[data-testid="feed-badge"]', { hasText: "MCP RESOURCES DISCOVERED" })).toHaveCount(0);
    await expect(page.locator('[data-testid="feed-badge"]', { hasText: "MCP PROMPTS DISCOVERED" })).toHaveCount(0);
  });

  test("T25-18: discovery events appear when toggle is on", async ({
    page,
    context,
  }) => {
    await context.clearCookies();
    await page.goto("/");
    await page.evaluate(() =>
      localStorage.setItem("flightdeck.feed.showDiscoveryEvents", "true"),
    );
    await page.reload();
    await page.waitForLoadState("networkidle");
    // Widen to 5m so the seeded mcp-active events fall inside the
    // visible window (same reasoning as the default-hidden case).
    await page.getByRole("button", { name: "5m" }).first().click();
    const toggle = page.locator('[data-testid="filter-pill-show-discovery"]');
    await expect(toggle).toHaveAttribute("aria-checked", "true");

    await page.locator('[data-testid="filter-pill-MCP"]').click();
    // At least one of each discovery type should appear (the seed
    // emits one of each on the mcp-active session). Web-first
    // visibility waits absorb the feed-update latency.
    for (const label of [
      "MCP TOOLS DISCOVERED",
      "MCP RESOURCES DISCOVERED",
      "MCP PROMPTS DISCOVERED",
    ]) {
      await expect(
        page
          .locator('[data-testid="feed-badge"]')
          .filter({ hasText: label })
          .first(),
      ).toBeVisible({ timeout: 10_000 });
    }
  });

  test("T25-18: drawer event timeline shows discovery events regardless of Fleet toggle", async ({
    page,
    context,
  }) => {
    // Default-off Fleet state. The drawer must still render the
    // full timeline including all discovery events — the drawer is
    // the detail view and intentionally diverges from the Fleet-
    // level visibility decision.
    await context.clearCookies();
    await page.goto("/");
    await page.evaluate(() =>
      localStorage.removeItem("flightdeck.feed.showDiscoveryEvents"),
    );
    await openMCPSession(page);
    const drawer = page.locator('[data-testid="session-drawer"]');
    // Each of the six MCP event_types should be present in the
    // drawer timeline (the canonical fixture seeds one of each).
    for (const eventType of MCP_EVENT_TYPES) {
      const row = drawer.locator(`[data-event-type="${eventType}"]`).first();
      await expect(
        row,
        `drawer must show ${eventType} regardless of Fleet discovery toggle`,
      ).toBeVisible();
    }
  });
});
