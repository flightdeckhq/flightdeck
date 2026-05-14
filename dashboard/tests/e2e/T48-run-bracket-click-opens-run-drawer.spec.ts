/**
 * T48 — Clicking a run bracket opens the existing session drawer
 * scoped to that run.
 *
 * The drawer mounts at ``data-testid="session-drawer"`` with the
 * clicked run's session_id wired through Fleet.tsx's existing
 * selectSession action. The drawer's title or metadata bar exposes
 * the same session_id prefix the bracket's testid carries so the
 * pairing is verifiable.
 */
import { test, expect } from "@playwright/test";
import { bringSwimlaneRowIntoView, waitForFleetReady } from "./_fixtures";

// Anchor on the langgraph-parent fixture: a single fresh-active
// session whose start bracket renders deterministically inside
// the swimlane's default 60 s window. Avoids coding-agent's
// multi-session row (where multiple brackets can overlap with
// concurrent-runs's stacked brackets next to it on the
// timeline) and avoids concurrent-runs itself (where two
// stacked brackets make ``.first()`` ambiguous under
// IntersectionObserver re-renders).
const SINGLE_RUN_AGENT = "e2e-test-langgraph-parent";

// Tall viewport so the agent's swimlane row materializes without
// virtualization eviction during the test's hover / click flow.
test.use({ viewport: { width: 1280, height: 1800 } });

test.describe("T48 — Click a run bracket → run drawer", () => {
	test("clicking a start tick opens the session drawer", async ({ page }) => {
		await page.goto("/");
		await waitForFleetReady(page);
		// Widen the time picker so the seeded bracket sits inside a
		// comfortable click target rather than at the right edge of
		// the live-monitor (1 m) default. Under 1 m the
		// keep-alive-pinned NOW-30s bracket drifts off-screen-left
		// as wall-clock advances during the parallel suite.
		await page.getByRole("button", { name: "1h" }).click();
		const row = await bringSwimlaneRowIntoView(page, SINGLE_RUN_AGENT);
		await expect(row).toBeVisible({ timeout: 10000 });

		// Poll for the bracket: the keep-alive watchdog refreshes
		// session start times every 30 s so the bracket may briefly
		// detach + remount during ANY click attempt. Polling until
		// the count stabilises avoids the "element was detached
		// from the DOM" retry storm Playwright triggers on
		// click-through-mount-race.
		const bracket = row
			.locator('[data-testid^="swimlane-run-bracket-start-"]')
			.first();
		await expect
			.poll(async () => bracket.count(), { timeout: 10000 })
			.toBeGreaterThan(0);
		const testId = (await bracket.getAttribute("data-testid")) ?? "";
		// data-testid = ``swimlane-run-bracket-start-<8hex>``
		const idPrefix = testId.replace("swimlane-run-bracket-start-", "");
		expect(idPrefix).toMatch(/^[0-9a-f]{8}$/);
		await bracket.click();
		const drawer = page.locator('[data-testid="session-drawer"]');
		// The drawer surfaces the loaded session_id via
		// ``data-session-id``. Poll until exactly one drawer is
		// mounted (AnimatePresence can briefly hold two) AND its
		// prefix matches the bracket's, so the drawer is scoped to
		// THE clicked run.
		await expect
			.poll(
				async () => {
					if ((await drawer.count()) !== 1) return null;
					return (await drawer.getAttribute("data-session-id")) ?? "";
				},
				{ timeout: 8000 },
			)
			.toMatch(new RegExp(`^${idPrefix}`));
	});
});
