/**
 * T51 — The ``?view=table`` Fleet toggle is gone.
 *
 * Phase 2 dropped the swimlane/table view toggle and deleted the
 * AgentTable component. The URL param ``view`` is no longer read;
 * navigating to ``/?view=table`` renders the swimlane.
 *
 * Three guarantees:
 *   1. The toggle ``data-testid="fleet-view-toggle"`` no longer
 *      exists on the Fleet page.
 *   2. Navigating with ``?view=table`` lands on the swimlane (at
 *      least one ``swimlane-agent-row-*`` mounts).
 *   3. No legacy ``fleet-agent-row-*`` (AgentTable rows) mount.
 */
import { test, expect } from "@playwright/test";
import { waitForFleetReady } from "./_fixtures";

test.describe("T51 — ?view=table toggle removed", () => {
	test("fleet-view-toggle data-testid no longer exists", async ({ page }) => {
		await page.goto("/");
		await waitForFleetReady(page);
		const toggle = page.locator('[data-testid="fleet-view-toggle"]');
		expect(await toggle.count()).toBe(0);
	});

	test("?view=table renders the swimlane (URL param ignored)", async ({
		page,
	}) => {
		await page.goto("/?view=table");
		await waitForFleetReady(page);
		const swimlaneRows = page.locator(
			'[data-testid^="swimlane-agent-row-"]',
		);
		expect(await swimlaneRows.count()).toBeGreaterThan(0);
	});

	test("no legacy AgentTable rows mount on the Fleet page", async ({
		page,
	}) => {
		await page.goto("/?view=table");
		await waitForFleetReady(page);
		const tableRows = page.locator('[data-testid^="fleet-agent-row-"]');
		expect(await tableRows.count()).toBe(0);
	});
});
