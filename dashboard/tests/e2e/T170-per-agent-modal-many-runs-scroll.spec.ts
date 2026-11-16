/**
 * T170 — When an agent's lanes at their minimum height do not fit above
 * the Live feed, they stay at the minimum and the lane area scrolls.
 *
 * Fixture: the fan-out's wide sub-agent
 * (e2e-test-fanout@e2e-host-fanout/wide), five runs started together and
 * still open. At the default 1280x720 the modal's scroll viewport above
 * the 240 px Live feed holds well under five 40 px lanes, so all five
 * lanes are 40 px, every run has its own lane (no overflow lane, unlike
 * the Fleet row's four), and the viewport scrolls vertically to the
 * last one.
 *
 * Geometry and attributes, read in one browser evaluation, so both theme
 * projects run it unchanged.
 */
import { test, expect } from "@playwright/test";
import { FANOUT_FIXTURE, fixtureSessionId, openPerAgentModal } from "./_fixtures";

test.use({ viewport: { width: 1280, height: 720 } });

const RUN_LANE_MIN_HEIGHT_PX = 40;

test.describe("T170 — Many runs keep the minimum lane height and scroll", () => {
	test("five runs draw five 40 px lanes in a scrolling viewport", async ({ page }) => {
		const modal = await openPerAgentModal(page, FANOUT_FIXTURE.wideName);
		const group = modal.locator(`[data-testid="swimlane-agent-row-${FANOUT_FIXTURE.wideName}"]`);
		await expect(group).toHaveAttribute("data-run-lanes", "true", { timeout: 10_000 });
		await expect(group).toHaveAttribute("data-lane-count", "5", { timeout: 10_000 });

		const runs = FANOUT_FIXTURE.wideRoles.map((role) => fixtureSessionId(FANOUT_FIXTURE.wideName, role));
		const scroll = modal.locator('[data-testid="per-agent-swimlane-modal-scroll"]');

		await expect
			.poll(
				() =>
					scroll.evaluate((el) =>
						Array.from(el.querySelectorAll<HTMLElement>("[data-run-lane-row]")).map((l) =>
							Math.round(l.getBoundingClientRect().height),
						),
					),
				{ timeout: 10_000 },
			)
			.toEqual(Array(5).fill(RUN_LANE_MIN_HEIGHT_PX));

		// Scroll to the bottom in the same evaluation that reads the
		// result, so nothing moves between the two.
		const g = await scroll.evaluate((el) => {
			const before = { clientHeight: el.clientHeight, scrollHeight: el.scrollHeight };
			el.scrollTop = el.scrollHeight;
			const box = el.getBoundingClientRect();
			const lanes = Array.from(el.querySelectorAll<HTMLElement>("[data-run-lane-row]"));
			const last = lanes[lanes.length - 1]!.getBoundingClientRect();
			return {
				...before,
				runs: lanes.map((l) => l.getAttribute("data-run-id")),
				lastTop: last.top,
				lastBottom: last.bottom,
				boxTop: box.top,
				boxBottom: el.getBoundingClientRect().top + el.clientHeight,
			};
		});
		expect(g.scrollHeight).toBeGreaterThan(g.clientHeight);
		expect([...g.runs].sort()).toEqual([...runs].sort());
		// The last lane is reachable: scrolled fully into the viewport.
		expect(g.lastTop).toBeGreaterThanOrEqual(g.boxTop - 0.5);
		expect(g.lastBottom).toBeLessThanOrEqual(g.boxBottom + 0.5);
		// No lane is shared: no overflow lane in the modal.
		await expect(modal.locator("[data-lane-overflow]")).toHaveCount(0);
	});
});
