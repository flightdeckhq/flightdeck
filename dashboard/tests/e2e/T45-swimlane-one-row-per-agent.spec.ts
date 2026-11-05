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
import {
	FANOUT_FIXTURE,
	bringSwimlaneRowIntoView,
	waitForFleetReady,
} from "./_fixtures";

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
		// The Fleet swimlane renders one row per agent, with no
		// per-run event rows under it.
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
		await expect(rows).not.toHaveCount(0);
	});

	test("an agent whose runs overlap stays one 48 px row with one name", async ({
		page,
	}) => {
		// The fan-out worker's three runs overlap, so its row splits
		// into run lanes inside the row, never into rows of their own.
		await page.setViewportSize({ width: 1700, height: 1800 });
		await page.goto("/");
		await waitForFleetReady(page);
		await page.getByRole("button", { name: "5m", exact: true }).click();
		const row = await bringSwimlaneRowIntoView(page, FANOUT_FIXTURE.workerName);
		await expect(row).toHaveAttribute("data-lane-count", "3", { timeout: 10_000 });
		await expect(
			page.locator(`[data-testid="swimlane-agent-row-${FANOUT_FIXTURE.workerName}"]`),
		).toHaveCount(1);
		await expect(row.getByTestId("swimlane-agent-name-link")).toHaveCount(1);
		expect((await row.boundingBox())!.height).toBeCloseTo(48, 0);
	});
});
