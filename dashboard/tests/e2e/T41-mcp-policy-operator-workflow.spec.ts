import { test, expect, type Page } from "@playwright/test";

import { CODING_AGENT } from "./_fixtures";

// T41 — MCP Protection Policy operator-workflow contract.
//
// Locks the cumulative shape after the step 6.9 chain:
//   - D138: quick-start link is suppressed on Global scope; the
//     ``apply_template`` API rejects ``flavor=global`` by design.
//   - Mutation affordances (Add / Edit / Delete, mode toggle, BOU
//     switch) render unconditionally — single-tier auth, every valid
//     bearer token has full access (D156).
//   - Step 6.9 InfoIcon migration: every label-side help affordance
//     uses the shared ``<InfoIcon>`` primitive (button trigger with
//     aria-label, not text-styled "info" links).
//   - Step 6.9 dialog rewrite: placeholders + InfoIcons on URL /
//     Name / Decision / Enforcement.
//
// All cases are read-only. The dev DB stays clean across runs.
// Theme-agnostic per Rule 40c.3 — assertions read structural
// attributes (data-testid, aria-label, placeholder), never colours.

async function navigateToMCPPolicy(page: Page): Promise<void> {
  await page.goto("/policies?policy=mcp");
  // Wait for the MCP Protection sub-tab content to mount; the scope
  // picker is the first deterministic element inside the tab body.
  await page
    .locator('[data-testid="mcp-policies-scope-picker"]')
    .waitFor({ state: "visible", timeout: 10_000 });
}

async function switchToFlavorTab(page: Page, flavor: string): Promise<void> {
  // Open the searchable scope picker, type-to-filter, click the
  // option. Type-to-filter avoids depending on alphabetical position
  // in a fleet that may grow over time.
  await page.locator('[data-testid="mcp-policies-scope-select"]').click();
  await page
    .locator('[data-testid="mcp-policies-scope-search"]')
    .waitFor({ state: "visible" });
  await page.locator('[data-testid="mcp-policies-scope-search"]').fill(flavor);
  // The scope picker emits one ``mcp-policies-tab-flavor:<name>``
  // option per matching flavor; click the exact match.
  await page
    .locator(`[data-testid="mcp-policies-tab-flavor:${flavor}"]`)
    .click();
  // Wait for the flavor panel to mount.
  await page
    .locator(`[data-testid="mcp-policies-panel-${flavor}"]`)
    .waitFor({ state: "visible", timeout: 10_000 });
}

