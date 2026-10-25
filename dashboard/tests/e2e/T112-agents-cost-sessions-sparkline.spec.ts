/**
 * T112 — Cost + Sessions sparkline coverage on /agents.
 *
 * Guarded regression: the only KPI columns with a sparkline were Tokens,
 * Latency p95, and Errors; the Cost and Sessions cells were
 * bare numbers. The fix wires `AgentSparkline` into both cells
 * (with the cost sparkline gated off for ClaudeCode agents
 * because Flightdeck has no pricing for them).
 *
 * This spec locks the contract end-to-end:
 *   - A sensor-instrumented agent's Cost cell renders a chart
 *     (or sparse-data placeholder) — never bare text.
 *   - Every agent's Sessions cell renders a sparkline.
 *   - The SVG strokes carry the semantic CSS variables:
 *       cost     → ``var(--warning)``     (amber)
 *       sessions → ``var(--chart-2)``     (cyan)
 *       errors   → ``var(--danger)``      (red)
 *   - An agent whose calls all ran on a subscription (the seeded
 *     Claude Code agent) shows "Subscription" and no sparkline.
 */
import { test, expect, type Locator } from "@playwright/test";
import { CODING_AGENT } from "./_fixtures";

async function findAgentRow(
	page: Locator | import("@playwright/test").Page,
	clientType: "claude_code" | "flightdeck_sensor",
): Promise<Locator | null> {
	// Walk the visible rows and pick one whose ClientTypePill
	// title matches the requested client_type. The pill's
	// ``title="client_type=<value>"`` attribute is the stable
	// hook (the testid carries the agent_id which is opaque
	// here, but the title is keyed to the client_type itself).
	const rows = page
		.locator(`[data-testid^="agent-row-"][data-agent-id]`)
		.filter({
			has: page.locator(`[title="client_type=${clientType}"]`),
		});
	const count = await rows.count();
	if (count === 0) return null;
	return rows.first();
}

test.describe("T112 — Cost + Sessions sparklines", () => {
	test("sensor agent's cost cell carries a sparkline (chart or placeholder)", async ({
		page,
	}) => {
		await page.goto("/agents");
		await expect(page.locator('[data-testid="agent-table"]')).toBeVisible();

		// Wait until at least one sparkline has materialised — the
		// summary fetch is per-row and may lag a tick after the
		// table mounts.
		await expect
			.poll(
				async () =>
					(await page
						.locator(
							'[data-testid="agent-sparkline"], [data-testid="agent-sparkline-empty"]',
						)
						.count()) > 0,
				{ timeout: 15_000 },
			)
			.toBe(true);

		const row = await findAgentRow(page, "flightdeck_sensor");
		test.skip(
			row == null,
			"no flightdeck_sensor agent in the seeded fleet — nothing to assert",
		);
		const costCell = row!.locator('[data-testid^="agent-row-cost-"]:not([data-testid*="-total-"])');
		await expect(costCell).toBeVisible();
		const costSparkline = costCell.locator(
			'[data-testid="agent-sparkline"], [data-testid="agent-sparkline-empty"]',
		);
		// At least one of the two sparkline shapes must mount
		// inside the cost cell (a chart for fluctuating cost or
		// the placeholder for a sparse 7-day window).
		expect(await costSparkline.count()).toBeGreaterThanOrEqual(1);
	});

	test("every agent row's Sessions cell carries a sparkline", async ({ page }) => {
		await page.goto("/agents");
		await expect(page.locator('[data-testid="agent-table"]')).toBeVisible();

		await expect
			.poll(
				async () =>
					(await page
						.locator(
							'[data-testid="agent-sparkline"], [data-testid="agent-sparkline-empty"]',
						)
						.count()) > 0,
				{ timeout: 15_000 },
			)
			.toBe(true);

		const rows = page.locator('[data-testid^="agent-row-"][data-agent-id]');
		const rowCount = await rows.count();
		expect(rowCount).toBeGreaterThan(0);

		for (let i = 0; i < rowCount; i++) {
			const sessionsCell = rows.nth(i).locator(
				'[data-testid^="agent-row-sessions-"]:not([data-testid*="-total-"])',
			);
			const sparkCount = await sessionsCell
				.locator(
					'[data-testid="agent-sparkline"], [data-testid="agent-sparkline-empty"]',
				)
				.count();
			expect(sparkCount).toBeGreaterThanOrEqual(1);
		}
	});

	// NOTE: A rendered-DOM stroke-colour assertion was attempted
	// here but pulled because the canonical ``seed-e2e`` fixtures
	// don't carry enough multi-day non-zero variation per agent
	// for the sparkline tile to render an SVG ``<path>`` (the
	// component falls back to the sparse-data placeholder when
	// fewer than two non-zero points exist on the axis, by design
	// — see T97). The strokeForAxis-per-axis wire contract is
	// locked by the dedicated unit suite at
	// ``dashboard/tests/unit/AgentSparkline.test.tsx`` under
	// "AgentSparkline — stroke colour per axis (semantic palette)",
	// which asserts every axis against its expected CSS variable
	// without needing a live-rendered SVG to inspect. The two
	// remaining E2E cases below still lock the structural
	// contract (sparkline tile mounts in cost / sessions cells,
	// Claude Code agents skip the cost chart).

	test("a subscription-only agent's cost cell shows Subscription + no sparkline", async ({
		page,
	}) => {
		await page.goto("/agents");
		await expect(page.locator('[data-testid="agent-table"]')).toBeVisible();

		// The seeded Claude Code agent's calls carry no billing mode,
		// which reads as subscription for claude_code sessions. Pinned
		// by name: other claude_code agents on a dev stack may be
		// metered.
		const row = page
			.locator('[data-testid^="agent-row-"][data-agent-id]')
			.filter({ has: page.getByText(CODING_AGENT.name, { exact: true }) });
		const costCell = row.locator('td[data-testid^="agent-row-cost-"]');
		await expect(costCell).toBeVisible();
		await expect(costCell).toHaveText("Subscription");
		const sparkCount = await costCell
			.locator(
				'[data-testid="agent-sparkline"], [data-testid="agent-sparkline-empty"]',
			)
			.count();
		expect(sparkCount).toBe(0);
	});
});
