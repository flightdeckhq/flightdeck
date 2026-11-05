/**
 * T154 — A row whose runs do not overlap stays one line.
 *
 * Fixtures: the fan-out coordinator (one open run, with a fresh
 * tool_call every keep-alive cycle) and e2e-test-run-handoff (one run
 * closes as the next starts, 3 ms apart). Neither has two runs open at
 * once in the 5m window, so neither row splits: ``data-lane-count="1"``,
 * no run lines, and the circles keep their full 22 px size on the row's
 * centre line. A hand-off must not read as an overlap.
 *
 * Geometry and attributes only, so both theme projects run it unchanged.
 */
import { test, expect } from "@playwright/test";
import {
	FANOUT_FIXTURE,
	LANE_FIXTURES,
	bringSwimlaneRowIntoView,
	waitForFleetReady,
} from "./_fixtures";

test.use({ viewport: { width: 1700, height: 1800 } });

// The one-line circle (EVENT_CIRCLE_SIZE).
const ONE_LINE_CIRCLE_PX = 22;

test.describe("T154 — A row without overlap keeps one line", () => {
	test("a single run and a hand-off draw one line with full-size circles", async ({ page }) => {
		await page.goto("/");
		await waitForFleetReady(page);
		await page.getByRole("button", { name: "5m", exact: true }).click();

		for (const name of [FANOUT_FIXTURE.coordinatorName, LANE_FIXTURES.handoff.name]) {
			const row = await bringSwimlaneRowIntoView(page, name);
			await expect(row).toBeVisible({ timeout: 10_000 });
			await expect(row.locator('[data-testid^="swimlane-run-bracket-start-"]').first()).toBeVisible({
				timeout: 10_000,
			});
			await expect(row).toHaveAttribute("data-lane-count", "1");
			await expect(row).not.toHaveAttribute("data-lane-overflow", "true");
			await expect(row.locator('[data-testid^="swimlane-run-line-"]')).toHaveCount(0);
		}

		// The coordinator's circles: 22 px, on the row's centre line.
		const row = await bringSwimlaneRowIntoView(page, FANOUT_FIXTURE.coordinatorName);
		await expect(row.locator("[data-event-id]").first()).toBeVisible({ timeout: 10_000 });
		const report = await row.evaluate((el) => {
			const panel = el.querySelector('[data-testid="swimlane-timeline-panel"]')!.getBoundingClientRect();
			const rowCentre = panel.top + panel.height / 2;
			return Array.from(el.querySelectorAll<HTMLElement>("[data-event-id]")).map((c) => {
				const r = c.getBoundingClientRect();
				return { width: c.offsetWidth, offCentre: Math.abs(r.top + r.height / 2 - rowCentre) };
			});
		});
		expect(report.length).toBeGreaterThan(0);
		for (const c of report) {
			expect(c.width).toBe(ONE_LINE_CIRCLE_PX);
			expect(c.offCentre).toBeLessThanOrEqual(1);
		}
	});
});
