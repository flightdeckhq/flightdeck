// A tool input over its bound is cut, and the cut is marked: the value
// ends with "…" and the tool_use content block lists it in
// ``truncated``, beside the input and never inside it, as a JSON
// Pointer relative to the input, so the dashboard never shows a command
// cut mid-way as if it were the whole command, and the list never reads
// as one of the tool's arguments. The bounds themselves
// (claude_code/tools.mjs) are privacy and size bounds and stay.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { CUT_MARK, cutChars, jsonPointer, withTruncated } from "../hooks/scripts/core/cut.mjs";
import {
  buildToolCallPayload,
  sanitizeToolInput,
  TOOL_INPUT_CUT_MARK,
  TOOL_INPUT_PROMPT_MAX_CHARS,
  TOOL_INPUT_TEXT_MAX_CHARS,
} from "../hooks/scripts/claude_code/tools.mjs";
import { assertIngestionContract, hookEnv, pollUntil, privateTmp, runScript, startCaptureServer } from "./contract_harness.mjs";

const chars = (n, c = "a") => c.repeat(n);

describe("sanitizeToolInput's bounds", () => {
  it("keeps a value at its bound whole and unmarked", () => {
    const at = sanitizeToolInput({
      command: chars(TOOL_INPUT_TEXT_MAX_CHARS),
      query: chars(TOOL_INPUT_TEXT_MAX_CHARS, "q"),
      pattern: chars(TOOL_INPUT_TEXT_MAX_CHARS, "*"),
      prompt: chars(TOOL_INPUT_PROMPT_MAX_CHARS, "p"),
    });
    assert.equal(at.input.command, chars(TOOL_INPUT_TEXT_MAX_CHARS));
    assert.equal(at.input.prompt, chars(TOOL_INPUT_PROMPT_MAX_CHARS, "p"));
    assert.deepEqual(at.truncated, []);
  });

  it("cuts a value one character over, and lists every cut value in order, beside the input", () => {
    const over = sanitizeToolInput({
      prompt: chars(TOOL_INPUT_PROMPT_MAX_CHARS + 1, "p"),
      pattern: chars(TOOL_INPUT_TEXT_MAX_CHARS + 1, "*"),
      query: "short",
      command: chars(TOOL_INPUT_TEXT_MAX_CHARS + 1),
      file_path: "/" + chars(5000, "f"),
    });
    assert.equal(over.input.command, chars(TOOL_INPUT_TEXT_MAX_CHARS) + TOOL_INPUT_CUT_MARK);
    assert.equal(over.input.pattern, chars(TOOL_INPUT_TEXT_MAX_CHARS, "*") + TOOL_INPUT_CUT_MARK);
    assert.equal(over.input.prompt, chars(TOOL_INPUT_PROMPT_MAX_CHARS, "p") + TOOL_INPUT_CUT_MARK);
    assert.equal(over.input.query, "short");
    assert.deepEqual(over.truncated, ["/command", "/pattern", "/prompt"]);
    assert.deepEqual(Object.keys(over.input).sort(), ["command", "file_path", "pattern", "prompt", "query"]);
    // file_path has no bound here and is never listed.
    assert.equal(over.input.file_path.length, 5001);
  });

  it("counts characters, not UTF-16 units, and never splits one", () => {
    const emoji = "🔧"; // two UTF-16 units, one character
    const at = sanitizeToolInput({ command: emoji.repeat(TOOL_INPUT_TEXT_MAX_CHARS) });
    assert.equal(Array.from(at.input.command).length, TOOL_INPUT_TEXT_MAX_CHARS);
    assert.deepEqual(at.truncated, []);
    const over = sanitizeToolInput({ command: emoji.repeat(TOOL_INPUT_TEXT_MAX_CHARS + 7) });
    assert.equal(over.input.command, emoji.repeat(TOOL_INPUT_TEXT_MAX_CHARS) + TOOL_INPUT_CUT_MARK);
    assert.doesNotMatch(over.input.command, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/, "no lone high surrogate");
  });

  it("drops everything off the whitelist, cut or not, a tool's own truncated argument included", () => {
    const result = sanitizeToolInput({ command: chars(300), content: "secret", description: chars(300), truncated: true });
    assert.deepEqual(Object.keys(result.input), ["command"]);
    assert.deepEqual(result.truncated, ["/command"]);
  });
});

