/**
 * T90 — the /agents left facet sidebar renders a per-dimension
 * visual on every facet chip.
 *
 * Polish Batch 2 Fix 2 — the /agents filter sidebar mirrors the
 * /events sidebar: each facet chip carries its dimension's visual
 * identity. STATE chips carry a status-chroma dot, AGENT TYPE an
 * `AgentTypeBadge`, CLIENT a `ClientTypePill`, FRAMEWORK a
 * `FrameworkPill` — each emitted under an
 * `agent-facet-icon-<dimension>-<value>` testid so the chrome is
 * externally verifiable, not just eyeball-checkable.
 *
 * Theme-agnostic — structural locators only; runs under both the
 * neon-dark and clean-light theme projects.
 */
import { test, expect } from "@playwright/test";

test.describe("T90 — /agents facet sidebar renders per-dimension icons", () => {
  test("every facet group's chips carry their dimension visual", async ({
    page,
  }) => {
    await page.goto("/agents");
    await expect(
      page.locator('[data-testid="agents-facet-sidebar"]'),
      "the /agents left facet sidebar must render",
    ).toBeVisible({ timeout: 10_000 });
    // The sidebar's per-dimension counts derive from the roster, so
    // wait for at least one agent row to confirm the roster loaded.
    await expect
      .poll(
        async () =>
          page.locator('[data-testid^="agent-row-"][data-agent-id]').count(),
        { timeout: 10_000 },
      )
      .toBeGreaterThan(0);

    // STATE chips carry a status-chroma dot; AGENT TYPE / CLIENT /
    // FRAMEWORK chips carry their identity pill/badge. Each is
    // emitted under an `agent-facet-icon-<dim>-*` testid. The
    // canonical seed has agents spanning every dimension, so each
    // group has at least one chip.
    for (const dim of ["state", "agent_type", "client_type", "framework"]) {
      await expect(
        page.locator(`[data-testid^="agent-facet-icon-${dim}-"]`).first(),
        `the ${dim} facet group must render a per-chip visual`,
      ).toBeVisible();
    }
  });
});
