/**
 * T177 — Cues in the per-agent modal count the run lanes out of view,
 * scroll to the next one, and cover nothing.
 *
 * Fixture: a coordinator of this spec run's own (``createPrivateAgent``)
 * with eight runs started 150 s back, a reviewer with two runs and a tester
 * with two (``createPrivateSubAgent``), started 100 s back, and tool
 * calls 40 to 90 s old on four lanes, so the lanes draw circles, marker
 * text, labels and two sub-agent headings with their pills. At the 5m
 * range all of it stays in the window for minutes, whatever the spec's
 * pace. Twelve lanes and three headings overflow the lane area at both
 * 1920x1080 and 1280x720.
 *
 * At the top, the middle and the bottom of the lanes' scroll, the cues
 * read what is out of view ("<n> more below", "<n> more above", each
 * absent at its end), counted from the lanes' geometry between the sticky
 * time axis and the viewport's bottom. The top cue sits in the axis row's
 * label-column cell, the bottom one on the footer strip under the
 * viewport, both inside the label column. Neither's box meets a circle,
 * marker text, a lane label's text or a heading's name or pill, where
 * those are visible: inside the viewport and below the sticky axis
 * (content scrolled under the axis is hidden by it). A click on the
 * bottom cue brings the next lane fully into view; one on the top cue
 * scrolls back up. The cues sit in no live region, and the viewport keeps
 * its name. Everything is read in one browser evaluation per poll, so
 * both theme projects run it unchanged.
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
import {
	createPrivateAgent,
	createPrivateSubAgent,
	endPrivateAgent,
	openPerAgentModal,
	postPrivateToolCall,
	startPrivateAgent,
	type PrivateAgent,
} from "./_fixtures";

/** Eight runs, two sub-agents' four and three headings: enough to
 *  scroll at 1920x1080 with lanes hidden on both sides at mid-scroll. */
const PARENT_RUNS = 8;
const PARENT_STARTED_AGO_MS = 150_000;
const CHILD_STARTED_AGO_MS = 100_000;

type Rect = { left: number; top: number; right: number; bottom: number };

/** What the cues show and where, against the lanes' geometry. */
function readCues(modal: Locator) {
	return modal.evaluate((m) => {
		const el = m.querySelector<HTMLElement>('[data-testid="per-agent-swimlane-modal-scroll"]')!;
		const box = el.getBoundingClientRect();
		const axis = el.querySelector('[data-timeline-axis="true"]')!.getBoundingClientRect();
		const cell = el.querySelector('[data-timeline-axis-label="true"]')!.getBoundingClientRect();
		// The part of the viewport the lanes show in.
		const view = {
			left: box.left + el.clientLeft,
			right: box.left + el.clientLeft + el.clientWidth,
			top: Math.max(box.top + el.clientTop, axis.bottom),
			bottom: box.top + el.clientTop + el.clientHeight,
		};
		let above = 0;
		let below = 0;
		const whole: string[] = [];
		for (const lane of el.querySelectorAll<HTMLElement>("[data-run-lane-row]")) {
			const r = lane.getBoundingClientRect();
			if (r.bottom > view.bottom + 1) below += 1;
			else if (r.top < view.top - 1) above += 1;
			else whole.push(lane.getAttribute("data-run-id") ?? "");
		}
		const plain = (r: DOMRect) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
		const cue = (id: string) => {
			const c = m.querySelector<HTMLElement>(`[data-testid="${id}"]`);
			return c ? { text: c.textContent, box: plain(c.getBoundingClientRect()) } : null;
		};
		const aboveCue = cue("swimlane-lanes-more-above");
		const belowCue = cue("swimlane-lanes-more-below");
		const strip = m.querySelector('[data-testid="swimlane-lanes-fold-footer"]');
		// What a cue must not cover, clipped to where it shows.
		const targets = [
			...Array.from(el.querySelectorAll("[data-run-lane-row] [data-event-id]"), (e) => ["circle", e] as const),
			...Array.from(el.querySelectorAll('[data-testid="swimlane-marker-text"]'), (e) => ["marker text", e] as const),
			...Array.from(
				el.querySelectorAll(
					'[data-testid="swimlane-run-lane-id"], [data-testid="swimlane-run-lane-status"], [data-testid="swimlane-run-lane-model"], [data-testid="swimlane-run-lane-tokens"]',
				),
				(e) => ["lane label", e] as const,
			),
			...Array.from(
				el.querySelectorAll('[data-testid="swimlane-run-lanes-heading"] .swimlane-row-label > *'),
				(e) => ["heading", e] as const,
			),
		];
		const hits: string[] = [];
		for (const c of [aboveCue, belowCue]) {
			if (!c) continue;
			for (const [kind, t] of targets) {
				const r = t.getBoundingClientRect();
				const left = Math.max(r.left, view.left);
				const right = Math.min(r.right, view.right);
				const top = Math.max(r.top, view.top);
				const bottom = Math.min(r.bottom, view.bottom);
				if (right <= left || bottom <= top) continue;
				if (left < c.box.right && right > c.box.left && top < c.box.bottom && bottom > c.box.top) {
					hits.push(`${c.text} covers ${kind} ${t.textContent?.slice(0, 24) ?? ""}`);
				}
			}
		}
		return {
			above,
			below,
			whole,
			aboveCue,
			belowCue,
			cell: plain(cell),
			strip: strip ? plain(strip.getBoundingClientRect()) : null,
			view,
			hits,
			liveRegion: Array.from(m.querySelectorAll('[data-testid^="swimlane-lanes-more-"]')).some(
				(c) => c.closest("[aria-live]") !== null,
			),
			scrollTop: el.scrollTop,
			maxScroll: el.scrollHeight - el.clientHeight,
		};
	});
}

