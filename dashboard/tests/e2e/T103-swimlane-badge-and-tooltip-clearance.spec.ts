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
    // Concurrent-runs fixture has two overlapping runs so its
    // row carries one top-anchored and one bottom-anchored
    // bracket. The bottom one's tooltip used to clip against
    // the timeline panel's ``overflow: hidden`` because the
    // tooltip (~56 px tall) doesn't fit in the row (48 px) —
    // either anchor direction lost ~10 px. The fix renders the
    // tooltip with ``position: fixed`` anchored to the
    // button's viewport rect, which escapes the panel clip.
    await page.setViewportSize({ width: 1700, height: 900 });
    await page.goto("/");
    const row = page
      .locator('[data-testid^="swimlane-agent-row-"]')
      .filter({ hasText: "e2e-test-concurrent-runs" })
      .first();
    await row.scrollIntoViewIfNeeded();
    await expect(row).toBeVisible({ timeout: 10_000 });

    // The two brackets sit at the same x position; one anchors
    // to the row's top half, the other to the bottom half. DOM
    // order doesn't reliably map to anchor (the order depends on
    // session sort + bracketAnchors logic), so pick by geometry:
    // the bracket with the higher viewport y is the
    // bottom-anchored one.
    const brackets = row.locator(
      '[data-testid^="swimlane-run-bracket-start-"]',
    );
    await expect(brackets).toHaveCount(2);
    const count = await brackets.count();
    let bottomBracketIndex = 0;
    let highestY = -Infinity;
    for (let i = 0; i < count; i++) {
      const box = await brackets.nth(i).boundingBox();
      if (box && box.y > highestY) {
        highestY = box.y;
        bottomBracketIndex = i;
      }
    }
    // Trigger React's ``onMouseEnter`` via ``.hover()`` —
    // ``dispatchEvent('mouseenter')`` does NOT fire React's
    // synthetic event handler in current React, so the tooltip
    // never renders programmatically. Wrap in ``expect.poll``
    // so the hover gets retried if the first attempt races
    // the swimlane's rAF tick.
    const tooltip = page
      .locator('[data-testid^="swimlane-run-bracket-tooltip-"]')
      .first();
    await expect
      .poll(
        async () => {
          await brackets.nth(bottomBracketIndex).hover({ force: true });
          return tooltip.count();
        },
        { timeout: 10_000 },
      )
      .toBeGreaterThan(0);

    // Tooltip must render with ``position: fixed`` so it
    // escapes the timeline panel's ``overflow: hidden`` clip.
    // The fixed positioning is what lets it extend visually
    // past the 48 px row height. Pre-fix the tooltip was
    // ``position: absolute`` inside the panel and the
    // overhang got clipped.
    const tooltipPosition = await tooltip.evaluate(
      (el) => window.getComputedStyle(el).position,
    );
    expect(tooltipPosition).toBe("fixed");
  });
});
