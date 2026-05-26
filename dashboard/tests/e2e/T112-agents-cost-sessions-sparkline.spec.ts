/**
 * T112 — Cost + Sessions sparkline coverage on /agents.
 *
 * Pre-fix the only KPI columns with a sparkline were Tokens,
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
 *   - A Claude Code agent's Cost cell shows the bare em-dash
 *     (no sparkline at all).
 */
import { test, expect, type Locator } from "@playwright/test";

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

	test("cost / sessions / errors sparkline SVGs carry the semantic stroke colours", async ({
		page,
	}) => {
		await page.goto("/agents");
		await expect(page.locator('[data-testid="agent-table"]')).toBeVisible();

		// Anchor on a sensor agent whose summary has at least
		// 2 non-zero buckets across cost, sessions, and errors —
		// otherwise the sparkline tile renders the sparse-data
		// placeholder which has no <path> stroke to inspect.
		await expect
			.poll(
				async () =>
					(await page
						.locator('[data-testid="agent-sparkline"]')
						.count()) > 0,
				{ timeout: 15_000 },
			)
			.toBe(true);

		const rows = page.locator('[data-testid^="agent-row-"][data-agent-id]');
		const rowCount = await rows.count();

		async function strokeIn(
			cellTestidPrefix: string,
		): Promise<string | null> {
			for (let i = 0; i < rowCount; i++) {
				const cell = rows.nth(i).locator(
					`[data-testid^="${cellTestidPrefix}"]:not([data-testid*="-total-"])`,
				);
				const path = cell
					.locator('[data-testid="agent-sparkline"]')
					.locator("path.recharts-curve.recharts-line-curve")
					.first();
				if ((await path.count()) === 0) continue;
				const stroke = await path.getAttribute("stroke");
				if (stroke != null) return stroke;
			}
			return null;
		}

		const costStroke = await strokeIn("agent-row-cost-");
		const sessionsStroke = await strokeIn("agent-row-sessions-");
		const errorsStroke = await strokeIn("agent-row-errors-");

		// At least one row must have produced a renderable
		// chart for each of cost / sessions / errors under
		// the seeded fleet. If none did, the seed didn't put
		// enough non-zero buckets in front of the test — surface
		// loudly rather than silently passing on a sparse seed.
		expect(costStroke, "no cost sparkline path rendered").toBe(
			"var(--warning)",
		);
		expect(sessionsStroke, "no sessions sparkline path rendered").toBe(
			"var(--chart-2)",
		);
		expect(errorsStroke, "no errors sparkline path rendered").toBe(
			"var(--danger)",
		);
	});

	test("Claude Code agent's cost cell shows em-dash + no sparkline", async ({
		page,
	}) => {
		await page.goto("/agents");
		await expect(page.locator('[data-testid="agent-table"]')).toBeVisible();

		const row = await findAgentRow(page, "claude_code");
		test.skip(
			row == null,
			"no claude_code agent in the seeded fleet — nothing to assert",
		);
		const costCell = row!.locator('[data-testid^="agent-row-cost-"]:not([data-testid*="-total-"])');
		await expect(costCell).toBeVisible();
		// Cost cell text should be the bare em-dash; no chart or
		// sparse-data placeholder mounts because the cell short-
		// circuits before rendering AgentSparkline.
		await expect(costCell).toHaveText("—");
		const sparkCount = await costCell
			.locator(
				'[data-testid="agent-sparkline"], [data-testid="agent-sparkline-empty"]',
			)
			.count();
		expect(sparkCount).toBe(0);
	});
});
