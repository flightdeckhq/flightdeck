/**
 * T107 — command palette event-type search.
 *
 * Locks Phase A's curated map + raw event_type substring match.
 * Pre-Phase-A search.go ILIKE'd only tool_name + model, so
 * typing "LLM" / "policy" / a tool literal returned 0 events
 * even though the DB held thousands. This spec types each term
 * and asserts the events group populates with the right types.
 *
 * Runs under both Playwright theme projects so per-theme parity
 * is locked (Rule 40c.3); assertions are structural only.
 */
import { test, expect } from "@playwright/test";

async function openPaletteAndSearch(page: import("@playwright/test").Page, query: string) {
  // Click-trigger keeps the open path deterministic across
  // workers; the Cmd/Ctrl+K chord is exercised in T108.
  await page.getByTestId("nav-search-trigger").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox", { name: "Search" }).fill(query);
  return dialog;
}

test.describe("T107 — palette event-type search returns curated + literal hits", () => {
  test("\"LLM\" curated term surfaces pre_call / post_call / llm_error events", async ({
    page,
  }) => {
    await page.goto("/");
    const dialog = await openPaletteAndSearch(page, "LLM");

    // Events group renders with at least one row. Poll the
    // event-type-pill testid (canonical across surfaces — Phase C
    // reuses the same component the run drawer + /events use).
    const pills = page.getByTestId("event-type-pill");
    await expect.poll(async () => pills.count()).toBeGreaterThan(0);

    // Every rendered pill belongs to the curated LLM set.
    const seen = await pills.evaluateAll((nodes) =>
      nodes.map((n) => n.getAttribute("data-event-type") ?? ""),
    );
    for (const et of seen) {
      expect(["pre_call", "post_call", "llm_error"]).toContain(et);
    }
  });

  test("\"policy\" curated term surfaces policy_* events", async ({ page }) => {
    await page.goto("/");
    const dialog = await openPaletteAndSearch(page, "policy");
    const pills = page.getByTestId("event-type-pill");
    await expect.poll(async () => pills.count()).toBeGreaterThan(0);
    const seen = await pills.evaluateAll((nodes) =>
      nodes.map((n) => n.getAttribute("data-event-type") ?? ""),
    );
    const allowed = new Set([
      "policy_warn",
      "policy_degrade",
      "policy_block",
      "policy_mcp_warn",
      "policy_mcp_block",
    ]);
    for (const et of seen) {
      expect(allowed.has(et)).toBeTruthy();
    }
  });

  test("a seeded tool_name literal surfaces tool_call events", async ({
    page,
  }) => {
    await page.goto("/");
    // ``read_file`` is one of the seed-e2e fixture's tool_name values
    // and is rare enough to anchor the rank without ambiguity.
    const dialog = await openPaletteAndSearch(page, "read_file");
    const pills = page.getByTestId("event-type-pill");
    await expect.poll(async () => pills.count()).toBeGreaterThan(0);
    const seen = await pills.evaluateAll((nodes) =>
      nodes.map((n) => n.getAttribute("data-event-type") ?? ""),
    );
    // The seed assigns the tool_name to tool_call events.
    expect(seen).toContain("tool_call");
  });
});
