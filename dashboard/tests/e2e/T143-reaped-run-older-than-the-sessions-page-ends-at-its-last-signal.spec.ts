/**
 * T143 — A run the orphan-timeout reaper closed, older than the Fleet's
 * sessions page, ends at its last signal with a hollow square.
 *
 * Fixture: e2e-test-run-reaped-old, one run that started 30 h ago, was
 * last seen 20 min ago and was reaped 2 min ago. The Fleet's sessions
 * page covers the last 24 h, so only the agent's recent_sessions rollup
 * carries the run. The spec also keeps the run's events from the page
 * (its history fetch and the window's bulk page come back without
 * them), so the reaper's session_end is not loaded and the rollup's
 * ``close_reasons`` is the only sign of the reap. At 1h the run's end is
 * a hollow square at its last signal, 20 min back; read as a plain
 * close, it would be a filled square at the reap, 2 min back.
 */
import { test, expect, type Route } from "@playwright/test";
import {
	LANE_FIXTURES,
	bringSwimlaneRowIntoView,
	fixtureSessionId,
	waitForFleetReady,
} from "./_fixtures";

const { name, roles } = LANE_FIXTURES.reapedOld;
const sessionId = fixtureSessionId(name, roles.run);

// Wide enough for the 240 px sidebar, the 460 px label column and the
// 900 px timeline side by side, so the swimlane does not scroll
// sideways to "now" and no part of the timeline sits under the
// sticky label column, where a glyph cannot be hovered or hit.
test.use({ viewport: { width: 1700, height: 1800 } });

/** Pass the response through without this run's events. */
async function withoutRunEvents(route: Route, field: "events"): Promise<void> {
	const response = await route.fetch();
	const body = await response.json();
	if (Array.isArray(body?.[field])) {
		body[field] = body[field].filter((e: { session_id?: string }) => e.session_id !== sessionId);
	}
	await route.fulfill({ response, json: body });
}

test.describe("T143 — A reaped run older than the sessions page ends at its last signal", () => {
	test("the rollup's close_reasons ends it at last_seen_at, as lost", async ({ page }) => {
		await page.route(`**/v1/sessions/${sessionId}*`, (route) => withoutRunEvents(route, "events"));
		await page.route("**/v1/events?*", (route) => withoutRunEvents(route, "events"));

		await page.goto("/");
		await waitForFleetReady(page);
		await page.getByRole("button", { name: "1h", exact: true }).click();
		const row = await bringSwimlaneRowIntoView(page, name);
		await expect(row).toBeVisible({ timeout: 10_000 });

		const end = row.locator(`[data-testid="swimlane-run-bracket-end-${sessionId.slice(0, 8)}"]`);
		await expect(end).toHaveAttribute("data-end-kind", "lost", { timeout: 10_000 });
		await expect(end.locator("rect")).toHaveAttribute("fill", "none");
		// Its start, 30 h back, is far outside the window.
		await expect(row.locator(`[data-testid="swimlane-run-bracket-start-${sessionId.slice(0, 8)}"]`)).toHaveCount(0);
		// No circle of the run is drawn: its events never reached the page.
		await expect(row.locator(`[data-session-id="${sessionId}"][data-event-id]`)).toHaveCount(0);

		// 20 min back at 1h is two thirds of the way across the panel;
		// the reap, 2 min back, would sit at its right edge.
		const panel = (await row.locator('[data-testid="swimlane-timeline-panel"]').boundingBox())!;
		const box = (await end.boundingBox())!;
		const fraction = (box.x + box.width - panel.x) / panel.width;
		expect(fraction).toBeGreaterThan(0.6);
		expect(fraction).toBeLessThan(0.75);
	});
});
