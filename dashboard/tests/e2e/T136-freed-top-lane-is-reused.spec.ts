/**
 * T136 — A run that starts after an earlier run ended takes the top
 * edge that run freed.
 *
 * Fixture: e2e-test-run-lane-reuse. Run A ran from -240 s to -180 s,
 * run B is open from -200 s and run C is open from -150 s, after A
 * ended. Tracks go to runs in start order, each to the lowest track
 * free at its start, so C reuses A's track. At 5m all three are in
 * view and B overlaps both, so the row splits: A and C keep the top
 * edge (``data-run-lane="0"``) and B sits on the bottom edge. The
 * glyph code this replaced gave the top edge only to a run that
 * started while nothing else was open, so C went to the bottom too.
 */
import { test, expect } from "@playwright/test";
import {
	LANE_FIXTURES,
	bringSwimlaneRowIntoView,
	fixtureSessionId,
	waitForFleetReady,
} from "./_fixtures";

const { name, roles } = LANE_FIXTURES.laneReuse;
const prefix = (role: string) => fixtureSessionId(name, role).slice(0, 8);

test.use({ viewport: { width: 1280, height: 1800 } });

test.describe("T136 — A freed top lane is reused", () => {
	test("the run that starts after an earlier one ended takes its top edge", async ({ page }) => {
		await page.goto("/");
		await waitForFleetReady(page);
		await page.getByRole("button", { name: "5m", exact: true }).click();
		const row = await bringSwimlaneRowIntoView(page, name);
		await expect(row).toBeVisible({ timeout: 10_000 });

		const start = (role: string) =>
			row.locator(`[data-testid="swimlane-run-bracket-start-${prefix(role)}"]`);
		await expect(start(roles.a)).toHaveAttribute("data-run-lane", "0", { timeout: 10_000 });
		await expect(start(roles.c)).toHaveAttribute("data-run-lane", "0");
		await expect(start(roles.b)).toHaveAttribute("data-run-lane", "1");
		await expect(row).toHaveAttribute("data-lane-count", "2");
		// A ended in the window: its closed end square shares the top edge.
		const aEnd = row.locator(`[data-testid="swimlane-run-bracket-end-${prefix(roles.a)}"]`);
		await expect(aEnd).toHaveAttribute("data-run-lane", "0");
		await expect(aEnd).toHaveAttribute("data-end-kind", "closed");

		// The top-edge glyphs sit above the bottom-edge one.
		const aBox = await start(roles.a).boundingBox();
		const bBox = await start(roles.b).boundingBox();
		const cBox = await start(roles.c).boundingBox();
		expect(aBox && bBox && cBox).toBeTruthy();
		expect(cBox!.y).toBeLessThan(bBox!.y);
		expect(Math.abs(aBox!.y - cBox!.y)).toBeLessThan(1);
	});
});
