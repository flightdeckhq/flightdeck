import { test, expect } from "@playwright/test";
import { CODING_AGENT, waitForInvestigateReady } from "./_fixtures";

// T14 — Phase 4 polish S-UI-1: embeddings event renders with rich
// drawer fields. The fresh-active role on the coding agent is
// seeded with an embeddings event (canonical.json + seed.py
// phase4_extras: ["embeddings", "streaming_post_call"]). T14
// opens that session's drawer and asserts:
//   - the timeline-tab event row carries the typed
//     ``embeddings-event-row-<id>`` testid
//   - the row's badge is the EMBED label
//   - the row's detail text shows the embeddings model and the
//     ``tok in`` segment (no completion-token suffix)
//
// Theme-agnostic: assertions read structural attrs / textContent,
// not computed colours. Runs under both neon-dark and clean-light.
test.describe("T14 — Embeddings event renders in drawer", () => {
  test("embeddings row visible with rich detail string", async ({ page }) => {
    const params = new URLSearchParams({
      from: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      to: new Date().toISOString(),
      // Filter to the coding agent's flavor so the first matching
      // row is deterministic (the fresh-active role lives there).
      flavor: CODING_AGENT.flavor,
    });
    await page.goto(`/investigate?${params.toString()}`);
    await waitForInvestigateReady(page);

    // Click the active session row to open the drawer. We can't
    // assume table-order without seeded sort guarantees, so locate
    // by the active state badge text inside the row.
    const activeRow = page
      .locator('[data-testid^="investigate-row-session-"]')
      .filter({ hasText: "active" })
      .first();
    await expect(
      activeRow,
      "fresh-active session for the coding flavor must be visible",
    ).toBeVisible();
    await activeRow.click();

    const drawer = page.locator('[data-testid="session-drawer"]');
    await expect(drawer).toBeVisible();

    // Locate the embeddings event row. The seed posts exactly one
    // embeddings event per fresh-active session, so the typed
    // testid prefix uniquely picks it out without the random id.
    const embedRow = drawer.locator(
      '[data-testid^="embeddings-event-row-"]',
    );
    await expect(
      embedRow,
      "drawer timeline must surface the seeded embeddings event row",
    ).toBeVisible();

    // Badge text == "EMBED" -- pinned by getBadge() and the events
    // helper. data-testid="event-badge" is shared across rows so
    // we scope inside the embeddings row.
    const badge = embedRow.locator('[data-testid="event-badge"]');
    await expect(badge).toHaveText("EMBED");

    // Detail string carries the embedding model + ``tok in`` (the
    // input-only token segment that distinguishes embeddings from
    // post_call). Assertion is on textContent, not the literal
    // formatting, so a future label tweak doesn't make this brittle.
    const rowText = (await embedRow.textContent()) ?? "";
    expect(rowText).toContain("text-embedding-3-small");
    expect(rowText).toContain("tok in");
  });
});
