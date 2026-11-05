/**
 * T156 — Each sub-agent connector ends on its child run's lane.
 *
 * Fixture: the fan-out coordinator and its worker sub-agent, whose three
 * runs start together and split the worker row into three lanes. The
 * connector overlay measures the rendered circles, so each
 * coordinator-to-worker connector ends on its own run's first circle in
 * the window, on that run's lane: the ends sit at distinct heights, one
 * per lane, instead of converging on the row's centre line.
 *
 * Geometry only, so both theme projects run it unchanged.
 */
import { test, expect } from "@playwright/test";
import {
	FANOUT_FIXTURE,
	bringSwimlaneRowIntoView,
	fixtureSessionId,
	waitForFleetReady,
} from "./_fixtures";

test.use({ viewport: { width: 1700, height: 1800 } });

// A path endpoint is a float the overlay computed from the same rects
// this spec reads, so anything past sub-pixel rounding is a real miss.
const ENDPOINT_TOLERANCE_PX = 1.5;

type ConnectorEnd = {
	child: string;
	lane: string | null;
	endY: number;
	offCentre: number;
};

test.describe("T156 — Sub-agent connector ends on the child run's lane", () => {
	test("the worker connectors end on three distinct lanes", async ({ page }) => {
		await page.goto("/");
		await waitForFleetReady(page);
		await page.getByRole("button", { name: "5m", exact: true }).click();
		const row = await bringSwimlaneRowIntoView(page, FANOUT_FIXTURE.workerName);
		await expect(row).toHaveAttribute("data-lane-count", "3", { timeout: 10_000 });

		const workers = FANOUT_FIXTURE.workerRoles.map((role) =>
			fixtureSessionId(FANOUT_FIXTURE.workerName, role),
		);

		// One evaluate per poll, so path geometry and circle rects come
		// from one rendered frame (the overlay redraws once a second, and a
		// connector drops out while its parent event leaves the window).
		const read = () =>
			page.evaluate((ids): ConnectorEnd[] => {
				const svg = document.querySelector('[data-testid="sub-agent-connector-overlay"]');
				if (!svg) return [];
				const origin = svg.getBoundingClientRect();
				return Array.from(svg.querySelectorAll("path[data-child-session-id]"))
					.filter((p) => ids.includes(p.getAttribute("data-child-session-id") ?? ""))
					.map((path) => {
						const nums = (path.getAttribute("d") ?? "")
							.replace(/[MQ]/g, " ")
							.trim()
							.split(/\s+/)
							.map(Number);
						const ex = nums[4]!;
						const ey = nums[5]!;
						const eventId = path.getAttribute("data-child-event-id") ?? "";
						const circle = document.querySelector<HTMLElement>(
							`[data-testid^="swimlane-agent-row-"] [data-event-id="${CSS.escape(eventId)}"]`,
						);
						if (!circle) {
							return { child: "", lane: null, endY: ey, offCentre: Number.POSITIVE_INFINITY };
						}
						const r = circle.getBoundingClientRect();
						const cx = r.left - origin.left + r.width / 2;
						const cy = r.top - origin.top + r.height / 2;
						return {
							child: path.getAttribute("data-child-session-id") ?? "",
							lane: circle.getAttribute("data-run-lane"),
							endY: ey,
							offCentre: Math.hypot(ex - cx, ey - cy),
						};
					});
			}, workers);

		let ends: ConnectorEnd[] = [];
		await expect
			.poll(
				async () => {
					ends = await read();
					return ends.length;
				},
				{ timeout: 15_000 },
			)
			.toBe(workers.length);

		for (const end of ends) {
			expect(end.offCentre, `${end.child}: end off its circle`).toBeLessThanOrEqual(
				ENDPOINT_TOLERANCE_PX,
			);
		}
		// One end per lane, each at its own height.
		expect(new Set(ends.map((e) => e.lane))).toEqual(new Set(["0", "1", "2"]));
		const ys = ends.map((e) => e.endY).sort((a, b) => a - b);
		for (let i = 1; i < ys.length; i++) expect(ys[i]! - ys[i - 1]!).toBeGreaterThan(10);
	});
});
