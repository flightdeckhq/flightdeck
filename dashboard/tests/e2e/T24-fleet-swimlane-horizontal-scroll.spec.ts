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

  test("expanded session-row left columns stay sticky across horizontal scroll", async ({
    page,
  }) => {
    // Pre-fix on PR #29: the swimlane-expanded-body wrapper used
    // overflow:hidden, which trapped sticky descendants in a zero-
    // scroll context. Session sequence numbers and token-count
    // pills drifted by exactly scrollLeft pixels (-460 at max
    // scroll on a 1280-wide viewport). This test pins the agent
    // header AND a session row's left columns at the same
    // viewport x at three scroll positions; the spread must stay
    // ≤ 1 px or sticky has regressed.
    await page.setViewportSize(NARROW_VIEWPORT);
    await page.goto(`/?flavor=${CODING_AGENT.flavor}`);
    await waitForFleetReady(page);

    const agentRow = await bringSwimlaneRowIntoView(page, CODING_AGENT.name);
    await expect(agentRow).toBeVisible();
    // Click the left-panel chevron, not the row's geometric center
    // — under narrow viewports the center can land on an event
    // circle whose onClick stops propagation (T5 uses the same
    // workaround).
    await agentRow.click({ position: { x: 10, y: 20 } });
    // Expansion fires a maxHeight transition; wait for the
    // expanded-body to paint its rows before sampling positions.
    const sessionIndex = page
      .locator('[data-testid="session-row-index"]')
      .first();
    await expect(sessionIndex).toBeVisible();

    const scroll = page.locator('[data-testid="fleet-main-scroll"]');
    const sample = async () => {
      const headerLeft = await agentRow.evaluate((el) => {
        const child = el.firstElementChild as HTMLElement | null;
        return child ? child.getBoundingClientRect().left : NaN;
      });
      const sessionLeft = await sessionIndex.evaluate((el) => {
        const col = el.parentElement;
        return col ? col.getBoundingClientRect().left : NaN;
      });
      return { headerLeft, sessionLeft };
    };

    await scroll.evaluate((el) => {
      el.scrollLeft = 0;
    });
    const atZero = await sample();

    await scroll.evaluate((el) => {
      el.scrollLeft = el.scrollWidth;
    });
    const atMax = await sample();

    await scroll.evaluate((el) => {
      el.scrollLeft = Math.floor((el.scrollWidth - el.clientWidth) / 2);
    });
    const atMid = await sample();

    // 2 px tolerance accommodates the sub-pixel offset between
    // sticky-active (scrollLeft > 0, position pinned to the scroll
    // viewport edge) and sticky-inactive (scrollLeft === 0, sitting
    // at its natural row-content origin). Drift larger than 2 px
    // means the column is moving with content -- the regression
    // class this test guards against.
    const STICKY_TOLERANCE_PX = 2;

    // Header column stays put.
    expect(
      Math.abs(atZero.headerLeft - atMax.headerLeft),
    ).toBeLessThanOrEqual(STICKY_TOLERANCE_PX);
    expect(
      Math.abs(atZero.headerLeft - atMid.headerLeft),
    ).toBeLessThanOrEqual(STICKY_TOLERANCE_PX);

    // Session column stays put.
    expect(
      Math.abs(atZero.sessionLeft - atMax.sessionLeft),
    ).toBeLessThanOrEqual(STICKY_TOLERANCE_PX);
    expect(
      Math.abs(atZero.sessionLeft - atMid.sessionLeft),
    ).toBeLessThanOrEqual(STICKY_TOLERANCE_PX);

    // Header column and session column pin at the SAME viewport x
    // at every scroll position — they share the sticky-left
    // anchor (Fleet's main scroll container).
    expect(
      Math.abs(atZero.sessionLeft - atZero.headerLeft),
    ).toBeLessThanOrEqual(STICKY_TOLERANCE_PX);
    expect(
      Math.abs(atMax.sessionLeft - atMax.headerLeft),
    ).toBeLessThanOrEqual(STICKY_TOLERANCE_PX);

    // Sanity: at scrollLeft=max the session column's left edge is
    // INSIDE the visible viewport, not drifted off-screen. Pre-fix,
    // at scrollLeft=460 the session sequence number landed at
    // x=-111 (drifted exactly scrollLeft pixels off the left edge).
    expect(atMax.sessionLeft).toBeGreaterThanOrEqual(0);
    expect(atMax.sessionLeft).toBeLessThan(NARROW_VIEWPORT.width);
  });

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
