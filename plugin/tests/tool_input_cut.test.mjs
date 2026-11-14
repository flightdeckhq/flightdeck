// A tool input over its bound is cut, and the cut is marked: the value
// ends with "…" and the sanitized input's ``truncated`` names the field,
// so the dashboard never shows a command cut mid-way as if it were the
// whole command. The bounds themselves (core/tools.mjs) are privacy and
// size bounds and stay.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
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
    assert.equal(at.command, chars(TOOL_INPUT_TEXT_MAX_CHARS));
    assert.equal(at.prompt, chars(TOOL_INPUT_PROMPT_MAX_CHARS, "p"));
    assert.equal("truncated" in at, false);
  });

  it("cuts a value one character over, and lists every cut field in order", () => {
    const over = sanitizeToolInput({
      prompt: chars(TOOL_INPUT_PROMPT_MAX_CHARS + 1, "p"),
      pattern: chars(TOOL_INPUT_TEXT_MAX_CHARS + 1, "*"),
      query: "short",
      command: chars(TOOL_INPUT_TEXT_MAX_CHARS + 1),
      file_path: "/" + chars(5000, "f"),
    });
    assert.equal(over.command, chars(TOOL_INPUT_TEXT_MAX_CHARS) + TOOL_INPUT_CUT_MARK);
    assert.equal(over.pattern, chars(TOOL_INPUT_TEXT_MAX_CHARS, "*") + TOOL_INPUT_CUT_MARK);
    assert.equal(over.prompt, chars(TOOL_INPUT_PROMPT_MAX_CHARS, "p") + TOOL_INPUT_CUT_MARK);
    assert.equal(over.query, "short");
    assert.deepEqual(over.truncated, ["command", "pattern", "prompt"]);
    // file_path has no bound here and is never listed.
    assert.equal(over.file_path.length, 5001);
  });

  it("counts characters, not UTF-16 units, and never splits one", () => {
    const emoji = "🔧"; // two UTF-16 units, one character
    const at = sanitizeToolInput({ command: emoji.repeat(TOOL_INPUT_TEXT_MAX_CHARS) });
    assert.equal(Array.from(at.command).length, TOOL_INPUT_TEXT_MAX_CHARS);
    assert.equal("truncated" in at, false);
    const over = sanitizeToolInput({ command: emoji.repeat(TOOL_INPUT_TEXT_MAX_CHARS + 7) });
    assert.equal(over.command, emoji.repeat(TOOL_INPUT_TEXT_MAX_CHARS) + TOOL_INPUT_CUT_MARK);
    assert.doesNotMatch(over.command, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/, "no lone high surrogate");
  });

  it("drops everything off the whitelist, cut or not", () => {
    const result = sanitizeToolInput({ command: chars(300), content: "secret", description: chars(300) });
    assert.deepEqual(Object.keys(result).sort(), ["command", "truncated"]);
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

  it("reaches the event's tool_input and the Prompts tab's tool block with the mark and the list", async () => {
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
    assert.equal(input.command, expected);
    assert.deepEqual(input.truncated, ["command"]);
    assert.equal(input.description, undefined);
    const toolUse = event.content.tools[0];
    assert.equal(toolUse.input.command, expected);
    assert.deepEqual(toolUse.input.truncated, ["command"]);
  });
});
