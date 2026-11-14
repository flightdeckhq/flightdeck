/**
 * T136 — A run that starts after an earlier run ended takes the top
 * edge that run freed.
 *
 * Fixture: e2e-test-run-lane-reuse. Run A ran from -150 s to -90 s,
 * run B is open from -120 s and run C is open from -60 s, after A
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

// Wide enough for the 240 px sidebar, the 460 px label column and the
// 900 px timeline side by side, so the swimlane does not scroll
// sideways to "now" and no part of the timeline sits under the
// sticky label column, where a glyph cannot be hovered or hit.
test.use({ viewport: { width: 1700, height: 1800 } });

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

		// The top-edge glyphs sit above the bottom-edge one. The three
		// tops come from one synchronous pass: the rows above move this
		// one 9 px when the divider between the live and the recent
		// agents comes or goes (an agent another spec has just posted
		// for passes 15 s without an event), so boxes read one call at
		// a time can be 9 px apart on the same lane.
		const [aTop, bTop, cTop] = await row.evaluate(
			(el, ids) =>
				ids.map((id) => {
					const glyph = el.querySelector(`[data-testid="swimlane-run-bracket-start-${id}"]`);
					return glyph ? glyph.getBoundingClientRect().top : null;
				}),
			[prefix(roles.a), prefix(roles.b), prefix(roles.c)],
		);
		expect(aTop).not.toBeNull();
		expect(bTop).not.toBeNull();
		expect(cTop).not.toBeNull();
		expect(cTop!).toBeLessThan(bTop!);
		expect(Math.abs(aTop! - cTop!)).toBeLessThan(1);
	});
});