type Cues = Awaited<ReturnType<typeof readCues>>;

/** The cues read what the geometry says is out of view. */
function cuesMatch(f: Cues): boolean {
	return (
		(f.belowCue?.text ?? null) === (f.below > 0 ? `${f.below} more below` : null) &&
		(f.aboveCue?.text ?? null) === (f.above > 0 ? `${f.above} more above` : null)
	);
}

function within(inner: Rect, outer: Rect): boolean {
	return (
		inner.left >= outer.left - 0.5 &&
		inner.right <= outer.right + 0.5 &&
		inner.top >= outer.top - 0.5 &&
		inner.bottom <= outer.bottom + 0.5
	);
}

/** The cues sit in their own space and cover nothing visible. */
function expectPlacedClear(f: Cues) {
	expect(f.hits).toEqual([]);
	if (f.aboveCue) expect(within(f.aboveCue.box, f.cell), "top cue in the axis label cell").toBe(true);
	if (f.belowCue) {
		expect(f.strip).not.toBeNull();
		expect(within(f.belowCue.box, f.strip!), "bottom cue on the strip").toBe(true);
		// The strip is under the viewport, not over it.
		expect(f.strip!.top).toBeGreaterThanOrEqual(f.view.bottom - 0.5);
		// Inside the label column, never over the timeline.
		expect(f.belowCue.box.right).toBeLessThanOrEqual(f.cell.right + 0.5);
	}
	expect(f.liveRegion).toBe(false);
}

async function scrollTo(modal: Locator, where: "top" | "middle" | "bottom") {
	await modal.locator('[data-testid="per-agent-swimlane-modal-scroll"]').evaluate((el, w) => {
		const max = el.scrollHeight - el.clientHeight;
		el.scrollTop = w === "top" ? 0 : w === "middle" ? Math.round(max / 2) : max;
	}, where);
}

