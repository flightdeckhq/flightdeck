import { test, expect } from "@playwright/test";
import {
  CODING_AGENT,
  bringSwimlaneRowIntoView,
  waitForFleetReady,
} from "./_fixtures";

// T24 — Phase 4.5 S-SWIM-1..5: at narrow viewports the Fleet
// swimlane gets a horizontal scrollbar, lands the user on "now"
// (rightmost) on mount, exposes fade-out gradients on the
// scrollable edges, keeps the agent-name column sticky as the
// timeline scrolls under it, and accepts ArrowLeft / ArrowRight
// keyboard navigation. The bug this fixes was a dead-end UX class:
// pre-fix the ``overflow-x: hidden`` on Fleet's main-content div
// silently amputated the older end of the timeline at viewports
// where leftPanelWidth + 900px exceeded the available width
// (typical MacBook screens at 1280-1440px).

const NARROW_VIEWPORT = { width: 1280, height: 800 };

test.describe("T24 — Fleet swimlane horizontal scroll", () => {
  test("swimlane is scrollable horizontally and lands rightmost on mount", async ({
    page,
  }) => {
    await page.setViewportSize(NARROW_VIEWPORT);
    await page.goto(`/?flavor=${CODING_AGENT.flavor}`);
    await waitForFleetReady(page);

    const scroll = page.locator('[data-testid="fleet-main-scroll"]');
    await expect(scroll).toBeVisible();

    // Container actually overflows at this viewport.
    const geom = await scroll.evaluate((el) => ({
      scrollLeft: el.scrollLeft,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));
    expect(geom.scrollWidth).toBeGreaterThan(geom.clientWidth);

    // Initial scrollLeft is at the rightmost edge ("now"). Browsers
    // round scrollLeft slightly differently when the container is
    // pinned at scrollWidth, so allow up to 2 px of slack.
    const maxScrollLeft = geom.scrollWidth - geom.clientWidth;
    expect(Math.abs(geom.scrollLeft - maxScrollLeft)).toBeLessThanOrEqual(2);

    // Right fade hidden (already at the right edge); left fade
    // visible (older content scrolled out to the left).
    await expect(
      page.locator('[data-testid="swimlane-fade-right"]'),
    ).toHaveCount(0);
    await expect(
      page.locator('[data-testid="swimlane-fade-left"]'),
    ).toBeVisible();
  });

  test("scrolling left exposes older content and flips the fades", async ({
    page,
  }) => {
    await page.setViewportSize(NARROW_VIEWPORT);
    await page.goto(`/?flavor=${CODING_AGENT.flavor}`);
    await waitForFleetReady(page);

    const scroll = page.locator('[data-testid="fleet-main-scroll"]');
    await scroll.evaluate((el) => {
      el.scrollLeft = 0;
    });
    // The hook's onscroll listener is async-ish; wait for the fade
    // overlays to update via the rendered DOM rather than polling
    // scrollLeft directly.
    await expect(
      page.locator('[data-testid="swimlane-fade-right"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="swimlane-fade-left"]'),
    ).toHaveCount(0);

    const after = await scroll.evaluate((el) => el.scrollLeft);
    expect(after).toBe(0);
  });

  test("agent-name column stays put while the timeline scrolls under it", async ({
    page,
  }) => {
    await page.setViewportSize(NARROW_VIEWPORT);
    await page.goto(`/?flavor=${CODING_AGENT.flavor}`);
    await waitForFleetReady(page);

    // Scroll the swimlane until the coding-agent row is mounted —
    // the seeded D126 fixture set adds 12+ extra agent rows so
    // the IntersectionObserver virtualizer no longer renders
    // every agent on initial mount at narrow viewport.
    const row = await bringSwimlaneRowIntoView(page, CODING_AGENT.name);
    await expect(row).toBeVisible();

    // The sticky agent-name column is the row's first child div
    // (Timeline.tsx line 184 — position:sticky;left:0). Capture its
    // viewport-relative left, scroll the container, and assert the
    // sticky column has not moved horizontally.
    const stickyLeftBefore = await row.evaluate((el) => {
      const child = el.firstElementChild as HTMLElement | null;
      return child ? child.getBoundingClientRect().left : NaN;
    });

    const scroll = page.locator('[data-testid="fleet-main-scroll"]');
    await scroll.evaluate((el) => {
      el.scrollLeft = 0;
    });

    const stickyLeftAfter = await row.evaluate((el) => {
      const child = el.firstElementChild as HTMLElement | null;
      return child ? child.getBoundingClientRect().left : NaN;
    });

    expect(Number.isFinite(stickyLeftBefore)).toBe(true);
    expect(Number.isFinite(stickyLeftAfter)).toBe(true);
    expect(Math.abs(stickyLeftAfter - stickyLeftBefore)).toBeLessThanOrEqual(1);
  });

  // The "expanded session-row left columns stay sticky across
  // horizontal scroll" test was removed alongside the swimlane
  // expand-row affordance. The agent-header sticky-left
  // regression guard above still covers the sticky-column
  // invariant for the single-row-per-agent layout.

  test("ArrowRight from the leftmost edge scrolls the swimlane right", async ({
    page,
  }) => {
    await page.setViewportSize(NARROW_VIEWPORT);
    await page.goto(`/?flavor=${CODING_AGENT.flavor}`);
    await waitForFleetReady(page);

    const scroll = page.locator('[data-testid="fleet-main-scroll"]');
    await scroll.evaluate((el) => {
      el.scrollLeft = 0;
    });
    await expect(
      page.locator('[data-testid="swimlane-fade-right"]'),
    ).toBeVisible();

    await scroll.focus();
    await page.keyboard.press("ArrowRight");

    // Smooth scroll resolves over a few frames; poll until scrollLeft
    // lands above zero rather than hardcoding a wait.
    await expect
      .poll(async () => scroll.evaluate((el) => el.scrollLeft), {
        timeout: 3000,
      })
      .toBeGreaterThan(0);
  });
});
