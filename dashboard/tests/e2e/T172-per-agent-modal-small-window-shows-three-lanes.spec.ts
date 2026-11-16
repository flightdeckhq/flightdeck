/**
 * T172 — In a small window the Live feed gives up height so three run
 * lanes show whole, and marker text keeps to the visible part of them.
 *
 * Fixture: an agent of this spec run's own (``startPrivateAgent``), three
 * runs started together through ingestion, so its lanes draw only what
 * the spec posts: one tool call 15 s ago on the second run and one 38 s
 * ago on the first. At 1280x720 the modal's scroll viewport above a
 * 240 px Live feed holds under three 40 px lanes, so the feed gives up
 * height, down to no less than its column header and three rows
 * (114 px), until all three lanes show whole, none cut through its label,
 * and nothing scrolls vertically. The heading shows the agent's whole
 * name. The swimlane opens scrolled to "now": the 15 s call shows its
 * name by its circle, on its run's lane, inside the view; the 38 s call's
 * circle sits under the sticky label column and shows none. Scrolled
 * back to the window's start, the 38 s call shows its name, right of the
 * label column and inside the view.
 *
 * Geometry and attributes, read in one browser evaluation per poll, so
 * both theme projects run it unchanged.
 */
import { test, expect, type Locator } from "@playwright/test";
import {
	endPrivateAgent,
	openPerAgentModal,
	postPrivateToolCall,
	startPrivateAgent,
	type PrivateAgent,
} from "./_fixtures";

test.use({ viewport: { width: 1280, height: 720 } });

const FEED_DEFAULT_HEIGHT_PX = 240;
const FEED_MIN_HEIGHT_PX = 114;
/** A call in view at "now" at 1m, 1280 px wide: right of the label
 *  column (about 37 s and younger) and its text left of "now". */
const IN_VIEW_AGO_MS = 15_000;
/** A call under the label column at "now" (older than about 37 s; it
 *  ages a few seconds more before that check) and still inside the
 *  minute's window, with some 20 s to spare, when the spec scrolls back
 *  to it. */
const UNDER_LABEL_AGO_MS = 38_000;

/** Where a marker text sits against its lane's label column and the
 *  visible part of the scroll viewport, and which run's lane holds it. */
function placement(text: Locator) {
	return text.evaluate((t) => {
		const scroller = t.closest('[data-testid="per-agent-swimlane-modal-scroll"]')!;
		const lane = t.closest("[data-run-lane-row]")!;
		const label = lane.querySelector('[data-testid="swimlane-run-lane-label"]')!.getBoundingClientRect();
		const now = scroller.querySelector('[data-testid="grid-line-now"]')!.getBoundingClientRect().left;
		const r = t.getBoundingClientRect();
		return {
			run: lane.getAttribute("data-run-id"),
			left: r.left,
			right: r.right,
			labelRight: label.right,
			limit: Math.min(now, scroller.getBoundingClientRect().left + scroller.clientWidth),
		};
	});
}

test.describe("T172 — A small window keeps three lanes whole", () => {
	let agent: PrivateAgent | null = null;

	test.afterEach(async ({ page }) => {
		if (agent) await endPrivateAgent(page, agent);
		agent = null;
	});

	test("the feed yields height to three lanes; marker text keeps to the view", async ({ page }) => {
		agent = await startPrivateAgent(page, "lane-text", 3);
		const [earlyRun, recentRun] = agent.sessionIds;
		const early = await postPrivateToolCall(page, agent, earlyRun!, "t172_early", UNDER_LABEL_AGO_MS);
		const recent = await postPrivateToolCall(page, agent, recentRun!, "t172_recent", IN_VIEW_AGO_MS);

		const modal = await openPerAgentModal(page, agent.agentName);
		const group = modal.locator(`[data-testid="swimlane-agent-row-${agent.agentName}"]`);
		await expect(group).toHaveAttribute("data-lane-count", "3", { timeout: 10_000 });
		const scroll = modal.locator('[data-testid="per-agent-swimlane-modal-scroll"]');

		const read = () =>
			scroll.evaluate((el) => {
				const top = el.getBoundingClientRect().top;
				const bottom = top + el.clientHeight;
				const lanes = Array.from(el.querySelectorAll<HTMLElement>("[data-run-lane-row]"));
				const feed = document.querySelector<HTMLElement>(
					'[data-testid="per-agent-swimlane-modal-feed"] [data-testid="feed-body-frame"]',
				)!;
				return {
					whole: lanes.every((l) => {
						const r = l.getBoundingClientRect();
						const label = l.querySelector('[data-testid="swimlane-run-lane-label"]')!.getBoundingClientRect();
						return r.top >= top - 0.5 && r.bottom <= bottom + 0.5 && label.bottom <= bottom + 0.5;
					}),
					scrolls: el.scrollHeight > el.clientHeight,
					feed: feed.getBoundingClientRect().height,
				};
			});
		await expect.poll(async () => (await read()).whole, { timeout: 10_000 }).toBe(true);
		const g = await read();
		expect(g.scrolls).toBe(false);
		expect(g.feed).toBeLessThan(FEED_DEFAULT_HEIGHT_PX);
		expect(g.feed).toBeGreaterThanOrEqual(FEED_MIN_HEIGHT_PX);

		// The heading's strip spans the visible row: the name is whole.
		const name = group.getByTestId("swimlane-run-lanes-heading").getByTestId("swimlane-agent-name-link");
		expect(await name.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);

		const circle = (eventId: string) => group.locator(`[data-run-lane-row] [data-event-id="${eventId}"]`);
		const text = (eventId: string) =>
			modal.locator(`[data-testid="swimlane-marker-text"][data-marker-for="${eventId}"]`);

		// At "now": the recent call names itself by its circle, on its
		// run's lane, inside the view.
		await expect(circle(recent)).toHaveCount(1, { timeout: 10_000 });
		await expect(text(recent)).toHaveText("t172_recent", { timeout: 10_000 });
		const recentAtNow = await placement(text(recent));
		expect(recentAtNow.run).toBe(recentRun);
		expect(recentAtNow.left).toBeGreaterThanOrEqual(recentAtNow.labelRight - 0.5);
		expect(recentAtNow.right).toBeLessThanOrEqual(recentAtNow.limit + 0.5);
		// The early call's circle is mounted, under the label column, and
		// shows no name.
		await expect(circle(early)).toHaveCount(1);
		const earlyUnderLabel = await circle(early).evaluate((c) => {
			const label = c
				.closest("[data-run-lane-row]")!
				.querySelector('[data-testid="swimlane-run-lane-label"]')!
				.getBoundingClientRect();
			return c.getBoundingClientRect().left < label.right;
		});
		expect(earlyUnderLabel).toBe(true);
		await expect(text(early)).toHaveCount(0);

		// Back to the window's start: the early call names itself, right of
		// the label column and inside the view.
		await scroll.evaluate((el) => {
			el.scrollLeft = 0;
		});
		await expect(text(early)).toHaveText("t172_early", { timeout: 10_000 });
		const earlyBack = await placement(text(early));
		expect(earlyBack.run).toBe(earlyRun);
		expect(earlyBack.left).toBeGreaterThanOrEqual(earlyBack.labelRight - 0.5);
		expect(earlyBack.right).toBeLessThanOrEqual(earlyBack.limit + 0.5);
	});
});
