/**
 * T47 — Hovering a run boundary glyph reveals the per-run tooltip.
 *
 * RunBracket.tsx renders a filled play-button triangle at the
 * start of every run, plus a filled solid square at the end of
 * any closed run (active / idle / stale / lost runs render the
 * triangle alone). Hovering EITHER glyph surfaces the same
 * tooltip with:
 *   - run id 8-char prefix
 *   - start time
 *   - end time (or "running" for an open-ended run)
 *   - state
 *   - total tokens
 *
 * The tooltip's testid is parametrised on the run's 8-char prefix
 * so multiple concurrent runs each surface their own tooltip on
 * hover, disambiguating overlap-aware visuals.
 */
import { test, expect } from "@playwright/test";
import { bringSwimlaneRowIntoView, waitForFleetReady } from "./_fixtures";

// Same anchor agent as T48 — single fresh-active run, no
// overlapping brackets, so the hover lands on the bracket
// deterministically instead of an adjacent label or another
// agent's overlapping bracket.
const SINGLE_RUN_AGENT = "e2e-test-langgraph-parent";

// Tall viewport so the row materialises without virtualization
// eviction.
test.use({ viewport: { width: 1280, height: 1800 } });

test.describe("T47 — Run bracket hover tooltip", () => {
	test("hovering any start bracket exposes the run tooltip", async ({
		page,
	}) => {
		await page.goto("/");
		await waitForFleetReady(page);
		// 5 m keeps a run that started 30-70 s ago (the keep-alive pins
		// these runs to start 30 s before each cycle) well inside the
		// panel, at x ≈ 690-810 px. At 1 h it sits in the panel's
		// clipped right margin, where glyphs centre on their time
		// inside the 19 px inset and are not mounted or visible; at
		// 1 m it drifts out of the window before the next cycle.
		await page.getByRole("button", { name: "5m", exact: true }).click();
		const row = await bringSwimlaneRowIntoView(page, SINGLE_RUN_AGENT);
		await expect(row).toBeVisible({ timeout: 10000 });

		const bracket = row
			.locator('[data-testid^="swimlane-run-bracket-start-"]')
			.first();
		await expect
			.poll(async () => bracket.count(), { timeout: 10000 })
			.toBeGreaterThan(0);
		// Dispatch the mouseenter event directly on the button
		// element. Playwright's ``hover()`` aims at the locator's
		// bounding-box centre, which on a 10 × 10 px SVG glyph is
		// a small hit target — under parallel-worker load
		// sub-pixel layout drift sometimes lands the synthetic
		// pointer event just outside the button, the React
		// onMouseEnter handler never fires, and the tooltip stays
		// hidden. Dispatching the event directly on the element
		// bypasses the geometry math and is reliable regardless
		// of the glyph's render position. The React synthetic
		// event system maps native ``mouseover`` to its
		// ``onMouseEnter`` handler when bubbling through the
		// button.
		await bracket.evaluate((el) => {
			el.dispatchEvent(
				new MouseEvent("mouseover", {
					bubbles: true,
					cancelable: true,
					view: window,
				}),
			);
		});
		const tooltip = page.locator(
			'[data-testid^="swimlane-run-bracket-tooltip-"]',
		);
		await expect(tooltip).toBeVisible();
		const text = (await tooltip.textContent()) ?? "";
		expect(text).toMatch(/run [0-9a-f]{8}/);
		expect(text).toMatch(/start:/);
		expect(text).toMatch(/end:/);
		expect(text).toMatch(/state:/);
		expect(text).toMatch(/tokens:/);
	});
});
