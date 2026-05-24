/**
 * T86 — the /agents page has a top-of-page free-text search bar.
 *
 * Polish Batch 2 Fix 4 — the /agents page gains a client-side
 * search input (`agents-search-input`). Typing narrows the agent
 * table rows to those whose name / agent_type / client_type /
 * framework / recent-session model match the query
 * (case-insensitive substring). Pressing Escape clears the input
 * and restores the unfiltered roster.
 *
 * Theme-agnostic — structural locators only; runs under both the
 * neon-dark and clean-light theme projects.
 */
import { test, expect } from "@playwright/test";

test.describe("T86 — /agents search bar narrows the roster", () => {
  test("typing narrows the rows; Escape restores them", async ({ page }) => {
    await page.goto("/agents");
    await expect(page.locator('[data-testid="agents-page"]')).toBeVisible();
    await expect(page.locator('[data-testid="agent-table"]')).toBeVisible();

    const rows = page.locator('[data-testid^="agent-row-"][data-agent-id]');
    await expect
      .poll(async () => rows.count(), { timeout: 10_000 })
      .toBeGreaterThan(0);
    const before = await rows.count();
    // The roster must hold more than one row for the narrowing
    // assertion to be meaningful — the canonical seed provides
    // ~19 e2e fixture agents.
    expect(before).toBeGreaterThan(1);

    // Derive a query from a real row so the search reliably matches
    // a SUBSET. The identity cell carries the agent name PLUS the
    // client-type pill text + agent_type label; isolate the
    // agent_name itself by reading the row's `data-agent-id` and
    // resolving the name from the API would be heavier than needed
    // — instead use the client-type-agnostic agent-row-agent-type
    // sibling to locate the name span. The name is the first
    // mono-font span inside the identity cell.
    const firstRow = rows.first();
    const firstAgentId =
      (await firstRow.getAttribute("data-agent-id")) ?? "";
    expect(firstAgentId.length).toBeGreaterThan(0);
    const nameSpan = page
      .locator(`[data-testid="agent-row-identity-${firstAgentId}"] span`)
      .first();
    await expect(nameSpan).toBeVisible();
    const name = ((await nameSpan.textContent()) ?? "").trim();
    expect(name.length).toBeGreaterThan(0);

    const search = page.locator('[data-testid="agents-search-input"]');
    await expect(search).toBeVisible();

    // Type the full agent name — guaranteed to match this row and
    // (because fixture names are distinct) at most a handful of
    // siblings, so the count never grows.
    await search.fill(name);
    await expect
      .poll(async () => rows.count(), { timeout: 10_000 })
      .toBeLessThanOrEqual(before);
    // The matched row is still present after the narrow — assert by
    // its stable agent_id, not by text (the identity cell's text is
    // a concatenation of name + pill + type).
    await expect(
      page.locator(`[data-testid="agent-row-${firstAgentId}"]`),
    ).toBeVisible();

    // A query that matches nothing collapses the table entirely.
    await search.fill("zzz-no-such-agent-xyzzy");
    await expect
      .poll(async () => rows.count(), { timeout: 10_000 })
      .toBe(0);

    // Press Escape — the input clears and the unfiltered roster is
    // restored.
    await search.press("Escape");
    await expect(search).toHaveValue("");
    await expect
      .poll(async () => rows.count(), { timeout: 10_000 })
      .toBe(before);
  });
});
