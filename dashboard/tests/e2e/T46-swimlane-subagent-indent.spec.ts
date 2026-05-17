/**
 * T46 — Sub-agent indent + Bezier connector regression guard.
 *
 * The swimlane reshape preserved sub-agent rendering: child rows
 * carry ``data-topology="child"`` (which the globals.css indent +
 * bg-tint rules target) and SubAgentConnector.tsx draws a Bezier
 * path from each parent spawn event to its child's first event.
 *
 * This spec confirms both pieces still work under the one-row-per-
 * agent layout. If the connector math shifted along with the row
 * reshape, the SVG path's data-testid would not mount and this
 * spec would fail loudly — fix the math before continuing past
 * the wait-point.
 */
import { test, expect } from "@playwright/test";
import { waitForFleetReady } from "./_fixtures";

test.describe("T46 — Sub-agent indent + connector", () => {
	test("at least one row carries data-topology=child", async ({ page }) => {
		await page.goto("/");
		await waitForFleetReady(page);
		const childRows = page.locator(
			'[data-testid^="swimlane-agent-row-"][data-topology="child"]',
		);
		// Seeded fixture has at least one parent/child pair under the
		// CrewAI + LangGraph sub-agent fixtures (T29/T30 cohort).
		expect(await childRows.count()).toBeGreaterThanOrEqual(1);
	});

	test("sub-agent connector SVG path mounts when a parent/child pair is visible", async ({
		page,
	}) => {
		await page.goto("/");
		await waitForFleetReady(page);
		// SubAgentConnector renders <path data-testid="sub-agent-connector-...">
		// elements in an SVG overlay over the timeline. At least one
		// connector path must exist when any parent + child are both
		// rendered.
		const connectors = page.locator(
			'[data-testid^="sub-agent-connector-"]',
		);
		// Allow a brief settle window — the connector geometry uses
		// document.querySelector to resolve circle anchors, which
		// runs in a useLayoutEffect after the swimlane rows mount.
		await expect(connectors.first()).toBeVisible({ timeout: 8000 });
	});
});
