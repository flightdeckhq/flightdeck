/**
 * T140 — A lost run, and a run the orphan-timeout reaper closed, end
 * at their last signal with a hollow square.
 *
 * Fixture: e2e-test-run-lost, all at 1h:
 * - lost-recent: lost, started 50 min ago, last seen 40 min ago;
 * - reaped-run: closed by the reaper a minute ago (its session_end
 *   carries close_reason orphan_timeout), last seen 30 min ago;
 * - lost-earlier: lost, last seen 1 h 55 min ago, before the window.
 * The two in view end in a hollow square (``data-end-kind="lost"``)
 * at their last signal, the reaped one 30 min back rather than at the
 * reap; the earlier one draws nothing. The glyph code this replaced
 * drew no end for a lost run (it read as running forever) and ended a
 * reaped run at the reap.
 */
import { test, expect } from "@playwright/test";
import {
	LANE_FIXTURES,
	bringSwimlaneRowIntoView,
	fixtureSessionId,
	waitForFleetReady,
} from "./_fixtures";

const { name, roles } = LANE_FIXTURES.lost;
const prefix = (role: string) => fixtureSessionId(name, role).slice(0, 8);

// Wide enough for the 240 px sidebar, the 460 px label column and the
// 900 px timeline side by side, so the swimlane does not scroll
// sideways to "now" and no part of the timeline sits under the
// sticky label column, where a glyph cannot be hovered or hit.
test.use({ viewport: { width: 1700, height: 1800 } });

test.describe("T140 — A lost run ends with a hollow square", () => {
	test("lost and reaped runs end at their last signal; an earlier lost run draws nothing", async ({ page }) => {
		await page.goto("/");
		await waitForFleetReady(page);
		// Find the row at the default 1m first: scrolling the swimlane
		// mounts rows as it goes, and at a wide window each one draws
		// that window's events, so hunting at 1h on a busy stack takes
		// most of the test's time. The row stays mounted across the
		// range switch.
		const row = await bringSwimlaneRowIntoView(page, name);
		await expect(row).toBeVisible({ timeout: 10_000 });
		await page.getByRole("button", { name: "1h", exact: true }).click();
		await expect(row).toBeVisible();

		const lostEnd = row.locator(`[data-testid="swimlane-run-bracket-end-${prefix(roles.recent)}"]`);
		const reapedEnd = row.locator(`[data-testid="swimlane-run-bracket-end-${prefix(roles.reaped)}"]`);
		await expect(lostEnd).toHaveAttribute("data-end-kind", "lost", { timeout: 10_000 });
		await expect(reapedEnd).toHaveAttribute("data-end-kind", "lost");
		// Hollow: the square has no fill, only a stroke.
		await expect(lostEnd.locator("rect")).toHaveAttribute("fill", "none");
		await expect(reapedEnd.locator("rect")).toHaveAttribute("fill", "none");

		await expect(
			row.locator(`[data-bracket-kind][data-session-id="${fixtureSessionId(name, roles.earlier)}"]`),
		).toHaveCount(0);

		// The reaped run ends 30 min back, at its last signal, so its
		// square sits near the middle of the 1h panel, far from the
		// right edge where the reap (a minute ago) would put it.
		const panel = row.locator('[data-testid="swimlane-timeline-panel"]');
		const panelBox = (await panel.boundingBox())!;
		const reapedBox = (await reapedEnd.boundingBox())!;
		const fraction = (reapedBox.x + reapedBox.width - panelBox.x) / panelBox.width;
		expect(fraction).toBeGreaterThan(0.4);
		expect(fraction).toBeLessThan(0.6);

		await lostEnd.hover();
		const tooltip = page.locator(`[data-testid="swimlane-run-bracket-tooltip-${prefix(roles.recent)}"]`);
		await expect(tooltip).toBeVisible();
		await expect(tooltip).toContainText(/end:\s+lost · last seen \d{2}:\d{2}:\d{2}/);
	});
});
