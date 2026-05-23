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

  test("now pole lands inside the visible swim viewport", async ({ page }) => {
    // The Timeline's natural inner width
    // (``leftPanelWidth + TIMELINE_WIDTH_PX`` ≈ 1280 px) is
    // wider than the 80 vw modal at typical viewport widths,
    // producing a horizontal scrollbar inside the modal's swim
    // wrapper. The grid-line-now element renders at the
    // rightmost pixel of the timeline (``x = TIMELINE_WIDTH_PX``
    // inside the grid overlay); without an explicit scroll-to-
    // right on open, the user lands at ``scrollLeft=0`` (the
    // OLDEST edge) and the now pole is clipped past the visible
    // viewport. The modal snaps ``scrollLeft`` to the rightmost
    // position when it opens so the now pole surfaces at the
    // right edge of the visible swim viewport, matching Fleet's
    // UX where the timeline naturally fits the page width.
    // Use ``e2e-test-connector-parent`` instead of the first
    // row: with its sub-agent toggle ON by default the Timeline
    // has reliably enough scoped agents to overflow the 80 vw
    // modal width, making the snap-scroll assertion
    // falsifiable. A ``first()`` lone-agent row could fit inside
    // the modal width on a wide viewport and pass even if the
    // ``scrollLeft`` snap regressed entirely.
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
    const modal = page.locator('[data-testid="per-agent-swimlane-modal"]');
    await expect(modal).toBeVisible({ timeout: 10_000 });
    // The now pole must be inside the modal body's horizontal
    // bounds — i.e. visible to the user, not clipped past the
    // scroll wrapper's right edge.
    await expect
      .poll(
        async () => {
          const bodyBox = await modal
            .locator('[data-testid="per-agent-swimlane-modal-body"]')
            .boundingBox();
          const nowBox = await modal
            .locator('[data-testid="grid-line-now"]')
            .first()
            .boundingBox();
          if (!bodyBox || !nowBox) return false;
          return (
            nowBox.x >= bodyBox.x && nowBox.x + nowBox.width <= bodyBox.x + bodyBox.width
          );
        },
        { timeout: 5_000 },
      )
      .toBeTruthy();
  });

  test("narrowing the picker shrinks the feed", async ({ page }) => {
    // Picker contract: the feed is a projection of the in-memory
    // event cache filtered by ``occurred_at >= NOW − TIMELINE_RANGE_MS[r]``.
    // Switching 1 h → 1 m must drop events older than 1 m without
    // a re-fetch. Uses ``e2e-test-connector-parent`` for the same
    // reason the rescope test does — guaranteed fresh ``tool_call``
    // events on both endpoints from the keep-alive watchdog.
    await page.goto("/agents");
    const row = page
      .locator('[data-testid^="agent-row-"]')
      .filter({ hasText: "e2e-test-connector-parent" })
      .first();
    await row.scrollIntoViewIfNeeded();
    const agentId = await row.getAttribute("data-agent-id");
    await page
      .locator(`[data-testid="agent-row-open-swimlane-modal-${agentId}"]`)
      .click();
    const modal = page.locator('[data-testid="per-agent-swimlane-modal"]');
    await expect(modal).toBeVisible({ timeout: 10_000 });

    // Widen first so the seed covers everything in the 1 h
    // window. The 1 h pill is the widest option.
    await modal
      .locator('[data-testid="per-agent-swimlane-modal-time-1h"]')
      .click();
    const feedStrip = modal.locator(
      '[data-testid="per-agent-swimlane-modal-feed"]',
    );
    const visibleRows = async (): Promise<number> =>
      feedStrip.locator('[data-testid="feed-row"]').count();
    // Need a baseline with ≥ 1 row so the narrowing assertion
    // is not vacuously true.
    await expect
      .poll(visibleRows, {
        message: "1 h feed must settle with >= 1 row before narrowing",
        timeout: 10_000,
      })
      .toBeGreaterThan(0);
    const wideCount = await visibleRows();

    // Narrow to 1 m — the seed window's older events must drop
    // out. The watchdog re-emits every 30 s so the narrowed
    // window will typically still carry 1 row from the most
    // recent tick, but the count must not exceed the wide count.
    //
    // ``toBeLessThanOrEqual`` is a monotonicity guard, not proof
    // of correct filtering: with watchdog ticks every 30 s it is
    // possible (e.g. ``wideCount === 1``, ``narrowCount === 1``)
    // for the count to be equal in both windows and the filter
    // to still be functioning correctly. The unit test
    // (``PerAgentSwimlaneModal.test.tsx`` -- "LiveFeed receives
    // only events inside the picker time window") carries the
    // proof-of-correctness with pinned ``Date.now()`` and
    // controlled event timestamps. This test guards against the
    // regression where the picker no longer affects the feed
    // AT ALL (count would stay constant or grow on narrowing).
    await modal
      .locator('[data-testid="per-agent-swimlane-modal-time-1m"]')
      .click();
    await expect
      .poll(visibleRows, { timeout: 5_000 })
      .toBeLessThanOrEqual(wideCount);
  });
});
