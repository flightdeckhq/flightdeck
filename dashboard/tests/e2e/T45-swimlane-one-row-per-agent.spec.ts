/**
 * T45 — Swimlane renders ONE row per agent with no session sub-rows.
 *
 * After the Fleet view reshape, every agent gets a single timeline
 * row that streams events from all of its runs onto one row. The
 * old chevron-expanded session-list drawer is gone; this spec is
 * the regression guard that the reshape's contract holds —
 * specifically that no ``data-testid="swimlane-expanded-body"``
 * containers and no per-session sub-rows render under any swimlane
 * row.
 */
import { test, expect } from "@playwright/test";
import { waitForFleetReady } from "./_fixtures";

test.describe("T45 — Swimlane one row per agent", () => {
	test("no swimlane-expanded-body container exists on any row", async ({
		page,
	}) => {
		await page.goto("/");
		await waitForFleetReady(page);
		const expandedBody = page.locator(
			'[data-testid="swimlane-expanded-body"]',
		);
		expect(await expandedBody.count()).toBe(0);
	});

	test("no SESSIONS sub-header or session-event-row children mount", async ({
		page,
	}) => {
		await page.goto("/");
		await waitForFleetReady(page);
		// The Fleet swimlane no longer renders <SessionEventRow/>
		// children. The Events page session drawer is the only
		// remaining consumer of that component.
		const sessionEventRows = page.locator(
			'[data-testid^="session-event-row-"]',
		);
		expect(await sessionEventRows.count()).toBe(0);
	});

	test("at least one swimlane-agent-row mounts under the Fleet timeline", async ({
		page,
	}) => {
		await page.goto("/");
		await waitForFleetReady(page);
		const rows = page.locator('[data-testid^="swimlane-agent-row-"]');
		expect(await rows.count()).toBeGreaterThan(0);
	});
});
