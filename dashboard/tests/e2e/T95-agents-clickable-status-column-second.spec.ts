import { test, expect } from "@playwright/test";

/**
 * T95 — /agents STATUS column relocation + clickable chip.
 *
 * Pre-fix STATUS was the last column on the right with the badge
 * doubling as both indicator and modal opener; the actions cell
 * also carried a duplicate badge. The polish move puts STATUS
 * second (right after AGENT), keeps the single labeled badge
 * inside a ``.agent-status-chip`` button wired to the per-agent
 * swimlane modal, and drops the actions-cell duplicate.
 *
 * This spec locks in the contract end-to-end at the live
 * dashboard:
 *
 *   1. Column-header order — second ``<th>`` is the STATUS
 *      header with ``data-testid="agent-table-th-state"``.
 *   2. Row geometry — for any seeded canonical row, the second
 *      ``<td>`` is the status cell
 *      (``agent-row-status-cell-{id}``), containing the chip
 *      button + nested badge.
 *   3. Clicking the chip opens the per-agent swimlane modal
 *      (``per-agent-swimlane-modal`` becomes visible) and does
 *      NOT open the agent drawer (mutually exclusive surfaces).
 *   4. Actions cell holds only the Events shortcut — no nested
 *      badge or modal-open button remains there.
 *
 * Theme-agnostic; runs under both ``neon-dark`` and
 * ``clean-light`` Playwright projects.
 */
test.describe("T95 — /agents STATUS column second + clickable chip", () => {
  test("STATUS is the second column header, chip opens modal, actions cell holds Events only", async ({
    page,
  }) => {
    await page.goto("/agents");

    // 1. Column-header order. The header row's children query
    // resolves <th> elements in source order; the second one is
    // the STATUS header.
    const headers = page.locator('thead th');
    await expect(headers.nth(0)).toHaveAttribute(
      "data-testid",
      "agent-table-th-agent_name",
    );
    await expect(headers.nth(1)).toHaveAttribute(
      "data-testid",
      "agent-table-th-state",
    );

    // 2. Row geometry. Wait for the table to populate, then
    // sample the first canonical row and walk its <td> list.
    await expect(
      page.locator('[data-testid^="agent-row-"]').first(),
    ).toBeVisible({ timeout: 10_000 });
    const firstRow = page.locator('[data-testid^="agent-row-"]').first();
    const agentId = await firstRow.getAttribute("data-agent-id");
    expect(agentId).toBeTruthy();
    const cells = firstRow.locator("td");
    await expect(cells.nth(1)).toHaveAttribute(
      "data-testid",
      `agent-row-status-cell-${agentId}`,
    );
    const chip = page.locator(
      `[data-testid="agent-row-open-swimlane-modal-${agentId}"]`,
    );
    await expect(chip).toBeVisible();
    const chipClass = await chip.getAttribute("class");
    expect(chipClass ?? "").toContain("agent-status-chip");

    // 3. Click opens the modal; the drawer must NOT appear.
    await chip.click();
    await expect(
      page.locator('[data-testid="per-agent-swimlane-modal"]'),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.locator('[data-testid="agent-drawer"]'),
    ).toHaveCount(0);

    // 4. Actions cell holds only the Events shortcut.
    // Close the modal by pressing Escape so the next assertion
    // doesn't race the closing dialog. Esc is Radix's standard
    // close path — outside-click would also work but Esc is
    // synchronous.
    await page.keyboard.press("Escape");
    const actions = page.locator(
      `[data-testid="agent-row-actions-${agentId}"]`,
    );
    await expect(actions).toBeVisible();
    await expect(
      actions.locator(`[data-testid="agent-row-open-events-${agentId}"]`),
    ).toBeVisible();
    await expect(
      actions.locator(`[data-testid="agent-row-status-${agentId}"]`),
    ).toHaveCount(0);
    await expect(
      actions.locator(
        `[data-testid="agent-row-open-swimlane-modal-${agentId}"]`,
      ),
    ).toHaveCount(0);
  });
});
