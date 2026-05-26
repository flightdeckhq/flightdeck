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

	test("child swimlane row's label strip indents 28 px", async ({ page }) => {
		// Stronger contract than the data-topology presence check
		// above: asserts the COMPUTED ``padding-left`` on the
		// ``.swimlane-row-label`` strip inside a child row resolves
		// to 28 px. Pre-fix (D157 → fix/fleet-subagent-indent) the
		// strip carried a flat inline ``paddingLeft: 12`` that
		// beat the globals.css ``[data-topology="child"]
		// .swimlane-row-label { padding-left: 28px }`` rule via
		// inline-style specificity, and child rows rendered flush
		// with their parents. The fix branches the inline value on
		// the topology prop; this assertion locks the contract.
		await page.goto("/");
		await waitForFleetReady(page);
		const childRow = page
			.locator(
				'[data-testid^="swimlane-agent-row-"][data-topology="child"]',
			)
			.first();
		await expect(childRow).toBeVisible({ timeout: 8000 });
		const childLabel = childRow.locator(".swimlane-row-label").first();
		await expect(childLabel).toBeVisible();
		const padding = await childLabel.evaluate(
			(el) => window.getComputedStyle(el).paddingLeft,
		);
		expect(padding).toBe("28px");

		// Symmetry check: a non-child (root or lone) row's strip
		// keeps the 12 px inline padding. Without this, a future
		// flat-28-px regression would pass the indent check above
		// but lose the parent vs child contrast.
		const rootRow = page
			.locator(
				'[data-testid^="swimlane-agent-row-"]:not([data-topology="child"])',
			)
			.first();
		await expect(rootRow).toBeVisible({ timeout: 8000 });
		const rootLabel = rootRow.locator(".swimlane-row-label").first();
		const rootPadding = await rootLabel.evaluate(
			(el) => window.getComputedStyle(el).paddingLeft,
		);
		expect(rootPadding).toBe("12px");
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
