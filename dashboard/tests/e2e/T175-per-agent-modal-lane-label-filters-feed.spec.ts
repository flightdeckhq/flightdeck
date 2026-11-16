/**
 * T175 — A lane's label filters the per-agent modal's Live feed to its
 * run, and a chip, the label again, or Esc clears it.
 *
 * Fixture: an agent of this spec run's own (``createPrivateAgent``), two
 * runs started 90 s back with one tool call each, so the feed holds only
 * what the spec posts. At the 5m range both stay in the window for
 * minutes, whatever the spec's pace.
 *
 * The lane label is a button (``aria-pressed``). Clicking the first
 * run's leaves only its rows in the feed and shows the chip "Run <id8>";
 * clicking the second run's switches the filter; clicking it again clears
 * it. The chip is a button the keyboard reaches: focused, Enter clears
 * the filter. With a filter on, Esc clears the filter and leaves the
 * modal open; a second Esc closes the modal. The feed's runs are read in
 * one browser evaluation per poll; nothing depends on a theme's colours.
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
const CALL_AGO_MS = 60_000;

/** The runs the feed's rows belong to, sorted. */
function feedRuns(modal: Locator) {
	return modal.evaluate((m) =>
		[
			...new Set(
				Array.from(
					m.querySelectorAll('[data-testid="per-agent-swimlane-modal-feed"] [data-testid="feed-row"]'),
				).map((r) => r.getAttribute("data-run-id")),
			),
		].sort(),
	);
}

test.describe("T175 — A lane label filters the Live feed to its run", () => {
	let agent: PrivateAgent | null = null;

	test.afterEach(async ({ page }) => {
		if (agent) await endPrivateAgent(page, agent);
		agent = null;
	});

	test("filter, switch, clear by label, chip and Esc", async ({ page }) => {
		agent = createPrivateAgent("lane-filter", 2);
		await startPrivateAgent(page, agent, { startedAgoMs: STARTED_AGO_MS });
		const [first, second] = agent.sessionIds as [string, string];
		await postPrivateToolCall(page, agent, first, "t175_first", CALL_AGO_MS);
		await postPrivateToolCall(page, agent, second, "t175_second", CALL_AGO_MS);

		const modal = await openPerAgentModal(page, agent.agentName);
		await modal.locator('[data-testid="per-agent-swimlane-modal-time-5m"]').click();
		const group = modal.locator(`[data-testid="swimlane-agent-row-${agent.agentName}"]`);
		await expect(group).toHaveAttribute("data-lane-count", "2", { timeout: 10_000 });
		const both = [first, second].sort();
		await expect.poll(() => feedRuns(modal), { timeout: 10_000 }).toEqual(both);

		const label = (run: string) =>
			group.getByRole("button", { name: `Show only run ${run.slice(0, 8)} in the Live feed` });
		const chip = modal.getByTestId("feed-run-filter-chip");
		await expect(label(first)).toHaveAttribute("aria-pressed", "false");
		await expect(chip).toHaveCount(0);

		// Filter to the first run.
		await label(first).click();
		await expect(label(first)).toHaveAttribute("aria-pressed", "true");
		await expect.poll(() => feedRuns(modal)).toEqual([first]);
		await expect(chip).toHaveText(`Run ${first.slice(0, 8)}`);
		await expect(chip).toHaveAccessibleName(`Run ${first.slice(0, 8)}: clear the run filter`);

		// Another lane's label switches it.
		await label(second).click();
		await expect(label(first)).toHaveAttribute("aria-pressed", "false");
		await expect(label(second)).toHaveAttribute("aria-pressed", "true");
		await expect.poll(() => feedRuns(modal)).toEqual([second]);
		await expect(chip).toHaveText(`Run ${second.slice(0, 8)}`);

		// The filtered lane's label clears it.
		await label(second).click();
		await expect(chip).toHaveCount(0);
		await expect.poll(() => feedRuns(modal)).toEqual(both);

		// The chip is a button the keyboard reaches and works.
		await label(first).click();
		await chip.focus();
		await expect(chip).toBeFocused();
		await page.keyboard.press("Enter");
		await expect(chip).toHaveCount(0);
		await expect(label(first)).toHaveAttribute("aria-pressed", "false");
		await expect.poll(() => feedRuns(modal)).toEqual(both);

		// Esc clears the filter first, then closes the modal.
		await label(second).click();
		await expect(chip).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(chip).toHaveCount(0);
		await expect(modal).toBeVisible();
		await expect.poll(() => feedRuns(modal)).toEqual(both);
		await page.keyboard.press("Escape");
		await expect(modal).toBeHidden();
	});
});
