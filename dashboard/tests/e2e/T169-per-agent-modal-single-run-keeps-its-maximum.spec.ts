/**
 * T169 — A single-run agent's lane stops at its maximum height in the
 * per-agent swimlane modal; it does not fill the modal.
 *
 * Fixture: the fan-out coordinator (e2e-test-fanout@e2e-host-fanout),
 * whose only run the keep-alive keeps open. It spawns the worker and
 * wide sub-agents, so the modal opens with "Show sub-agents" ticked. At
 * 1920x1080 the space left above the Live feed is far taller than one
 * lane needs: the coordinator's one lane is 144 px (three Fleet rows),
 * labelled with its run, and its sub-agents stay compact 48 px rows
 * under it, with no runs chip (the modal's rows are already expanded).
 *
 * Geometry and attributes only, so both theme projects run it unchanged.
 */
import { test, expect } from "@playwright/test";
import { FANOUT_FIXTURE, fixtureSessionId, openPerAgentModal } from "./_fixtures";

test.use({ viewport: { width: 1920, height: 1080 } });

const RUN_LANE_MAX_HEIGHT_PX = 144;
const FLEET_ROW_HEIGHT_PX = 48;

test.describe("T169 — A single-run agent keeps a lane of the maximum height", () => {
	test("the coordinator's one lane is 144 px, its sub-agents stay compact rows", async ({ page }) => {
		const modal = await openPerAgentModal(page, FANOUT_FIXTURE.coordinatorName);
		const group = modal.locator(`[data-testid="swimlane-agent-row-${FANOUT_FIXTURE.coordinatorName}"]`);
		await expect(group).toHaveAttribute("data-run-lanes", "true", { timeout: 10_000 });
		await expect(group).toHaveAttribute("data-lane-count", "1");
		await expect(
			modal.locator('[data-testid="per-agent-swimlane-modal-show-sub-agents-input"]'),
		).toBeChecked();

		const run = fixtureSessionId(FANOUT_FIXTURE.coordinatorName, "fanout-coordinator");
		const lane = group.locator(`[data-run-lane-row][data-run-id="${run}"]`);
		await expect(lane).toHaveCount(1);
		await expect(lane.getByTestId("swimlane-run-lane-id")).toHaveText(run.slice(0, 8));
		await expect(lane.getByTestId("swimlane-run-lane-status")).toHaveAttribute("data-state", "active");

		await expect
			.poll(async () => Math.round((await lane.boundingBox())?.height ?? 0), { timeout: 10_000 })
			.toBe(RUN_LANE_MAX_HEIGHT_PX);

		// The sub-agent rows (worker, wide) render once their runs are in
		// the roster; each is the Fleet's compact row, without a chip.
		for (const name of [FANOUT_FIXTURE.workerName, FANOUT_FIXTURE.wideName]) {
			const row = modal.locator(`[data-testid="swimlane-agent-row-${name}"]`);
			await expect(row).toBeVisible({ timeout: 10_000 });
			await expect(row).not.toHaveAttribute("data-run-lanes", "true");
			expect(Math.round((await row.boundingBox())!.height)).toBe(FLEET_ROW_HEIGHT_PX);
		}
		await expect(modal.getByTestId("swimlane-runs-chip")).toHaveCount(0);

		// Not the whole modal: room is left between the content and the feed.
		const room = await modal.evaluate((m) => {
			const scroll = m.querySelector<HTMLElement>('[data-testid="per-agent-swimlane-modal-scroll"]')!;
			return scroll.clientHeight - scroll.scrollHeight;
		});
		expect(room).toBeGreaterThanOrEqual(0);
		const viewport = await modal
			.locator('[data-testid="per-agent-swimlane-modal-scroll"]')
			.evaluate((el) => el.clientHeight);
		expect(viewport).toBeGreaterThan(2 * RUN_LANE_MAX_HEIGHT_PX);
	});
});
