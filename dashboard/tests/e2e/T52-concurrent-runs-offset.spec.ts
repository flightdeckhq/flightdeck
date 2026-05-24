/**
 * T52 — Concurrent runs of the same agent render with offset
 * bracket anchors (top vs bottom).
 *
 * Multi-pod K8s deployments with collapsed FLIGHTDECK_HOSTNAME
 * (and any other case where two sessions share an agent_id and
 * have overlapping time windows) get bracket pairs anchored to
 * opposite edges of the swimlane row so they remain visually
 * distinguishable. The ``bracketAnchors`` helper in
 * ``RunBracket.tsx`` assigns "top" to the first run and "bottom"
 * to every subsequent concurrent run; the brackets' inline
 * top / bottom style props reflect that anchor.
 *
 * Fixture: any agent in the seeded fleet that exposes 2+ runs.
 * The spec scans every visible swimlane row, picks one with at
 * least two start brackets, and asserts the two start ticks
 * carry different vertical offsets.
 */
import { test, expect } from "@playwright/test";
import { bringSwimlaneRowIntoView, waitForFleetReady } from "./_fixtures";

const CONCURRENT_AGENT = "e2e-test-concurrent-runs";

// Tall viewport so the seeded D126 fixtures all fit without
// IntersectionObserver evicting rows that are just-off-screen --
// the concurrent-runs agent's last_seen_at can land mid-list on a
// populated fleet, so the default 720px viewport occasionally
// virtualizes its row out before the bracket assertions run.
// Matches the pattern T29 / T40 use for the same reason.
test.use({ viewport: { width: 1280, height: 1800 } });

test.describe("T52 — Concurrent runs offset anchors", () => {
	test("two start brackets on the same row anchor to opposite edges", async ({
		page,
	}) => {
		await page.goto("/");
		await waitForFleetReady(page);
		// Widen the time picker so the seeded concurrent-run
		// brackets sit comfortably inside the timeline rather than
		// at the right edge of the live-monitor (1 m) default.
		await page.getByRole("button", { name: "1h" }).click();
		const row = await bringSwimlaneRowIntoView(page, CONCURRENT_AGENT);
		await expect(row).toBeVisible({ timeout: 10000 });

		const starts = row.locator(
			'[data-testid^="swimlane-run-bracket-start-"]',
		);
		// Seeded fixture guarantees both runs render on the row.
		await expect(starts).toHaveCount(2, { timeout: 8000 });

		const ys: number[] = [];
		for (let j = 0; j < 2; j++) {
			const box = await starts.nth(j).boundingBox();
			expect(box, `bracket ${j} must have a bounding box`).not.toBeNull();
			ys.push(box!.y);
		}
		const delta = Math.abs(ys[0]! - ys[1]!);
		// 4 px tolerance accommodates sub-pixel layout; ROW_HEIGHT is
		// 48 px and the anchors sit at the row's top edge vs bottom
		// edge so the real delta is ~30 px. Anything > 4 px confirms
		// the offset logic fired; anything ≤ 4 px means both brackets
		// stacked on the same anchor (regression).
		expect(delta).toBeGreaterThan(4);
	});

	test("clicking each bracket opens the correct run drawer", async ({
		page,
	}) => {
		await page.goto("/");
		await waitForFleetReady(page);
		// Widen the time picker so the seeded concurrent-run
		// brackets sit comfortably inside the timeline rather than
		// at the right edge of the live-monitor (1 m) default.
		await page.getByRole("button", { name: "1h" }).click();
		const row = await bringSwimlaneRowIntoView(page, CONCURRENT_AGENT);
		await expect(row).toBeVisible({ timeout: 10000 });

		const starts = row.locator(
			'[data-testid^="swimlane-run-bracket-start-"]',
		);
		await expect(starts).toHaveCount(2, { timeout: 8000 });

		// Pull both brackets' run_id prefixes from their data-testids.
		const a = (await starts.nth(0).getAttribute("data-testid")) ?? "";
		const b = (await starts.nth(1).getAttribute("data-testid")) ?? "";
		const prefixA = a.replace("swimlane-run-bracket-start-", "");
		const prefixB = b.replace("swimlane-run-bracket-start-", "");
		expect(prefixA).toMatch(/^[0-9a-f]{8}$/);
		expect(prefixB).toMatch(/^[0-9a-f]{8}$/);
		expect(prefixA).not.toBe(prefixB);

		// Click bracket A → drawer opens scoped to run A. The
		// motion.div is keyed on sessionId so click B will exit-
		// then-enter; during the AnimatePresence overlap the
		// generic ``[data-testid="session-drawer"]`` locator
		// briefly resolves to two elements. Poll until the
		// transition has settled to a SINGLE drawer carrying the
		// expected prefix; first-match-regex during the overlap
		// would race the exit animation.
		await starts.nth(0).click();
		const drawer = page.locator('[data-testid="session-drawer"]');
		await expect
			.poll(
				async () => {
					if ((await drawer.count()) !== 1) return null;
					return (await drawer.getAttribute("data-session-id")) ?? "";
				},
				{ timeout: 8000 },
			)
			.toMatch(new RegExp(`^${prefixA}`));

		// Both seeded concurrent-runs sessions are forward-dated to
		// NOW-30s by the keep-alive watchdog (so they stay inside
		// the swimlane window), which under the default 15m time
		// range places both bracket glyphs near the right edge of
		// the timeline — directly under the right-anchored drawer
		// overlay. Close the drawer before clicking bracket B so
		// the synthesized click actually lands on the bracket.
		await page
			.locator('[data-testid="session-drawer-close"]')
			.click();
		await expect.poll(async () => drawer.count(), { timeout: 5000 }).toBe(0);

		// Click bracket B → drawer's session_id flips to run B.
		await starts.nth(1).click();
		await expect
			.poll(
				async () => {
					if ((await drawer.count()) !== 1) return null;
					return (await drawer.getAttribute("data-session-id")) ?? "";
				},
				{ timeout: 8000 },
			)
			.toMatch(new RegExp(`^${prefixB}`));
	});
});
