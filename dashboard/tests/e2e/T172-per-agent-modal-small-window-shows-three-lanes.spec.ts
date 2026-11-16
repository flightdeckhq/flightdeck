/**
 * T172 — In a small window the Live feed gives up height so three run
 * lanes show whole, and marker text stays in the visible part of them.
 *
 * Fixture: the fan-out worker (e2e-test-fanout@e2e-host-fanout/worker),
 * three runs still open, each with a keep-alive tool call
 * (``e2e_fanout_work``) every cycle. At 1280x720 the modal's scroll
 * viewport above a 240 px Live feed holds under three 40 px lanes, so
 * the feed gives up height, down to no less than its column header and
 * three rows (114 px), until all three lanes show whole, none cut
 * through its label, and nothing scrolls vertically. The heading shows
 * the agent's whole name. The swimlane opens scrolled to "now"; scrolled
 * back to the window's start, the circles under the sticky label column
 * carry no text, and every text sits by a circle wholly right of that
 * column and ends left of the now line.
 *
 * Geometry and attributes, read in one browser evaluation per poll, so
 * both theme projects run it unchanged.
 */
import { test, expect } from "@playwright/test";
import { FANOUT_FIXTURE, openPerAgentModal } from "./_fixtures";

test.use({ viewport: { width: 1280, height: 720 } });

const FEED_DEFAULT_HEIGHT_PX = 240;
const FEED_MIN_HEIGHT_PX = 114;

test.describe("T172 — A small window keeps three lanes whole", () => {
	test("the feed yields height to three lanes; marker text stays in view", async ({ page }) => {
		const modal = await openPerAgentModal(page, FANOUT_FIXTURE.workerName);
		const group = modal.locator(`[data-testid="swimlane-agent-row-${FANOUT_FIXTURE.workerName}"]`);
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

		// Back to the window's start: the tool calls of the last minute
		// come into view, and those under the label column lose their text.
		await scroll.evaluate((el) => {
			el.scrollLeft = 0;
		});
		const texts = () =>
			scroll.evaluate((el) => {
				const now = el.querySelector('[data-testid="grid-line-now"]')!.getBoundingClientRect().left;
				const right = el.getBoundingClientRect().left + el.clientWidth;
				return Array.from(el.querySelectorAll<HTMLElement>('[data-testid="swimlane-marker-text"]')).map((t) => {
					const lane = t.closest("[data-run-lane-row]")!;
					const label = lane.querySelector('[data-testid="swimlane-run-lane-label"]')!.getBoundingClientRect();
					const circle = lane
						.querySelector(`[data-event-id="${t.getAttribute("data-marker-for")}"]`)!
						.getBoundingClientRect();
					const r = t.getBoundingClientRect();
					return {
						labelRight: label.right,
						circleLeft: circle.left,
						left: r.left,
						right: r.right,
						limit: Math.min(now, right),
					};
				});
			});
		await expect.poll(async () => (await texts()).length, { timeout: 10_000 }).toBeGreaterThan(0);
		for (const t of await texts()) {
			expect(t.circleLeft).toBeGreaterThanOrEqual(t.labelRight - 0.5);
			expect(t.left).toBeGreaterThanOrEqual(t.labelRight - 0.5);
			expect(t.right).toBeLessThanOrEqual(t.limit + 0.5);
		}
	});
});
