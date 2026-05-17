/**
 * T56 — Every sub-agent swimlane row renders at least one event
 * circle on the live stack.
 *
 * Regression guard for the Phase 2 Fold-A windowing fix. The
 * ``AgentSummary.recent_sessions`` rollup on ``/v1/fleet`` carries
 * each agent's most-recent sessions independent of the paginated
 * ``/v1/sessions`` page; the swimlane row reads its event circles
 * from those sessions via the merge in
 * ``dashboard/src/store/fleet.ts::buildFlavors``.
 *
 * Pre-fix shape of the bug: 16 of 17 sub-agent rows had
 * ``data-topology="child"`` but rendered with zero event circles
 * regardless of which time window the operator selected, because
 * ``buildFlavors`` couldn't find sessions for them in the
 * paginated ``/v1/sessions`` page. The fix attaches a
 * ``recent_sessions`` rollup on /v1/fleet so each row's session
 * slice is always populated; rendering then becomes a function
 * of the operator-selected time range.
 *
 * The test widens the time picker to ``1h`` before scanning so
 * every seeded sub-agent fixture's events fall inside the
 * visible window. The default time range on page load is ``1m``
 * (live-monitor view); closed sub-agent rows legitimately
 * render empty at that default — the operator widens the
 * picker to see history.
 *
 * The assertion is positive on every canonical sub-agent row
 * (``data-testid`` prefixed with ``swimlane-agent-row-e2e-test-``).
 * Real-world sub-agent rows that landed in the dev DB outside
 * the seed (e.g. operator-invoked Claude Code Task subagents)
 * are not part of the canonical contract and are tolerated.
 *
 * Theme-agnostic; runs under both projects via the Playwright
 * project matrix.
 */
import { test, expect } from "@playwright/test";
import { waitForFleetReady } from "./_fixtures";

// Tall viewport so every seeded sub-agent row materialises
// simultaneously. The default viewport virtualises rows past the
// bottom edge; the regression guard must scan every child row, not
// just the visible-by-default subset.
test.use({ viewport: { width: 1280, height: 2200 } });

test.describe("T56 — Every sub-agent row renders circles", () => {
  test("every visible data-topology=child row has at least one session circle", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForFleetReady(page);

    // Widen the swimlane window to ``1h`` before scanning. The
    // default time range on page load is ``1m`` (live-monitor
    // view); closed sub-agent fixtures whose events sit at
    // NOW-2m to NOW-7m legitimately render with no circles in
    // that window. The ``recent_sessions`` rollup contract is
    // about data availability — when the operator widens the
    // picker, every canonical sub-agent row must surface its
    // circles from the embedded slice without a follow-up
    // fetch. The button label "1h" is the picker's widest
    // option and reliably covers every canonical fixture.
    await page.getByRole("button", { name: "1h" }).click();

    // The fleet sometimes lazily materialises rows as they scroll
    // into the IntersectionObserver-tracked band. Scroll the whole
    // swimlane top → bottom in chunks so every row mounts before
    // the assertion fires.
    await page.evaluate(async () => {
      const scroller =
        document.querySelector('[data-testid="swimlane-scroll"]') ??
        document.scrollingElement;
      if (!scroller) return;
      const total = scroller.scrollHeight;
      const step = window.innerHeight * 0.8;
      for (let y = 0; y <= total; y += step) {
        scroller.scrollTop = y;
        await new Promise((r) => requestAnimationFrame(() => r(null)));
      }
      scroller.scrollTop = 0;
    });

    // Wait for at least one child row before scanning — the seed
    // declares several sub-agent fixtures and the keep-alive cycle
    // keeps them in the swimlane window.
    const childRows = page.locator('[data-topology="child"]');
    await expect
      .poll(async () => childRows.count(), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(1);

    // Restrict the assertion target to canonical seeded
    // sub-agent fixtures (data-testid prefixed with
    // ``swimlane-agent-row-e2e-test-``). Real-world sub-agent
    // rows that landed in the dev DB outside the seed
    // (e.g. operator-invoked Claude Code Task subagents) are
    // tolerated even if their rows render empty — those
    // sessions are not part of the canonical fixture contract.
    // The recent_sessions rollup is still verified for them
    // via the integration test ``test_fleet_recent_sessions.py``.
    const canonicalChildRows = page.locator(
      '[data-topology="child"][data-testid^="swimlane-agent-row-e2e-test-"]',
    );
    await expect
      .poll(async () => canonicalChildRows.count(), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(1);

    // Wait for every canonical child row to attach its first
    // session circle. One shared 25 s deadline rather than
    // per-row waits (17 × 8 s would exceed the 30 s test
    // timeout). The bulk-scroll pass above primed the
    // IntersectionObserver; this gate waits for the parallel
    // /v1/sessions/:id event fetches to settle.
    await page
      .waitForFunction(
        () => {
          const rows = document.querySelectorAll(
            '[data-topology="child"][data-testid^="swimlane-agent-row-e2e-test-"]',
          );
          if (rows.length === 0) return false;
          for (const row of rows) {
            const circle = row.querySelector(
              '[data-testid^="session-circle-"]',
            );
            if (!circle) return false;
          }
          return true;
        },
        undefined,
        { timeout: 25_000 },
      )
      .catch(() => {
        // Settle window expired; the next loop records empties.
      });

    const canonicalCount = await canonicalChildRows.count();
    const empties: string[] = [];
    for (let i = 0; i < canonicalCount; i++) {
      const row = canonicalChildRows.nth(i);
      const agentId =
        (await row.getAttribute("data-agent-id")) ?? `index-${i}`;
      const circleCount = await row
        .locator('[data-testid^="session-circle-"]')
        .count();
      if (circleCount === 0) empties.push(agentId);
    }
    expect(
      empties,
      `canonical sub-agent rows rendered with zero session circles: ` +
        `${empties.join(", ")}. The recent_sessions rollup must surface ` +
        `event circles for every seeded sub-agent row regardless of where ` +
        `its sessions fall in the global /v1/sessions page.`,
    ).toEqual([]);
  });
});
