/**
 * T161 — The newest circles and run glyphs stay inside the panel, and a
 * circle sits on its time on the grid.
 *
 * The Timeline's scale maps the window onto the 900 px panel less half a
 * circle plus an 8 px buffer at each end, and the rows, the grid overlay
 * and the time axis share it. So:
 *   - a circle at "now" sits whole inside its row's panel (the panel's
 *     ``overflow: hidden`` used to clip the newest ~30 s at 1h);
 *   - a circle's centre sits where the grid puts its time: on the line
 *     for a grid time, and in proportion between two lines otherwise
 *     (circles used to sit 19 px right of their time's grid line);
 *   - the ▶ of a run that started moments ago sits at its own time,
 *     inside the panel, rather than being pulled back from the edge.
 *
 * Fixture: the fan-out coordinator and its worker sub-agent, which the
 * keep-alive refreshes every cycle with a run start and a tool call
 * about 30 s before "now". Read at 1h, where a second is a quarter of a
 * pixel, so the tooltip's whole-second times place a mark to well under
 * a pixel. Geometry only, so both theme projects run it unchanged.
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
import {
	FANOUT_FIXTURE,
	bringSwimlaneRowIntoView,
	waitForFleetReady,
} from "./_fixtures";

test.use({ viewport: { width: 1700, height: 1800 } });

const HOUR_MS = 60 * 60 * 1000;

// A whole-second time places a mark to a quarter pixel at 1h, and the
// scale's right edge steps once a second: past a pixel and a half the
// mark is not where the grid puts its time.
const ON_TIME_TOLERANCE_PX = 1.5;

/** Where the grid puts ``timeMs`` on screen: the shared scale, read
 *  back from grid line 0 (the window's start) and the now line. The
 *  window's end is "now" floored to a second, as the Timeline floors
 *  it. ``timeOf`` picks, from the second-by-second times of the last
 *  hour, the one whose local formatting matches ``label`` (the
 *  formatting the dashboard used to print it). */
async function gridXOf(
	page: Page,
	label: string,
	format: "tooltip" | "glyph",
): Promise<{ x: number; panelLeft: number; panelRight: number } | null> {
	return page.evaluate(
		({ label, format, hourMs }) => {
			const g0 = document.querySelector('[data-testid="grid-line-0"]')!.getBoundingClientRect();
			const gNow = document.querySelector('[data-testid="grid-line-now"]')!.getBoundingClientRect();
			const endMs = Math.floor(Date.now() / 1000) * 1000;
			const pad = (n: number) => String(n).padStart(2, "0");
			const fmt = (ms: number) => {
				const d = new Date(ms);
				return format === "tooltip"
					? d.toLocaleTimeString()
					: `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
			};
			let timeMs: number | null = null;
			for (let t = endMs; t >= endMs - hourMs; t -= 1000) {
				if (fmt(t) === label) {
					timeMs = t;
					break;
				}
			}
			if (timeMs === null) return null;
			const x0 = g0.left;
			const x1 = gNow.left;
			const panel = document
				.querySelector('[data-testid^="swimlane-agent-row-"] [data-testid="swimlane-timeline-panel"]')!
				.getBoundingClientRect();
			return {
				// The label drops the milliseconds, so the time is up to a
				// second early: aim at the middle of that second.
				x: x0 + ((timeMs + 500 - (endMs - hourMs)) / hourMs) * (x1 - x0),
				panelLeft: panel.left,
				panelRight: panel.right,
			};
		},
		{ label, format, hourMs: HOUR_MS },
	);
}

/** The newest circle of ``row``: the one furthest right. */
async function newestCircle(row: Locator): Promise<Locator> {
	const index = await row.evaluate((el) => {
		const circles = Array.from(el.querySelectorAll("[data-event-id]"));
		let best = -1;
		let bestX = -Infinity;
		circles.forEach((c, i) => {
			const x = c.getBoundingClientRect().left;
			if (x > bestX) {
				bestX = x;
				best = i;
			}
		});
		return best;
	});
	return row.locator("[data-event-id]").nth(index);
}

test.describe("T161 — Newest circles and glyphs stay inside the panel", () => {
	test("at 1h the newest circle is whole, on its time, and a new run's ▶ sits at its start", async ({
		page,
	}) => {
		await page.goto("/");
		await waitForFleetReady(page);
		const row = await bringSwimlaneRowIntoView(page, FANOUT_FIXTURE.coordinatorName);
		await page.getByRole("button", { name: "1h", exact: true }).click();
		await expect(row.locator("[data-event-id]").first()).toBeVisible({ timeout: 10_000 });

		// 1. The newest circle sits whole inside its panel.
		await expect
			.poll(
				async () => {
					const circle = await newestCircle(row);
					return circle.evaluate((c) => {
						const r = c.getBoundingClientRect();
						const p = c
							.closest('[data-testid="swimlane-timeline-panel"]')!
							.getBoundingClientRect();
						return r.left >= p.left && r.right <= p.right;
					});
				},
				{ timeout: 10_000 },
			)
			.toBe(true);

		// 2. Its centre sits where the grid puts its time. Hover for the
		// time, then read the circle and the grid in one evaluate.
		await expect
			.poll(
				async () => {
					const circle = await newestCircle(row);
					await circle.hover();
					const time = await page.evaluate(() => {
						const tip = Array.from(document.body.children).find(
							(n) => n instanceof HTMLElement && n.style.position === "fixed" && n.style.zIndex === "9999",
						);
						return tip?.lastElementChild?.textContent ?? null;
					});
					if (!time) return null;
					const expected = await gridXOf(page, time, "tooltip");
					if (!expected) return null;
					const box = (await circle.boundingBox())!;
					return Math.abs(box.x + box.width / 2 - expected.x);
				},
				{ timeout: 15_000 },
			)
			.toBeLessThanOrEqual(ON_TIME_TOLERANCE_PX);

		// 3. The ▶ of a worker run that started about 30 s ago sits at its
		// own start (1 px right of it), inside the panel, not pulled back.
		const workerRow = await bringSwimlaneRowIntoView(page, FANOUT_FIXTURE.workerName);
		const start = workerRow.locator('[data-testid^="swimlane-run-bracket-start-"]').first();
		await expect(start).toBeVisible({ timeout: 10_000 });
		await expect
			.poll(
				async () => {
					const aria = (await start.getAttribute("aria-label")) ?? "";
					const time = /start (\d{2}:\d{2}:\d{2})/.exec(aria)?.[1];
					if (!time) return null;
					const expected = await gridXOf(page, time, "glyph");
					if (!expected) return null;
					const box = (await start.boundingBox())!;
					if (box.x < expected.panelLeft || box.x + box.width > expected.panelRight) return "clipped";
					return Math.abs(box.x - 1 - expected.x) <= ON_TIME_TOLERANCE_PX;
				},
				{ timeout: 15_000 },
			)
			.toBe(true);
	});
});
