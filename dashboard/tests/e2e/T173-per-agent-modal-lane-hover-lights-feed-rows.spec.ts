/**
 * T173 — Hovering a run lane in the per-agent modal lights that run's
 * rows in the modal's Live feed.
 *
 * Fixture: an agent of this spec run's own (``createPrivateAgent``), two
 * runs started 90 s back with one tool call each, so the modal's lanes
 * and feed hold only what the spec posts. At the 5m range the runs and
 * calls stay in the window for minutes, whatever the spec's pace.
 *
 * Pointing at the first lane's label lights that lane and every feed
 * row of its run, and no row of the other run; pointing at the second
 * lane's panel moves the light to it; pointing away puts it out. The
 * lanes and rows are read in one browser evaluation per poll, by their
 * ``data-linked`` attribute, so both theme projects run it unchanged.
 */
import { test, expect, type Locator } from "@playwright/test";
import {
	createPrivateAgent,
	endPrivateAgent,
	openPerAgentModal,
	postPrivateToolCall,
	startPrivateAgent,
	type PrivateAgent,
} from "./_fixtures";

/** The runs' starts and the calls: inside the 5m window for minutes. */
const STARTED_AGO_MS = 90_000;
const CALL_AGO_MS = 60_000;
/** A point of a lane's 900 px panel just left of "now" (881 px), which
 *  the modal opens scrolled to: in view, and at 5m 20 px (7 s) newer
 *  than any mark the spec posts. */
const PANEL_POINT_X_PX = 860;

/** The lit lanes and, per run, the feed rows lit and in all. */
function readLight(modal: Locator) {
	return modal.evaluate((m) => {
		const rows = Array.from(m.querySelectorAll<HTMLElement>('[data-testid="feed-row"]'));
		const byRun: Record<string, { lit: number; all: number }> = {};
		for (const r of rows) {
			const run = r.getAttribute("data-run-id") ?? "";
			byRun[run] ??= { lit: 0, all: 0 };
			byRun[run].all += 1;
			if (r.getAttribute("data-linked") === "true") byRun[run].lit += 1;
		}
		const lanes = Array.from(m.querySelectorAll<HTMLElement>('[data-run-lane-row][data-linked="true"]')).map(
			(l) => l.getAttribute("data-run-id"),
		);
		return { lanes, byRun };
	});
}

test.describe("T173 — Hovering a lane lights its run's feed rows", () => {
	let agent: PrivateAgent | null = null;

	test.afterEach(async ({ page }) => {
		if (agent) await endPrivateAgent(page, agent);
		agent = null;
	});

	test("a hovered lane lights its own run's rows and no other", async ({ page }) => {
		agent = createPrivateAgent("lane-hover", 2);
		await startPrivateAgent(page, agent, { startedAgoMs: STARTED_AGO_MS });
		const [first, second] = agent.sessionIds as [string, string];
		await postPrivateToolCall(page, agent, first, "t173_first", CALL_AGO_MS);
		await postPrivateToolCall(page, agent, second, "t173_second", CALL_AGO_MS);

		const modal = await openPerAgentModal(page, agent.agentName);
		await modal.locator('[data-testid="per-agent-swimlane-modal-time-5m"]').click();
		const group = modal.locator(`[data-testid="swimlane-agent-row-${agent.agentName}"]`);
		await expect(group).toHaveAttribute("data-lane-count", "2", { timeout: 10_000 });
		const lane = (run: string) => group.locator(`[data-run-lane-row][data-run-id="${run}"]`);
		const feed = modal.locator('[data-testid="per-agent-swimlane-modal-feed"]');
		// Both runs' calls are in the feed before anything is hovered.
		for (const run of [first, second]) {
			await expect(feed.locator(`[data-testid="feed-row"][data-run-id="${run}"]`).first()).toBeVisible({
				timeout: 10_000,
			});
		}

		await lane(first).getByTestId("swimlane-run-lane-label").hover();
		await expect
			.poll(async () => {
				const { lanes, byRun } = await readLight(modal);
				return {
					lanes,
					firstAllLit: byRun[first]!.lit === byRun[first]!.all,
					secondLit: byRun[second]!.lit,
				};
			})
			.toEqual({ lanes: [first], firstAllLit: true, secondLit: 0 });

		// The lane's panel lights it too: the light moves to the second run.
		// Its top edge just left of "now", in view and clear of any mark.
		await lane(second).getByTestId("swimlane-timeline-panel").hover({ position: { x: PANEL_POINT_X_PX, y: 4 } });
		await expect
			.poll(async () => {
				const { lanes, byRun } = await readLight(modal);
				return {
					lanes,
					firstLit: byRun[first]!.lit,
					secondAllLit: byRun[second]!.lit === byRun[second]!.all,
				};
			})
			.toEqual({ lanes: [second], firstLit: 0, secondAllLit: true });

		// Away from the lanes and the feed: nothing is lit.
		await modal.getByTestId("per-agent-swimlane-modal-name").hover();
		await expect
			.poll(async () => {
				const { lanes, byRun } = await readLight(modal);
				return { lanes, lit: Object.values(byRun).reduce((n, r) => n + r.lit, 0) };
			})
			.toEqual({ lanes: [], lit: 0 });
	});
});
