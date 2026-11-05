/**
 * T155 — Runs past the fourth lane share it.
 *
 * Fixture: the fan-out coordinator's ``/wide`` sub-agent
 * (e2e-test-fanout@e2e-host-fanout/wide), five runs started in one
 * statement. A row draws at most four lanes, so at 5m it has
 * ``data-lane-count="4"`` and ``data-lane-overflow="true"``: the first
 * three runs (in run-id order, the tie-break for runs started together)
 * get a lane each and the last two share the fourth. Every ▶ is still
 * its own hit target with its own tooltip, and the shared glyphs say how
 * many runs share their lane. The overflow lane's lines overlap, so
 * they take no pointer input there.
 *
 * Geometry and attributes only, so both theme projects run it unchanged.
 */
import { test, expect } from "@playwright/test";
import {
	FANOUT_FIXTURE,
	bringSwimlaneRowIntoView,
	fixtureSessionId,
	waitForFleetReady,
} from "./_fixtures";

test.use({ viewport: { width: 1700, height: 1800 } });

test.describe("T155 — Runs past four share the overflow lane", () => {
	test("five runs started together draw four lanes, the last one shared", async ({ page }) => {
		await page.goto("/");
		await waitForFleetReady(page);
		await page.getByRole("button", { name: "5m", exact: true }).click();
		const row = await bringSwimlaneRowIntoView(page, FANOUT_FIXTURE.wideName);
		await expect(row).toBeVisible({ timeout: 10_000 });
		await expect(row).toHaveAttribute("data-lane-count", "4", { timeout: 10_000 });
		await expect(row).toHaveAttribute("data-lane-overflow", "true");

		// Runs started together take lanes in run-id order.
		const ids = FANOUT_FIXTURE.wideRoles
			.map((role) => fixtureSessionId(FANOUT_FIXTURE.wideName, role))
			.sort();
		const prefixes = ids.map((id) => id.slice(0, 8));
		const expectedLanes = ["0", "1", "2", "3", "3"];
		const glyphs = prefixes.map((p) => row.locator(`[data-testid="swimlane-run-bracket-start-${p}"]`));
		for (let i = 0; i < glyphs.length; i++) {
			await expect(glyphs[i]!).toHaveAttribute("data-run-lane", expectedLanes[i]!, { timeout: 10_000 });
		}

		// Five lines; the two in the overflow lane are shared.
		const lines = row.locator('[data-testid^="swimlane-run-line-"]');
		await expect(lines).toHaveCount(5);
		await expect(row.locator('[data-testid^="swimlane-run-line-"][data-shared="true"]')).toHaveCount(2);

		// Every ▶'s centre hit-tests to that ▶, in one synchronous read.
		await glyphs[0]!.scrollIntoViewIfNeeded();
		const hits = await row.evaluate((el, ps) => {
			return ps.map((p) => {
				const glyph = el.querySelector(`[data-testid="swimlane-run-bracket-start-${p}"]`)!;
				const r = glyph.getBoundingClientRect();
				return (
					document
						.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
						?.closest("button")
						?.getAttribute("data-testid") ?? null
				);
			});
		}, prefixes);
		expect(hits).toEqual(prefixes.map((p) => `swimlane-run-bracket-start-${p}`));

		// Each tooltip names its own run and lane; the shared ones say so.
		// The keep-alive re-pins these runs every cycle and the window
		// moves each second, so a glyph can slide out from under the
		// pointer between two reads: each poll hovers and reads the
		// tooltip in one step.
		for (let i = 0; i < glyphs.length; i++) {
			const tooltip = page.locator(`[data-testid="swimlane-run-bracket-tooltip-${prefixes[i]}"]`);
			const lane = i < 3 ? `lane ${i + 1} of 4` : "lane 4 of 4 · shared by 2 runs";
			await expect
				.poll(
					async () => {
						await glyphs[i]!.hover();
						const text = (await tooltip.textContent({ timeout: 1_000 }).catch(() => null)) ?? "";
						return (
							text.includes(`run ${prefixes[i]}`) &&
							text.includes(lane) &&
							(i >= 3 || !text.includes("shared"))
						);
					},
					{ timeout: 15_000 },
				)
				.toBe(true);
		}
	});
});
