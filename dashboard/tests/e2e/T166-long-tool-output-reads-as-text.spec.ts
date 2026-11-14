/**
 * T166 — A long tool output reads as text in the Prompts tab.
 *
 * The Claude Code plugin stores a tool_call's result as a tool_result
 * block whose content is the response's JSON text, kept within 2000
 * characters. Each test posts a capture-on plugin run through ingestion
 * with a Bash call whose stdout is far over that bound, then opens the
 * call's Prompts tab in the event drawer:
 *
 * - the call the plugin builds now, made by the plugin's own
 *   buildToolCallPayload from a PostToolUse hook (the cut stdout ends
 *   with "…" and the tool_result block names it, `["/stdout"]`, beside
 *   the content; the cut command likewise on the tool_use block): Pretty
 *   shows stdout as terminal text with its line breaks, scrolling in a
 *   focusable region, stderr and the other fields, and what was cut;
 * - in the form earlier plugin versions stored (the JSON text cut at
 *   2000 characters with "…" appended), Pretty reads the fields up to
 *   the cut and says where the stored text ends;
 * - Raw shows the stored tool_result in both: its content as the stored
 *   string, and the block's list beside it;
 * - only the plugin wrote that earlier form: a tool_result in an
 *   Anthropic call's messages, reported by the sensor, whose text
 *   happens to end with "…" is shown as stored.
 *
 * Theme-agnostic: test ids and text only, so it runs under both the
 * neon-dark and clean-light theme projects (Rule 40c.3).
 */
import { test, expect, type Locator } from "@playwright/test";
import {
  anthropicPostCall,
  newRun,
  openEventDrawer,
  pluginHookToolCall,
  pluginSessionStart,
  pluginToolCall,
  removeRun,
  seedRun,
  sessionStart,
  storedEvent,
  type Run,
} from "./_tool-content-run";

/** The plugin's bound on a stored tool output, and its cut mark. */
const OUTPUT_MAX_CHARS = 2000;
const CUT_MARK = "…";

const STDOUT = Array.from(
  { length: 120 },
  (_, i) => `=== RUN   TestStoreEvents/case_${i}\n--- PASS: TestStoreEvents/case_${i} (0.00s)`,
).join("\n");
const STDERR = "go: downloading golang.org/x/sync v0.8.0";
const BASH_RESPONSE = { stdout: STDOUT, stderr: STDERR, interrupted: false, isImage: false, noOutputExpected: false };

/** What earlier plugin versions stored: the JSON text cut mid-way. */
const STORED_BEFORE = JSON.stringify(BASH_RESPONSE).slice(0, OUTPUT_MAX_CHARS) + CUT_MARK;

/** A command over the plugin's 200-character input bound. */
const LONG_COMMAND = `go test ./api/internal/store/... -run 'TestStoreEvents' -v -count=1 2>&1 | ${"tee -a /tmp/store-test.log | ".repeat(8)}tail -n 400`;

async function openPrompts(page: import("@playwright/test").Page, run: Run, eventId: string): Promise<Locator> {
  const drawer = await openEventDrawer(page, run, eventId);
  await drawer.getByTestId("detail-tab-prompts").click();
  await expect(drawer.getByTestId("prompt-box-response")).toHaveAttribute("data-view", "pretty");
  return drawer;
}

/** The stdout block's text keeps its line breaks and no JSON escapes. */
async function expectTerminalText(stdout: Locator): Promise<void> {
  await expect(stdout).toContainText("--- PASS: TestStoreEvents/case_0 (0.00s)");
  const text = await stdout.locator("pre").textContent();
  expect(text, "stdout reads as lines").not.toBeNull();
  expect(text!.split("\n").length, "stdout keeps its line breaks").toBeGreaterThan(20);
  expect(text, "no escaped line breaks").not.toContain("\\n");
  expect(text, "not the JSON text").not.toContain('{"stdout"');
}

