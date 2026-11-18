/**
 * T50 — AgentStatusBadge applies the rotating-ring class iff
 * state is ``active``.
 *
 * The active indicator is implemented in globals.css under the
 * ``agent-status-active-ring`` class (rotating gradient arc on a
 * ``::before`` pseudo-element). The badge's inner dot picks the
 * class up only when ``data-state="active"`` is set on the
 * surrounding span. Theme-agnostic — colour resolves to a CSS
 * custom property, so the assertion is structural (class
 * presence / absence) rather than computed-colour based.
 */
import { test, expect } from "@playwright/test";
import { waitForFleetReady } from "./_fixtures";

test.describe("T50 — Active status indicator", () => {
	test("active-state badges carry the active-ring class; non-active states do not", async ({
		page,
	}) => {
		await page.goto("/");
		await waitForFleetReady(page);
		// Every badge mounted right now, its state and its inner dot's
		// classes read in one browser evaluation, at the same moment. A
		// scan of one locator call per badge and field costs a page round
		// trip each, and reads rows the Fleet keeps re-rendering (the
		// first render mounts every row before the observer swaps those
		// out of view for placeholders), so the badge counted first need
		// not be there when its fields are read.
		const badges = await page
			.locator('[data-testid="swimlane-agent-status-badge"]')
			.evaluateAll((els) =>
				els.map((badge) => ({
					state: badge.getAttribute("data-state"),
					dotClass:
						badge
							.querySelector('[data-testid="swimlane-agent-status-dot"]')
							?.getAttribute("class") ?? "",
				})),
			);
		expect(badges.length).toBeGreaterThan(0);
		// For each badge, the inner dot must carry the active-ring class
		// iff data-state="active".
		for (const { state, dotClass } of badges) {
			if (state === "active") {
				expect(dotClass).toContain("agent-status-active-ring");
			} else {
				expect(dotClass).not.toContain("agent-status-active-ring");
			}
		}
	});
});
