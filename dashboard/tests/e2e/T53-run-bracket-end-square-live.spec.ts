/**
 * T53 — RunBracket end-square glyph renders on the live page for
 * a closed session whose ended_at is inside the visible window.
 *
 * Anchored on the ``fresh-closed-in-window`` canonical role (see
 * tests/e2e-fixtures/canonical.json): state=closed, with started_at
 * and ended_at pinned 15 s and 3 s before every keep-alive cycle
 * (seed.py's FRESH_CLOSED_STARTED_AGO_S / FRESH_CLOSED_ENDED_AGO_S),
 * so the run stays inside the swimlane's recent windows.
 *
 * Guards against the Chrome-verify Issue A regression: an
 * earlier render path returned the start triangle alone for
 * every run; closed runs whose end was in-window never produced
 * the square. The unit test in tests/unit/RunBracket.test.tsx
 * covers the component in isolation; this spec gates the live
 * rendering against the seeded fixture so a future regression
 * (e.g. a forgotten ``ended_at !== null`` clause) is caught at
 * the integration boundary.
 */
import { test, expect } from "@playwright/test";
import { bringSwimlaneRowIntoView, waitForFleetReady } from "./_fixtures";

// Tall viewport so e2e-test-coding-agent's row mounts without
// IntersectionObserver eviction — matches the pattern T29 / T34
// / T48 use for the same reason.
test.use({ viewport: { width: 1280, height: 1800 } });

test.describe("T53 — RunBracket end-square renders for closed-in-window session", () => {
	test("at least one end-square glyph mounts on the swimlane", async ({
		page,
	}) => {
		await page.goto("/");
		await waitForFleetReady(page);
		// 5 m keeps the anchor's end square inside the panel. The
		// keep-alive pins the run to end 3 s before each cycle, so at
		// 1 h (4 s a pixel) the square sits in the panel's clipped right
		// margin for the first ~30 s after a pin, where the swimlane
		// does not mount it; at 1 m a slow keep-alive cycle can push the
		// run's start out of the window, and a run whose start is out
		// of view draws no glyphs. At 5 m the start stays in view and
		// the end clears the margin within a few seconds of a pin.
		await page.getByRole("button", { name: "5m", exact: true }).click();
		// Scroll the coding-agent row into view explicitly — its
		// fresh-closed-in-window session is the anchor.
		const row = await bringSwimlaneRowIntoView(
			page,
			"e2e-test-coding-agent",
		);
		await expect(row).toBeVisible({ timeout: 10_000 });

		// At least one end-square glyph must be attached. The
		// fresh-closed-in-window role on e2e-test-coding-agent is the
		// deterministic anchor; other closed sessions whose
		// ended_at also lands in window contribute additional
		// matches but are not required for this contract.
		const endGlyph = page.locator(
			'[data-testid^="swimlane-run-bracket-end-"]',
		);
		await expect
			.poll(async () => endGlyph.count(), {
				timeout: 15_000,
				message:
					"at least one end-square glyph must mount — the " +
					"fresh-closed-in-window fixture is the deterministic anchor",
			})
			.toBeGreaterThanOrEqual(1);

		// Confirm the rendered glyph is the square ``<rect>``, not
		// a triangle ``<polygon>``. Theme-agnostic — asserts on
		// SVG element shape, not on colour.
		const firstEndGlyph = endGlyph.first();
		await expect(firstEndGlyph.locator("rect")).toBeAttached();
	});
});
