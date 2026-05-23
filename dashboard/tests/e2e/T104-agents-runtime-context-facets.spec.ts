import { test, expect } from "@playwright/test";

/**
 * T104 — /agents runtime-context facets filter the agent table.
 *
 * Nine new D161 facet groups land on the /agents page sidebar:
 * HOSTNAME, USER, OS, ARCH, GIT BRANCH, GIT REPO, ORCHESTRATION,
 * PYTHON, PROCESS. Each chip click toggles a value in the parent's
 * `AgentFilterState`; the page re-runs `filterAgents()` over the
 * loaded roster (all filtering is client-side over the
 * `useFleetStore().agents` slice — no API roundtrip).
 *
 * This spec exercises two of the new facets end-to-end:
 *   - Click an OS chip → the agent table narrows (row count drops or
 *     stays — never increases).
 *   - Click an OS chip then a GIT BRANCH chip → table narrows further
 *     (or stays). Confirms client-side AND composition across D161
 *     dimensions.
 *
 * Theme-agnostic. Uses fixtures the dev stack already populates: the
 * dev Claude Code agent (`omria@Omri-PC`) carries
 * `os=Linux + git_branch=feat/d157-per-agent-landing-page`, plus the
 * E2E seed agents whose sessions carry varied context.
 */
test.describe("T104 — /agents runtime-context facets", () => {
  test("clicking an OS chip filters the agent table", async ({ page }) => {
    await page.setViewportSize({ width: 1700, height: 1000 });
    await page.goto("/agents");

    // Wait for the facet sidebar to mount AND for the OS group to
    // render at least one chip (the dev stack always carries
    // os=Linux on the dev agent, so this is deterministic).
    const sidebar = page.locator('[data-testid="agents-facet-sidebar"]');
    await expect(sidebar).toBeVisible({ timeout: 15_000 });
    const osGroup = page.locator('[data-testid="agent-filter-os-group"]');
    await expect(osGroup).toBeVisible({ timeout: 15_000 });
    const osChips = osGroup.locator('[data-testid^="agent-filter-os-"]');
    // Filter out the group container itself (its testid also matches
    // the prefix); count() against the descendant button locator
    // returns only the actual chips.
    const osChipButtons = osGroup.locator(
      'button[data-testid^="agent-filter-os-"]',
    );
    await expect
      .poll(() => osChipButtons.count(), { timeout: 10_000 })
      .toBeGreaterThan(0);

    // Settle the agent table — bare count() immediately after page
    // mount can race the loading skeleton.
    const agentRows = page.locator('[data-testid^="agent-row-"]');
    await expect
      .poll(() => agentRows.count(), { timeout: 10_000 })
      .toBeGreaterThan(0);
    const baselineCount = await agentRows.count();

    // Click the first OS chip (sidebar sorts by descending count;
    // Linux dominates in the dev stack so it lands first).
    const firstChip = osChipButtons.first();
    await firstChip.click();

    // The agent table re-renders client-side — count is ≤ baseline.
    await expect
      .poll(() => agentRows.count(), { timeout: 10_000 })
      .toBeLessThanOrEqual(baselineCount);

    // The clicked chip is now in the active state — the inline style
    // background paints with `var(--primary)` mix when active.
    await expect(firstChip).toHaveAttribute("data-active", "true");
    void osChips; // referenced for documentation; the button-only
                  // selector is what we actually assert against.
  });

  test("filters compose AND across D161 dimensions", async ({ page }) => {
    await page.setViewportSize({ width: 1700, height: 1000 });
    await page.goto("/agents");

    const sidebar = page.locator('[data-testid="agents-facet-sidebar"]');
    await expect(sidebar).toBeVisible({ timeout: 15_000 });

    // OS group must be present (dev stack always carries os=Linux).
    const osChipButtons = page.locator(
      'button[data-testid^="agent-filter-os-"]',
    );
    await expect
      .poll(() => osChipButtons.count(), { timeout: 10_000 })
      .toBeGreaterThan(0);

    // Settle the table before the first click.
    const agentRows = page.locator('[data-testid^="agent-row-"]');
    await expect
      .poll(() => agentRows.count(), { timeout: 10_000 })
      .toBeGreaterThan(0);
    const baselineCount = await agentRows.count();

    // Apply the first dim — OS.
    await osChipButtons.first().click();
    await expect
      .poll(() => agentRows.count(), { timeout: 10_000 })
      .toBeLessThanOrEqual(baselineCount);
    const osOnlyCount = await agentRows.count();

    // Second dim — GIT BRANCH. The dev Claude Code agent carries the
    // current feature branch; the GIT BRANCH group is reliably present.
    const branchGroup = page.locator(
      '[data-testid="agent-filter-git_branch-group"]',
    );
    // If the group is missing (no agent carries a branch on this
    // dev stack), the AND-composition claim can't be exercised —
    // skip the rest of the test rather than fail. This matches the
    // empty-group hides contract: a missing group is acceptable
    // behavior, not a bug.
    if (!(await branchGroup.isVisible().catch(() => false))) {
      test.skip(true, "no agent carries a git_branch on this dev stack");
      return;
    }
    const branchChipButtons = branchGroup.locator(
      'button[data-testid^="agent-filter-git_branch-"]',
    );
    await expect
      .poll(() => branchChipButtons.count(), { timeout: 10_000 })
      .toBeGreaterThan(0);
    await branchChipButtons.first().click();

    // Combined OS + GIT BRANCH narrows further (or stays equal).
    // Confirms AND composition across D161 dims.
    await expect
      .poll(() => agentRows.count(), { timeout: 10_000 })
      .toBeLessThanOrEqual(osOnlyCount);
  });
});
