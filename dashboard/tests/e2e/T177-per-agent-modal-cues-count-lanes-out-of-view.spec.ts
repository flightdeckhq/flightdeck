/**
 * T177 — Cues in the per-agent modal count the run lanes out of view and
 * scroll to the next one.
 *
 * Fixture: an agent of this spec run's own (``createPrivateAgent``) with
 * six runs started together, open for the whole spec, so it has six
 * lanes. At 1280x720 the Live feed gives up height until three 40 px
 * lanes show whole and the rest scroll.
 *
 * The cue at the lane area's bottom edge reads "<n> more below", n the
 * lanes not fully visible below the viewport, and none shows above. A
 * click scrolls the next hidden lane fully into view; then the counts on
 * both sides match what is out of view. Scrolled to the end, the bottom
 * cue goes and the top one counts the lanes above; a click on it scrolls
 * back up. The cues sit in no live region, and the scroll viewport keeps
 * its name. Counts come from the lanes' geometry (the sticky time axis's
 * bottom to the viewport's), read with the cues' text in one browser
 * evaluation per poll, so both theme projects run it unchanged.
 */
import { test, expect, type Locator } from "@playwright/test";
import {
	createPrivateAgent,
	endPrivateAgent,
	openPerAgentModal,
	startPrivateAgent,
	type PrivateAgent,
} from "./_fixtures";

test.use({ viewport: { width: 1280, height: 720 } });

const RUNS = 6;

/** The lanes out of view on each side, from geometry, with the cues'
 *  text (null when a cue is absent) and the scroll position. */
function readFold(modal: Locator) {
	return modal.evaluate((m) => {
		const el = m.querySelector<HTMLElement>('[data-testid="per-agent-swimlane-modal-scroll"]')!;
		const box = el.getBoundingClientRect();
		const axis = el.querySelector('[data-timeline-axis="true"]')!.getBoundingClientRect();
		const top = Math.max(box.top + el.clientTop, axis.bottom);
		const bottom = box.top + el.clientTop + el.clientHeight;
		let above = 0;
		let below = 0;
		const whole: string[] = [];
		for (const lane of el.querySelectorAll<HTMLElement>("[data-run-lane-row]")) {
			const r = lane.getBoundingClientRect();
			if (r.bottom > bottom + 1) below += 1;
			else if (r.top < top - 1) above += 1;
			else whole.push(lane.getAttribute("data-run-id") ?? "");
		}
		const text = (id: string) => m.querySelector(`[data-testid="${id}"]`)?.textContent ?? null;
		return {
			above,
			below,
			whole,
			aboveCue: text("swimlane-lanes-more-above"),
			belowCue: text("swimlane-lanes-more-below"),
			scrollTop: el.scrollTop,
			atEnd: el.scrollTop + el.clientHeight >= el.scrollHeight - 1,
		};
	});
}

/** The cues read what the geometry says is out of view. */
function cuesMatch(f: Awaited<ReturnType<typeof readFold>>): boolean {
	return (
		f.belowCue === (f.below > 0 ? `${f.below} more below` : null) &&
		f.aboveCue === (f.above > 0 ? `${f.above} more above` : null)
	);
}

test.describe("T177 — Cues count the lanes out of view", () => {
	let agent: PrivateAgent | null = null;

	test.afterEach(async ({ page }) => {
		if (agent) await endPrivateAgent(page, agent);
		agent = null;
	});

	test("bottom and top cues count the hidden lanes and scroll to the next", async ({ page }) => {
		agent = createPrivateAgent("lane-cues", RUNS);
		await startPrivateAgent(page, agent);
		const modal = await openPerAgentModal(page, agent.agentName);
		const group = modal.locator(`[data-testid="swimlane-agent-row-${agent.agentName}"]`);
		await expect(group).toHaveAttribute("data-lane-count", String(RUNS), { timeout: 10_000 });
		const scroll = modal.locator('[data-testid="per-agent-swimlane-modal-scroll"]');
		await expect(scroll).toHaveAccessibleName(`Run lanes of ${agent.agentName}`);

		// At the top: three whole lanes, the rest counted below.
		let fold = await readFold(modal);
		await expect
			.poll(async () => {
				fold = await readFold(modal);
				return fold.whole.length >= 3 && fold.below > 0 && fold.scrollTop === 0 && cuesMatch(fold);
			}, { timeout: 10_000 })
			.toBe(true);
		expect(fold.aboveCue).toBeNull();
		const lanes = await group.locator("[data-run-lane-row]").evaluateAll((ls) =>
			ls.map((l) => l.getAttribute("data-run-id") ?? ""),
		);
		const nextHidden = lanes[fold.whole.length]!;

		// No live region: the counts are not announced as they change.
		const cue = modal.getByTestId("swimlane-lanes-more-below");
		expect(await cue.evaluate((c) => c.closest("[aria-live]") === null)).toBe(true);

		// A click brings the next lane fully into view.
		await cue.click();
		await expect
			.poll(async () => {
				fold = await readFold(modal);
				return fold.whole.includes(nextHidden) && fold.scrollTop > 0 && cuesMatch(fold);
			})
			.toBe(true);

		// At the end: no cue below, the top one counts the lanes above.
		await scroll.evaluate((el) => {
			el.scrollTop = el.scrollHeight;
		});
		await expect
			.poll(async () => {
				fold = await readFold(modal);
				return fold.atEnd && fold.below === 0 && fold.above > 0 && cuesMatch(fold);
			})
			.toBe(true);
		const endTop = fold.scrollTop;

		// The top cue scrolls back up, the counts follow.
		await modal.getByTestId("swimlane-lanes-more-above").click();
		await expect
			.poll(async () => {
				fold = await readFold(modal);
				return fold.scrollTop < endTop && cuesMatch(fold);
			})
			.toBe(true);
	});
});
