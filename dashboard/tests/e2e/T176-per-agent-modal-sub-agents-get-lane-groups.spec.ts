/**
 * T176 — With "Show sub-agents" on, each sub-agent in the per-agent modal
 * is its own group of run lanes, and the connectors end on its runs'
 * lanes.
 *
 * Fixture: a coordinator of this spec run's own (``createPrivateAgent``)
 * with two runs started 120 s back; its first run calls ``Agent`` 70 s
 * back and spawns one "reviewer" run, its second calls ``Agent`` 65 s
 * back and spawns two "tester" runs (``createPrivateSubAgent``), all
 * started 50 s back. At the 5m range every run, call and start stays in
 * the window, and in view, for minutes, whatever the spec's pace.
 *
 * The coordinator's group comes first, with its two lanes; the reviewer's
 * and the tester's groups follow, as children, with one and two lanes.
 * Each connector ends on its child run's first circle, on that run's own
 * lane. At 1280x720 the coordinator's two lanes show whole: the Live feed
 * gives up height to the first group's lanes, and the sub-agents' groups
 * scroll. Turning "Show sub-agents" off leaves the coordinator's group
 * alone. Geometry and attributes, read in one browser evaluation per
 * poll, so both theme projects run it unchanged.
 */
import { test, expect } from "@playwright/test";
import {
	createPrivateAgent,
	createPrivateSubAgent,
	endPrivateAgent,
	openPerAgentModal,
	postPrivateToolCall,
	startPrivateAgent,
	type PrivateAgent,
} from "./_fixtures";

test.use({ viewport: { width: 1280, height: 720 } });

const PARENT_STARTED_AGO_MS = 120_000;
const REVIEWER_SPAWN_AGO_MS = 70_000;
const TESTER_SPAWN_AGO_MS = 65_000;
const CHILD_STARTED_AGO_MS = 50_000;
/** How far a connector's end may sit from its circle's centre. */
const ENDPOINT_TOLERANCE_PX = 1.5;

test.describe("T176 — Each sub-agent is a group of run lanes", () => {
	const agents: PrivateAgent[] = [];

	test.afterEach(async ({ page }) => {
		for (const a of agents.splice(0)) await endPrivateAgent(page, a);
	});

	test("the coordinator's group first, a group per sub-agent, connectors on their lanes", async ({ page }) => {
		const parent = createPrivateAgent("lane-groups", 2);
		agents.push(parent);
		await startPrivateAgent(page, parent, { startedAgoMs: PARENT_STARTED_AGO_MS });
		const [p0, p1] = parent.sessionIds as [string, string];
		await postPrivateToolCall(page, parent, p0, "Agent", REVIEWER_SPAWN_AGO_MS);
		await postPrivateToolCall(page, parent, p1, "Agent", TESTER_SPAWN_AGO_MS);
		const reviewer = createPrivateSubAgent(parent, "reviewer", [p0]);
		const tester = createPrivateSubAgent(parent, "tester", [p1, p1]);
		agents.push(reviewer, tester);
		await startPrivateAgent(page, reviewer, { startedAgoMs: CHILD_STARTED_AGO_MS });
		await startPrivateAgent(page, tester, { startedAgoMs: CHILD_STARTED_AGO_MS });

		const modal = await openPerAgentModal(page, parent.agentName);
		await modal.locator('[data-testid="per-agent-swimlane-modal-time-5m"]').click();
		const showSubAgents = modal.locator('[data-testid="per-agent-swimlane-modal-show-sub-agents-input"]');
		await showSubAgents.check();

		const groups = () =>
			modal.evaluate((m) =>
				Array.from(m.querySelectorAll<HTMLElement>('[data-run-lanes="true"]')).map((g) => ({
					name: g.getAttribute("data-testid")!.replace("swimlane-agent-row-", ""),
					topology: g.getAttribute("data-topology"),
					lanes: Array.from(g.querySelectorAll("[data-run-lane-row]")).map((l) => l.getAttribute("data-run-id")),
				})),
			);
		await expect.poll(async () => (await groups()).length, { timeout: 15_000 }).toBe(3);
		const [own, ...subs] = await groups();
		expect({ ...own, lanes: [...own!.lanes].sort() }).toEqual({
			name: parent.agentName,
			topology: "root",
			lanes: [p0, p1].sort(),
		});
		expect(subs.map((g) => g.name).sort()).toEqual([reviewer.agentName, tester.agentName].sort());
		const sub = (name: string) => subs.find((g) => g.name === name)!;
		expect(sub(reviewer.agentName)).toMatchObject({ topology: "child", lanes: reviewer.sessionIds });
		expect(sub(tester.agentName).topology).toBe("child");
		expect([...sub(tester.agentName).lanes].sort()).toEqual([...tester.sessionIds].sort());

		// Each connector ends on its child run's circle, on that run's lane.
		const children = [...reviewer.sessionIds, ...tester.sessionIds];
		const ends = () =>
			modal.evaluate((m, ids) => {
				const svg = m.querySelector('[data-testid="sub-agent-connector-overlay"]');
				if (!svg) return [];
				const origin = svg.getBoundingClientRect();
				return Array.from(svg.querySelectorAll("path[data-child-session-id]"))
					.filter((p) => ids.includes(p.getAttribute("data-child-session-id") ?? ""))
					.map((p) => {
						const nums = (p.getAttribute("d") ?? "").replace(/[MQ]/g, " ").trim().split(/\s+/).map(Number);
						const circle = m.querySelector<HTMLElement>(
							`[data-run-lane-row] [data-event-id="${CSS.escape(p.getAttribute("data-child-event-id") ?? "")}"]`,
						);
						if (!circle) return { child: p.getAttribute("data-child-session-id"), lane: null, off: Infinity };
						const r = circle.getBoundingClientRect();
						return {
							child: p.getAttribute("data-child-session-id"),
							lane: circle.closest("[data-run-lane-row]")!.getAttribute("data-run-id"),
							off: Math.hypot(
								nums[4]! - (r.left - origin.left + r.width / 2),
								nums[5]! - (r.top - origin.top + r.height / 2),
							),
						};
					});
			}, children);
		await expect
			.poll(async () => (await ends()).filter((e) => e.lane === e.child && e.off <= ENDPOINT_TOLERANCE_PX).length, {
				timeout: 15_000,
			})
			.toBe(children.length);

		// The feed gives up height to the coordinator's lanes: both whole.
		const scroll = modal.locator('[data-testid="per-agent-swimlane-modal-scroll"]');
		await expect
			.poll(() =>
				scroll.evaluate((el, name) => {
					const bottom = el.getBoundingClientRect().top + el.clientHeight;
					const own = el.querySelector(`[data-testid="swimlane-agent-row-${CSS.escape(name)}"]`)!;
					return Array.from(own.querySelectorAll("[data-run-lane-row]")).every(
						(l) => l.getBoundingClientRect().bottom <= bottom + 0.5,
					);
				}, parent.agentName),
			)
			.toBe(true);

		// Off: the coordinator's group alone.
		await showSubAgents.uncheck();
		await expect.poll(async () => (await groups()).map((g) => g.name)).toEqual([parent.agentName]);
	});
});
