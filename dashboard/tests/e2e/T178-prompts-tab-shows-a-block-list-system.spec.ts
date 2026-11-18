/**
 * T178 — The Prompts tab shows an Anthropic call whose ``system`` is a
 * list of content blocks.
 *
 * The form prompt caching uses: ``system=[{type: "text", text,
 * cache_control}, ...]``. The run posts a capture-on Anthropic
 * ``post_call`` through ingestion in the sensor's wire shape with that
 * list as its ``system``; the worker stores the list as it was sent and
 * the content endpoint serves it as ``system_prompt``. Opened in the
 * event drawer, the System box shows each block's text (not the blocks'
 * JSON) beside the call's messages, the block carrying ``cache_control``
 * marked under it, and JSON shows the list as stored, ``cache_control``
 * included. A run whose ``system`` is text shows that text as it always
 * has, with no mark.
 *
 * Theme-agnostic: test ids and text only, so it runs under both the
 * neon-dark and clean-light theme projects (Rule 40c.3).
 */
import { test, expect } from "@playwright/test";
import {
  anthropicPostCall,
  newRun,
  openEventDrawer,
  removeRun,
  seedRun,
  sessionStart,
  storedEvent,
  type Run,
} from "./_tool-content-run";

const FIRST_BLOCK = "You are a terse geography assistant. T178-SYSTEM-BLOCK-ONE";
const SECOND_BLOCK = "Answer in one word. T178-SYSTEM-BLOCK-TWO";
const SYSTEM_BLOCKS = [
  { type: "text", text: FIRST_BLOCK, cache_control: { type: "ephemeral" } },
  { type: "text", text: SECOND_BLOCK },
];

const callContent = (system: unknown) => ({
  system,
  messages: [{ role: "user", content: "Capital of France? T178-USER" }],
  tools: null,
  response: {
    id: "msg_t178",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-5",
    content: [{ type: "text", text: "Paris. T178-RESPONSE" }],
    stop_reason: "end_turn",
  },
  captured_at: new Date().toISOString(),
});

test.describe("T178 — the Prompts tab shows a block-list system", () => {
  let run: Run;

  test.beforeEach(() => {
    run = newRun("t178", test.info().project.name);
  });

  test.afterEach(() => {
    removeRun(run);
  });

  test("each block's text shows under System, and JSON keeps the list", async ({ page, request }) => {
    const events = await seedRun(request, run, [
      sessionStart(run, true),
      anthropicPostCall(run, 1, callContent(SYSTEM_BLOCKS)),
    ]);
    const call = storedEvent(events, "post_call");
    expect(call.has_content, "the call was stored without its content").toBe(true);

    const drawer = await openEventDrawer(page, run, call.id);
    await drawer.getByTestId("detail-tab-prompts").click();
    const system = drawer.getByTestId("prompt-box-system");
    await expect(system).toBeVisible();
    await expect(system).toContainText(FIRST_BLOCK);
    await expect(system).toContainText(SECOND_BLOCK);
    await expect(system).not.toContainText('"type"');
    await expect(drawer.getByTestId("prompt-box-message-0")).toContainText("T178-USER");
    await expect(drawer.getByTestId("prompt-box-response")).toContainText("T178-RESPONSE");
    await expect(drawer.getByText("No content was recorded for this event")).toHaveCount(0);
    // The block carrying cache_control is marked, and only that block.
    const marks = system.getByTestId("content-block-cache-control");
    await expect(marks).toHaveCount(1);
    await expect(marks).toHaveText("cache_control · ephemeral");
    await expect(system.getByTestId("content-block-cached")).toContainText(FIRST_BLOCK);

    await drawer.getByTestId("prompt-box-system-json").click();
    const raw = drawer.getByTestId("prompt-box-system-json-view");
    await expect(raw).toContainText('"cache_control"');
    await expect(raw).toContainText('"ephemeral"');
    await expect(raw).toContainText("T178-SYSTEM-BLOCK-TWO");
  });

  test("a text system shows as written", async ({ page, request }) => {
    const text = "You are a terse geography assistant. T178-SYSTEM-TEXT";
    const events = await seedRun(request, run, [
      sessionStart(run, true),
      anthropicPostCall(run, 1, callContent(text)),
    ]);
    const drawer = await openEventDrawer(page, run, storedEvent(events, "post_call").id);
    await drawer.getByTestId("detail-tab-prompts").click();
    const system = drawer.getByTestId("prompt-box-system");
    await expect(system).toHaveText(new RegExp(`${text}$`));
    await expect(system.getByTestId("content-block-cache-control")).toHaveCount(0);
    await drawer.getByTestId("prompt-box-system-json").click();
    await expect(drawer.getByTestId("prompt-box-system-json-view")).toHaveText(`"${text}"`);
  });
});
