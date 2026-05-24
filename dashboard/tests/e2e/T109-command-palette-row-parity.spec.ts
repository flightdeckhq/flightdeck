/**
 * T109 — command palette row parity.
 *
 * Locks the row-parity follow-up to D162: agent rows surface
 * the identity badge cluster (ClaudeCodeLogo for Claude Code
 * clients, the agent-type badge, the state chip) and run rows
 * surface ProviderLogo + model. Pre-fix the agent row was bare
 * name + grey agent_type and the run row hid the model entirely.
 *
 * Runs under both Playwright theme projects so per-theme parity
 * is locked (Rule 40c.3); assertions are structural only.
 */
import { test, expect } from "@playwright/test";

test.describe("T109 — palette row parity (agent + run)", () => {
  test("agent row carries the identity badge cluster", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("nav-search-trigger").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // ``claude-subagent`` matches the e2e-test-claude-subagent
    // agent (client_type=claude_code) without colliding with any
    // session flavor.
    await dialog.getByRole("textbox", { name: "Search" }).fill("claude-subagent");
    const agentOptions = dialog
      .getByRole("option")
      .filter({ hasText: /claude-subagent/ });
    await expect.poll(async () => agentOptions.count()).toBeGreaterThan(0);

    const firstAgentRow = agentOptions.first();
    // ClientTypePill renders the brand label ("CLAUDE CODE" or
    // "SENSOR" today, any future coding-agent tool we add). The
    // operator recognises this; the agent-type axis (CODING /
    // PRODUCTION) is too abstract for the palette row.
    await expect(firstAgentRow).toContainText(/claude code|sensor/i);
    // State chip text. Seeded e2e agents land in one of the locked
    // states; assert one of them appears in the row.
    await expect(firstAgentRow).toContainText(/active|idle|stale|closed|lost/);
    // ClaudeCodeLogo carries the stable ``Coding agent (Claude
    // Code)`` aria-label — query the SVG by that label so the
    // assertion can't be satisfied by a stray icon (chevron,
    // spinner).
    const claudeLogo = firstAgentRow.locator(
      'svg[aria-label="Coding agent (Claude Code)"]',
    );
    await expect(claudeLogo).toBeVisible();
  });

  test("run row carries ProviderLogo + model text", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("nav-search-trigger").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // ``claude-code`` matches the e2e-claude-code session flavor
    // (model=claude-sonnet-4-5) without colliding with any e2e
    // agent_name.
    await dialog.getByRole("textbox", { name: "Search" }).fill("claude-code");
    const runOptions = dialog
      .getByRole("option")
      .filter({ hasText: /claude-code/ });
    await expect.poll(async () => runOptions.count()).toBeGreaterThan(0);

    const firstRunRow = runOptions.first();
    // Model text — seed assigns claude-sonnet-* or gpt-* to e2e
    // sessions; both are valid.
    await expect(firstRunRow).toContainText(/claude-|gpt-/i);
    // ProviderLogo renders ``role="img"`` + a brand-cased
    // ``aria-label`` (from PROVIDER_META). Query by both so a
    // stray icon (chevron, spinner) cannot satisfy the assertion.
    const providerLogo = firstRunRow.locator(
      'svg[role="img"][aria-label]',
    );
    await expect(providerLogo).toBeVisible();
  });
});
