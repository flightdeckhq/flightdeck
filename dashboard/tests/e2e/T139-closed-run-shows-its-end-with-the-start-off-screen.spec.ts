/**
 * T139 — A closed run whose start is before the window still shows
 * its end square.
 *
 * Fixture: e2e-test-run-long, a run that started 2 h ago and closed
 * 10 s ago. At 1m, 5m and 1h its start is before the window, so it
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

test.use({ viewport: { width: 1280, height: 1800 } });

test.describe("T139 — A closed run shows its end with its start off-screen", () => {
	for (const range of ["1m", "5m", "1h"]) {
		test(`at ${range} the end square shows and the start triangle does not`, async ({ page }) => {
			await page.goto("/");
			await waitForFleetReady(page);
			await page.getByRole("button", { name: range, exact: true }).click();
			const row = await bringSwimlaneRowIntoView(page, name);
			await expect(row).toBeVisible({ timeout: 10_000 });

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

			await end.hover();
			const tooltip = page.locator(`[data-testid="swimlane-run-bracket-tooltip-${prefix}"]`);
			await expect(tooltip).toBeVisible();
			await expect(tooltip).toContainText(/end:\s+\d{2}:\d{2}:\d{2}/);
		});
	}
});
