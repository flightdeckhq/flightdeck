/**
 * T137 — Runs that start together keep a start glyph each that the
 * pointer can reach.
 *
 * Fixture: the fan-out worker (e2e-test-fanout@e2e-host-fanout/worker),
 * whose three open runs start at the same instant, as a Claude Code
 * coordinator fans out same-role sub-agents. Their ▶ glyphs want the
 * same spot; glyphs on one edge are packed side by side, 1 px apart, so
 * no glyph covers another. At 5m every ▶'s centre hit-tests to that
 * ▶, the boxes are disjoint, and hovering each opens its own run's
 * tooltip. The glyph code this replaced drew coincident glyphs on one
 * spot, so only the topmost could be hovered or clicked.
 */
import { test, expect } from "@playwright/test";
import {
	FANOUT_FIXTURE,
	bringSwimlaneRowIntoView,
	fixtureSessionId,
	waitForFleetReady,
} from "./_fixtures";

const WORKER_ROLES = ["fanout-worker-1", "fanout-worker-2", "fanout-worker-3"];

// Wide enough for the 240 px sidebar, the 460 px label column and the
// 900 px timeline side by side, so the swimlane does not scroll
// sideways to "now" and no part of the timeline sits under the
// sticky label column, where a glyph cannot be hovered or hit.
test.use({ viewport: { width: 1700, height: 1800 } });

test.describe("T137 — Runs started together keep reachable glyphs", () => {
	test("every start glyph is its own hit target with its own tooltip", async ({ page }) => {
		await page.goto("/");
		await waitForFleetReady(page);
		await page.getByRole("button", { name: "5m", exact: true }).click();
		const row = await bringSwimlaneRowIntoView(page, FANOUT_FIXTURE.workerName);
		await expect(row).toBeVisible({ timeout: 10_000 });

		const prefixes = WORKER_ROLES.map((role) =>
			fixtureSessionId(FANOUT_FIXTURE.workerName, role).slice(0, 8),
		);
		const glyphs = prefixes.map((p) =>
			row.locator(`[data-testid="swimlane-run-bracket-start-${p}"]`),
		);
		for (const glyph of glyphs) await expect(glyph).toBeVisible({ timeout: 10_000 });

		// One synchronous pass: the window advances a few pixels a second
		// at 5m, so boxes read one call at a time can drift apart and
		// glyphs packed 1 px apart can seem to overlap.
		await glyphs[0]!.scrollIntoViewIfNeeded();
		const placed = await row.evaluate((el, ids) => {
			return ids.map((id) => {
				const glyph = el.querySelector(`[data-testid="swimlane-run-bracket-start-${id}"]`);
				const r = glyph!.getBoundingClientRect();
				const hit = document
					.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
					?.closest("button")
					?.getAttribute("data-testid");
				return { id, left: r.left, right: r.right, top: r.top, bottom: r.bottom, hit: hit ?? null };
			});
		}, prefixes);

		// Pairwise disjoint.
		for (let i = 0; i < placed.length; i++) {
			for (let j = i + 1; j < placed.length; j++) {
				const a = placed[i]!;
				const b = placed[j]!;
				const apart =
					a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;
				expect(apart, `glyphs ${a.id} and ${b.id} overlap`).toBe(true);
			}
		}

		for (let i = 0; i < glyphs.length; i++) {
			// The glyph's centre hit-tests to the glyph itself.
			expect(placed[i]!.hit).toBe(`swimlane-run-bracket-start-${prefixes[i]}`);

			await glyphs[i]!.hover();
			const tooltip = page.locator(`[data-testid="swimlane-run-bracket-tooltip-${prefixes[i]}"]`);
			await expect(tooltip).toBeVisible();
			await expect(tooltip).toContainText(`run ${prefixes[i]}`);
		}
	});
});
