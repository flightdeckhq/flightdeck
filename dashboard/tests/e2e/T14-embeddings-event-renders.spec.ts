import { test, expect, type Page } from "@playwright/test";
import { CODING_AGENT, waitForInvestigateReady } from "./_fixtures";

// T14 — embeddings event renders with rich
// drawer fields. The fresh-active role on the coding agent is
// seeded with three embeddings events (canonical.json + seed.py
// phase4_extras). T14 opens that session's drawer via deep-link
// navigation (``?session=<id>``) and asserts:
//   - the timeline-tab event row carries the typed
//     ``embeddings-event-row-<id>`` testid
//   - the row's badge is the EMBED label
//   - the row's detail text shows the embeddings model and the
//     ``tok in`` segment (no completion-token suffix)
//
// Theme-agnostic: assertions read structural attrs / textContent,
// not computed colours. Runs under both neon-dark and clean-light.
// The coding agent's fresh-active session: uuid5 of
// ``flightdeck-e2e/e2e-test-coding-agent/fresh-active`` (see seed.py).
const FRESH_ACTIVE_SESSION_ID = "8660f293-7039-5cae-9f0a-f4c3428f20d6";

// The drawer's default page size; the embeddings events have to be
// inside it to render without "Show older".
const DRAWER_EVENTS_LIMIT = 100;

test.describe("T14 — Embeddings event renders in drawer", () => {
  test("embeddings row visible with rich detail string", async ({ page }) => {
    // The embeddings event ids come from the API first, from the same
    // page of events the drawer loads, so the test waits on the exact
    // rows it expects. Counting rows as soon as the drawer mounted
    // read "no rows" before its events had loaded.
    const embedIds = await fetchEmbeddingsEventIds(page, FRESH_ACTIVE_SESSION_ID);
    expect(
      embedIds.length,
      "the fresh-active session must carry the three seeded embeddings events",
    ).toBeGreaterThanOrEqual(3);

    const params = new URLSearchParams({
      from: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      to: new Date().toISOString(),
      flavor: CODING_AGENT.flavor,
      session: FRESH_ACTIVE_SESSION_ID,
    });
    await page.goto(`/investigate?${params.toString()}`);
    await waitForInvestigateReady(page);
    const drawer = page.locator('[data-testid="session-drawer"]');
    await expect(drawer).toBeVisible();

    const first = drawer.locator(`[data-testid="embeddings-event-row-${embedIds[0]}"]`);
    await expect(first).toBeVisible();
    await expect(first.locator('[data-testid="event-type-pill"]')).toHaveText("EMBED");
    await expect(first).toContainText("text-embedding-3-small");
    await expect(first).toContainText("tok in");

    // With the seed fixture seeding three embeddings events per
    // fresh-active session (no content + single-string captured +
    // list captured), the drawer mounts one of each
    // EmbeddingsContentViewer branch. Expand each row, read the
    // viewer's state, and collapse it again (a second click toggles).
    const observedStates = new Set<string>();
    for (const id of embedIds) {
      const row = drawer.locator(`[data-testid="embeddings-event-row-${id}"]`);
      await expect(row).toBeVisible();
      await row.click();
      const viewer = drawer.locator('[data-testid="embeddings-content-viewer"]').first();
      await expect(viewer).toBeVisible();
      const state = await viewer.getAttribute("data-state");
      if (state) observedStates.add(state);
      await row.click();
    }
    expect(
      observedStates,
      `EmbeddingsContentViewer must surface every render branch ` +
        `(empty + string + list) across the three seeded events; ` +
        `observed: ${[...observedStates].join(", ") || "(none)"}`,
    ).toEqual(new Set(["empty", "string", "list"]));
  });
});

/**
 * The ids of a session's embeddings events, from the same page of
 * events the drawer loads.
 */
async function fetchEmbeddingsEventIds(page: Page, sessionId: string): Promise<string[]> {
  const resp = await page.request.get(
    `http://localhost:4000/api/v1/sessions/${sessionId}?events_limit=${DRAWER_EVENTS_LIMIT}`,
    { headers: { Authorization: "Bearer tok_dev" } },
  );
  expect(resp.ok(), `GET session ${sessionId}`).toBe(true);
  const body = (await resp.json()) as {
    events?: Array<{ id: string; event_type: string }>;
  };
  return (body.events ?? []).filter((e) => e.event_type === "embeddings").map((e) => e.id);
}
