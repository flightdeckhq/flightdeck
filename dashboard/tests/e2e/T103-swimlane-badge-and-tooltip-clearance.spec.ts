import { test, expect } from "@playwright/test";

/**
 * T103 — swimlane right-edge clearance.
 *
 * Three regression guards bundled — each addresses a distinct
 * visual overlap reported on the Fleet swimlane:
 *
 *   1. AgentStatusBadge sits inside its label strip (no
 *      overflow past the strip's right edge / into the timeline
 *      panel area). The pre-fix ``ml-auto`` flex layout let a
 *      wide topology pill push the badge past the boundary; the
 *      fix anchors the badge ``position: absolute; right: 0``
 *      with a solid ``background: inherit`` so it always reads
 *      as a fully visible right-edge anchor on every row,
 *      including child rows whose 28-px indent narrows the
 *      available width.
 *   2. The leftmost event circles sit inset from the timeline
 *      panel's left edge by ``TIMELINE_LEFT_BUFFER_PX`` (8 px)
 *      so circles never crowd the badge boundary.
 *   3. Run-bracket tooltips on bottom-anchored brackets (
 *      concurrent runs staggered to the row's bottom half) flip
 *      their anchor to ``bottom: 0`` so they extend UPWARD into
 *      the row rather than DOWNWARD past it (where the timeline
 *      panel's ``overflow: hidden`` would clip them).
 *
 * Theme-agnostic.
 */
