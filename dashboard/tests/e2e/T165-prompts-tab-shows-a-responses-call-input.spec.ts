/**
 * T165 — The Prompts tab shows an OpenAI Responses call's stored input
 * and labels its instructions.
 *
 * The sensor stores a Responses call's request as the API's own
 * parameters: ``instructions`` in the content's system slot and
 * ``input`` verbatim (a string or a list of input items), with no
 * ``messages``. Each test posts a capture-on run through ingestion in the
 * sensor's wire shape, its content taken from bodies the live pipeline
 * served (tests/unit/fixtures/responses-content.json), then opens it:
 *
 * - a string input shows as written, under `instructions` rather than
 *   System, in the event drawer and the run drawer;
 * - an item-list input shows one box per item: the message items with
 *   their roles, the function_call with its arguments and the
 *   function_call_output with its result;
 * - a litellm ``text_completion`` shows its prompt under Prompt.
 *
 * Theme-agnostic: test ids and text only, so it runs under both the
 * neon-dark and clean-light theme projects (Rule 40c.3).
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";
import {
  newRun,
  openEventDrawer,
  removeRun,
  contentPostCall,
  seedRun,
  sessionStart,
  storedEvent,
  type Run,
} from "./_tool-content-run";

const FIXTURES = JSON.parse(
  readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../unit/fixtures/responses-content.json"),
    "utf8",
  ),
) as Record<string, Record<string, unknown>>;

/** A served content body as the sensor's wire envelope sends it. */
function wireContent(name: string): Record<string, unknown> {
  const { system_prompt, event_id: _id, session_id: _sid, ...rest } = FIXTURES[name]!;
  return { ...rest, system: system_prompt };
}

test.describe("T165 — the Prompts tab shows a Responses call's input", () => {
  let run: Run;

  test.beforeEach(() => {
    run = newRun("t165", test.info().project.name);
  });

  test.afterEach(() => {
    removeRun(run);
  });

  test("a string input shows as written, under instructions", async ({ page, request }) => {
    const events = await seedRun(request, run, [
      sessionStart(run, true),
      contentPostCall(run, 1, wireContent("responses_string_input")),
    ]);
    const callId = storedEvent(events, "post_call").id;

    const drawer = await openEventDrawer(page, run, callId);
    await drawer.getByTestId("detail-tab-prompts").click();
    const instructions = drawer.getByTestId("prompt-box-instructions");
    await expect(instructions).toBeVisible();
    await expect(instructions).toContainText("instructions");
    await expect(instructions).toContainText("You are terse. Answer in five words or fewer.");
    await expect(drawer.getByTestId("prompt-box-system")).toHaveCount(0);
    await expect(drawer.getByRole("button", { name: /^Instructions/ })).toBeVisible();
    await expect(drawer.getByRole("button", { name: /^System/ })).toHaveCount(0);
    await expect(drawer.getByTestId("prompt-box-input")).toContainText("Name the capital of France.");
    await expect(drawer.getByText("Prompt capture is not enabled for this deployment.")).toHaveCount(0);

    // The run drawer's Prompts list opens the same call.
    await page.goto(`/events?run=${run.sessionId}`);
    const runDrawer = page.getByTestId("session-drawer");
    await expect(runDrawer).toBeVisible();
    await runDrawer.getByTestId("drawer-tab-prompts").click();
    await runDrawer.getByTestId(`prompts-row-${callId}`).click();
    await expect(runDrawer.getByTestId("prompt-box-input")).toContainText("Name the capital of France.");
    await expect(runDrawer.getByTestId("prompt-box-instructions")).toContainText("You are terse.");
  });

  test("an item-list input shows each item, the function call and its output", async ({ page, request }) => {
    const events = await seedRun(request, run, [
      sessionStart(run, true),
      contentPostCall(run, 1, wireContent("responses_function_call_round_trip")),
    ]);
    const drawer = await openEventDrawer(page, run, storedEvent(events, "post_call").id);
    await drawer.getByTestId("detail-tab-prompts").click();

    await expect(drawer.getByRole("button", { name: /^Input\s*\(4\)/ })).toBeVisible();
    await expect(drawer.getByTestId("prompt-box-instructions")).toContainText("You are a weather assistant.");
    const item = (i: number) => drawer.getByTestId(`responses-input-item-${i}`);
    await expect(item(0)).toHaveAttribute("data-item-type", "message");
    await expect(item(0)).toContainText("developer");
    await expect(item(0)).toContainText("Use the weather tool for weather questions.");
    await expect(item(1)).toContainText("user");
    await expect(item(1)).toContainText("What is the weather in Paris?");

    await expect(item(2)).toHaveAttribute("data-item-type", "function_call");
    const call = item(2).getByTestId("responses-function-call");
    await expect(call).toContainText("get_weather");
    await expect(call.getByTestId("kv-label")).toHaveText(["city:"]);
    await expect(call).toContainText("Paris");

    await expect(item(3)).toHaveAttribute("data-item-type", "function_call_output");
    const output = item(3).getByTestId("responses-function-call-output");
    await expect(output.getByTestId("responses-call-id")).toHaveText("call_9IQorB7WiLKDYNXtObQMBB75");
    await expect(output.getByTestId("pretty-json")).toContainText('"temp_c": 18');

    // Raw on an item shows it as stored.
    await drawer.getByTestId("prompt-box-input-2-raw").click();
    await expect(drawer.getByTestId("prompt-box-input-2-raw-json")).toContainText('"type": "function_call"');
    await expect(drawer.getByTestId("prompt-box-input-3")).toHaveAttribute("data-view", "pretty");

    // The Responses tool shows its parameters.
    await expect(drawer.getByTestId("prompt-box-tool-0")).toContainText("city");
  });

  test("a text_completion prompt shows under Prompt", async ({ page, request }) => {
    const prompt = ["The capital of France is", "The capital of Italy is"];
    const events = await seedRun(request, run, [
      sessionStart(run, true),
      contentPostCall(
        run,
        1,
        {
          system: null,
          messages: [],
          tools: null,
          input: prompt,
          response: {
            id: "cmpl-t165",
            object: "text_completion",
            model: "gpt-3.5-turbo-instruct",
            choices: [
              { index: 0, text: " Paris.", finish_reason: "stop" },
              { index: 1, text: " Rome.", finish_reason: "stop" },
            ],
            usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
          },
          provider: "litellm",
          model: "gpt-3.5-turbo-instruct",
          captured_at: new Date().toISOString(),
        },
      ),
    ]);
    const drawer = await openEventDrawer(page, run, storedEvent(events, "post_call").id);
    await drawer.getByTestId("detail-tab-prompts").click();

    await expect(drawer.getByRole("button", { name: /^Prompt\s*\(2\)/ })).toBeVisible();
    await expect(drawer.getByTestId("prompt-box-prompt-0")).toContainText("The capital of France is");
    await expect(drawer.getByTestId("prompt-box-prompt-1")).toContainText("The capital of Italy is");
    await expect(drawer.getByRole("button", { name: /^Input/ })).toHaveCount(0);
    await expect(drawer.getByRole("button", { name: /^System/ })).toHaveCount(0);
  });
});
