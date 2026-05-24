import { test, expect } from "@playwright/test";

/**
 * T99 — Agent drawer ContextPanel renders the full session
 * context, not the prior 6-key curation.
 *
 * The seeded ``DEFAULT_TEST_CONTEXT`` (tests/shared/fixtures.py)
 * carries 13 keys: os, arch, hostname, user, python_version,
 * pid, process_name, git_branch, git_commit, git_repo,
 * orchestration, compose_project, frameworks. All 12 curated
 * keys defined in ``CONTEXT_KEYS`` that have a value land in
 * the panel; ``compose_project`` falls into the generic
 * unknown-key bucket (rendered with the humanised label
 * ``Compose project``) — exactly the "future sensor key never
 * gets hidden" contract.
 *
 * Theme-agnostic.
 */
test.describe("T99 — Agent drawer ContextPanel renders full context", () => {
  test("curated + generic context keys all render", async ({ page }) => {
    await page.goto("/agents");
    const row = page
      .locator('[data-testid^="agent-row-"]')
      .filter({ hasText: "e2e-test-coding-agent" })
      .first();
    await row.scrollIntoViewIfNeeded();
    await expect(row).toBeVisible({ timeout: 10_000 });
    const agentId = await row.getAttribute("data-agent-id");
    expect(agentId).toBeTruthy();
    await page.goto(`/agents?agent_drawer=${encodeURIComponent(agentId!)}`);
    const drawer = page.locator('[data-testid="agent-drawer"]');
    await expect(drawer).toBeVisible({ timeout: 10_000 });

    // Expand the runtime-context panel (defaults to collapsed).
    await drawer
      .locator('[data-testid="agent-drawer-panel-context-toggle"]')
      .click();
    const rowsContainer = drawer.locator(
      '[data-testid="agent-drawer-context-rows"]',
    );
    await expect(rowsContainer).toBeVisible();

    // Curated keys the seed fixture populates — every one must
    // render its testid + a non-empty value.
    const curatedSeedKeys = [
      "user",
      "hostname",
      "os",
      "arch",
      "pid",
      "process_name",
      "python_version",
      "git_branch",
      "git_repo",
      "git_commit",
      "orchestration",
      "frameworks",
    ];
    for (const key of curatedSeedKeys) {
      await expect(
        rowsContainer.locator(
          `[data-testid="agent-drawer-context-row-${key}"]`,
        ),
      ).toBeVisible();
    }

    // Generic unknown key — ``compose_project`` is a top-level
    // context field (the seed emits ``orchestration`` as a bare
    // string, so compose_project doesn't nest under it). The
    // panel humanises the snake_case key to ``Compose project``.
    const generic = rowsContainer.locator(
      '[data-testid="agent-drawer-context-row-compose_project"]',
    );
    await expect(generic).toBeVisible();
    await expect(generic).toContainText("Compose project");
    await expect(generic).toContainText("flightdeck-tests");

    // ``mcp_servers`` is rendered in the MCP SERVERS panel
    // above — the context panel must never duplicate it.
    await expect(
      rowsContainer.locator(
        '[data-testid="agent-drawer-context-row-mcp_servers"]',
      ),
    ).toHaveCount(0);
  });
});
