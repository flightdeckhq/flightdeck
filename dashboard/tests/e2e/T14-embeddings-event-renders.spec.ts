import { test, expect, type Page } from "@playwright/test";
import { CODING_AGENT, waitForInvestigateReady } from "./_fixtures";

// T14 — Phase 4 polish S-UI-1: embeddings event renders with rich
// drawer fields. The fresh-active role on the coding agent is
// seeded with an embeddings event (canonical.json + seed.py
// phase4_extras: ["embeddings", "streaming_post_call"]). T14
// opens an active session's drawer via deep-link navigation
// (``?session=<id>``) and asserts:
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
    // Pull the active coding-flavor session ids straight from the
    // API instead of trying to navigate row-by-row through the table
    // (the drawer overlay makes sequential row clicks fragile). Only
    // fresh-active and error-active match the filter; fresh-active
    // is the one carrying the embeddings event, so we deep-link to
    // each candidate via ``?session=<id>`` and assert the embeddings
    // row appears for at least one.
    const sessionIds = await fetchActiveCodingSessionIds(page);
    expect(
      sessionIds.length,
      "API must return ≥1 active coding session",
    ).toBeGreaterThanOrEqual(1);

    let foundEmbedRow = false;
    for (const sid of sessionIds) {
      const params = new URLSearchParams({
        from: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
        to: new Date().toISOString(),
        flavor: CODING_AGENT.flavor,
        state: "active",
        session: sid,
      });
      await page.goto(`/investigate?${params.toString()}`);
      await waitForInvestigateReady(page);
      const drawer = page.locator('[data-testid="session-drawer"]');
      await expect(drawer).toBeVisible();
      const embedRow = drawer.locator(
        '[data-testid^="embeddings-event-row-"]',
      );
      if ((await embedRow.count()) > 0) {
        foundEmbedRow = true;
        const first = embedRow.first();
        await expect(first).toBeVisible();
        const badge = first.locator('[data-testid="event-badge"]');
        await expect(badge).toHaveText("EMBED");
        const rowText = (await first.textContent()) ?? "";
        expect(rowText).toContain("text-embedding-3-small");
        expect(rowText).toContain("tok in");
        break;
      }
    }
    expect(
      foundEmbedRow,
      "at least one active coding session must surface an embeddings event row",
    ).toBe(true);
  });
});

/**
 * Fetch the session ids of every active session under the canonical
 * coding-agent flavor via a direct API call, bypassing the drawer
 * UI entirely. Used by T14/T15 to deep-link into a candidate
 * session via ``?session=<id>`` so the test doesn't depend on
 * Investigate table sort order or row-click choreography.
 */
async function fetchActiveCodingSessionIds(page: Page): Promise<string[]> {
  const resp = await page.request.get(
    `http://localhost:4000/api/v1/sessions?flavor=${encodeURIComponent(
      CODING_AGENT.flavor,
    )}&state=active&from=2020-01-01T00:00:00Z&limit=100`,
    { headers: { Authorization: "Bearer tok_dev" } },
  );
  expect(resp.ok(), "sessions API call must succeed").toBe(true);
  const body = await resp.json();
  return ((body.sessions ?? []) as Array<{ session_id: string }>).map(
    (s) => s.session_id,
  );
}
