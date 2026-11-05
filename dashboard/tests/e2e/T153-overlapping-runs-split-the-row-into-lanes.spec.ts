/**
 * T153 — Runs of one agent that overlap split its row into lanes.
 *
 * Fixture: the fan-out worker (e2e-test-fanout@e2e-host-fanout/worker),
 * one agent with an earlier lost run and three runs started together,
 * as a Claude Code coordinator fans out same-role sub-agents. At 5m the
 * three open runs overlap, so the row stays one 48 px row with one name
 * but splits into three lanes (``data-lane-count="3"``). Each run's
 * circles and ▶ sit on its own lane's centre, a solid line joins each
 * run's marks, and the lost run, which ended two hours ago, takes no
 * lane. Before lanes, the three runs' circles stacked on one centre
 * line and could not be told apart.
 *
 * Geometry and attributes only, so both theme projects run it unchanged.
 */
import { test, expect } from "@playwright/test";
import {
	FANOUT_FIXTURE,
	bringSwimlaneRowIntoView,
	fixtureSessionId,
	waitForFleetReady,
} from "./_fixtures";

// Wide enough for the 240 px sidebar, the 460 px label column and the
// 900 px timeline side by side, so the swimlane does not scroll
// sideways to "now".
test.use({ viewport: { width: 1700, height: 1800 } });

// Circles and glyphs are centred on the same lane centre by CSS, so
// anything past sub-pixel rounding is a real miss.
const CENTRE_TOLERANCE_PX = 1;

test.describe("T153 — Overlapping runs split the row into lanes", () => {
	test("each run of the fan-out draws on its own lane with its own line", async ({ page }) => {
		await page.goto("/");
		await waitForFleetReady(page);
		await page.getByRole("button", { name: "5m", exact: true }).click();
		const row = await bringSwimlaneRowIntoView(page, FANOUT_FIXTURE.workerName);
		await expect(row).toBeVisible({ timeout: 10_000 });
		await expect(row).toHaveAttribute("data-lane-count", "3", { timeout: 10_000 });
		await expect(row).not.toHaveAttribute("data-lane-overflow", "true");

		// Still one agent row: one name, a fixed 48 px height.
		await expect(row.getByTestId("swimlane-agent-name-link")).toHaveCount(1);
		expect((await row.boundingBox())!.height).toBeCloseTo(48, 0);

		const runs = FANOUT_FIXTURE.workerRoles.map((role) =>
			fixtureSessionId(FANOUT_FIXTURE.workerName, role),
		);
		for (const run of runs) {
			await expect(
				row.locator(`[data-testid="session-circle-${run}"]`).first(),
			).toBeVisible({ timeout: 10_000 });
		}

		// One synchronous read, so every mark comes from one frame.
		const placed = await row.evaluate((el, ids) => {
			const centreY = (n: Element) => {
				const r = n.getBoundingClientRect();
				return r.top + r.height / 2;
			};
			return ids.map((id) => {
				const circles = Array.from(el.querySelectorAll(`[data-testid="session-circle-${id}"]`));
				const start = el.querySelector(`[data-testid="swimlane-run-bracket-start-${id.slice(0, 8)}"]`);
				const line = el.querySelector(`[data-testid="swimlane-run-line-${id.slice(0, 8)}"]`);
				return {
					id,
					circleLanes: [...new Set(circles.map((c) => c.getAttribute("data-run-lane")))],
					circleYs: circles.map(centreY),
					startLane: start?.getAttribute("data-run-lane") ?? null,
					startY: start ? centreY(start) : null,
					lineLane: line?.getAttribute("data-run-lane") ?? null,
					lineTail: line?.getAttribute("data-tail") ?? null,
					lineY: line ? centreY(line) : null,
				};
			});
		}, runs);

		const lanes = placed.map((p) => p.startLane);
		expect(new Set(lanes)).toEqual(new Set(["0", "1", "2"]));
		for (const p of placed) {
			// Circles, ▶ and line of a run share its lane and its centre.
			expect(p.circleLanes, `${p.id}: circles on one lane`).toEqual([p.startLane]);
			expect(p.lineLane).toBe(p.startLane);
			expect(p.lineTail).toBe("live");
			for (const y of p.circleYs) {
				expect(Math.abs(y - p.startY!)).toBeLessThanOrEqual(CENTRE_TOLERANCE_PX);
			}
			expect(Math.abs(p.lineY! - p.startY!)).toBeLessThanOrEqual(CENTRE_TOLERANCE_PX);
		}
		// Three distinct lane centres, top to bottom in lane order.
		const byLane = [...placed].sort((a, b) => Number(a.startLane) - Number(b.startLane));
		for (let i = 1; i < byLane.length; i++) {
			expect(byLane[i]!.startY!).toBeGreaterThan(byLane[i - 1]!.startY! + 10);
		}

		// The lost run ended two hours ago: no glyph and no line.
		const lostPrefix = fixtureSessionId(
			FANOUT_FIXTURE.workerName,
			FANOUT_FIXTURE.workerLostRole,
		).slice(0, 8);
		await expect(row.locator(`[data-testid$="-${lostPrefix}"]`)).toHaveCount(0);
		await expect(row.locator('[data-testid^="swimlane-run-line-"]')).toHaveCount(3);
	});
});
