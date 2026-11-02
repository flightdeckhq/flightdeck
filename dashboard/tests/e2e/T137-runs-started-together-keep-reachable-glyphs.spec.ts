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

test.use({ viewport: { width: 1280, height: 1800 } });

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

		const boxes = [];
		for (const glyph of glyphs) {
			const box = await glyph.boundingBox();
			expect(box).not.toBeNull();
			boxes.push(box!);
		}
		// Pairwise disjoint.
		for (let i = 0; i < boxes.length; i++) {
			for (let j = i + 1; j < boxes.length; j++) {
				const a = boxes[i]!;
				const b = boxes[j]!;
				const apart =
					a.x + a.width <= b.x ||
					b.x + b.width <= a.x ||
					a.y + a.height <= b.y ||
					b.y + b.height <= a.y;
				expect(apart, `glyphs ${prefixes[i]} and ${prefixes[j]} overlap`).toBe(true);
			}
		}

		for (let i = 0; i < glyphs.length; i++) {
			const box = boxes[i]!;
			const hit = await page.evaluate(
				([x, y]) => document.elementFromPoint(x!, y!)?.closest("button")?.getAttribute("data-testid") ?? null,
				[box.x + box.width / 2, box.y + box.height / 2],
			);
			expect(hit).toBe(`swimlane-run-bracket-start-${prefixes[i]}`);

			await glyphs[i]!.hover();
			const tooltip = page.locator(`[data-testid="swimlane-run-bracket-tooltip-${prefixes[i]}"]`);
			await expect(tooltip).toBeVisible();
			await expect(tooltip).toContainText(`run ${prefixes[i]}`);
		}
	});
});
