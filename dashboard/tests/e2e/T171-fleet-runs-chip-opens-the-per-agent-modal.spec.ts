/**
 * T171 — A Fleet row whose agent has two or more runs at once shows a
 * runs chip that opens the per-agent swimlane modal.
 *
 * Fixtures: the fan-out worker (three runs at once), the wide sub-agent
 * (five at once: the chip counts five although the row draws four
 * lanes) and the coordinator (one run). The worker's and the wide row's
 * chips read "3 runs" / "5 runs" with a matching tooltip and accessible
 * name; the coordinator's row has none. The chip sits in the label
 * strip's badge column under the status badge, so the row stays 48 px
 * and the name keeps the width it had, at 1700 px and at 1280x720. The
 * chip, a button in the tab order, opens the modal for its agent from
 * the keyboard (focus, Enter) and by click. An agent of the spec's own
 * with ten runs at once reads `9+ runs`, the full count in its tooltip,
 * and its widest label still fits the badge column.
 *
 * Geometry and attributes, read in one browser evaluation, so both
 * theme projects run it unchanged.
 */
import { test, expect, type Page } from "@playwright/test";
import {
	FANOUT_FIXTURE,
	bringSwimlaneRowIntoView,
	endPrivateAgent,
	startPrivateAgent,
	waitForFleetReady,
	type PrivateAgent,
} from "./_fixtures";

/** The label strip's right padding that holds the badge column
 *  (SwimLane's ``BADGE_RESERVED_ZONE_PX``). */
const BADGE_COLUMN_PX = 88;
const FLEET_ROW_HEIGHT_PX = 48;

async function chipGeometry(page: Page, agentName: string) {
	const row = await bringSwimlaneRowIntoView(page, agentName);
	await expect(row).toBeVisible({ timeout: 10_000 });
	const chip = row.getByTestId("swimlane-runs-chip");
	await expect(chip).toBeVisible({ timeout: 10_000 });
	return row.evaluate((el) => {
		const rect = (sel: string) => el.querySelector(sel)!.getBoundingClientRect();
		const label = el.querySelector(".swimlane-row-label")!.getBoundingClientRect();
		const chipEl = el.querySelector('[data-testid="swimlane-runs-chip"]')!;
		const badge = rect('[data-testid="swimlane-agent-status-badge"]');
		const c = chipEl.getBoundingClientRect();
		return {
			rowHeight: el.getBoundingClientRect().height,
			labelRight: label.right,
			labelTop: label.top,
			labelBottom: label.bottom,
			chip: { left: c.left, right: c.right, top: c.top, bottom: c.bottom },
			badgeBottom: badge.bottom,
			wrapperWidth: rect('[data-testid="swimlane-badge-wrapper"]').width,
			text: chipEl.textContent?.trim(),
			title: chipEl.getAttribute("title"),
			ariaLabel: chipEl.getAttribute("aria-label"),
		};
	});
}

function expectChipFits(g: Awaited<ReturnType<typeof chipGeometry>>) {
	expect(Math.round(g.rowHeight)).toBe(FLEET_ROW_HEIGHT_PX);
	// Inside the badge column, under the status badge, inside the row.
	expect(g.wrapperWidth).toBeLessThanOrEqual(BADGE_COLUMN_PX);
	expect(g.chip.left).toBeGreaterThanOrEqual(g.labelRight - BADGE_COLUMN_PX);
	expect(g.chip.right).toBeLessThanOrEqual(g.labelRight);
	expect(g.chip.top).toBeGreaterThanOrEqual(g.badgeBottom);
	expect(g.chip.top).toBeGreaterThanOrEqual(g.labelTop);
	expect(g.chip.bottom).toBeLessThanOrEqual(g.labelBottom);
}

for (const viewport of [
	{ width: 1700, height: 1000 },
	{ width: 1280, height: 720 },
]) {
	test.describe(`T171 — The Fleet runs chip at ${viewport.width}x${viewport.height}`, () => {
		test.use({ viewport });

		test("multi-run rows show the chip in the badge column; a one-run row has none", async ({ page }) => {
			await page.goto("/");
			await waitForFleetReady(page);

			const worker = await chipGeometry(page, FANOUT_FIXTURE.workerName);
			expect(worker.text).toBe("3 runs");
			expect(worker.title).toBe("3 runs at once: expand in swimlane");
			expect(worker.ariaLabel).toBe("3 runs at once: expand in swimlane");
			expectChipFits(worker);

			const wide = await chipGeometry(page, FANOUT_FIXTURE.wideName);
			expect(wide.text).toBe("5 runs");
			expectChipFits(wide);

			const coordinator = await bringSwimlaneRowIntoView(page, FANOUT_FIXTURE.coordinatorName);
			await expect(coordinator).toBeVisible({ timeout: 10_000 });
			await expect(coordinator.getByTestId("swimlane-agent-status-badge")).toBeVisible();
			await expect(coordinator.getByTestId("swimlane-runs-chip")).toHaveCount(0);
		});
	});
}

test.describe("T171 — The Fleet runs chip opens the per-agent modal", () => {
	test.use({ viewport: { width: 1700, height: 1000 } });

	test("Enter on the focused chip opens the agent's modal; so does a click", async ({ page }) => {
		await page.goto("/");
		await waitForFleetReady(page);
		const modal = page.locator('[data-testid="per-agent-swimlane-modal"]');

		const worker = await bringSwimlaneRowIntoView(page, FANOUT_FIXTURE.workerName);
		const chip = worker.getByTestId("swimlane-runs-chip");
		await expect(chip).toBeVisible({ timeout: 10_000 });
		await chip.focus();
		await expect(chip).toBeFocused();
		await page.keyboard.press("Enter");
		await expect(modal).toBeVisible();
		await expect(modal.getByTestId("per-agent-swimlane-modal-name")).toHaveText(FANOUT_FIXTURE.workerName);
		// The same modal as the drawer's: the agent's row as run lanes.
		await expect(
			modal.locator(`[data-testid="swimlane-agent-row-${FANOUT_FIXTURE.workerName}"]`),
		).toHaveAttribute("data-run-lanes", "true");
		await page.keyboard.press("Escape");
		await expect(modal).toHaveCount(0);

		const wide = await bringSwimlaneRowIntoView(page, FANOUT_FIXTURE.wideName);
		await wide.getByTestId("swimlane-runs-chip").click();
		await expect(modal).toBeVisible();
		await expect(modal.getByTestId("per-agent-swimlane-modal-name")).toHaveText(FANOUT_FIXTURE.wideName);
	});
});

test.describe("T171 — The Fleet runs chip caps its label past nine runs", () => {
	test.use({ viewport: { width: 1280, height: 720 } });
	let agent: PrivateAgent | null = null;

	test.afterEach(async ({ page }) => {
		if (agent) await endPrivateAgent(page, agent);
		agent = null;
	});

	test("ten runs at once read 9+ runs and the chip fits the badge column", async ({ page }) => {
		agent = await startPrivateAgent(page, "ten-runs", 10);
		await page.goto("/");
		await waitForFleetReady(page);
		const g = await chipGeometry(page, agent.agentName);
		expect(g.text).toBe("9+ runs");
		expect(g.title).toBe("10 runs at once: expand in swimlane");
		expect(g.ariaLabel).toBe("10 runs at once: expand in swimlane");
		expectChipFits(g);
	});
});
