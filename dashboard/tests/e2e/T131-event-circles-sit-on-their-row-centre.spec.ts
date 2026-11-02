import { test, expect } from "@playwright/test";
import {
  CONNECTOR_FIXTURE,
  bringSwimlaneRowIntoView,
  waitForFleetReady,
} from "./_fixtures";

// T131 — Event circles sit on their row's centre line.
//
// A circle is centred vertically by one CSS translate (Tailwind 4's
// `-translate-y-1/2` emits the separate `translate` property); an
// inline `translateY(-50%)` on top of it once moved every circle
// about 11 px up, into the top-edge glyph lane, and clipped the top
// of the expanded ALL row's circles. The ALL row now shares the
// agent rows' 19 px inset, so the same event sits at the same x on
// both rows.
//
// Geometry only, so both theme projects run it unchanged.

// Tall enough that the ALL row and the connector-parent row are both
// mounted (the swimlane virtualises rows outside the viewport band).
test.use({ viewport: { width: 1600, height: 1400 } });

// Half a pixel of sub-pixel rounding either side, plus margin.
const CENTRE_TOLERANCE_PX = 1;

test.describe("T131 — event circles sit on their row's centre line", () => {
  test("an agent row's circles are centred on its timeline panel", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForFleetReady(page);
    // 5m holds several keep-alive cycles of the connector parent's
    // events, so the row always has circles to measure.
    await page.getByRole("button", { name: "5m", exact: true }).click();
    const row = await bringSwimlaneRowIntoView(page, CONNECTOR_FIXTURE.parentName);
    await expect(row).toBeVisible();
    const circles = row.locator('[data-testid^="session-circle-"]');
    await expect
      .poll(() => circles.count(), { timeout: 15_000 })
      .toBeGreaterThan(0);

    const offsets = await row.evaluate((rowEl) => {
      const panel = rowEl
        .querySelector('[data-testid="swimlane-timeline-panel"]')!
        .getBoundingClientRect();
      const centreY = panel.top + panel.height / 2;
      return Array.from(
        rowEl.querySelectorAll('[data-testid^="session-circle-"]'),
      ).map((el) => {
        const r = el.getBoundingClientRect();
        return r.top + r.height / 2 - centreY;
      });
    });
    expect(offsets.length).toBeGreaterThan(0);
    for (const dy of offsets) {
      expect(Math.abs(dy)).toBeLessThanOrEqual(CENTRE_TOLERANCE_PX);
    }
  });

  test("the expanded ALL row centres its circles inside the row, at the agent rows' x", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForFleetReady(page);
    await page.getByRole("button", { name: "5m", exact: true }).click();

    const allRow = page.getByTestId("swimlane-all");
    if ((await allRow.getAttribute("data-collapsed")) === "true") {
      await page.getByTestId("swimlane-all-toggle").click();
    }
    await expect(allRow).toHaveAttribute("data-collapsed", "false");
    const pulse = page.getByTestId("swimlane-all-pulse");
    await expect
      .poll(() => pulse.locator('[data-testid^="session-circle-"]').count(), {
        timeout: 15_000,
      })
      .toBeGreaterThan(0);

    const row = await bringSwimlaneRowIntoView(page, CONNECTOR_FIXTURE.parentName);
    await expect(row).toBeVisible();
    await expect
      .poll(() => row.locator("[data-event-id]").count(), { timeout: 15_000 })
      .toBeGreaterThan(0);

    // One evaluate, so every rect comes from the same rendered frame
    // (the scale steps once a second).
    const geometry = await page.evaluate((agentRowTestId) => {
      const allRowEl = document.querySelector('[data-testid="swimlane-all"]')!;
      const pulseEl = document.querySelector('[data-testid="swimlane-all-pulse"]')!;
      const rowBox = allRowEl.getBoundingClientRect();
      const pulseBox = pulseEl.getBoundingClientRect();
      const pulseCentreY = pulseBox.top + pulseBox.height / 2;
      const allCircles = Array.from(
        pulseEl.querySelectorAll<HTMLElement>("[data-event-id]"),
      ).map((el) => {
        const r = el.getBoundingClientRect();
        return {
          id: el.dataset.eventId ?? "",
          dy: r.top + r.height / 2 - pulseCentreY,
          topInset: r.top - rowBox.top,
          bottomInset: rowBox.bottom - r.bottom,
          centreX: r.left + r.width / 2,
        };
      });
      const agentRow = document.querySelector(
        `[data-testid="${agentRowTestId}"]`,
      );
      const agentCircles = Array.from(
        agentRow?.querySelectorAll<HTMLElement>("[data-event-id]") ?? [],
      ).map((el) => {
        const r = el.getBoundingClientRect();
        return { id: el.dataset.eventId ?? "", centreX: r.left + r.width / 2 };
      });
      return { rowHeight: rowBox.height, allCircles, agentCircles };
    }, `swimlane-agent-row-${CONNECTOR_FIXTURE.parentName}`);

    expect(geometry.rowHeight).toBe(36);
    expect(geometry.allCircles.length).toBeGreaterThan(0);
    for (const c of geometry.allCircles) {
      expect(Math.abs(c.dy)).toBeLessThanOrEqual(CENTRE_TOLERANCE_PX);
      // Fully inside the 36 px row: nothing clipped at the top or bottom.
      expect(c.topInset).toBeGreaterThanOrEqual(0);
      expect(c.bottomInset).toBeGreaterThanOrEqual(0);
    }

    // The same event on the ALL row and on its agent's row sits at
    // the same x.
    const allById = new Map(geometry.allCircles.map((c) => [c.id, c.centreX]));
    const shared = geometry.agentCircles.filter((c) => allById.has(c.id));
    expect(shared.length).toBeGreaterThan(0);
    for (const c of shared) {
      expect(Math.abs(c.centreX - allById.get(c.id)!)).toBeLessThanOrEqual(
        CENTRE_TOLERANCE_PX,
      );
    }
  });
});
