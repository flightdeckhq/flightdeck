/**
 * T169 — A single-run agent's lane stops at its maximum height in the
 * per-agent swimlane modal; it does not fill the modal.
 *
 * Fixture: the fan-out coordinator (e2e-test-fanout@e2e-host-fanout),
 * whose only run the keep-alive keeps open. It spawns the worker and
 * wide sub-agents, so the modal opens with "Show sub-agents" ticked;
 * each sub-agent is then its own group of run lanes under the
 * coordinator's (the worker's three open runs, the wide one's five), with
 * no runs chip (the modal's rows are already expanded). With "Show
 * sub-agents" off, at 1920x1080 the space left above the Live feed is far
 * taller than one lane needs: the coordinator's one lane is 144 px (three
 * Fleet rows), labelled with its run, and the Timeline's content ends
 * well above the feed.
 *
 * Geometry and attributes only, so both theme projects run it unchanged.
 */
import { test, expect } from "@playwright/test";
import { FANOUT_FIXTURE, fixtureSessionId, openPerAgentModal } from "./_fixtures";

test.use({ viewport: { width: 1920, height: 1080 } });

const RUN_LANE_MAX_HEIGHT_PX = 144;

test.describe("T169 — A single-run agent keeps a lane of the maximum height", () => {
	test("the coordinator's one lane is 144 px; each sub-agent is a group of lanes", async ({ page }) => {
		const modal = await openPerAgentModal(page, FANOUT_FIXTURE.coordinatorName);
		const group = modal.locator(`[data-testid="swimlane-agent-row-${FANOUT_FIXTURE.coordinatorName}"]`);
		await expect(group).toHaveAttribute("data-run-lanes", "true", { timeout: 10_000 });
		await expect(group).toHaveAttribute("data-lane-count", "1");
		const showSubAgents = modal.locator('[data-testid="per-agent-swimlane-modal-show-sub-agents-input"]');
		await expect(showSubAgents).toBeChecked();

		// The sub-agents (worker, wide) render once their runs are in the
		// roster; each is a group of run lanes of its own, without a chip.
		for (const [name, lanes] of [
			[FANOUT_FIXTURE.workerName, "3"],
			[FANOUT_FIXTURE.wideName, "5"],
		] as const) {
			const row = modal.locator(`[data-testid="swimlane-agent-row-${name}"]`);
			await expect(row).toBeVisible({ timeout: 10_000 });
			await expect(row).toHaveAttribute("data-run-lanes", "true");
			await expect(row).toHaveAttribute("data-topology", "child");
			await expect(row).toHaveAttribute("data-lane-count", lanes);
		}
		await expect(modal.getByTestId("swimlane-runs-chip")).toHaveCount(0);

		// The coordinator alone: its one lane takes its maximum.
		await showSubAgents.uncheck();
		await expect(modal.locator(`[data-testid="swimlane-agent-row-${FANOUT_FIXTURE.workerName}"]`)).toHaveCount(0);

		const run = fixtureSessionId(FANOUT_FIXTURE.coordinatorName, "fanout-coordinator");
		const lane = group.locator(`[data-run-lane-row][data-run-id="${run}"]`);
		await expect(lane).toHaveCount(1);
		await expect(lane.getByTestId("swimlane-run-lane-id")).toHaveText(run.slice(0, 8));
		await expect(lane.getByTestId("swimlane-run-lane-status")).toHaveAttribute("data-state", "active");

		await expect
			.poll(async () => Math.round((await lane.boundingBox())?.height ?? 0), { timeout: 10_000 })
			.toBe(RUN_LANE_MAX_HEIGHT_PX);

		// Not the whole modal: the Timeline's content ends well above the
		// feed, with room left in the scroll viewport.
		const { content, viewport } = await modal.evaluate((m) => {
			const scroll = m.querySelector<HTMLElement>('[data-testid="per-agent-swimlane-modal-scroll"]')!;
			const timeline = scroll.querySelector<HTMLElement>('[data-testid="timeline-scroll"]')!;
			return { content: timeline.getBoundingClientRect().height, viewport: scroll.clientHeight };
		});
		expect(viewport - content).toBeGreaterThan(RUN_LANE_MAX_HEIGHT_PX / 2);
	});
});
