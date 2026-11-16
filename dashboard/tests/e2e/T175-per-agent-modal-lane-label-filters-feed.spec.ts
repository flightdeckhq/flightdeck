/**
 * T175 — A lane's label filters the per-agent modal's Live feed to its
 * run, and a chip, the label again, or Esc clears it.
 *
 * Fixture: an agent of this spec run's own (``createPrivateAgent``), two
 * runs started 150 s back, the first with a tool call 120 s old and the
 * second with one 60 s old, so the feed holds only what the spec posts.
 * At the 5m range both stay in the window for minutes, whatever the
 * spec's pace; at 1m the first run's start and call are out of it, and
 * only grow older.
 *
 * The lane label is a button (``aria-pressed``) named "Run <id8>".
 * Clicking the first run's leaves only its rows in the feed and shows the
 * chip "Run <id8>"; clicking the second run's switches the filter;
 * clicking it again clears it. The chip is a button the keyboard
 * reaches: focused, Enter clears the filter and the focus goes to the
 * run's lane label. A filter on the first run outlives a narrower range
 * that leaves it nothing: the feed says "No events from run <id8> in this
 * window" under the chip, and widening the range brings the rows back
 * with the label still pressed. With a filter on, Esc clears it (the
 * focus to the run's label) and leaves the modal open; a second Esc
 * closes the modal. The feed's runs are read in one browser evaluation
 * per poll; nothing depends on a theme's colours.
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

const STARTED_AGO_MS = 150_000;
/** The first run's call: in the 5m window, out of the 1m one. */
const FIRST_CALL_AGO_MS = 120_000;
const SECOND_CALL_AGO_MS = 60_000;

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
		await postPrivateToolCall(page, agent, first, "t175_first", FIRST_CALL_AGO_MS);
		await postPrivateToolCall(page, agent, second, "t175_second", SECOND_CALL_AGO_MS);

		const modal = await openPerAgentModal(page, agent.agentName);
		await modal.locator('[data-testid="per-agent-swimlane-modal-time-5m"]').click();
		const group = modal.locator(`[data-testid="swimlane-agent-row-${agent.agentName}"]`);
		await expect(group).toHaveAttribute("data-lane-count", "2", { timeout: 10_000 });
		const both = [first, second].sort();
		await expect.poll(() => feedRuns(modal), { timeout: 10_000 }).toEqual(both);

		const label = (run: string) => group.getByRole("button", { name: `Run ${run.slice(0, 8)}`, exact: true });
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

		// The chip is a button the keyboard reaches and works; the focus
		// goes to the run's lane label as the chip goes.
		await label(first).click();
		await chip.focus();
		await expect(chip).toBeFocused();
		await page.keyboard.press("Enter");
		await expect(chip).toHaveCount(0);
		await expect(label(first)).toHaveAttribute("aria-pressed", "false");
		await expect(label(first)).toBeFocused();
		await expect.poll(() => feedRuns(modal)).toEqual(both);

		// A narrower range leaves the filtered run nothing: the filter
		// stays and the feed says so; the wider range brings its rows back.
		await label(first).click();
		await modal.locator('[data-testid="per-agent-swimlane-modal-time-1m"]').click();
		const empty = modal.locator('[data-testid="per-agent-swimlane-modal-feed"] [data-testid="feed-empty"]');
		await expect(empty).toHaveText(`No events from run ${first.slice(0, 8)} in this window`);
		await expect(chip).toHaveText(`Run ${first.slice(0, 8)}`);
		await modal.locator('[data-testid="per-agent-swimlane-modal-time-5m"]').click();
		await expect.poll(() => feedRuns(modal)).toEqual([first]);
		await expect(label(first)).toHaveAttribute("aria-pressed", "true");
		await chip.click();
		await expect(chip).toHaveCount(0);

		// Esc clears the filter first, then closes the modal.
		await label(second).click();
		await expect(chip).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(chip).toHaveCount(0);
		await expect(modal).toBeVisible();
		await expect(label(second)).toBeFocused();
		await expect.poll(() => feedRuns(modal)).toEqual(both);
		await page.keyboard.press("Escape");
		await expect(modal).toBeHidden();
	});
});
