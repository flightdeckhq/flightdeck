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

  test("badge wrapper paints the row tint exactly on child rows (no grey rectangle)", async ({
    page,
  }) => {
    // Regression guard: the wrapper used to paint
    // ``background: inherit`` which resolved to a subtly
    // different shade than the row container's
    // ``var(--swimlane-row-child-bg)``, reading as an ugly
    // grey rectangle around the Active / Closed badge on every
    // child row. The fix keys the wrapper's background
    // directly off ``topology`` so the painted shade matches
    // the row tint pixel-for-pixel.
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

    const colors = await page.evaluate(() => {
      const wrapper = document.querySelector(
        '[data-testid^="swimlane-agent-row-"][data-topology="child"] [data-testid="swimlane-badge-wrapper"]',
      ) as HTMLElement | null;
      const row = wrapper?.closest(
        '[data-testid^="swimlane-agent-row-"]',
      ) as HTMLElement | null;
      return {
        wrapper: wrapper ? window.getComputedStyle(wrapper).backgroundColor : "",
        row: row ? window.getComputedStyle(row).backgroundColor : "",
      };
    });
    expect(colors.wrapper).not.toBe("");
    expect(colors.wrapper).toBe(colors.row);
  });

  test("bottom-anchored run-bracket tooltip anchors to its button's bottom", async ({
    page,
  }) => {
    // Concurrent-runs fixture has two overlapping runs so its
    // row carries one top-anchored and one bottom-anchored
    // bracket. Hover the bottom-anchored one and assert the
    // tooltip's bottom edge does not extend below the row.
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
    // never renders programmatically. Live verification of the
    // anchor-flip fix is via Cowork's Chrome V-pass; this E2E
    // check passes when Playwright's mouse simulation latches
    // and confirms the assertion ``tooltip.bottom <= row.bottom``.
    await brackets.nth(bottomBracketIndex).hover({ force: true });
    const tooltip = page
      .locator('[data-testid^="swimlane-run-bracket-tooltip-"]')
      .first();
    await expect(tooltip).toBeVisible({ timeout: 5_000 });

    // Tooltip's bottom must NOT extend past the row's bottom
    // (which would mean the tooltip is anchored from top:0 of a
    // bottom-positioned bracket — the pre-fix bug).
    const rowBox = await row.boundingBox();
    const tipBox = await tooltip.boundingBox();
    expect(rowBox).not.toBeNull();
    expect(tipBox).not.toBeNull();
    expect(tipBox!.y + tipBox!.height).toBeLessThanOrEqual(
      rowBox!.y + rowBox!.height + 1,
    );
  });
});
