/**
 * T142 — A run narrower than its two glyphs still reads start then
 * end, and the circle at its start stays clickable.
 *
 * Fixture: e2e-test-run-short, a run of 2 s (-120 s to -118 s): 6 px at
 * 5m and half a pixel at 1h, less than the ▶ and ■ need side by side.
 * A segment's square always follows its own triangle, past the
 * segment's end, so the run reads ▶■, never ■▶ (the hand-off order).
 * The glyphs sit on the row's edge, clear of the circles on the centre
 * line, so a click at the centre of the session_start circle reaches
 * the circle.
 */
import { test, expect } from "@playwright/test";
import {
	LANE_FIXTURES,
	bringSwimlaneRowIntoView,
	fixtureSessionId,
	waitForFleetReady,
} from "./_fixtures";

const { name, roles } = LANE_FIXTURES.short;
const sessionId = fixtureSessionId(name, roles.run);
const prefix = sessionId.slice(0, 8);

// Wide enough for the 240 px sidebar, the 460 px label column and the
// 900 px timeline side by side, so the swimlane does not scroll
// sideways to "now" and no part of the timeline sits under the
// sticky label column, where a glyph cannot be hovered or hit.
test.use({ viewport: { width: 1700, height: 1800 } });

test.describe("T142 — A short run keeps its start before its end", () => {
	for (const range of ["5m", "1h"]) {
		test(`at ${range} the triangle comes first and the start circle stays clickable`, async ({ page }) => {
			await page.goto("/");
			await waitForFleetReady(page);
			await page.getByRole("button", { name: range, exact: true }).click();
			const row = await bringSwimlaneRowIntoView(page, name);
			await expect(row).toBeVisible({ timeout: 10_000 });

			const start = row.locator(`[data-testid="swimlane-run-bracket-start-${prefix}"]`);
			const end = row.locator(`[data-testid="swimlane-run-bracket-end-${prefix}"]`);
			await expect(start).toBeVisible({ timeout: 10_000 });
			await expect(end).toBeVisible();
			const startBox = (await start.boundingBox())!;
			const endBox = (await end.boundingBox())!;
			expect(startBox.x + startBox.width).toBeLessThanOrEqual(endBox.x);

			// The session_start circle: the run's earliest circle.
			const circles = row.locator(`[data-session-id="${sessionId}"][data-event-id]`);
			await expect.poll(async () => circles.count(), { timeout: 10_000 }).toBeGreaterThan(0);
			const centres = await circles.evaluateAll((els) =>
				els
					.map((el) => {
						const r = el.getBoundingClientRect();
						return { id: el.getAttribute("data-event-id"), x: r.left + r.width / 2, y: r.top + r.height / 2 };
					})
					.sort((a, b) => a.x - b.x),
			);
			// The run's circles overlap each other at these widths; what
			// matters is that no glyph covers the start circle's centre,
			// so a click there reaches one of the run's circles.
			const first = centres[0]!;
			const hit = await page.evaluate(
				([x, y]) => {
					const el = document.elementFromPoint(x!, y!);
					return {
						glyph: el?.closest("[data-bracket-kind]") !== null && el?.closest("[data-bracket-kind]") !== undefined,
						session: el?.closest("[data-event-id]")?.getAttribute("data-session-id") ?? null,
					};
				},
				[first.x, first.y],
			);
			expect(hit.glyph).toBe(false);
			expect(hit.session).toBe(sessionId);
		});
	}
});
