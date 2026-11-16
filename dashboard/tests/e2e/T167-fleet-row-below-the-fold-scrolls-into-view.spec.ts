/**
 * T167 — A swimlane row below the fold is found and scrolled into
 * view, and a row already mounted is scrolled to without a hunt.
 *
 * Covers the two paths of ``bringSwimlaneRowIntoView`` (_fixtures.ts),
 * which most swimlane specs use to reach their row. The swimlane virtualizes its
 * rows: one outside the scroller's view is a placeholder with no
 * ``swimlane-agent-row-<name>`` testid. When the row is not mounted, the
 * helper walks the scroller down from the top in one browser evaluation
 * until the row mounts. When the row is mounted, it scrolls straight to
 * it. Which path a spec takes depends on where its row sorts on the
 * day, so this spec forces each one.
 *
 * Fixture: the ancient agent, whose only sessions are eight to nine
 * days old, so it sorts near the bottom of the fleet, several screens
 * below the fold at this viewport. Structural assertions only, so both
 * theme projects run it unchanged.
 */
import { test, expect } from "@playwright/test";
import {
  ANCIENT_AGENT,
  bringSwimlaneRowIntoView,
  waitForFleetReady,
} from "./_fixtures";

// The default desktop size. The swimlane scroller shows about six rows
// here, so the ancient agent's row starts several screens down and is
// virtualized when the page settles.
const VIEWPORT = { width: 1280, height: 720 };

test.use({ viewport: VIEWPORT });

test.describe("T167 — Fleet row below the fold scrolls into view", () => {
  test("the helper walks to a row below the fold, and scrolls straight to a mounted one", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForFleetReady(page);
    const row = page.locator(
      `[data-testid="swimlane-agent-row-${ANCIENT_AGENT.name}"]`,
    );

    await test.step("a row below the fold: the walk finds it", async () => {
      // A row's first render mounts it; the observer then swaps the
      // rows out of view for placeholders. Wait for that, so the
      // helper starts with the row unmounted and must walk to it.
      await expect(row).toHaveCount(0);
      const found = await bringSwimlaneRowIntoView(page, ANCIENT_AGENT.name);
      await expect(found).toBeInViewport();
    });

    await test.step("a mounted row: no snap to the top, no walk", async () => {
      // Record every scroll position of the row's scroller from here on.
      // The walk starts by snapping the scroller to the top; scrolling
      // straight to a mounted row never passes there, as the row sits
      // several screens down.
      const startTop = await row.evaluate((el) => {
        let node = el.parentElement;
        while (node) {
          const { overflowY } = window.getComputedStyle(node);
          if (overflowY === "auto" || overflowY === "scroll") break;
          node = node.parentElement;
        }
        const scroller = node ?? document.documentElement;
        const tops = [scroller.scrollTop];
        (window as unknown as { __t167Tops: number[] }).__t167Tops = tops;
        scroller.addEventListener("scroll", () => tops.push(scroller.scrollTop), {
          passive: true,
        });
        return scroller.scrollTop;
      });
      expect(startTop).toBeGreaterThan(0);
      const again = await bringSwimlaneRowIntoView(page, ANCIENT_AGENT.name);
      await expect(again).toBeInViewport();
      const tops = await page.evaluate(
        () => (window as unknown as { __t167Tops: number[] }).__t167Tops,
      );
      expect(Math.min(...tops)).toBeGreaterThan(0);
    });
  });
});
