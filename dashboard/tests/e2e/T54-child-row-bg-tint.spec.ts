/**
 * T54 — Child swimlane rows carry a visually distinct background
 * tint from root rows.
 *
 * Guards against the Chrome-verify Issue C regression: an earlier
 * inline ``background: var(--surface)`` on the SwimLane row beat
 * the ``[data-topology="child"]`` CSS rule via specificity, so
 * child rows rendered the same colour as root and the tint was
 * lost. The fix removes the inline override and pairs the
 * ``[data-topology="root"]`` rule with the child rule at equal
 * weight in globals.css.
 *
 * Theme-agnostic: asserts that the two computed backgrounds
 * DIFFER, not that they hit specific colour values. Runs under
 * both neon-dark and clean-light Playwright projects.
 */
import { test, expect } from "@playwright/test";
import { waitForFleetReady } from "./_fixtures";

test.describe("T54 — Child row bg tint regression guard", () => {
	test("child row background differs from root row background", async ({
		page,
	}) => {
		await page.goto("/");
		await waitForFleetReady(page);

		const childRow = page.locator('[data-topology="child"]').first();
		const rootRow = page.locator('[data-topology="root"]').first();
		// Both rows must be VISIBLE (not just attached) — virtualized
		// placeholders are attached but report
		// ``getComputedStyle().backgroundColor = 'rgba(0,0,0,0)'``
		// which would pass the !== comparison vacuously for the wrong
		// reason. Visible rows guarantee the live SwimLane has
		// rendered + the CSS rule has resolved against a non-empty
		// background-color.
		await expect(childRow).toBeVisible({ timeout: 10_000 });
		await expect(rootRow).toBeVisible({ timeout: 10_000 });

		const childBg = await childRow.evaluate(
			(el) => getComputedStyle(el).backgroundColor,
		);
		const rootBg = await rootRow.evaluate(
			(el) => getComputedStyle(el).backgroundColor,
		);
		// Neither value should be empty or 'rgba(0, 0, 0, 0)' —
		// that would indicate the CSS rule didn't resolve at all,
		// which is itself a regression. Then assert they differ.
		expect(childBg).not.toBe("");
		expect(childBg).not.toBe("rgba(0, 0, 0, 0)");
		expect(rootBg).not.toBe("");
		expect(rootBg).not.toBe("rgba(0, 0, 0, 0)");
		expect(childBg).not.toBe(rootBg);
	});
});
