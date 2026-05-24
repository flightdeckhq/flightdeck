import { test, expect } from "@playwright/test";
import {
  TRUNCATION_AGENT,
  bringSwimlaneRowIntoView,
  waitForFleetReady,
} from "./_fixtures";

// T92 — swimlane agent-name link uses ellipsis truncation with an
// always-on ``title`` tooltip carrying the full name. Pre-Fix-2 the
// link inherited ``white-space: normal`` from its flex ancestor
// and either wrapped or hard-clipped the name at narrow column
// widths. Fix 2 puts the ellipsis styles + title directly on the
// link so the user contract is single-shape:
//
//   * Computed style ``white-space: nowrap`` (never wrap).
//   * Computed style ``text-overflow: ellipsis`` (clean
//     character-by-character clip with the ellipsis glyph).
//   * Computed style ``overflow: hidden`` (the prerequisite for
//     text-overflow to engage).
//   * Native ``title`` attribute equal to the full agent name —
//     unconditional, so a hover reveals the complete value at
//     ANY column width, not just when truncated.
//
// The 70-char TRUNCATION_AGENT name overflows even at the new
// 460-px DEFAULT, so the ellipsis path is exercised on the
// out-of-the-box column width — no manual narrowing required.
test.describe("T92 — Swimlane agent-name link ellipsis + title tooltip", () => {
  test("link has nowrap + ellipsis + overflow:hidden + always-on title", async ({
    page,
  }) => {
    // Default column width — the long-name fixture overflows at
    // 460 px so the ellipsis is rendered without a manual resize.
    await page.addInitScript(() => {
      localStorage.removeItem("flightdeck-left-panel-width");
    });
    await page.goto("/");
    await waitForFleetReady(page);

    const row = await bringSwimlaneRowIntoView(page, TRUNCATION_AGENT.name);
    await expect(row).toBeVisible();

    const link = row.locator('[data-testid="swimlane-agent-name-link"]');
    await expect(link).toBeVisible();

    // Computed styles — assert the three properties that define
    // the ellipsis contract. ``getComputedStyle`` returns the
    // resolved value (e.g. ``ellipsis``, not the shorthand
    // ``clip ellipsis``), so a direct string match is safe.
    const styles = await link.evaluate((el) => {
      const cs = window.getComputedStyle(el);
      return {
        whiteSpace: cs.whiteSpace,
        textOverflow: cs.textOverflow,
        overflow: cs.overflow,
      };
    });
    expect(styles.whiteSpace).toBe("nowrap");
    expect(styles.textOverflow).toBe("ellipsis");
    // ``overflow`` resolves to the shorthand (``overflow-x`` +
    // ``overflow-y`` both ``hidden``) on most engines. Accept
    // either the single-value form or the shorthand expansion.
    expect(styles.overflow.split(/\s+/)[0]).toBe("hidden");

    // Title attribute — must be the full agent name. Poll on
    // the getAttribute so a one-tick lag between mount and the
    // assertion doesn't flake the spec.
    await expect
      .poll(async () => link.getAttribute("title"), { timeout: 5_000 })
      .toBe(TRUNCATION_AGENT.name);

    // The rendered text inside the link is truncated by the
    // browser (scrollWidth > clientWidth). Locking this in
    // ensures the assertion on computed styles isn't passing
    // trivially while the text still fits.
    const overflow = await link.evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeGreaterThan(overflow.clientWidth);
  });
});
