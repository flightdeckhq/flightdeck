/**
 * T55 — Sub-agent swimlane row renders event circles + the
 * connector overlay anchors at least one Bezier path for an
 * in-window parent-child pair.
 *
 * Regression guard for the Chrome-verify Issue B: the
 * ``e2e-test-fresh-subagent`` fixture's session is in the API
 * page but the sub-agent's swimlane row was rendering ZERO
 * session circles at default viewport because the agent's
 * ``last_seen_at`` was frozen at original seed time (the worker
 * stamps it on session_start; subsequent keep-alive tool_call
 * events don't bump the agents row). The bucket-sort placed the
 * sub-agent deep in the swimlane, the IntersectionObserver
 * virtualized its row off-screen, and the connector overlay
 * skipped the pair entirely.
 *
 * Fix: seed.py's keep-alive watchdog now also bumps
 * ``agents.last_seen_at`` whenever it forward-dates an
 * active-role session. The agent's row materializes near the
 * top of the swimlane; its session events fall inside the
 * default 1-minute window; the connector overlay anchors the
 * Bezier path from the parent's spawn event to the child's
 * first event.
 *
 * Theme-agnostic; runs under both projects.
 */
import { test, expect } from "@playwright/test";
import { bringSwimlaneRowIntoView, waitForFleetReady } from "./_fixtures";

// Tall viewport so the fresh-subagent row AND its parent
// (coding-agent) both materialise simultaneously. The connector
// overlay's useLayoutEffect skips any pair where either endpoint
// is virtualized; default viewport sometimes leaves one of them
// outside the IntersectionObserver-materialized band under
// parallel-worker load.
test.use({ viewport: { width: 1280, height: 1800 } });

test.describe("T55 — Sub-agent row event circles + connector overlay", () => {
	test("fresh-subagent row has at least one event circle and the connector overlay anchors a path", async ({
		page,
	}) => {
		await page.goto("/");
		await waitForFleetReady(page);
		// Widen the time picker so the seeded fresh-subagent's
		// event circles + the connector overlay's spawn anchor
		// both sit comfortably inside the timeline rather than at
		// the right edge of the live-monitor (1 m) default.
		await page.getByRole("button", { name: "1h" }).click();
		const subAgentRow = await bringSwimlaneRowIntoView(
			page,
			"e2e-test-fresh-subagent",
		);
		await expect(subAgentRow).toBeVisible({ timeout: 10_000 });
		// The sub-agent row stamps data-topology="child" because its
		// session carries parent_session_id pointing at the coding-
		// agent's fresh-active root.
		await expect(subAgentRow).toHaveAttribute("data-topology", "child");
		// At least one event circle is rendered inside the row. The
		// fixture seeds a session_start + a fresh tool_call (kept in
		// window by the keep-alive watchdog) so this is the
		// in-window event the connector anchors on.
		const circles = subAgentRow.locator('[data-testid^="session-circle-"]');
		await expect
			.poll(async () => circles.count(), { timeout: 10_000 })
			.toBeGreaterThanOrEqual(1);

		// The connector overlay's data-connector-count attribute
		// reflects the resolved spec list. At least one connector
		// must render because the fresh-subagent fixture pairs with
		// the coding-agent's fresh-active session (both in window).
		const overlay = page.locator(
			'[data-testid="sub-agent-connector-overlay"]',
		);
		await expect(overlay).toBeAttached();
		await expect
			.poll(
				async () => {
					const v = await overlay.getAttribute("data-connector-count");
					return v ? parseInt(v, 10) : 0;
				},
				{ timeout: 15_000 },
			)
			.toBeGreaterThanOrEqual(1);
		const paths = page.locator('[data-testid^="sub-agent-connector-"]');
		await expect
			.poll(async () => paths.count(), { timeout: 15_000 })
			.toBeGreaterThanOrEqual(1);
	});
});
