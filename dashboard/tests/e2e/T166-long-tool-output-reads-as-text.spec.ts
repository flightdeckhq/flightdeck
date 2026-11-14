/**
 * T166 — A long tool output reads as text in the Prompts tab.
 *
 * The Claude Code plugin stores a tool_call's result as a tool_result
 * block whose content is the response's JSON text, kept within 2000
 * characters. Each test posts a capture-on plugin run through ingestion
 * with a Bash call whose stdout is far over that bound, then opens the
 * call's Prompts tab in the event drawer:
 *
 * - in the form the plugin stores now (cut inside the structure, so the
 *   text is JSON; the cut stdout ends with "…" and the tool_result block
 *   names it, `truncated: ["/stdout"]`, beside the content; the cut
 *   command of the input likewise on the tool_use block), Pretty shows
 *   stdout as terminal text with its line breaks, stderr and the other
 *   fields, and which fields were cut;
 * - in the form earlier plugin versions stored (the JSON text cut at
 *   2000 characters with "…" appended), Pretty reads the fields up to
 *   the cut and says where the stored text ends;
 * - Raw shows the stored tool_result in both: its content as the stored
 *   string, and the block's list beside it.
 *
 * Theme-agnostic: test ids and text only, so it runs under both the
 * neon-dark and clean-light theme projects (Rule 40c.3).
 */
import { test, expect, type Locator } from "@playwright/test";
import {
  newRun,
  openEventDrawer,
  pluginSessionStart,
  pluginToolCall,
  removeRun,
  seedRun,
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

/** What the plugin stores now: stdout cut so the whole JSON fits, marked;
 *  the block names it in `truncated`. Nothing is added inside the response. */
function storedNow(): string {
  // ASCII only, so a character is one UTF-16 unit.
  let kept = OUTPUT_MAX_CHARS;
  let text = "";
  do {
    kept -= 1;
    text = JSON.stringify({ ...BASH_RESPONSE, stdout: STDOUT.slice(0, kept) + CUT_MARK });
  } while (text.length > OUTPUT_MAX_CHARS);
  return text;
}

/** What earlier plugin versions stored: the JSON text cut mid-way. */
const STORED_BEFORE = JSON.stringify(BASH_RESPONSE).slice(0, OUTPUT_MAX_CHARS) + CUT_MARK;

/** A command over the plugin's 200-character input bound, cut; the
 *  tool_use block names it. */
const LONG_COMMAND = `go test ./api/internal/store/... -run 'TestStoreEvents' -v -count=1 2>&1 | ${"tee -a /tmp/store-test.log | ".repeat(8)}tail -n 400`;
const CUT_INPUT = { command: LONG_COMMAND.slice(0, 200) + CUT_MARK };

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

  test("the output the plugin stores now: stdout as text, the cut fields named, Raw as stored", async ({
    page,
    request,
  }) => {
    const stored = storedNow();
    expect(Object.keys(JSON.parse(stored))).toEqual(Object.keys(BASH_RESPONSE));
    const events = await seedRun(request, run, [
      pluginSessionStart(run),
      pluginToolCall(run, 1, "Bash", CUT_INPUT, stored, { input: ["/command"], output: ["/stdout"] }),
    ]);
    const drawer = await openPrompts(page, run, storedEvent(events, "tool_call").id);

    const response = drawer.getByTestId("prompt-box-response");
    const result = response.getByTestId("tool-result-parsed");
    await expect(result).toBeVisible();
    await expectTerminalText(result.getByTestId("tool-result-stdout"));
    await expect(result.getByTestId("tool-result-stderr")).toContainText(STDERR);
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
});
