/**
 * T188 — From an embeddings event to its input in the Prompts tab.
 *
 * Fixture: an agent of this spec run's own (``createPrivateAgent``), two
 * runs, and on each one ``embeddings`` call posted through ingestion in
 * the sensor's wire shape with its content captured (the request's
 * ``input`` as sent, ``response`` ``{}`` and the vectors in
 * ``embedding_output``, as the sensor stores them) and its
 * ``output_dimensions``: an OpenAI call with two texts, and a
 * google-genai ``embed_content`` call whose contents are the Gemini
 * API's ``Content`` objects. Neither run stores any other content.
 *
 * Three ways in, each landing on the input: the event drawer's Prompts
 * tab (from the event's deep link on /events); the run drawer's "View
 * Prompts →" on the call's expanded row; and the run drawer's full
 * detail of that row, then its Prompts tab. The input shows under the
 * provider's name for it (Input, or Contents for google-genai), drawn
 * as the expanded row draws it, its JSON view the stored input; the
 * response is the event's output_dimensions, never ``{}`` nor a vector.
 *
 * Theme-agnostic: test ids and text only, so it runs under both the
 * neon-dark and clean-light theme projects (Rule 40c.3).
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
import {
  createPrivateAgent,
  endPrivateAgent,
  postPrivateEmbeddings,
  startPrivateAgent,
  type PrivateAgent,
} from "./_fixtures";

const TEXTS = ["Tide tables for the harbour T188-ONE", "Ferry times on Sunday T188-TWO"];
const VECTORS = [
  [0.0188123, -0.0188456, 0.0188789],
  [0.0188321, -0.0188654, 0.0188987],
];

const OPENAI_CALL = { client_type: "flightdeck_sensor", framework: null, model: "text-embedding-3-small", provider: "openai" };
const GOOGLE_CALL = { client_type: "flightdeck_sensor", framework: null, model: "gemini-embedding-001", provider: "google" };

/** An embeddings call's content as the sensor stores it. */
function stored(provider: string, model: string, input: unknown): Record<string, unknown> {
  return {
    provider,
    model,
    system: null,
    messages: [],
    tools: null,
    response: {},
    input,
    embedding_output: VECTORS,
    captured_at: new Date().toISOString(),
  };
}

const GEMINI_CONTENTS = TEXTS.map((text) => ({ parts: [{ text }], role: "user" }));

/** The embeddings view's input box, settled. */
async function inputBox(root: Locator): Promise<Locator> {
  await expect(root.getByTestId("prompt-viewer-embeddings")).toBeVisible();
  const box = root.getByTestId("prompt-box-embeddings-input");
  await expect(box.getByTestId("embeddings-content-viewer")).toBeVisible();
  return box;
}

/** The two OpenAI texts, behind their count, then opened; the JSON view
 *  is the stored input; the response is the output_dimensions. */
async function expectOpenAIInput(root: Locator): Promise<void> {
  await expect(root.getByRole("button", { name: "Input", exact: true })).toBeVisible();
  const box = await inputBox(root);
  await expect(box.getByTestId("embeddings-content-viewer")).toHaveAttribute("data-state", "list");
  await expect(box.getByTestId("embeddings-content-state-list")).toHaveText("2 inputs");
  await box.getByTestId("embeddings-content-toggle").click();
  await expect(box.getByTestId("embeddings-content-list-item-0")).toHaveText(TEXTS[0]!);
  await expect(box.getByTestId("embeddings-content-list-item-1")).toHaveText(TEXTS[1]!);

  await box.getByTestId("prompt-box-embeddings-input-json").click();
  await expect(box.getByTestId("prompt-box-embeddings-input-json-view")).toHaveText(JSON.stringify(TEXTS, null, 2));

  await expectDimensions(root, 2, 3);
}

async function expectDimensions(root: Locator, count: number, dimension: number): Promise<void> {
  const output = root.getByTestId("prompt-box-embeddings-output");
  await expect(output.getByTestId("embeddings-output-dimensions")).toContainText(`count:${count}`);
  await expect(output.getByTestId("embeddings-output-dimensions")).toContainText(`dimension:${dimension}`);
  // Never the stored {} response, never a vector.
  await expect(root.getByTestId("prompt-box-response")).toHaveCount(0);
  await expect(root).not.toContainText("0.0188");
}

/** The run drawer on the run, its embeddings row expanded. */
async function expandRow(page: Page, sessionId: string, eventId: string): Promise<Locator> {
  await page.goto(`/events?run=${sessionId}`);
  const drawer = page.getByTestId("session-drawer");
  await expect(drawer).toBeVisible();
  const row = drawer.getByTestId(`embeddings-event-row-${eventId}`);
  await expect(row).toBeVisible();
  await row.click();
  return drawer;
}

test.describe("T188 — from an embeddings event to its input in the Prompts tab", () => {
  let agent: PrivateAgent | undefined;

  test.afterEach(async ({ page }) => {
    if (agent) await endPrivateAgent(page, agent);
  });

  async function start(page: Page): Promise<{ openai: string; google: string; agent: PrivateAgent }> {
    agent = createPrivateAgent("t188-embeddings", 2);
    await startPrivateAgent(page, agent);
    const openai = await postPrivateEmbeddings(page, agent, agent.sessionIds[0]!, stored("openai", OPENAI_CALL.model, TEXTS), {
      ...OPENAI_CALL,
      output_dimensions: { count: 2, dimension: 3 },
    });
    const google = await postPrivateEmbeddings(
      page,
      agent,
      agent.sessionIds[1]!,
      stored("google", GOOGLE_CALL.model, GEMINI_CONTENTS),
      { ...GOOGLE_CALL, output_dimensions: { count: 2, dimension: 3 } },
    );
    return { openai, google, agent };
  }

  test("the event drawer's Prompts tab shows the input, under Input", async ({ page }) => {
    const { openai, agent: a } = await start(page);
    await page.goto(`/events?event=${openai}&event_session=${a.sessionIds[0]}`);
    const drawer = page.getByTestId("event-detail-drawer");
    await expect(drawer).toBeVisible();
    await drawer.getByTestId("detail-tab-prompts").click();
    await expectOpenAIInput(drawer);
  });

  test("the run drawer's View Prompts → shows a Gemini call's contents, in a run with no other content", async ({
    page,
  }) => {
    const { google, agent: a } = await start(page);
    const drawer = await expandRow(page, a.sessionIds[1]!, google);
    await drawer.getByRole("button", { name: "View Prompts →" }).click();

    await expect(drawer.getByRole("button", { name: "Contents", exact: true })).toBeVisible();
    const box = await inputBox(drawer);
    // The Gemini API's Content objects are shown as their JSON, as the
    // expanded row shows them, and not as a generate call.
    await expect(box.getByTestId("embeddings-content-viewer")).toHaveAttribute("data-state", "json");
    await expect(box.getByTestId("embeddings-content-state-json")).toContainText(TEXTS[1]!);
    await expect(drawer.getByTestId("prompt-viewer-gemini")).toHaveCount(0);
    await expect(drawer.getByTestId("prompts-no-content-for-run")).toHaveCount(0);
    await expectDimensions(drawer, 2, 3);
  });

  test("the run drawer's full detail of the row shows the input in its Prompts tab", async ({ page }) => {
    const { openai, agent: a } = await start(page);
    const drawer = await expandRow(page, a.sessionIds[0]!, openai);
    await drawer.getByTestId("open-full-detail").click();
    await drawer.getByTestId("detail-tab-prompts").click();
    await expectOpenAIInput(drawer);
  });
});