test.describe("T166 — a long tool output reads as text in the Prompts tab", () => {
  let run: Run;

  test.beforeEach(() => {
    run = newRun("t166", test.info().project.name);
  });

  test.afterEach(() => {
    removeRun(run);
  });

  test("the call the plugin builds now: stdout as text, the cut values named, Raw as stored", async ({
    page,
    request,
  }) => {
    const call = pluginHookToolCall(run, 1, {
      tool_name: "Bash",
      tool_input: { command: LONG_COMMAND, description: "Run the store tests" },
      tool_response: BASH_RESPONSE,
    });
    // What the plugin built: both cuts named on their blocks, nothing
    // added inside the input or the response.
    const content = call.content as { tools: Array<Record<string, unknown>>; response: Array<Record<string, unknown>> };
    expect(content.tools[0]!.truncated).toEqual(["/command"]);
    expect(content.response[0]!.truncated).toEqual(["/stdout"]);
    expect(Object.keys(JSON.parse(String(content.response[0]!.content)))).toEqual(Object.keys(BASH_RESPONSE));
    expect(String(content.response[0]!.content).length).toBeLessThanOrEqual(OUTPUT_MAX_CHARS);
    const events = await seedRun(request, run, [pluginSessionStart(run), call]);
    const drawer = await openPrompts(page, run, storedEvent(events, "tool_call").id);

    const response = drawer.getByTestId("prompt-box-response");
    const result = response.getByTestId("tool-result-parsed");
    await expect(result).toBeVisible();
    await expectTerminalText(result.getByTestId("tool-result-stdout"));
    await expect(result.getByTestId("tool-result-stderr")).toContainText(STDERR);
    // The long stdout scrolls in its box, so it is a focusable region;
    // the one-line stderr fits and stays out of the tab order.
    const stdoutRegion = result.getByRole("region", { name: "stdout" });
    await expect(stdoutRegion).toHaveAttribute("tabindex", "0");
    await stdoutRegion.focus();
    await expect(stdoutRegion).toBeFocused();
    await expect(result.getByTestId("tool-result-stderr").locator("pre")).not.toHaveAttribute("tabindex");
    const scalars = result.getByTestId("tool-result-scalars");
    await expect(scalars).toContainText("interrupted:");
    await expect(scalars).toContainText("noOutputExpected:");
    await expect(result.getByTestId("tool-result-truncated")).toContainText(/stdout cut at [\d,]+ characters/);
    // The fields are the tool's own: the list is on the block, not among them.
    await expect(result.getByTestId("kv-label").filter({ hasText: /^truncated/ })).toHaveCount(0);

    // The cut command shows how much it kept.
    const tool = drawer.getByTestId("prompt-box-tool-0");
    await expect(tool.getByTestId("tool-use-input")).toContainText(LONG_COMMAND.slice(0, 60));
    await expect(tool.getByTestId("cut-note")).toHaveText("cut at 200 characters");
    await expect(tool.getByTestId("kv-label")).toHaveText(["command"]);

    // Raw is the stored tool_result: its content is the stored string,
    // and the list sits beside it on the block.
    await drawer.getByTestId("prompt-box-response-raw").click();
    await expect(response).toHaveAttribute("data-view", "raw");
    const raw = drawer.getByTestId("prompt-box-response-raw-json");
    await expect(raw).toContainText('"type": "tool_result"');
    await expect(raw).toContainText('"content": "{\\"stdout\\":\\"=== RUN');
    await expect(raw).toContainText(/"truncated": \[\s*"\/stdout"\s*\]/);
    await expect(raw).not.toContainText('\\"truncated\\"');
    await expect(response.getByTestId("tool-result-parsed")).toHaveCount(0);
  });

  test("an output an earlier plugin version stored cut mid-way: read up to the cut, Raw as stored", async ({
    page,
    request,
  }) => {
    const events = await seedRun(request, run, [
      pluginSessionStart(run),
      pluginToolCall(run, 1, "Bash", { command: "go test ./api/internal/store/... -v" }, STORED_BEFORE),
    ]);
    const drawer = await openPrompts(page, run, storedEvent(events, "tool_call").id);

    const response = drawer.getByTestId("prompt-box-response");
    const result = response.getByTestId("tool-result-recovered");
    await expect(result).toBeVisible();
    await expectTerminalText(result.getByTestId("tool-result-stdout"));
    // The stored text ended inside stdout: nothing after it was stored.
    await expect(result.getByTestId("tool-result-stderr")).toHaveCount(0);
    await expect(result.getByTestId("tool-result-truncated")).toHaveText(
      /stored output ends at 2,000 characters, inside stdout/,
    );
    await expect(response.getByTestId("tool-result-raw")).toHaveCount(0);
    // An input with no cut list shows no cut note.
    await expect(drawer.getByTestId("prompt-box-tool-0").getByTestId("cut-note")).toHaveCount(0);

    await drawer.getByTestId("prompt-box-response-raw").click();
    const raw = drawer.getByTestId("prompt-box-response-raw-json");
    await expect(raw).toContainText('"content": "{\\"stdout\\":\\"=== RUN');
    await expect(raw).toContainText(`${CUT_MARK}"`);
    await expect(response.getByTestId("tool-result-recovered")).toHaveCount(0);
  });

  test("a provider's tool_result that ends with … is shown as stored, not read as the plugin's cut", async ({
    page,
    request,
  }) => {
    const events = await seedRun(request, run, [
      sessionStart(run, true),
      anthropicPostCall(run, 1, {
        system: "You run the tests.",
        messages: [
          { role: "user", content: "Run the store tests." },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_t166", content: STORED_BEFORE }] },
        ],
        tools: null,
        response: { id: "msg_t166", type: "message", role: "assistant", content: [{ type: "text", text: "They pass." }] },
      }),
    ]);
    const drawer = await openEventDrawer(page, run, storedEvent(events, "post_call").id);
    await drawer.getByTestId("detail-tab-prompts").click();
    const message = drawer.getByTestId("prompt-box-message-1");
    await expect(message).toHaveAttribute("data-view", "pretty");
    await expect(message.getByTestId("tool-result-raw")).toContainText('{"stdout":"=== RUN');
    await expect(message.getByTestId("tool-result-recovered")).toHaveCount(0);
    await expect(message.getByText(/the stored output ends at/)).toHaveCount(0);
  });
});