test.describe("T41 — MCP Protection Policy operator workflow", () => {
  test("Global tab: mode + BOU controls render; quick-start link is suppressed (D138 regression guard)", async ({
    page,
  }) => {
    await navigateToMCPPolicy(page);

    // Default tab is Global; the panel testid confirms.
    await expect(
      page.locator('[data-testid="mcp-policies-panel-global"]'),
    ).toBeVisible();

    // Mode segmented control + InfoIcon trigger render.
    await expect(
      page.locator('[data-testid="mcp-policy-mode-segmented-global"]'),
    ).toBeVisible();
    const modeInfo = page.locator(
      '[data-testid="mcp-policy-mode-tooltip-trigger-global"]',
    );
    await expect(modeInfo).toBeVisible();
    expect(await modeInfo.evaluate((el) => el.tagName)).toBe("BUTTON");
    expect(await modeInfo.getAttribute("aria-label")).toBe("Policy mode help");

    // D138 regression guard: NO quick-start link inside the Global
    // scope's empty-state. apply_template returns 400 with
    // "templates apply to flavor policies only" by design — the
    // dashboard must not render a CTA the API will always reject.
    await expect(
      page.locator('[data-testid="mcp-quickstart-templates-trigger-global"]'),
    ).toHaveCount(0);
  });

  test("Flavor tab: quick-start link renders on 0-entry flavor; popover lists 3 templates incl. maintenance chip", async ({
    page,
  }) => {
    await navigateToMCPPolicy(page);
    await switchToFlavorTab(page, CODING_AGENT.flavor);

    // The flavor has no MCP policy — the panel renders the "no
    // flavor policy" copy + the empty entries table with the
    // quick-start CTA. ``MCPPolicyEntryTable`` keys testids on
    // ``scopeKey``, which is the flavor name on flavor panels.
    const trigger = page.locator(
      `[data-testid="mcp-quickstart-templates-trigger-${CODING_AGENT.flavor}"]`,
    );
    await expect(trigger).toBeVisible();

    // Open the popover — first click lazy-loads the templates from
    // GET /v1/mcp-policies/templates.
    await trigger.click();
    await expect(
      page.locator(
        `[data-testid="mcp-quickstart-templates-popover-${CODING_AGENT.flavor}"]`,
      ),
    ).toBeVisible();

    // All three D138 templates land. Each row carries a stable
    // testid keyed on the template name.
    for (const name of [
      "strict-baseline",
      "permissive-dev",
      "strict-with-common-allows",
    ]) {
      await expect(
        page.locator(`[data-testid="mcp-quickstart-templates-row-${name}"]`),
      ).toBeVisible();
    }

    // The maintenance-warning chip renders on
    // ``strict-with-common-allows`` only — D138 contract surface for
    // operators reviewing the URL-maintenance commitment.
    await expect(
      page.locator(
        '[data-testid="mcp-quickstart-templates-maintenance-chip-strict-with-common-allows"]',
      ),
    ).toBeVisible();
    await expect(
      page.locator(
        '[data-testid="mcp-quickstart-templates-maintenance-chip-strict-baseline"]',
      ),
    ).toHaveCount(0);
  });

  test("Add entry dialog: spec placeholders + InfoIcons on every field (step 6.9 dialog rewrite)", async ({
    page,
  }) => {
    await navigateToMCPPolicy(page);
    await switchToFlavorTab(page, CODING_AGENT.flavor);

    // Open the Add entry dialog. The button's testid is keyed on
    // the scopeKey (flavor name on flavor panels).
    await page
      .locator(`[data-testid="mcp-policy-entries-add-${CODING_AGENT.flavor}"]`)
      .click();
    await expect(
      page.locator('[data-testid="mcp-policy-entry-dialog-title"]'),
    ).toBeVisible();

    // Spec-required placeholders verbatim per step 6.9.
    await expect(
      page.locator('[data-testid="mcp-policy-entry-url"]'),
    ).toHaveAttribute(
      "placeholder",
      "https://mcp.example.com/sse OR stdio:///path/to/server-binary",
    );
    await expect(
      page.locator('[data-testid="mcp-policy-entry-name"]'),
    ).toHaveAttribute("placeholder", "filesystem");

    // Every label has a paired InfoIcon (button trigger, not span).
    const infoTriggerIds = [
      "mcp-policy-entry-url-tooltip-trigger",
      "mcp-policy-entry-name-tooltip-trigger",
      "mcp-policy-entry-kind-tooltip-trigger",
      "mcp-policy-entry-enforcement-tooltip-trigger",
    ];
    for (const id of infoTriggerIds) {
      const trigger = page.locator(`[data-testid="${id}"]`);
      await expect(trigger).toBeVisible();
      expect(
        await trigger.evaluate((el) => el.tagName),
        `${id} must render as a <button>, not a styled span`,
      ).toBe("BUTTON");
      const ariaLabel = await trigger.getAttribute("aria-label");
      expect(
        ariaLabel,
        `${id} must declare an aria-label so screen readers announce it`,
      ).toBeTruthy();
    }

    // Live-preview empty state renders before URL/Name fill — D135
    // § Add-edit dialog contract.
    await expect(
      page.locator('[data-testid="mcp-policy-entry-resolve-empty"]'),
    ).toBeVisible();
  });
});
