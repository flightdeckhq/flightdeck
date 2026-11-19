/**
 * T193 — An embeddings-only run lists its calls in the Prompts tab, and
 * each opens its own input.
 *
 * Fixture: an agent of this spec run's own (``createPrivateAgent``), one
 * run, and on it three OpenAI ``embeddings`` calls posted through
 * ingestion in the sensor's wire shape with their content captured
 * (each its own two texts as ``input``, ``response`` ``{}`` and the
 * vectors in ``embedding_output``, as the sensor stores them) and their
 * ``output_dimensions``. The run stores no other content.
 *
 * The run drawer's Prompts tab lists the three calls, newest first, each
 * row with the embeddings badge and the call's model, and never says
 * "No content was recorded for this run.". Each row opens the embeddings
 * view on that call's own texts, with its output_dimensions under
 * Output, and "← Back to event list" returns to the three rows. The
 * Timeline's "View Prompts →" on the oldest call opens the same view,
 * and Back lands on the list with that call's row focused.
 *
 * Theme-agnostic: test ids, roles and text only, so it runs under both
 * the neon-dark and clean-light theme projects (Rule 40c.3).
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
import {
  createPrivateAgent,
  endPrivateAgent,
  postPrivateEmbeddings,
  startPrivateAgent,
  type PrivateAgent,
} from "./_fixtures";

const MODEL = "text-embedding-3-small";
const CALL = { client_type: "flightdeck_sensor", framework: null, model: MODEL, provider: "openai" };
/** Each call's texts, in the order the calls are made. */
const CALL_TEXTS = [
  ["Harbour tide table T193-ONE-A", "Harbour tide table T193-ONE-B"],
  ["Ferry timetable T193-TWO-A", "Ferry timetable T193-TWO-B"],
  ["Lighthouse hours T193-THREE-A", "Lighthouse hours T193-THREE-B"],
] as const;
const DIMENSION = 3;
/** The embeddings badge's label (lib/events.ts). */
const EMBEDDINGS_BADGE = "EMBED";

/** An embeddings call's content as the sensor stores it. */
function stored(texts: readonly string[]): Record<string, unknown> {
  return {
    provider: "openai",
    model: MODEL,
    system: null,
    messages: [],
    tools: null,
    response: {},
    input: texts,
    embedding_output: texts.map(() => [0.0193, -0.0193, 0.0193]),
    captured_at: new Date().toISOString(),
  };
}

/** The run drawer on the run, its Prompts tab open. */
async function openPromptsTab(page: Page, sessionId: string): Promise<Locator> {
  await page.goto(`/events?run=${sessionId}`);
  const drawer = page.getByTestId("session-drawer");
  await expect(drawer).toBeVisible();
  await drawer.getByTestId("drawer-tab-prompts").click();
  return drawer;
}

/** The embeddings view on a call: its own two texts behind their count,
 *  then opened; its output_dimensions under Output; no response. */
async function expectCallView(drawer: Locator, texts: readonly string[]): Promise<void> {
  const view = drawer.getByTestId("prompt-viewer-embeddings");
  await expect(view).toBeVisible();
  const box = view.getByTestId("prompt-box-embeddings-input");
  await expect(box.getByTestId("embeddings-content-state-list")).toHaveText(`${texts.length} inputs`);
  await box.getByTestId("embeddings-content-toggle").click();
  for (const [i, text] of texts.entries()) {
    await expect(box.getByTestId(`embeddings-content-list-item-${i}`)).toHaveText(text);
  }
  await expect(view.getByRole("button", { name: "Output", exact: true })).toBeVisible();
  await expect(view.getByRole("button", { name: "Response", exact: true })).toHaveCount(0);
  const dimensions = view.getByTestId("embeddings-output-dimensions");
  await expect(dimensions).toContainText(`count:${texts.length}`);
  await expect(dimensions).toContainText(`dimension:${DIMENSION}`);
}

test.describe("T193 — an embeddings-only run lists its calls in the Prompts tab", () => {
  let agent: PrivateAgent | undefined;

  test.afterEach(async ({ page }) => {
    if (agent) await endPrivateAgent(page, agent);
  });

  async function start(page: Page): Promise<{ sessionId: string; callIds: string[] }> {
    agent = createPrivateAgent("t193-embeddings-list", 1);
    await startPrivateAgent(page, agent);
    const sessionId = agent.sessionIds[0]!;
    const callIds: string[] = [];
    for (const texts of CALL_TEXTS) {
      callIds.push(
        await postPrivateEmbeddings(page, agent, sessionId, stored(texts), {
          ...CALL,
          output_dimensions: { count: texts.length, dimension: DIMENSION },
        }),
      );
    }
    return { sessionId, callIds };
  }

  test("the list shows each call, and each row opens that call's input", async ({ page }) => {
    const { sessionId, callIds } = await start(page);
    expect(new Set(callIds).size).toBe(CALL_TEXTS.length);
    const drawer = await openPromptsTab(page, sessionId);

    const rows = drawer.locator('[data-testid^="prompts-row-"]');
    // Newest first, as the Timeline lists them.
    const newestFirst = [...callIds].reverse();
    await expect(rows).toHaveCount(callIds.length);
    for (const [i, id] of newestFirst.entries()) {
      await expect(rows.nth(i)).toHaveAttribute("data-testid", `prompts-row-${id}`);
      await expect(rows.nth(i)).toContainText(EMBEDDINGS_BADGE);
      await expect(rows.nth(i)).toContainText(MODEL);
    }
    await expect(drawer.getByTestId("prompts-no-content-for-run")).toHaveCount(0);

    for (const [i, id] of callIds.entries()) {
      await drawer.getByTestId(`prompts-row-${id}`).click();
      await expectCallView(drawer, CALL_TEXTS[i]!);
      await drawer.getByRole("button", { name: "← Back to event list" }).click();
      await expect(rows).toHaveCount(callIds.length);
      await expect(drawer.getByTestId("prompts-no-content-for-run")).toHaveCount(0);
    }
  });

  test("View Prompts → on a call's row, then Back, lands on the list with that row focused", async ({ page }) => {
    const { sessionId, callIds } = await start(page);
    const oldest = callIds[0]!;
    await page.goto(`/events?run=${sessionId}`);
    const drawer = page.getByTestId("session-drawer");
    await expect(drawer).toBeVisible();
    await drawer.getByTestId(`embeddings-event-row-${oldest}`).click();
    await drawer.getByRole("button", { name: "View Prompts →" }).click();
    await expectCallView(drawer, CALL_TEXTS[0]);

    await drawer.getByRole("button", { name: "← Back to event list" }).click();
    await expect(drawer.locator('[data-testid^="prompts-row-"]')).toHaveCount(callIds.length);
    await expect(drawer.getByTestId(`prompts-row-${oldest}`)).toHaveAttribute("data-focused", "true");
    await expect(drawer.getByTestId("prompts-no-content-for-run")).toHaveCount(0);
  });
});