test.describe("T103 — swimlane right-edge clearance", () => {
  test("AgentStatusBadge stays inside the label strip on child rows", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1700, height: 900 });
    await page.goto("/");
    await page.waitForSelector('[data-testid="fleet-main-scroll"]', {
      timeout: 10_000,
    });
    // The virtualized swimlane can unmount rows mid-scroll, so
    // read both rects in one ``page.evaluate`` snapshot —
    // avoids the flake where ``scrollIntoViewIfNeeded`` racing
    // with virtualization detaches the element between calls.
    // Any child-topology row works as the regression guard.
    await expect
      .poll(
        () =>
          page
            .locator(
              '[data-testid^="swimlane-agent-row-"][data-topology="child"] [data-testid="swimlane-agent-status-badge"]',
            )
            .count(),
        { timeout: 10_000 },
      )
      .toBeGreaterThan(0);

    const rects = await page.evaluate(() => {
      const badge = document.querySelector(
        '[data-testid^="swimlane-agent-row-"][data-topology="child"] [data-testid="swimlane-agent-status-badge"]',
      ) as HTMLElement | null;
      const label = badge?.closest(
        ".swimlane-row-label",
      ) as HTMLElement | null;
      return {
        badge: badge?.getBoundingClientRect().toJSON() ?? null,
        label: label?.getBoundingClientRect().toJSON() ?? null,
      };
    });
    expect(rects.badge).not.toBeNull();
    expect(rects.label).not.toBeNull();
    // The badge's right edge must not extend past the label
    // strip's right edge. 1-px tolerance for sub-pixel
    // rounding.
    expect(rects.badge!.x + rects.badge!.width).toBeLessThanOrEqual(
      rects.label!.x + rects.label!.width + 1,
    );
  });

  test("event circles render inset from the panel's left edge", async ({
    page,
  }) => {
    // Buffer constant in SwimLane.tsx is 8 px. Circles at the
    // OLDEST visible time render at ``panel.left + buffer``
    // rather than flush against panel.left.
    await page.setViewportSize({ width: 1700, height: 900 });
    await page.goto("/");
    await page.waitForSelector('[data-testid="fleet-main-scroll"]', {
      timeout: 10_000,
    });
    // Poll until at least one session-circle has mounted inside
    // a swimlane row — replaces a fixed waitForTimeout (qa.md
    // hard rule: no fixed timeouts). The buffer geometry check
    // below operates on those circles' bounding rects, so this
    // wait guarantees the evaluate has data to read.
    await expect
      .poll(
        () =>
          page
            .locator(
              '[data-testid^="swimlane-agent-row-"] [data-testid^="session-circle-"]',
            )
            .count(),
        { timeout: 10_000 },
      )
      .toBeGreaterThan(0);

    const offset = await page.evaluate(() => {
      const rows = Array.from(
        document.querySelectorAll('[data-testid^="swimlane-agent-row-"]'),
      );
      for (const row of rows) {
        const panel = row.querySelector(
          '[data-testid="swimlane-timeline-panel"]',
        ) as HTMLElement | null;
        const circles = Array.from(
          row.querySelectorAll('[data-testid^="session-circle-"]'),
        ) as HTMLElement[];
        if (!panel || circles.length === 0) continue;
        const panelLeft = panel.getBoundingClientRect().left;
        // Find the leftmost circle in this row.
        const min = circles.reduce((m, c) => {
          const left = c.getBoundingClientRect().left;
          return Math.min(m, left);
        }, Infinity);
        return min - panelLeft;
      }
      return null;
    });

    expect(offset).not.toBeNull();
    // Leftmost circle must be at least 4 px inside the panel's
    // left edge (the buffer is 8 px; allow some headroom for
    // circles at xScale > 0).
    expect(offset!).toBeGreaterThanOrEqual(4);
  });

  test("badge wrapper is transparent on child rows (no double-stacked overlay)", async ({
    page,
  }) => {
    // Regression guard: ``--swimlane-row-child-bg`` is a
    // SEMI-TRANSPARENT overlay (rgba(255,255,255,0.06) under
    // neon-dark) painted on the row container AND inherited
    // by the label strip. If the badge wrapper paints the
    // same rgba a third time, the area shows as ~18 %
    // effective opacity vs the surrounding ~12 % — a visible
    // lighter rectangle around the Active / Closed badge.
    // The wrapper now carries NO own background — the
    // row + label strip's already-painted layer shows
    // through transparently.
    await page.setViewportSize({ width: 1700, height: 900 });
    await page.goto("/");
    await page.waitForSelector('[data-testid="fleet-main-scroll"]', {
      timeout: 10_000,
    });
    // Wait for at least one child row's badge wrapper to mount.
    // The virtualized swimlane can unmount rows mid-scroll, so
    // do the entire colour comparison inside a single
    // ``page.evaluate`` snapshot — read the wrapper + row in one
    // pass so the closest() / getComputedStyle calls operate on
    // a stable DOM tree.
    await expect
      .poll(
        () =>
          page
            .locator(
              '[data-testid^="swimlane-agent-row-"][data-topology="child"] [data-testid="swimlane-badge-wrapper"]',
            )
            .count(),
        { timeout: 10_000 },
      )
      .toBeGreaterThan(0);

    const wrapperBg = await page.evaluate(() => {
      const wrapper = document.querySelector(
        '[data-testid^="swimlane-agent-row-"][data-topology="child"] [data-testid="swimlane-badge-wrapper"]',
      ) as HTMLElement | null;
      return wrapper ? window.getComputedStyle(wrapper).backgroundColor : "";
    });
    // Transparent computes to ``rgba(0, 0, 0, 0)``. Anything
    // else means the wrapper is painting a layer on top of the
    // row's existing layer — the failure mode that produced
    // the visible rectangle.
    expect(wrapperBg).toBe("rgba(0, 0, 0, 0)");
  });

  test("run-bracket tooltip renders position:fixed and escapes the timeline panel's overflow clip", async ({
    page,
  }) => {
    // The 20 s poll inside this test plus the surrounding setup
    // tip past Playwright's 30 s per-test default under 4-workers
    // parallel pressure occasionally. Extend the budget so a
    // genuine race surfaces as the poll's "expected 'fixed'"
    // failure rather than a confusing per-test-timeout exhaust.
    test.setTimeout(45_000);
    // The tooltip's ``position: fixed`` contract is bracket-
    // agnostic — every run-bracket tooltip uses fixed
    // positioning anchored to the bracket's viewport rect, so
    // hovering ANY bracket on ANY row verifies the same
    // contract. Pre-fix this test locked the assertion to a
    // specific row with two overlapping runs (concurrent-runs
    // fixture) to reach the bottom-anchored case; that case is
    // the original bug shape, but the position-fixed fix
    // applies uniformly. Decoupling the test from a specific
    // fixture row removes the keep-alive-watchdog drift
    // surface — runs can age out of the active window between
    // seed and assertion, leaving the concurrent-runs row
    // bracket-less, which was the historical clean-light
    // flake pattern.
    await page.setViewportSize({ width: 1700, height: 900 });
    await page.goto("/");
    // Wait for the swimlane to mount and render at least one
    // bracket. ``expect.toBeVisible`` on a global locator is
    // the cheapest precondition that proves brackets exist
    // somewhere in the swimlane.
    const anyBracket = page
      .locator('[data-testid^="swimlane-run-bracket-start-"]')
      .first();
    await expect(anyBracket).toBeVisible({ timeout: 15_000 });
    // The poll re-hovers the bracket and captures the
    // tooltip's computed ``position`` in the same browser
    // tick the tooltip is verified mounted; doing the read
    // OUTSIDE the poll races a swimlane re-render that can
    // unmount the tooltip between the poll exit and a
    // standalone ``evaluate`` call. ``page.evaluate`` returns
    // ``""`` when the tooltip element is absent so the poll
    // keeps retrying until it lands. React's synthetic
    // onMouseEnter requires ``.hover()`` —
    // ``dispatchEvent('mouseenter')`` does NOT fire it.
    const tooltip = page
      .locator('[data-testid^="swimlane-run-bracket-tooltip-"]')
      .first();
    await expect
      .poll(
        async () => {
          await anyBracket.hover({ force: true });
          return page.evaluate(() => {
            // Tooltip selector is duplicated here so the
            // function runs entirely in the browser frame and
            // the lookup + computed-style read happen in one
            // tick. Locator-based evaluate would re-resolve the
            // selector after the hover, opening a window for a
            // re-render to invalidate it.
            const el = document.querySelector(
              '[data-testid^="swimlane-run-bracket-tooltip-"]',
            );
            return el ? window.getComputedStyle(el).position : "";
          });
        },
        { timeout: 20_000 },
      )
      // Tooltip must render with ``position: fixed`` so it
      // escapes the timeline panel's ``overflow: hidden`` clip.
      // The fixed positioning is what lets it extend visually
      // past the 48 px row height. Pre-fix the tooltip was
      // ``position: absolute`` inside the panel and the overhang
      // got clipped.
      .toBe("fixed");
  });
});
