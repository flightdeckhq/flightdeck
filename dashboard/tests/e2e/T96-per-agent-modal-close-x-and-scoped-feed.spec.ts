import { test, expect } from "@playwright/test";

/**
 * T96 — per-agent swimlane modal: close X + scoped LiveFeed.
 *
 * The polish move on the modal:
 *
 *   1. Explicit close X in the header. Outside-click / Esc keep
 *      working (Radix Dialog's onOpenChange), but the X is the
 *      operator's visible affordance.
 *   2. LiveFeed strip below the swimlane body, scoped to the
 *      same flavor set the lanes use. Toggling Show sub-agents
 *      rescopes BOTH the lanes and the feed in lockstep.
 *
 * Fixtures used:
 *   * ``e2e-test-connector-parent`` (parent topology with
 *     ``fresh-subagent-in-window`` as its sub-agent) — used for
 *     the scope-toggle assertion. Both endpoints are the
 *     SubAgentConnector anchor (T34) and receive fresh
 *     ``tool_call`` events from the Playwright globalSetup
 *     keep-alive watchdog every 30 s, so the modal's 1 h
 *     historical seed reliably carries in-scope rows from
 *     both endpoints. Other parent fixtures (crewai-parent
 *     etc.) only get a SQL ``last_seen_at`` pin from the
 *     watchdog, not fresh events.
 *
 * Theme-agnostic; runs under both Playwright projects.
 */
test.describe("T96 — per-agent modal: close X + scoped LiveFeed", () => {
  test("close X dismisses the modal", async ({ page }) => {
    await page.goto("/agents");
    await expect(
      page.locator('[data-testid^="agent-row-"]').first(),
    ).toBeVisible({ timeout: 10_000 });
    // Open the modal from any row's STATUS chip.
    const firstRow = page.locator('[data-testid^="agent-row-"]').first();
    const agentId = await firstRow.getAttribute("data-agent-id");
    expect(agentId).toBeTruthy();
    await page
      .locator(`[data-testid="agent-row-open-swimlane-modal-${agentId}"]`)
      .click();
    const modal = page.locator(
      '[data-testid="per-agent-swimlane-modal"]',
    );
    await expect(modal).toBeVisible({ timeout: 10_000 });

    // Close X is in the header, top-right, with the documented
    // aria-label. Click closes the modal — Radix's onOpenChange
    // path drives the parent's onClose.
    const closeX = page.locator(
      '[data-testid="per-agent-swimlane-modal-close"]',
    );
    await expect(closeX).toBeVisible();
    await expect(closeX).toHaveAttribute(
      "aria-label",
      "Close per-agent swimlane modal",
    );
    await closeX.click();
    await expect(modal).toHaveCount(0);
  });

  test("LiveFeed strip mounts inside the modal body", async ({ page }) => {
    await page.goto("/agents");
    await expect(
      page.locator('[data-testid^="agent-row-"]').first(),
    ).toBeVisible({ timeout: 10_000 });
    const firstRow = page.locator('[data-testid^="agent-row-"]').first();
    const agentId = await firstRow.getAttribute("data-agent-id");
    await page
      .locator(`[data-testid="agent-row-open-swimlane-modal-${agentId}"]`)
      .click();
    const modal = page.locator(
      '[data-testid="per-agent-swimlane-modal"]',
    );
    await expect(modal).toBeVisible({ timeout: 10_000 });
    // The feed strip is the dedicated mount point inside the
    // modal body. Presence here confirms the scoped-feed
    // pipeline is wired all the way through; the toggle test
    // below exercises rescoping semantics.
    await expect(
      modal.locator('[data-testid="per-agent-swimlane-modal-feed"]'),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("toggling Show sub-agents rescopes the feed in lockstep with the lanes", async ({
    page,
  }) => {
    // Land on /agents, open the connector-parent modal. This
    // fixture is the SubAgentConnector anchor (T34): the
    // Playwright globalSetup keep-alive watchdog re-emits a
    // fresh ``tool_call`` event every 30 s on BOTH endpoints
    // (the parent's ``connector-parent-fresh`` session + the
    // child's ``fresh-subagent-in-window`` session), so the
    // modal's 1 h historical feed reliably carries in-scope
    // rows from both the parent and the sub-agent. Other
    // parent fixtures (crewai-parent etc.) only get a SQL
    // ``last_seen_at`` pin from the watchdog, not fresh
    // events, so their feed can collapse to zero after the
    // dev stack has been up >1 h and the strict
    // "feed >= 1 row before recording baseline" guard below
    // would time out.
    await page.goto("/agents");
    const row = page
      .locator('[data-testid^="agent-row-"]')
      .filter({ hasText: "e2e-test-connector-parent" })
      .first();
    await row.scrollIntoViewIfNeeded();
    await expect(row).toBeVisible({ timeout: 10_000 });
    const agentId = await row.getAttribute("data-agent-id");
    await page
      .locator(`[data-testid="agent-row-open-swimlane-modal-${agentId}"]`)
      .click();

    const modal = page.locator(
      '[data-testid="per-agent-swimlane-modal"]',
    );
    await expect(modal).toBeVisible({ timeout: 10_000 });
    // Click the 1h time-range pill so any seeded fixture events
    // fall inside the historical window the feed seeds from.
    await modal.locator('[data-testid="per-agent-swimlane-modal-time-1h"]').click();
    const feedStrip = modal.locator(
      '[data-testid="per-agent-swimlane-modal-feed"]',
    );
    await expect(feedStrip).toBeVisible();

    const toggle = modal.locator(
      '[data-testid="per-agent-swimlane-modal-show-sub-agents-input"]',
    );
    // Parent default ON — wait for the on-state feed to settle
    // with at least one row before recording the baseline. A
    // bare ``await visibleFlavors()`` immediately after the
    // time-range click could capture an unresolved 0-count and
    // make the later "off <= on" assertion vacuously true.
    await expect(toggle).toBeChecked();
    // ``LiveFeed`` is div-based, not a real <table>; each row
    // carries data-testid="feed-row".
    const visibleFlavors = async (): Promise<number> => {
      return feedStrip.locator('[data-testid="feed-row"]').count();
    };
    await expect
      .poll(visibleFlavors, {
        message:
          "feed must settle with >= 1 in-scope row before testing rescope",
        timeout: 10_000,
      })
      .toBeGreaterThan(0);
    const onCount = await visibleFlavors();

    // Toggle OFF — only the parent flavor remains in scope. The
    // feed re-derives off ``scopedFlavorIds`` so its row count
    // must drop (or at minimum not increase) relative to the
    // ON state.
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await expect
      .poll(visibleFlavors, { timeout: 5_000 })
      .toBeLessThanOrEqual(onCount);
  });
});
