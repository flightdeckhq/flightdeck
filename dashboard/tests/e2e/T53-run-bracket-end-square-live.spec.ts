/**
 * T53 — RunBracket end-square glyph renders on the live page for
 * a closed session whose ended_at is inside the 1-minute window.
 *
 * Anchored on the ``fresh-closed-in-window`` canonical role (see
 * tests/e2e-fixtures/canonical.json): started -45s, ended -10s,
 * state=closed. seed.py pins both timestamps on every keep-alive
 * cycle so the run stays inside the swimlane's default 1-minute
 * domain.
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
		// Widen the time picker so the seeded fresh-closed-in-window
		// session's end-square sits inside the timeline rather than
		// at the right edge of the live-monitor (1 m) default.
		await page.getByRole("button", { name: "1h" }).click();
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
