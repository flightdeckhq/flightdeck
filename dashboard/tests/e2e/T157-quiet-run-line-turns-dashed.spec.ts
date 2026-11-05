/**
 * T157 — A quiet run's line turns dashed from its last signal.
 *
 * Fixture: e2e-test-run-quiet. A run the worker marked ``stale`` (open
 * from -240 s, last seen at -200 s) overlaps an active run open from
 * -200 s, so at 5m the row splits into two lanes. The stale run's line
 * is solid from its start to its last signal and dashed from there to
 * the panel's right edge (``data-tail="quiet"``); the active run's line
 * stays solid (``data-tail="live"``). Its tooltip reads "running · quiet
 * since". The dashboard takes the quiet state from the worker's own
 * stale mark and keeps no threshold of its own.
 *
 * Attributes and geometry only, so both theme projects run it unchanged.
 */
import { test, expect } from "@playwright/test";
import {
	LANE_FIXTURES,
	bringSwimlaneRowIntoView,
	fixtureSessionId,
	waitForFleetReady,
} from "./_fixtures";

test.use({ viewport: { width: 1700, height: 1800 } });

const { name, roles } = LANE_FIXTURES.quiet;
const prefix = (role: string) => fixtureSessionId(name, role).slice(0, 8);

test.describe("T157 — A quiet run's line turns dashed", () => {
	test("the stale run's line is dashed from its last signal, the live one solid", async ({ page }) => {
		await page.goto("/");
		await waitForFleetReady(page);
		await page.getByRole("button", { name: "5m", exact: true }).click();
		const row = await bringSwimlaneRowIntoView(page, name);
		await expect(row).toBeVisible({ timeout: 10_000 });
		await expect(row).toHaveAttribute("data-lane-count", "2", { timeout: 10_000 });

		const stale = row.getByTestId(`swimlane-run-line-${prefix(roles.stale)}`);
		const live = row.getByTestId(`swimlane-run-line-${prefix(roles.live)}`);
		await expect(stale).toHaveAttribute("data-tail", "quiet");
		await expect(live).toHaveAttribute("data-tail", "live");
		// The stale run started first, so it holds the top lane.
		await expect(stale).toHaveAttribute("data-run-lane", "0");
		await expect(live).toHaveAttribute("data-run-lane", "1");

		// Solid from the start to the last signal, then the dashed tail to
		// the right edge; the live line has no tail.
		const parts = await stale.evaluate((el) => {
			const box = (sel: string) => {
				const n = el.querySelector(sel);
				return n ? n.getBoundingClientRect() : null;
			};
			const solid = box('[data-testid="swimlane-run-solid-part"]');
			const tail = box('[data-testid="swimlane-run-quiet-tail"]');
			const line = el.getBoundingClientRect();
			return {
				solid: solid && { left: solid.left, right: solid.right },
				tail: tail && { left: tail.left, right: tail.right },
				line: { left: line.left, right: line.right },
			};
		});
		expect(parts.solid).not.toBeNull();
		expect(parts.tail).not.toBeNull();
		expect(parts.solid!.right - parts.solid!.left).toBeGreaterThan(0);
		expect(Math.abs(parts.tail!.left - parts.solid!.right)).toBeLessThanOrEqual(1);
		expect(Math.abs(parts.tail!.right - parts.line.right)).toBeLessThanOrEqual(1);
		await expect(live.getByTestId("swimlane-run-quiet-tail")).toHaveCount(0);

		// Hover the quiet tail near the right edge, where no circle of the
		// run sits (it has been silent there).
		const lineBox = await stale.boundingBox();
		await stale.hover({ position: { x: lineBox!.width - 8, y: lineBox!.height / 2 } });
		const tooltip = page.getByTestId(`swimlane-run-line-tooltip-${prefix(roles.stale)}`);
		await expect(tooltip).toBeVisible();
		await expect(tooltip).toContainText("running · quiet since");
		await expect(tooltip).toContainText("state: stale");
		await expect(stale).toHaveAttribute("data-highlighted", "true");
	});
});
