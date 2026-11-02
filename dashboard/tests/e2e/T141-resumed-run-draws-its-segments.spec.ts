/**
 * T141 — A run that ended and was resumed draws each segment, with a
 * gap, and a run inside the gap does not split the row.
 *
 * Fixture: e2e-test-run-resumed. resumed-run ran from -170 s to -120 s,
 * ended, and was resumed under the same session id at -40 s (still
 * open); resumed-gap-run ran from -100 s to -70 s, inside the gap. At
 * 5m the resumed run draws ▶ ■ ▶ (its first segment's end gets its own
 * square), and the gap frees its track, so the other run shares it and
 * the row stays one lane. The glyph code this replaced drew the resumed
 * run as one stretch from its first start, with no square at -120 s,
 * and moved the run in the gap to the bottom edge.
 */
import { test, expect } from "@playwright/test";
import {
	LANE_FIXTURES,
	bringSwimlaneRowIntoView,
	fixtureSessionId,
	waitForFleetReady,
} from "./_fixtures";

const { name, roles } = LANE_FIXTURES.resumed;

// Wide enough for the 240 px sidebar, the 460 px label column and the
// 900 px timeline side by side, so the swimlane does not scroll
// sideways to "now" and no part of the timeline sits under the
// sticky label column, where a glyph cannot be hovered or hit.
test.use({ viewport: { width: 1700, height: 1800 } });

test.describe("T141 — A resumed run draws its segments", () => {
	test("two segments with a gap, and the run in the gap on the same lane", async ({ page }) => {
		await page.goto("/");
		await waitForFleetReady(page);
		await page.getByRole("button", { name: "5m", exact: true }).click();
		const row = await bringSwimlaneRowIntoView(page, name);
		await expect(row).toBeVisible({ timeout: 10_000 });

		const resumedId = fixtureSessionId(name, roles.resumed);
		const resumedGlyphs = row.locator(`[data-bracket-kind][data-session-id="${resumedId}"]`);
		// Poll: the run's history loads after the row mounts.
		await expect
			.poll(
				async () =>
					resumedGlyphs.evaluateAll((els) =>
						els
							.map((el) => ({
								kind: el.getAttribute("data-bracket-kind"),
								left: el.getBoundingClientRect().left,
							}))
							.sort((a, b) => a.left - b.left)
							.map((g) => g.kind),
					),
				{ timeout: 10_000 },
			)
			.toEqual(["start", "end", "start"]);
		await expect(row.locator(`[data-segment-index="1"][data-session-id="${resumedId}"]`)).toHaveCount(1);

		const gapId = fixtureSessionId(name, roles.inGap);
		await expect(row.locator(`[data-bracket-kind][data-session-id="${gapId}"]`)).toHaveCount(2);
		await expect(row).toHaveAttribute("data-lane-count", "1");
		for (const lane of await row
			.locator('[data-testid^="swimlane-run-bracket-"]')
			.evaluateAll((els) => els.map((el) => el.getAttribute("data-run-lane")))) {
			expect(lane).toBe("0");
		}

		const firstEnd = row.locator(`[data-testid="swimlane-run-bracket-end-${resumedId.slice(0, 8)}"]`);
		await firstEnd.hover();
		const tooltip = page.locator(`[data-testid="swimlane-run-bracket-tooltip-${resumedId.slice(0, 8)}"]`);
		await expect(tooltip).toBeVisible();
		await expect(tooltip).toContainText("segment 1 of 2");
	});
});
