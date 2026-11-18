/**
 * T49 — Swimlane agent label strip preserves the locked left-to-
 * right order.
 *
 * Inside each swimlane row's left panel the elements must appear in
 * this order:
 *
 *   agent name (mono)
 *   → ClientTypePill (CC for plugin, SDK for sensor)
 *   → agent_type badge (coding / production)
 *   → provider icon
 *   → OS icon
 *   → orchestration icon
 *   → topology pill (lone / ↳ parent / ⤴ N)
 *   → AgentStatusBadge at the right edge
 *
 * Not every agent renders every pill — provider / OS / orchestration
 * are best-effort from the most-recent session. The pills that DO
 * mount must appear in the canonical order.
 */
import { test, expect } from "@playwright/test";
import { waitForFleetReady } from "./_fixtures";

const PILL_TESTIDS_IN_ORDER = [
	"swimlane-client-type-pill",
	"swimlane-agent-type-badge",
	"swimlane-relationship-pill",
	"swimlane-agent-status-badge",
];

test.describe("T49 — Agent label strip ordering", () => {
	test("rendered pills appear in canonical left-to-right order", async ({
		page,
	}) => {
		await page.goto("/");
		await waitForFleetReady(page);
		// Locate the first swimlane row and inspect its label-strip
		// children ordering. Pills that don't render for this agent
		// are dropped from the order check; the order of the
		// rendered subset must match.
		const row = page.locator('[data-testid^="swimlane-agent-row-"]').first();
		await expect(row).toBeVisible({ timeout: 8000 });
		// Every pill's left edge read in one browser evaluation, off the
		// same row at the same moment: one locator call per pill would
		// re-resolve "the first row" each time, and the Fleet re-sorts
		// and re-renders its rows between page round trips.
		const present = await row.evaluate((el, testids) => {
			const found: { testid: string; x: number }[] = [];
			for (const testid of testids) {
				const pill = el.querySelector(`[data-testid="${testid}"]`);
				const box = pill?.getBoundingClientRect();
				if (!box || (box.width === 0 && box.height === 0)) continue;
				found.push({ testid, x: box.x });
			}
			return found;
		}, PILL_TESTIDS_IN_ORDER);
		const positions = present.map((p) => p.x);
		const presentTestIds = present.map((p) => p.testid);
		// At minimum the AgentStatusBadge must render on every row.
		expect(presentTestIds).toContain("swimlane-agent-status-badge");
		// Positions must be monotonically increasing left → right.
		for (let i = 1; i < positions.length; i++) {
			expect(
				positions[i],
				`${presentTestIds[i]} must render to the right of ${presentTestIds[i - 1]}`,
			).toBeGreaterThan(positions[i - 1]!);
		}
	});
});
