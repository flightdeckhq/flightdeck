/**
 * T63 — per-agent swimlane modal sub-agents toggle.
 *
 * The toggle defaults ON for parents (topology="parent") and is
 * DISABLED + off for lone agents. The seeded `e2e-test-crewai-
 * parent` fixture is the canonical parent anchor; `e2e-test-
 * coding-agent` may or may not be a parent depending on whether
 * its keep-alive watchdog has linked the fresh-subagent — but
 * crewai-parent reliably has children (crewai-researcher +
 * crewai-writer) regardless of timing.
 */
import { test, expect } from "@playwright/test";

test.use({ viewport: { width: 1400, height: 1800 } });

test.describe("T63 — show-sub-agents toggle reflects topology", () => {
  test("toggle defaults ON for a parent agent's modal", async ({ page }) => {
    await page.goto("/agents");
    await expect(page.locator('[data-testid="agent-table"]')).toBeVisible();

    // Find a row whose AgentSummary.topology === "parent" via
    // the row's data-agent-topology attribute. This is the
    // authoritative server-side rollup; TopologyCell's
    // client-side mode can disagree under partial-fleet-store
    // states.
    const parentRow = page
      .locator('[data-agent-topology="parent"][data-testid^="agent-row-"]')
      .first();
    await expect(parentRow).toBeVisible({ timeout: 10_000 });

    const agentId = (await parentRow.getAttribute("data-agent-id")) ?? "";
    const statusBtn = page.locator(
      `[data-testid="agent-row-open-swimlane-modal-${agentId}"]`,
    );
    await statusBtn.click();

    const toggleInput = page.locator(
      '[data-testid="per-agent-swimlane-modal-show-sub-agents-input"]',
    );
    await expect(toggleInput).toBeVisible();
    await expect(toggleInput).toBeChecked();
    await expect(toggleInput).not.toBeDisabled();
  });

  test("toggle is DISABLED + unchecked for a lone agent's modal", async ({
    page,
  }) => {
    await page.goto("/agents");
    await expect(page.locator('[data-testid="agent-table"]')).toBeVisible();

    const loneRow = page
      .locator('[data-agent-topology="lone"][data-testid^="agent-row-"]')
      .first();
    await expect(loneRow).toBeVisible({ timeout: 10_000 });

    const agentId = (await loneRow.getAttribute("data-agent-id")) ?? "";
    const statusBtn = page.locator(
      `[data-testid="agent-row-open-swimlane-modal-${agentId}"]`,
    );
    await statusBtn.click();

    const toggleInput = page.locator(
      '[data-testid="per-agent-swimlane-modal-show-sub-agents-input"]',
    );
    await expect(toggleInput).toBeVisible();
    await expect(toggleInput).toBeDisabled();
    await expect(toggleInput).not.toBeChecked();
  });
});
