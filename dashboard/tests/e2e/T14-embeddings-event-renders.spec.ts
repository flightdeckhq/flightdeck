import { test, expect, type Locator, type Page } from "@playwright/test";
import { CODING_AGENT, waitForInvestigateReady } from "./_fixtures";
import { API_URL } from "./_stack";
import { EMBEDDING_TOKEN_IDS_PREVIEW_COUNT as TOKEN_IDS_PREVIEW_COUNT } from "../../src/lib/constants";
import {
  embeddingsCall,
  newRun,
  removeRun,
  seedRun,
  sessionStart,
  storedEvent,
  type Run,
} from "./_tool-content-run";

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
// The embeddings API also takes one input as a list of token ids and
// several inputs as a list of token-id lists. The second group posts an
// embeddings call of each through ingestion, each on a capture-on run
// of its own (removed afterwards), opens the run drawer and expands the
// call's row: one token-id input reads as one input labelled as token
// ids with its count, and two token-id lists as two inputs, each with
// its own count.
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
      // The viewer mounts with data-state="loading" while a captured
      // event's content loads; wait for the settled state before
      // reading it. The drawer expands one row at a time, so this row's
      // viewer is the only one mounted.
      const viewer = drawer.locator('[data-testid="embeddings-content-viewer"]');
      await expect(viewer).toBeVisible();
      await expect(viewer).not.toHaveAttribute("data-state", "loading");
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

/** A token-id input longer than the viewer's preview. */
const LONG_TOKEN_IDS = Array.from({ length: TOKEN_IDS_PREVIEW_COUNT + 5 }, (_, i) => 100 + i);

test.describe("T14 — Embeddings token-id inputs render as what they are", () => {
  let run: Run;

  test.beforeEach(() => {
    run = newRun("t14", test.info().project.name);
  });

  test.afterEach(() => {
    removeRun(run);
  });

  test("one token-id input reads as one input with its token count", async ({ page, request }) => {
    const events = await seedRun(request, run, [
      sessionStart(run, true),
      embeddingsCall(run, 1, [101, 202, 303], 3),
    ]);
    const viewer = await openEmbeddingsViewer(page, run, storedEvent(events, "embeddings").id);

    await expect(viewer).toHaveAttribute("data-state", "tokens");
    await expect(viewer).toContainText("Token ids");
    await expect(viewer.getByTestId("embeddings-content-token-count")).toHaveText("3 tokens");
    await expect(viewer.getByTestId("embeddings-content-state-tokens")).toHaveText("101, 202, 303");
    // Not three inputs of one number each.
    await expect(viewer.getByTestId("embeddings-content-state-list")).toHaveCount(0);
  });

  test("two token-id lists read as two inputs, each with its token count, a long one cut", async ({
    page,
    request,
  }) => {
    const events = await seedRun(request, run, [
      sessionStart(run, true),
      embeddingsCall(run, 1, [[1, 2, 3], LONG_TOKEN_IDS], 3 + LONG_TOKEN_IDS.length),
    ]);
    const viewer = await openEmbeddingsViewer(page, run, storedEvent(events, "embeddings").id);

    await expect(viewer).toHaveAttribute("data-state", "list");
    await expect(viewer.getByTestId("embeddings-content-state-list")).toHaveText("2 inputs");
    await expect(viewer.getByTestId("embeddings-content-list-kind")).toHaveText("Token ids");
    await viewer.getByTestId("embeddings-content-toggle").click();
    await expect(viewer.getByTestId("embeddings-content-list-item-0-count")).toHaveText(
      "Token ids (3 tokens)",
    );
    await expect(viewer.getByTestId("embeddings-content-list-item-0-ids")).toHaveText("1, 2, 3");
    await expect(viewer.getByTestId("embeddings-content-list-item-1-count")).toHaveText(
      `Token ids (${LONG_TOKEN_IDS.length} tokens)`,
    );
    // The long list is cut to the preview, and shown whole on "Show full inputs".
    await expect(viewer.getByTestId("embeddings-content-list-item-1-ids")).toHaveText(
      `${LONG_TOKEN_IDS.slice(0, TOKEN_IDS_PREVIEW_COUNT).join(", ")}, …`,
    );
    await viewer.getByTestId("embeddings-content-full-toggle").click();
    await expect(viewer.getByTestId("embeddings-content-list-item-1-ids")).toHaveText(
      LONG_TOKEN_IDS.join(", "),
    );
  });
});

/**
 * Open the run drawer on ``run`` and expand the embeddings row
 * ``eventId``; returns its settled content viewer.
 */
async function openEmbeddingsViewer(page: Page, run: Run, eventId: string): Promise<Locator> {
  await page.goto(`/events?run=${run.sessionId}`);
  const drawer = page.getByTestId("session-drawer");
  const row = drawer.getByTestId(`embeddings-event-row-${eventId}`);
  await expect(row).toBeVisible();
  await row.click();
  const viewer = drawer.getByTestId("embeddings-content-viewer");
  await expect(viewer).toBeVisible();
  await expect(viewer).not.toHaveAttribute("data-state", "loading");
  return viewer;
}

/**
 * The ids of a session's embeddings events, from the same page of
 * events the drawer loads.
 */
async function fetchEmbeddingsEventIds(page: Page, sessionId: string): Promise<string[]> {
  const resp = await page.request.get(
    `${API_URL}/v1/sessions/${sessionId}?events_limit=${DRAWER_EVENTS_LIMIT}`,
    { headers: { Authorization: "Bearer tok_dev" } },
  );
  expect(resp.ok(), `GET session ${sessionId}`).toBe(true);
  const body = (await resp.json()) as {
    events?: Array<{ id: string; event_type: string }>;
  };
  return (body.events ?? []).filter((e) => e.event_type === "embeddings").map((e) => e.id);
}