describe("the cut list's helpers (core/cut.mjs)", () => {
  it("cutChars keeps a value at its bound and marks one over it", () => {
    assert.deepEqual(cutChars("abc", 3), { text: "abc", cut: false });
    assert.deepEqual(cutChars("abcd", 3), { text: `abc${CUT_MARK}`, cut: true });
    assert.deepEqual(cutChars(12345, 3), { text: `123${CUT_MARK}`, cut: true });
  });

  it("jsonPointer builds RFC 6901 pointers and escapes ~ and /", () => {
    assert.equal(jsonPointer(["command"]), "/command");
    assert.equal(jsonPointer(["content", 0, "text"]), "/content/0/text");
    assert.equal(jsonPointer(["a/b", "m~n"]), "/a~1b/m~0n");
    assert.equal(jsonPointer(["truncated"]), "/truncated");
  });

  it("withTruncated adds the list only when something was cut", () => {
    const block = { type: "tool_use", name: "Bash", input: { command: "ls" } };
    assert.deepEqual(withTruncated(block, []), block);
    assert.equal("truncated" in withTruncated(block, []), false);
    assert.deepEqual(withTruncated(block, ["/command"]), { ...block, truncated: ["/command"] });
  });
});

describe("the tool_call payload of a cut input", () => {
  const cfg = { captureToolInputs: true, capturePrompts: true };
  const build = (toolInput) =>
    buildToolCallPayload({
      cfg,
      hookName: "PostToolUse",
      hookEvent: { tool_name: "Bash", tool_input: toolInput, tool_response: "ok", tool_use_id: "toolu_01payload" },
      toolName: "Bash",
      basePayload: { session_id: randomUUID(), model: "claude-sonnet-4-5" },
      sessionId: randomUUID(),
    });

  it("lists the cut values on the tool_use block and keeps tool_input to the tool's own keys", () => {
    const payload = build({ command: chars(300) });
    const block = payload.content.tools[0];
    assert.deepEqual(Object.keys(block), ["type", "name", "input", "truncated"]);
    assert.deepEqual(block.truncated, ["/command"]);
    assert.deepEqual(Object.keys(block.input), ["command"]);
    assert.deepEqual(JSON.parse(payload.tool_input), block.input);
  });

  it("carries no list when nothing was cut", () => {
    const payload = build({ command: "ls -la" });
    assert.equal("truncated" in payload.content.tools[0], false);
    assert.deepEqual(JSON.parse(payload.tool_input), { command: "ls -la" });
  });
});

describe("a cut tool input on the wire", () => {
  let capture;
  before(async () => {
    capture = await startCaptureServer();
  });
  after(() => {
    capture.server.closeAllConnections?.();
    capture.server.close();
  });

  it("reaches the event's tool_input and the Prompts tab's tool block with the mark, the list beside the input", async () => {
    // The command the dashboard showed cut mid-way.
    const command = `grep -rn "tool_input" dashboard/src | grep -v "\\.test\\." | cut -c1-190 | head -16; ${"git log --oneline -1 | cat; ".repeat(8)}`;
    assert.ok(Array.from(command).length > TOOL_INPUT_TEXT_MAX_CHARS);
    const sessionId = randomUUID();
    const before = capture.bodies().length;
    const result = await runScript(
      JSON.stringify({
        hook_event_name: "PostToolUse",
        session_id: randomUUID(),
        cwd: privateTmp,
        tool_name: "Bash",
        tool_input: { command, description: "list the readers" },
        tool_response: { stdout: "ok", stderr: "" },
        tool_use_id: "toolu_01cutcommand",
        duration_ms: 12,
      }),
      hookEnv({}, {
        FLIGHTDECK_SERVER: `http://127.0.0.1:${capture.port}`,
        FLIGHTDECK_TOKEN: "tok_test",
        CLAUDE_SESSION_ID: sessionId,
      }),
    );
    assert.equal(result.code, 0, result.stderr);
    await pollUntil(
      () => capture.bodies().slice(before).some((b) => b.event_type === "tool_call"),
      "the tool_call event",
    );
    const event = capture.bodies().slice(before).find((b) => b.event_type === "tool_call");
    assertIngestionContract(event);
    const expected = Array.from(command).slice(0, TOOL_INPUT_TEXT_MAX_CHARS).join("") + TOOL_INPUT_CUT_MARK;
    const input = JSON.parse(event.tool_input);
    assert.deepEqual(input, { command: expected }, "tool_input holds the tool's own keys only");
    const toolUse = event.content.tools[0];
    assert.deepEqual(toolUse.input, { command: expected });
    assert.deepEqual(toolUse.truncated, ["/command"], "the cut is listed beside the input");
  });
});
