/**
 * T190 — The agent drawer's "Open in swimlane" names the agent's runs at
 * once, and opens the modal with a lane for each.
 *
 * Fixture: agents of this spec run's own (``createPrivateAgent``), one
 * with three runs started together and one with a single run, open for
 * the whole spec. Open runs reach to "now", so they stay in the 1m window
 * the per-agent modal opens with, whatever the spec's pace.
 *
 * The three-run agent's drawer button reads "Open in swimlane · 3 runs",
 * named "Open <agent> in swimlane, 3 runs at once", its tooltip "3 runs
 * at once: each gets its own lane"; a click opens the per-agent modal
 * with three lanes. The one-run agent's button is the plain one: "Open
 * in swimlane", no count, no tooltip. Text and attributes only, so both
 * theme projects run it unchanged.
 */
import { test, expect, type Page } from "@playwright/test";
import {
	agentIdByName,
	createPrivateAgent,
	endPrivateAgent,
	startPrivateAgent,
	type PrivateAgent,
} from "./_fixtures";

/** The agent's drawer, opened the way an operator links to it. */
async function openDrawer(page: Page, agent: PrivateAgent) {
	const agentId = await agentIdByName(page, agent.agentName);
	await page.goto(`/?agent_drawer=${encodeURIComponent(agentId)}`);
	const drawer = page.locator(`[data-testid="agent-drawer"][data-agent-id="${agentId}"]`);
	await drawer.waitFor({ timeout: 15_000 });
	return drawer;
}

test.describe("T190 — The agent drawer's Open in swimlane names the runs at once", () => {
	const agents: PrivateAgent[] = [];

	test.afterEach(async ({ page }) => {
		for (const a of agents.splice(0)) await endPrivateAgent(page, a);
	});

	test("three runs at once: the button names them and the modal draws three lanes", async ({ page }) => {
		const agent = createPrivateAgent("drawer-runs", 3);
		agents.push(agent);
		await startPrivateAgent(page, agent);

		const drawer = await openDrawer(page, agent);
		const button = drawer.getByTestId("agent-drawer-open-swimlane");
		await expect(button).toHaveText("Open in swimlane · 3 runs", { timeout: 15_000 });
		await expect(button).toHaveAccessibleName(`Open ${agent.agentName} in swimlane, 3 runs at once`);
		await expect(button).toHaveAttribute("title", "3 runs at once: each gets its own lane");
		await expect(button).toHaveAttribute("data-run-count", "3");

		await button.click();
		const modal = page.locator('[data-testid="per-agent-swimlane-modal"]');
		await expect(modal.locator(`[data-testid="swimlane-agent-row-${agent.agentName}"]`)).toHaveAttribute(
			"data-lane-count",
			"3",
			{ timeout: 10_000 },
		);
		await expect(modal.locator("[data-run-lane-row]")).toHaveCount(3);
	});

	test("one run: the plain button", async ({ page }) => {
		const agent = createPrivateAgent("drawer-one-run", 1);
		agents.push(agent);
		await startPrivateAgent(page, agent);

		const drawer = await openDrawer(page, agent);
		const button = drawer.getByTestId("agent-drawer-open-swimlane");
		await expect(button).toHaveText("Open in swimlane");
		await expect(button).toHaveAccessibleName(`Open ${agent.agentName} in swimlane`);
		await expect(button).not.toHaveAttribute("data-run-count");
		await expect(button).not.toHaveAttribute("title");
	});
});
