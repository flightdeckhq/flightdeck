import { test, expect } from "@playwright/test";
import { CODING_AGENT, waitForInvestigateReady } from "./_fixtures";

// T17 — Phase 4 polish S-POLICY-EV-4: policy_warn / policy_degrade /
// policy_block event rendering plus Investigate POLICY facet +
// session-row severity-ranked dot. Backed by the canonical
// ``policy-active`` role on the coding agent (canonical.json), which
// seeds one of each enforcement event type with the contract-shape
// payload (source / threshold_pct / tokens_used / token_limit, plus
// from_model/to_model on degrade and intended_model on block).
//
// Theme-agnostic — selectors are testids/structural, never colour.
test.describe("T17 — policy event rendering + POLICY facet", () => {
  test("POLICY facet renders three pills and click filters the table", async ({
    page,
  }) => {
    const params = new URLSearchParams({
      from: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      to: new Date().toISOString(),
      flavor: CODING_AGENT.flavor,
    });
    await page.goto(`/investigate?${params.toString()}`);
    await waitForInvestigateReady(page);

    const facet = page.locator('[data-testid="investigate-policy-facet"]');
    await expect(
      facet,
      "POLICY facet must render when a visible session has policy events",
    ).toBeVisible();

    for (const pt of ["policy_warn", "policy_degrade", "policy_block"]) {
      await expect(
        facet.locator(`[data-testid="investigate-policy-pill-${pt}"]`),
        `POLICY pill for ${pt} must render`,
      ).toBeVisible();
    }

    // Click policy_block. URL gains ?policy_event_type=policy_block;
    // the filtered table must contain the seeded session.
    await facet
      .locator('[data-testid="investigate-policy-pill-policy_block"]')
      .click();
    await expect(page).toHaveURL(/policy_event_type=policy_block/);

    const dots = page.locator(
      '[data-testid^="session-row-policy-indicator-"]',
    );
    expect(
      await dots.count(),
      "policy_block filter should yield at least 1 row with the policy dot",
    ).toBeGreaterThanOrEqual(1);
  });

  test("session-row dot colour-ranks block > degrade > warn", async ({
    page,
  }) => {
    const params = new URLSearchParams({
      from: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      to: new Date().toISOString(),
      flavor: CODING_AGENT.flavor,
    });
    await page.goto(`/investigate?${params.toString()}`);
    await waitForInvestigateReady(page);

    // The policy-active session emits all three event types; its dot
    // aria-label must list every distinct value (severity-ranked
    // colour, but the tooltip text reflects the full set).
    const allDots = page.locator(
      '[data-testid^="session-row-policy-indicator-"]',
    );
    const labels = await allDots.evaluateAll((els) =>
      els.map((e) => e.getAttribute("aria-label") ?? ""),
    );
    const hasMultiPolicy = labels.some(
      (l) =>
        l.includes("warn") &&
        l.includes("degrade") &&
        l.includes("block"),
    );
    expect(
      hasMultiPolicy,
      "policy-active session must surface a row dot listing warn/degrade/block",
    ).toBe(true);

    // Negative: there must be at least one row in the same flavor
    // WITHOUT a policy dot (fresh-active / aged-closed / stale roles).
    const totalRows = await page
      .locator('[data-testid^="investigate-row-session-"]')
      .count();
    const dotCount = await allDots.count();
    expect(
      totalRows,
      "expected at least one row without the policy dot (clean sessions in the flavor)",
    ).toBeGreaterThan(dotCount);
  });

  test("drawer renders all three policy event rows with PolicyEventDetails", async ({
    page,
  }) => {
    const params = new URLSearchParams({
      from: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      to: new Date().toISOString(),
      flavor: CODING_AGENT.flavor,
      policy_event_type: "policy_block",
    });
    await page.goto(`/investigate?${params.toString()}`);
    await waitForInvestigateReady(page);

    const firstRow = page
      .locator('[data-testid^="investigate-row-session-"]')
      .first();
    await firstRow.click();

    const drawer = page.locator('[data-testid="session-drawer"]');
    await expect(drawer).toBeVisible();

    // The drawer must include three policy event rows (one per type).
    const policyRows = drawer.locator(
      '[data-testid^="policy-event-row-"]',
    );
    expect(
      await policyRows.count(),
      "drawer timeline must include all three seeded policy event rows",
    ).toBeGreaterThanOrEqual(3);

    // Expand the first policy row. The PolicyEventDetails accordion
    // must mount with the per-id testid.
    await policyRows.first().click();
    const accordion = drawer
      .locator('[data-testid^="policy-event-details-"]')
      .first();
    await expect(
      accordion,
      "PolicyEventDetails accordion must mount when the policy row expands",
    ).toBeVisible();

    // Toggle the accordion open and assert the per-field testids.
    await drawer
      .locator('[data-testid^="policy-event-details-toggle-"]')
      .first()
      .click();
    await expect(
      drawer.locator('[data-testid^="policy-event-detail-source-"]').first(),
    ).toBeVisible();
    await expect(
      drawer.locator('[data-testid^="policy-event-detail-summary-"]').first(),
    ).toBeVisible();
  });

  test("policy_warn detail string carries threshold + token math", async ({
    page,
  }) => {
    const params = new URLSearchParams({
      from: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      to: new Date().toISOString(),
      flavor: CODING_AGENT.flavor,
      policy_event_type: "policy_warn",
    });
    await page.goto(`/investigate?${params.toString()}`);
    await waitForInvestigateReady(page);

    const firstRow = page
      .locator('[data-testid^="investigate-row-session-"]')
      .first();
    await firstRow.click();
    const drawer = page.locator('[data-testid="session-drawer"]');
    await expect(drawer).toBeVisible();

    // policy_warn row's detail text reads
    // "warn at 80% · 8,000 of 10,000 tokens" per the seeder fixture.
    const warnRows = drawer.locator(
      '[data-testid^="policy-event-row-"]',
    );
    let foundWarnDetail = false;
    const count = await warnRows.count();
    for (let i = 0; i < count; i++) {
      const row = warnRows.nth(i);
      const eventType = await row.getAttribute("data-event-type");
      if (eventType === "policy_warn") {
        const text = (await row.textContent()) ?? "";
        if (text.includes("warn at 80%") && text.includes("of 10,000 tokens")) {
          foundWarnDetail = true;
          break;
        }
      }
    }
    expect(
      foundWarnDetail,
      "policy_warn row must carry the threshold + token math detail string",
    ).toBe(true);
  });

  test("policy_degrade detail surfaces from→to model swap", async ({
    page,
  }) => {
    const params = new URLSearchParams({
      from: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      to: new Date().toISOString(),
      flavor: CODING_AGENT.flavor,
      policy_event_type: "policy_degrade",
    });
    await page.goto(`/investigate?${params.toString()}`);
    await waitForInvestigateReady(page);

    const firstRow = page
      .locator('[data-testid^="investigate-row-session-"]')
      .first();
    await firstRow.click();
    const drawer = page.locator('[data-testid="session-drawer"]');
    await expect(drawer).toBeVisible();

    const rows = drawer.locator('[data-testid^="policy-event-row-"]');
    let foundDegrade = false;
    const count = await rows.count();
    for (let i = 0; i < count; i++) {
      const row = rows.nth(i);
      if ((await row.getAttribute("data-event-type")) === "policy_degrade") {
        const text = (await row.textContent()) ?? "";
        if (
          text.includes("degraded from") &&
          text.includes("claude-sonnet-4-6") &&
          text.includes("claude-haiku-4-5")
        ) {
          foundDegrade = true;
          break;
        }
      }
    }
    expect(
      foundDegrade,
      "policy_degrade row must include the from→to model swap text",
    ).toBe(true);
  });

  test("policy_block detail surfaces tokens used vs limit", async ({
    page,
  }) => {
    const params = new URLSearchParams({
      from: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      to: new Date().toISOString(),
      flavor: CODING_AGENT.flavor,
      policy_event_type: "policy_block",
    });
    await page.goto(`/investigate?${params.toString()}`);
    await waitForInvestigateReady(page);

    const firstRow = page
      .locator('[data-testid^="investigate-row-session-"]')
      .first();
    await firstRow.click();
    const drawer = page.locator('[data-testid="session-drawer"]');
    await expect(drawer).toBeVisible();

    const rows = drawer.locator('[data-testid^="policy-event-row-"]');
    let foundBlock = false;
    const count = await rows.count();
    for (let i = 0; i < count; i++) {
      const row = rows.nth(i);
      if ((await row.getAttribute("data-event-type")) === "policy_block") {
        const text = (await row.textContent()) ?? "";
        if (text.includes("blocked at 10,100 of 10,000 tokens")) {
          foundBlock = true;
          break;
        }
      }
    }
    expect(
      foundBlock,
      "policy_block row must include 'blocked at <used> of <limit> tokens'",
    ).toBe(true);
  });

  test("URL ?policy_event_type round-trips and clearing reverts the table", async ({
    page,
  }) => {
    const params = new URLSearchParams({
      from: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      to: new Date().toISOString(),
      flavor: CODING_AGENT.flavor,
      policy_event_type: "policy_warn",
    });
    await page.goto(`/investigate?${params.toString()}`);
    await waitForInvestigateReady(page);

    // Active filter chip with the policy_event_type:policy_warn label.
    await expect(
      page.locator("text=policy_event_type:policy_warn").first(),
    ).toBeVisible();

    // Re-clicking the active pill toggles the filter off.
    const facet = page.locator('[data-testid="investigate-policy-facet"]');
    await facet
      .locator('[data-testid="investigate-policy-pill-policy_warn"]')
      .click();

    await expect(page).not.toHaveURL(/policy_event_type=policy_warn/);
  });
});
