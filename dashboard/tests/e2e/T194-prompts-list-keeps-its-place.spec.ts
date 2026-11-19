/**
 * T194 — The run drawer's Prompts list keeps its place.
 *
 * Fixture: an agent of this spec run's own (``createPrivateAgent``), one
 * run, and on it forty OpenAI ``embeddings`` calls posted through
 * ingestion with their content captured: enough rows that both the
 * Timeline and the Prompts list scroll in the drawer.
 *
 * The drawer's tabs share one scroll container. Opening the Prompts tab
 * after scrolling the Timeline shows the list at its top, and each tab
 * comes back where it was left. "← Back to event list" after opening a
 * call far down the list returns the list to where it was, that call's
 * row in view and holding keyboard focus.
 *
 * Theme-agnostic: test ids, roles and scroll offsets only, so it runs
 * under both the neon-dark and clean-light theme projects (Rule 40c.3).
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
import {
  createPrivateAgent,
  endPrivateAgent,
  postPrivateEmbeddings,
  startPrivateAgent,
  type PrivateAgent,
} from "./_fixtures";

/** Calls on the run: rows enough for the list and the Timeline to scroll. */
const CALLS = 40;
/** The list row the Back journey opens: far enough down to need a scroll. */
const OPENED_ROW = 30;
/** Where the Timeline and the list are scrolled to before a tab switch. */
const TIMELINE_OFFSET = 600;
const LIST_OFFSET = 400;
const MODEL = "text-embedding-3-small";
const CALL = { client_type: "flightdeck_sensor", framework: null, model: MODEL, provider: "openai" };

function stored(text: string): Record<string, unknown> {
  return {
    provider: "openai",
    model: MODEL,
    system: null,
    messages: [],
    tools: null,
    response: {},
    input: [text],
    embedding_output: [[0.0194, -0.0194, 0.0194]],
    captured_at: new Date().toISOString(),
  };
}

/** Scroll the drawer's tab content to ``top``, wait two frames so the
 *  scroll event has been handled, and return where it landed. */
async function scrollContent(content: Locator, top: number): Promise<number> {
  return content.evaluate(async (el, to) => {
    el.scrollTop = to;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    return el.scrollTop;
  }, top);
}

function scrollTopOf(content: Locator): Promise<number> {
  return content.evaluate((el) => el.scrollTop);
}

async function openRun(page: Page, sessionId: string): Promise<Locator> {
  await page.goto(`/events?run=${sessionId}`);
  const drawer = page.getByTestId("session-drawer");
  await expect(drawer).toBeVisible();
  await expect(drawer.locator("[data-event-id]")).toHaveCount(CALLS + 1);
  return drawer;
}

test.describe("T194 — the run drawer's Prompts list keeps its place", () => {
  let agent: PrivateAgent | undefined;

  test.afterEach(async ({ page }) => {
    if (agent) await endPrivateAgent(page, agent);
  });

  async function start(page: Page): Promise<string> {
    agent = createPrivateAgent("t194-prompts-place", 1);
    await startPrivateAgent(page, agent);
    const sessionId = agent.sessionIds[0]!;
    for (let i = 1; i <= CALLS; i++) {
      await postPrivateEmbeddings(page, agent, sessionId, stored(`Passage T194-${i}`), {
        ...CALL,
        output_dimensions: { count: 1, dimension: 3 },
      });
    }
    return sessionId;
  }

  test("the Prompts tab opens at its own top after the Timeline was scrolled, and each tab comes back where it was left", async ({
    page,
  }) => {
    const drawer = await openRun(page, await start(page));
    const content = drawer.getByTestId("session-drawer-tab-content");
    const timelineAt = await scrollContent(content, TIMELINE_OFFSET);
    expect(timelineAt).toBeGreaterThan(0);

    await drawer.getByTestId("drawer-tab-prompts").click();
    await expect(drawer.locator('[data-testid^="prompts-row-"]')).toHaveCount(CALLS);
    await expect.poll(() => scrollTopOf(content)).toBe(0);
    const listAt = await scrollContent(content, LIST_OFFSET);
    expect(listAt).toBeGreaterThan(0);

    await drawer.getByTestId("drawer-tab-timeline").click();
    await expect(drawer.getByTestId("session-event-feed")).toBeVisible();
    await expect.poll(() => scrollTopOf(content)).toBe(timelineAt);

    await drawer.getByTestId("drawer-tab-prompts").click();
    await expect(drawer.locator('[data-testid^="prompts-row-"]')).toHaveCount(CALLS);
    await expect.poll(() => scrollTopOf(content)).toBe(listAt);
  });

  test("Back from a call opened far down the list returns to it, in view and focused", async ({ page }) => {
    const drawer = await openRun(page, await start(page));
    const content = drawer.getByTestId("session-drawer-tab-content");
    await drawer.getByTestId("drawer-tab-prompts").click();
    const rows = drawer.locator('[data-testid^="prompts-row-"]');
    await expect(rows).toHaveCount(CALLS);

    const row = rows.nth(OPENED_ROW);
    await row.scrollIntoViewIfNeeded();
    const listAt = await scrollContent(content, await scrollTopOf(content));
    expect(listAt).toBeGreaterThan(0);
    const rowId = await row.getAttribute("data-testid");

    await row.click();
    await expect(drawer.getByTestId("prompt-viewer-embeddings")).toBeVisible();
    // The call opens at its top: its Back button is in view.
    const back = drawer.getByRole("button", { name: "← Back to event list" });
    await expect(back).toBeInViewport();

    await back.click();
    const opened = drawer.getByTestId(rowId!);
    await expect(opened).toBeVisible();
    await expect.poll(() => scrollTopOf(content)).toBe(listAt);
    await expect(opened).toBeInViewport();
    await expect(opened).toBeFocused();
  });
});
