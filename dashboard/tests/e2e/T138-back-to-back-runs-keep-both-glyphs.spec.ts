/**
 * T138 — A run that hands off to the next keeps both its end square
 * and the next run's start triangle in reach, on one lane.
 *
 * Fixture: e2e-test-run-handoff. The first run closes at -15 s and the
 * second starts 3 ms before that, the overlap a worker's processing
 * order can stamp. Overlaps within the tolerance are hand-offs, so the
 * row stays one lane (``data-lane-count="1"``) with both glyphs on the
 * top edge, and the end sorts before the start: ■ then ▶, side by side.
 * The glyph code this replaced centred both glyphs on the hand-off's
 * x, so the square hid the triangle, and read the 3 ms as a concurrent
 * run, moving the second run to the bottom edge.
 */
import { test, expect } from "@playwright/test";
import {
	LANE_FIXTURES,
	bringSwimlaneRowIntoView,
	fixtureSessionId,
	waitForFleetReady,
} from "./_fixtures";

const { name, roles } = LANE_FIXTURES.handoff;

// Wide enough for the 240 px sidebar, the 460 px label column and the
// 900 px timeline side by side, so the swimlane does not scroll
// sideways to "now" and no part of the timeline sits under the
// sticky label column, where a glyph cannot be hovered or hit.
test.use({ viewport: { width: 1700, height: 1800 } });

test.describe("T138 — Back-to-back runs keep both glyphs", () => {
	test("the hand-off reads end then start, both reachable, on one lane", async ({ page }) => {
		await page.goto("/");
		await waitForFleetReady(page);
		// 5m: the keep-alive re-pins the fixture once per seed pass plus
		// 30 s, which under load can drift it past the edge of a 1m
		// window. At 5m a pixel is a third of a second, so the 3 ms
		// overlap still sits far inside the 1 s tolerance.
		await page.getByRole("button", { name: "5m", exact: true }).click();
		const row = await bringSwimlaneRowIntoView(page, name);
		await expect(row).toBeVisible({ timeout: 10_000 });

		const firstPrefix = fixtureSessionId(name, roles.first).slice(0, 8);
		const secondPrefix = fixtureSessionId(name, roles.second).slice(0, 8);
		const end = row.locator(`[data-testid="swimlane-run-bracket-end-${firstPrefix}"]`);
		const start = row.locator(`[data-testid="swimlane-run-bracket-start-${secondPrefix}"]`);
		await expect(end).toBeVisible({ timeout: 10_000 });
		await expect(start).toBeVisible();

		await expect(row).toHaveAttribute("data-lane-count", "1");
		await expect(end).toHaveAttribute("data-run-lane", "0");
		await expect(start).toHaveAttribute("data-run-lane", "0");

		// Both boxes in one synchronous read: the window advances a few
		// pixels a second, so two separate reads can drift apart.
		const [endBox, startBox] = await row.evaluate(
			(el, ids) =>
				ids.map((id) => {
					const r = el.querySelector(`[data-testid="${id}"]`)!.getBoundingClientRect();
					return { left: r.left, right: r.right };
				}),
			[`swimlane-run-bracket-end-${firstPrefix}`, `swimlane-run-bracket-start-${secondPrefix}`],
		);
		expect(endBox!.right).toBeLessThanOrEqual(startBox!.left);

		for (const [glyph, prefix] of [
			[end, firstPrefix],
			[start, secondPrefix],
		] as const) {
			await glyph.hover();
			const tooltip = page.locator(`[data-testid="swimlane-run-bracket-tooltip-${prefix}"]`);
			await expect(tooltip).toBeVisible();
			await expect(tooltip).toContainText(`run ${prefix}`);
		}
	});
});
