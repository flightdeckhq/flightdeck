/**
 * T174 — Hovering a Live feed row in the per-agent modal lights its run's
 * lane and rings that event's circle.
 *
 * Fixture: an agent of this spec run's own (``createPrivateAgent``), two
 * runs started 90 s back, the first with two tool calls (60 s and 40 s
 * old), the second with one, so the feed holds only what the spec posts
 * and its rows stay put. At the 5m range the calls sit in the window and
 * in view, right of the label column, for minutes, whatever the spec's
 * pace.
 *
 * Pointing at the feed row of the first run's older call lights that
 * run's lane, and of its circles rings that call's alone; the row of the
 * same run's newer call moves the ring to its circle; the second run's
 * row moves the light to the second lane. Attributes (``data-linked``)
 * only, read in one browser evaluation per poll, so both theme projects
 * run it unchanged.
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

const STARTED_AGO_MS = 90_000;
const OLDER_CALL_AGO_MS = 60_000;
const NEWER_CALL_AGO_MS = 40_000;

/** The lit lanes and the ringed circles (by event id). */
function readLight(modal: Locator) {
	return modal.evaluate((m) => ({
		lanes: Array.from(m.querySelectorAll('[data-run-lane-row][data-linked="true"]')).map((l) =>
			l.getAttribute("data-run-id"),
		),
		circles: Array.from(m.querySelectorAll('[data-run-lane-row] [data-event-id][data-linked="true"]')).map((c) =>
			c.getAttribute("data-event-id"),
		),
	}));
}

test.describe("T174 — Hovering a feed row lights its lane and circle", () => {
	let agent: PrivateAgent | null = null;

	test.afterEach(async ({ page }) => {
		if (agent) await endPrivateAgent(page, agent);
		agent = null;
	});

	test("the row's run lights, and the ring follows the row", async ({ page }) => {
		agent = createPrivateAgent("feed-hover", 2);
		await startPrivateAgent(page, agent, { startedAgoMs: STARTED_AGO_MS });
		const [first, second] = agent.sessionIds as [string, string];
		const older = await postPrivateToolCall(page, agent, first, "t174_older", OLDER_CALL_AGO_MS);
		const newer = await postPrivateToolCall(page, agent, first, "t174_newer", NEWER_CALL_AGO_MS);
		const other = await postPrivateToolCall(page, agent, second, "t174_other", OLDER_CALL_AGO_MS);

		const modal = await openPerAgentModal(page, agent.agentName);
		await modal.locator('[data-testid="per-agent-swimlane-modal-time-5m"]').click();
		const group = modal.locator(`[data-testid="swimlane-agent-row-${agent.agentName}"]`);
		await expect(group).toHaveAttribute("data-lane-count", "2", { timeout: 10_000 });
		const feedRow = (eventId: string) =>
			modal.locator(`[data-testid="feed-row"][data-feed-event-id="${eventId}"]`);
		// The calls' circles are on the lanes and their rows in the feed.
		for (const id of [older, newer, other]) {
			await expect(group.locator(`[data-run-lane-row] [data-event-id="${id}"]`)).toHaveCount(1, {
				timeout: 10_000,
			});
			await expect(feedRow(id)).toBeVisible({ timeout: 10_000 });
		}

		await feedRow(older).hover();
		await expect.poll(() => readLight(modal)).toEqual({ lanes: [first], circles: [older] });

		await feedRow(newer).hover();
		await expect.poll(() => readLight(modal)).toEqual({ lanes: [first], circles: [newer] });

		await feedRow(other).hover();
		await expect.poll(() => readLight(modal)).toEqual({ lanes: [second], circles: [other] });

		await modal.getByTestId("per-agent-swimlane-modal-name").hover();
		await expect.poll(() => readLight(modal)).toEqual({ lanes: [], circles: [] });
	});
});
