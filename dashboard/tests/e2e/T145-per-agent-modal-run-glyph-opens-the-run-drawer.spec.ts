/**
 * T145 — A run glyph in the per-agent swimlane modal opens the run
 * drawer inside the modal, and Esc closes the drawer before the modal.
 *
 * Fixture: e2e-test-concurrent-runs, whose two runs started a few
 * minutes ago and are still open, so at 1h each draws its start
 * triangle. The spec opens the modal from the agent's STATUS chip on
 * /agents, clicks a start triangle the pointer can reach, and expects
 * the run drawer (`session-drawer`) for that run. The first Esc closes
 * the drawer and leaves the modal open; the second closes the modal.
 * Before, a glyph click in the modal did nothing.
 */
import { test, expect } from "@playwright/test";

const AGENT_NAME = "e2e-test-concurrent-runs";

test.describe("T145 — A run glyph in the per-agent modal opens the run drawer", () => {
	test("the drawer opens on the glyph's run; Esc closes it, then the modal", async ({ page }) => {
		await page.goto("/agents");
		await expect(page.locator('[data-testid="agent-table"]')).toBeVisible();

		// Find the agent's row by its name, then open its modal from the
		// STATUS chip.
		const rows = page.locator('[data-testid^="agent-row-"][data-agent-id]');
		await expect.poll(async () => rows.count(), { timeout: 10_000 }).toBeGreaterThan(0);
		const agentRow = rows.filter({ hasText: AGENT_NAME }).first();
		await expect(agentRow).toBeVisible({ timeout: 10_000 });
		const agentId = await agentRow.getAttribute("data-agent-id");
		expect(agentId).not.toBeNull();
		await page.locator(`[data-testid="agent-row-open-swimlane-modal-${agentId}"]`).click();
		const modal = page.locator('[data-testid="per-agent-swimlane-modal"]');
		await expect(modal).toBeVisible();
		await page.locator('[data-testid="per-agent-swimlane-modal-time-1h"]').click();

		// A start triangle the pointer can reach: the modal opens scrolled
		// to "now", so a glyph under the sticky label column is not one.
		const body = page.locator('[data-testid="per-agent-swimlane-modal-body"]');
		let runId: string | null = null;
		await expect
			.poll(
				async () => {
					runId = await body.evaluate((b) => {
						for (const g of Array.from(
							b.querySelectorAll<HTMLElement>('button[data-bracket-kind="start"]'),
						)) {
							const r = g.getBoundingClientRect();
							const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
							if (hit && (hit === g || g.contains(hit))) return g.getAttribute("data-session-id");
						}
						return null;
					});
					return runId;
				},
				{ timeout: 15_000 },
			)
			.not.toBeNull();
		await body.locator(`button[data-bracket-kind="start"][data-session-id="${runId}"]`).first().click();

		const drawer = page.locator('[data-testid="session-drawer"]');
		await expect(drawer).toBeVisible({ timeout: 10_000 });
		await expect(drawer).toHaveAttribute("data-session-id", runId!);

		await page.keyboard.press("Escape");
		await expect(drawer).toHaveCount(0);
		await expect(modal).toBeVisible();

		await page.keyboard.press("Escape");
		await expect(modal).toHaveCount(0);
	});
});
