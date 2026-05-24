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
		const badges = page.locator('[data-testid="swimlane-agent-status-badge"]');
		const count = await badges.count();
		expect(count).toBeGreaterThan(0);
		// Scan every visible badge. For each, the inner dot must
		// carry the active-ring class iff data-state="active".
		for (let i = 0; i < count; i++) {
			const badge = badges.nth(i);
			const state = await badge.getAttribute("data-state");
			const dot = badge.locator(
				'[data-testid="swimlane-agent-status-dot"]',
			);
			const cls = (await dot.getAttribute("class")) ?? "";
			if (state === "active") {
				expect(cls).toContain("agent-status-active-ring");
			} else {
				expect(cls).not.toContain("agent-status-active-ring");
			}
		}
	});
});
