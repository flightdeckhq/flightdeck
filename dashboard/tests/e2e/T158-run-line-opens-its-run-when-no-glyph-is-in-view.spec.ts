/**
 * T158 — A run line is the keyboard path to a run whose glyphs are out
 * of view.
 *
 * Fixture: e2e-test-run-quiet, two overlapping open runs that started
 * 240 s and 200 s ago. At 1m neither start is in the window and neither
 * run has ended, so neither has a glyph: each run line takes keyboard
 * focus (``tabIndex`` 0), and Enter on it opens the run drawer scoped to
 * that run. At 5m the starts are in view, so the glyphs carry the
 * keyboard path and the lines leave the tab order.
 *
 * Attributes only, so both theme projects run it unchanged.
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

test.describe("T158 — A run line opens its run when no glyph is in view", () => {
	test("Enter on a focusable run line opens that run's drawer", async ({ page }) => {
		await page.goto("/");
		await waitForFleetReady(page);
		await page.getByRole("button", { name: "1m", exact: true }).click();
		const row = await bringSwimlaneRowIntoView(page, name);
		await expect(row).toHaveAttribute("data-lane-count", "2", { timeout: 10_000 });
		await expect(row.locator('[data-testid^="swimlane-run-bracket-"]')).toHaveCount(0);

		const runId = fixtureSessionId(name, roles.live);
		const line = row.getByTestId(`swimlane-run-line-${runId.slice(0, 8)}`);
		const lines = row.locator('[data-testid^="swimlane-run-line-"]');
		await expect(lines).toHaveCount(2);
		for (const l of await lines.all()) await expect(l).toHaveAttribute("tabindex", "0");
		await expect(line).toHaveAccessibleName(/^Open run [0-9a-f]{8}, lane 2 of 2, running$/);

		await line.focus();
		await expect(line).toBeFocused();
		await page.keyboard.press("Enter");
		const drawer = page.locator('[data-testid="session-drawer"]');
		await expect(drawer).toHaveCount(1, { timeout: 10_000 });
		await expect(drawer).toHaveAttribute("data-session-id", runId);

		// At 5m the starts are in view: the glyphs take the keyboard path.
		await drawer.getByTestId("session-drawer-close").click();
		await expect(drawer).toHaveCount(0);
		await page.getByRole("button", { name: "5m", exact: true }).click();
		await expect(row.locator('[data-testid^="swimlane-run-bracket-start-"]')).toHaveCount(2, {
			timeout: 10_000,
		});
		for (const l of await lines.all()) await expect(l).toHaveAttribute("tabindex", "-1");
	});
});
