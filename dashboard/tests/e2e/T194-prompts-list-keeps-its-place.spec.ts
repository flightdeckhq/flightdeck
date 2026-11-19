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
 * comes back where it was left, also after a "View Prompts →" round trip
 * (the highlighted row is brought into view when the user arrives for
 * it, not on every return to the tab). "← Back to event list" after
 * opening a call far down the list returns to THAT row: where it was,
 * in view and holding keyboard focus, also when new calls arrived at the
 * top of the list while the call was open (on Fleet, whose live stream
 * feeds the drawer).
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
  waitForFleetReady,
  type PrivateAgent,
} from "./_fixtures";
import { DISABLE_KEEPALIVE_WS_STORAGE_KEY } from "../../src/lib/constants";

/** Calls on the run: rows enough for the list and the Timeline to scroll. */
const CALLS = 40;
/** Calls that arrive while a call is open. */
const ARRIVING = 5;
/** The list row the Back journey opens: far enough down to need a scroll. */
const OPENED_ROW = 30;
/** Where the Timeline and the list are scrolled to before a tab switch. */
const TIMELINE_OFFSET = 600;
const LIST_OFFSET = 400;
/** Where the list is left after a "View Prompts →" round trip. */
const ROUND_TRIP_OFFSET = 700;
/** Frames the tab content must hold still to count as settled: a smooth
 *  scroll moves it every frame until it ends. */
const STILL_FRAMES = 10;
/** The most frames to wait for it to settle. */
const MAX_FRAMES = 240;
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

/** The tab content's offset once it has held still for STILL_FRAMES
 *  frames (any smooth scroll it was given has ended). */
function settledScrollTop(content: Locator): Promise<number> {
  return content.evaluate(
    (el, { still, max }) =>
      new Promise<number>((resolve) => {
        let last = el.scrollTop;
        let quiet = 0;
        let frames = 0;
        const tick = () => {
          frames += 1;
          quiet = el.scrollTop === last ? quiet + 1 : 0;
          last = el.scrollTop;
          if (quiet >= still || frames >= max) resolve(last);
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    { still: STILL_FRAMES, max: MAX_FRAMES },
  );
}

/** ``row``'s distance from the top of the tab content's view. */
async function offsetOf(content: Locator, row: Locator): Promise<number> {
  const view = await content.elementHandle();
  return row.evaluate(
    (el, v) => Math.round(el.getBoundingClientRect().top - (v as Element).getBoundingClientRect().top),
    view,
  );
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
    for (let i = 1; i <= CALLS; i++) await post(page, sessionId, i);
    return sessionId;
  }

  async function post(page: Page, sessionId: string, i: number): Promise<string> {
    return postPrivateEmbeddings(page, agent!, sessionId, stored(`Passage T194-${i}`), {
      ...CALL,
      output_dimensions: { count: 1, dimension: 3 },
    });
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

  test("after a View Prompts → round trip, a plain return to the Prompts tab keeps the list where it was left", async ({
    page,
  }) => {
    const drawer = await openRun(page, await start(page));
    const content = drawer.getByTestId("session-drawer-tab-content");
    // The newest call: its row is at the list's top, far from where the
    // list is then left.
    await drawer.locator('[data-testid^="embeddings-event-row-"]').first().click();
    await drawer.getByRole("button", { name: "View Prompts →" }).click();
    await expect(drawer.getByTestId("prompt-viewer-embeddings")).toBeVisible();
    await drawer.getByRole("button", { name: "← Back to event list" }).click();
    await expect(drawer.locator('[data-testid^="prompts-row-"][data-focused="true"]')).toBeFocused();
    await settledScrollTop(content);

    const listAt = await scrollContent(content, ROUND_TRIP_OFFSET);
    expect(listAt).toBeGreaterThan(0);
    await drawer.getByTestId("drawer-tab-timeline").click();
    await expect(drawer.getByTestId("session-event-feed")).toBeVisible();
    await drawer.getByTestId("drawer-tab-prompts").click();
    await expect(drawer.locator('[data-testid^="prompts-row-"]')).toHaveCount(CALLS);
    expect(await settledScrollTop(content)).toBe(listAt);
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

  test("calls that arrive while a call is open: Back returns to that call's row, where it was, in view and focused", async ({
    page,
  }) => {
    // The live stream feeds the drawer new calls: drop the keep-alive
    // flag the project's storage state sets, before the app reads it.
    await page.addInitScript((key) => {
      window.localStorage.removeItem(key);
    }, DISABLE_KEEPALIVE_WS_STORAGE_KEY);
    const sessionId = await start(page);
    await page.goto("/");
    await waitForFleetReady(page);

    // A call made now reaches the Live feed; its event drawer opens the run.
    await post(page, sessionId, CALLS + 1);
    // By its run's short id: both theme projects' agents share the flavor.
    const feedRow = page
      .locator('[data-testid="feed-row"]')
      .filter({ has: page.getByTestId("feed-session-id").filter({ hasText: sessionId.slice(0, 8) }) })
      .first();
    await feedRow.click();
    await page.getByTestId("event-detail-view-run").click();
    const drawer = page.locator(`[data-testid="session-drawer"][data-session-id="${sessionId}"]`);
    await expect(drawer).toBeVisible();
    const content = drawer.getByTestId("session-drawer-tab-content");

    await drawer.getByTestId("drawer-tab-prompts").click();
    const rows = drawer.locator('[data-testid^="prompts-row-"]');
    await expect(rows).toHaveCount(CALLS + 1);
    const row = rows.nth(OPENED_ROW);
    await row.scrollIntoViewIfNeeded();
    await scrollContent(content, await scrollTopOf(content));
    const rowAt = await offsetOf(content, row);
    const rowId = await row.getAttribute("data-testid");
    await row.click();
    await expect(drawer.getByTestId("prompt-viewer-embeddings")).toBeVisible();

    // New calls arrive at the top of the list while the call is open; the
    // Timeline shows when the drawer has them, and the call stays open.
    for (let i = 1; i <= ARRIVING; i++) await post(page, sessionId, CALLS + 1 + i);
    await drawer.getByTestId("drawer-tab-timeline").click();
    await expect(drawer.locator("[data-event-id]")).toHaveCount(1 + CALLS + 1 + ARRIVING);
    await drawer.getByTestId("drawer-tab-prompts").click();
    await expect(drawer.getByTestId("prompt-viewer-embeddings")).toBeVisible();

    await drawer.getByRole("button", { name: "← Back to event list" }).click();
    await expect(rows).toHaveCount(CALLS + 1 + ARRIVING);
    const opened = drawer.getByTestId(rowId!);
    await expect(opened).toBeInViewport();
    await expect(opened).toBeFocused();
    await expect.poll(() => offsetOf(content, opened)).toBe(rowAt);
  });
});
