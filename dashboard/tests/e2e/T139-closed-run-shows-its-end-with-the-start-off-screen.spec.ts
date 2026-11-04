/**
 * T139 — A closed run whose start is before the window still shows
 * its end square.
 *
 * Fixture: e2e-test-run-long, a run that started 2 h ago and closed
 * 10 s ago. At 5m, 15m and 1h its start is before the window, so it
 * draws no ▶, but its ■ is drawn (each glyph is drawn when its own
 * time is in the window), and the tooltip's end line is a time. The
 * glyph code this replaced drew neither glyph whenever the start was
 * off-screen, so the run read as still running.
 */
import { test, expect } from "@playwright/test";
import {
	LANE_FIXTURES,
	bringSwimlaneRowIntoView,
	fixtureSessionId,
	waitForFleetReady,
} from "./_fixtures";

const { name, roles } = LANE_FIXTURES.long;
const prefix = fixtureSessionId(name, roles.run).slice(0, 8);

// Wide enough for the 240 px sidebar, the 460 px label column and the
// 900 px timeline side by side, so the swimlane does not scroll
// sideways to "now" and no part of the timeline sits under the
// sticky label column, where a glyph cannot be hovered or hit.
test.use({ viewport: { width: 1700, height: 1800 } });

test.describe("T139 — A closed run shows its end with its start off-screen", () => {
	// Not 1m: the keep-alive re-pins the fixture once per seed pass plus
	// 30 s, which under load can drift its end past a 1m window's edge.
	// The 1m geometry is covered by swimlane-lanes.test.ts.
	for (const range of ["5m", "15m", "1h"]) {
		test(`at ${range} the end square shows and the start triangle does not`, async ({ page }) => {
			await page.goto("/");
			await waitForFleetReady(page);
			// Find the row at the default 1m first: scrolling the swimlane
			// mounts rows as it goes, and at a wide window each one draws
			// that window's events, so hunting at 1h on a busy stack takes
			// most of the test's time. The row stays mounted across the
			// range switch.
			const row = await bringSwimlaneRowIntoView(page, name);
			await expect(row).toBeVisible({ timeout: 10_000 });
			await page.getByRole("button", { name: range, exact: true }).click();
			await expect(row).toBeVisible();

			const end = row.locator(`[data-testid="swimlane-run-bracket-end-${prefix}"]`);
			await expect(end).toBeVisible({ timeout: 10_000 });
			await expect(end).toHaveAttribute("data-end-kind", "closed");
			await expect(row.locator(`[data-testid="swimlane-run-bracket-start-${prefix}"]`)).toHaveCount(0);

			// The square sits inside the panel.
			const panel = row.locator('[data-testid="swimlane-timeline-panel"]');
			const panelBox = (await panel.boundingBox())!;
			const endBox = (await end.boundingBox())!;
			expect(endBox.x).toBeGreaterThanOrEqual(panelBox.x);
			expect(endBox.x + endBox.width).toBeLessThanOrEqual(panelBox.x + panelBox.width);

			// Hover until the tooltip shows. The square drifts left as the
			// window advances, and rows above it can move while the window's
			// history loads, so a square that slides out from under the
			// pointer is hovered again where it now is.
			const tooltip = page.locator(`[data-testid="swimlane-run-bracket-tooltip-${prefix}"]`);
			await expect
				.poll(
					async () => {
						await end.hover();
						return tooltip.isVisible();
					},
					{ timeout: 10_000 },
				)
				.toBe(true);
			await expect(tooltip).toContainText(/end:\s+\d{2}:\d{2}:\d{2}/);
		});
	}
});
