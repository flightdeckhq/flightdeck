import { test, expect, type Locator, type Page } from "@playwright/test";

import type { PricedModel } from "../../src/lib/types";

// T118 — the token policy editor's degrade-to list comes from
// GET /v1/pricing/models, and the API's rejection of a model outside
// that list shows inside the dialog.
//
// The rejected create persists nothing, so the dev DB stays clean
// across runs. Theme-agnostic per Rule 40c.3: assertions read text,
// test ids and roles, never colours.

// A model row's accessible name is the provider logo's label followed by
// the model id ("Anthropic claude-haiku-4-5").
function modelButton(dropdown: Locator, modelId: string): Locator {
  const id = modelId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return dropdown.getByRole("button", { name: new RegExp(`(^|\\s)${id}$`) });
}

async function openCreateDialog(page: Page): Promise<PricedModel[]> {
  const models = page.waitForResponse((r) => r.url().includes("/v1/pricing/models"));
  await page.goto("/policies");
  const create = page
    .locator('[data-testid="policies-token-budget-create-header"], [data-testid="policy-table-empty-create"]')
    .first();
  await create.click();
  await page.getByPlaceholder("1-99").nth(1).fill("85");
  const res = await models;
  expect(res.status()).toBe(200);
  return (await res.json()) as PricedModel[];
}

test.describe("T118 — policy degrade-to offers priced models", () => {
  test("the list shows the API's models and the filter narrows it", async ({ page }) => {
    const models = await openCreateDialog(page);
    expect(models.length).toBeGreaterThan(0);

    const dropdown = page.getByTestId("model-dropdown");
    const target = models.find((m) => m.model_id === "claude-haiku-4-5") ?? models[0];
    await expect(modelButton(dropdown, target.model_id)).toBeVisible();

    await page.getByLabel("Filter models").fill(target.model_id);
    await expect(modelButton(dropdown, target.model_id)).toBeVisible();
    const other = models.find((m) => !m.model_id.includes(target.model_id));
    if (other) {
      await expect(modelButton(dropdown, other.model_id)).toHaveCount(0);
    }

    await page.getByLabel("Filter models").fill("no-such-model-anywhere");
    await expect(dropdown).toContainText("No priced model matches.");
  });

  test("an unpriced model is flagged and the API's 400 shows in the dialog", async ({ page }) => {
    await openCreateDialog(page);

    await page.getByRole("button", { name: "Or enter model name directly →" }).click();
    await page.getByPlaceholder("e.g. claude-haiku-4-5").fill("e2e-not-a-priced-model");
    await expect(page.getByTestId("degrade-to-unlisted")).toContainText("the API will reject it");

    const rejected = page.waitForResponse(
      (r) => r.url().endsWith("/v1/policies") && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Create", exact: true }).click();
    expect((await rejected).status()).toBe(400);

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("alert")).toContainText("degrade_to must be a current, priced model");
    // The dialog stays open so the operator can pick another model.
    await expect(dialog.getByRole("button", { name: "Create", exact: true })).toBeVisible();
  });
});
