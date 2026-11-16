/**
 * T168 — The per-agent swimlane modal draws one labelled lane per run,
 * filling the space down to the Live feed.
 *
 * Fixture: the fan-out worker (e2e-test-fanout@e2e-host-fanout/worker),
 * one Claude Code sub-agent role with three runs started together and
 * still open (the keep-alive re-pins them every cycle), and an earlier
 * lost run that ended two hours ago. Its modal, opened from the agent
 * drawer's "Open in swimlane" at 1920x1080, draws the agent's row as a
 * heading and three lanes: one per open run, none for the lost run.
 * Each lane is labelled with its run's short id, state, model and
 * tokens; the lanes share the scroll viewport's height equally (between
 * the 40 px minimum and the 144 px maximum), so the last lane ends at the
 * Live feed and nothing scrolls. The heading shows the agent's whole
 * name. Marker text is T172's, on runs of its own: on these shared runs
 * the seed's, the keep-alive's and other specs' calls decide which texts
 * have room.
 *
 * Geometry and attributes, read in one browser evaluation per poll, so
 * both theme projects run it unchanged.
 */
import { test, expect } from "@playwright/test";
import { FANOUT_FIXTURE, fixtureSessionId, openPerAgentModal } from "./_fixtures";

test.use({ viewport: { width: 1920, height: 1080 } });

const RUN_LANE_MIN_HEIGHT_PX = 40;
const RUN_LANE_MAX_HEIGHT_PX = 144;

/** Lanes take equal whole-pixel shares, so up to one pixel per lane is
 *  left over, plus the agent row's 1 px bottom border. */
const FILL_SLACK_PX = 3 + 1;

test.describe("T168 — The per-agent modal draws one lane per run", () => {
	test("three concurrent runs get three labelled lanes that fill the space above the feed", async ({ page }) => {
		const modal = await openPerAgentModal(page, FANOUT_FIXTURE.workerName);
		const group = modal.locator(`[data-testid="swimlane-agent-row-${FANOUT_FIXTURE.workerName}"]`);
		await expect(group).toHaveAttribute("data-run-lanes", "true", { timeout: 10_000 });
		await expect(group).toHaveAttribute("data-lane-count", "3", { timeout: 10_000 });

		const runs = FANOUT_FIXTURE.workerRoles.map((role) =>
			fixtureSessionId(FANOUT_FIXTURE.workerName, role),
		);
		// The three runs start in one statement, so they tie on start
		// and the lanes follow the run ids.
		const expectedOrder = [...runs].sort();

		const read = () =>
			modal.evaluate((m) => {
				const scroll = m.querySelector<HTMLElement>('[data-testid="per-agent-swimlane-modal-scroll"]')!;
				const feed = m.querySelector<HTMLElement>('[data-testid="per-agent-swimlane-modal-feed"]')!;
				const lanes = Array.from(m.querySelectorAll<HTMLElement>("[data-run-lane-row]"));
				const text = (el: Element, id: string) =>
					el.querySelector(`[data-testid="${id}"]`)?.textContent?.trim() ?? null;
				return {
					lanes: lanes.map((lane) => {
						const r = lane.getBoundingClientRect();
						return {
							run: lane.getAttribute("data-run-id"),
							top: r.top,
							bottom: r.bottom,
							height: r.height,
							id: text(lane, "swimlane-run-lane-id"),
							state:
								lane
									.querySelector('[data-testid="swimlane-run-lane-status"]')
									?.getAttribute("data-state") ?? null,
							model: text(lane, "swimlane-run-lane-model"),
							tokens: text(lane, "swimlane-run-lane-tokens"),
						};
					}),
					feedTop: feed.getBoundingClientRect().top,
					clientHeight: scroll.clientHeight,
					scrollHeight: scroll.scrollHeight,
				};
			});

		// The lanes are sized after the dialog lays out; poll until the
		// last lane reaches the feed.
		await expect
			.poll(
				async () => {
					const g = await read();
					const last = g.lanes[g.lanes.length - 1];
					return last ? Math.round(g.feedTop - last.bottom) : null;
				},
				{ timeout: 10_000 },
			)
			.toBeLessThanOrEqual(FILL_SLACK_PX);

		const g = await read();
		expect(g.lanes.map((l) => l.run)).toEqual(expectedOrder);
		const heights = g.lanes.map((l) => l.height);
		for (const h of heights) {
			expect(h).toBeGreaterThanOrEqual(RUN_LANE_MIN_HEIGHT_PX);
			expect(h).toBeLessThanOrEqual(RUN_LANE_MAX_HEIGHT_PX);
			expect(Math.abs(h - heights[0]!)).toBeLessThanOrEqual(0.5);
		}
		// Stacked one under the other, the last one reaching the feed,
		// with nothing to scroll.
		for (let i = 1; i < g.lanes.length; i++) {
			expect(Math.abs(g.lanes[i]!.top - g.lanes[i - 1]!.bottom)).toBeLessThanOrEqual(0.5);
		}
		expect(g.feedTop - g.lanes[2]!.bottom).toBeGreaterThanOrEqual(0);
		expect(g.scrollHeight).toBeLessThanOrEqual(g.clientHeight);

		// Each lane names its run: short id, state, model, tokens so far.
		for (const lane of g.lanes) {
			expect(lane.id).toBe(lane.run!.slice(0, 8));
			expect(lane.state).toBe("active");
			expect(lane.model).toBe("claude-sonnet-4-5");
			expect(lane.tokens).toMatch(/^\d+(\.\d)?[kM]? tokens$/);
		}

		// The heading spans the row: the agent's name is not cut.
		const name = group.getByTestId("swimlane-run-lanes-heading").getByTestId("swimlane-agent-name-link");
		await expect(name).toHaveAttribute("title", FANOUT_FIXTURE.workerName);
		expect(await name.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);

		// The lost run, which left the window two hours ago, has no lane.
		const lost = fixtureSessionId(FANOUT_FIXTURE.workerName, FANOUT_FIXTURE.workerLostRole);
		await expect(modal.locator(`[data-run-lane-row][data-run-id="${lost}"]`)).toHaveCount(0);
	});
});