async function journey(page: Page, agents: PrivateAgent[]) {
	const parent = createPrivateAgent("lane-cues", PARENT_RUNS);
	agents.push(parent);
	await startPrivateAgent(page, parent, { startedAgoMs: PARENT_STARTED_AGO_MS });
	const [p0, p1, p2] = parent.sessionIds as [string, string, string];
	const reviewer = createPrivateSubAgent(parent, "reviewer", [p0, p1]);
	const tester = createPrivateSubAgent(parent, "tester", [p2, p2]);
	agents.push(reviewer, tester);
	await startPrivateAgent(page, reviewer, { startedAgoMs: CHILD_STARTED_AGO_MS });
	await startPrivateAgent(page, tester, { startedAgoMs: CHILD_STARTED_AGO_MS });
	await postPrivateToolCall(page, parent, p0, "t177_read", 90_000);
	await postPrivateToolCall(page, parent, p2, "t177_grep", 60_000);
	await postPrivateToolCall(page, reviewer, reviewer.sessionIds[0]!, "t177_edit", 50_000);
	await postPrivateToolCall(page, tester, tester.sessionIds[1]!, "t177_bash", 40_000);

	const modal = await openPerAgentModal(page, parent.agentName);
	await modal.locator('[data-testid="per-agent-swimlane-modal-time-5m"]').click();
	await modal.locator('[data-testid="per-agent-swimlane-modal-show-sub-agents-input"]').check();
	await expect(modal.locator('[data-run-lanes="true"]')).toHaveCount(3, { timeout: 15_000 });
	await expect(modal.locator("[data-run-lane-row]")).toHaveCount(PARENT_RUNS + 4);
	const scroll = modal.locator('[data-testid="per-agent-swimlane-modal-scroll"]');
	await expect(scroll).toHaveAccessibleName(`Run lanes of ${parent.agentName}`);

	let f = await readCues(modal);
	// At the top, the middle and the bottom: the cues count what is out
	// of view, sit in their own space and cover nothing.
	for (const where of ["top", "middle", "bottom"] as const) {
		await scrollTo(modal, where);
		await expect
			.poll(async () => {
				f = await readCues(modal);
				const atEnd = where === "top" ? f.above === 0 : where === "bottom" ? f.below === 0 : true;
				const beyond = where === "top" ? f.below > 0 : where === "bottom" ? f.above > 0 : f.above > 0 && f.below > 0;
				return atEnd && beyond && cuesMatch(f);
			}, { message: `cues at the ${where}`, timeout: 10_000 })
			.toBe(true);
		expectPlacedClear(f);
	}

	// Back at the top, a click brings the next lane fully into view.
	await scrollTo(modal, "top");
	await expect.poll(async () => cuesMatch((f = await readCues(modal))) && f.scrollTop === 0).toBe(true);
	const lanes = await modal.locator("[data-run-lane-row]").evaluateAll((ls) =>
		ls.map((l) => l.getAttribute("data-run-id") ?? ""),
	);
	const nextHidden = lanes.find((id) => !f.whole.includes(id))!;
	await modal.getByTestId("swimlane-lanes-more-below").click();
	await expect
		.poll(async () => {
			f = await readCues(modal);
			return f.whole.includes(nextHidden) && f.scrollTop > 0 && cuesMatch(f);
		})
		.toBe(true);
	expectPlacedClear(f);

	// At the end, the top cue scrolls back up.
	await scrollTo(modal, "bottom");
	await expect.poll(async () => cuesMatch((f = await readCues(modal))) && f.below === 0).toBe(true);
	const endTop = f.scrollTop;
	await modal.getByTestId("swimlane-lanes-more-above").click();
	await expect
		.poll(async () => {
			f = await readCues(modal);
			return f.scrollTop < endTop && cuesMatch(f);
		})
		.toBe(true);
	expectPlacedClear(f);
}

for (const viewport of [
	{ width: 1920, height: 1080 },
	{ width: 1280, height: 720 },
]) {
	test.describe(`T177 — Cues count the lanes out of view and cover nothing (${viewport.width}x${viewport.height})`, () => {
		test.use({ viewport });
		const agents: PrivateAgent[] = [];

		test.afterEach(async ({ page }) => {
			for (const a of agents.splice(0)) await endPrivateAgent(page, a);
		});

		test("top, middle and bottom: counted, clear of the lanes, scrolling to the next", async ({ page }) => {
			await journey(page, agents);
		});
	});
}
