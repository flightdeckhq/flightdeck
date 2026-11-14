// A tool's response over its bound is cut inside its structure, so the
// tool_call's stored tool_result stays valid JSON: the dashboard's
// Prompts tab reads its fields (a Bash command's stdout and stderr, a
// Read's file content) instead of a JSON text cut mid-way. Each cut
// string ends with "…", a list whose tail was dropped ends with "…",
// and the object holding a cut value names it in `truncated`.
//
// The Bash, ToolSearch, Agent and MCP shapes are the ones recorded in
// fixtures/claude-code-2.1.316/hooks.jsonl; Read, Grep, Glob, Edit and
// WebFetch follow the output shapes Claude Code gives those tools.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  boundToolOutput,
  TOOL_OUTPUT_CUT_MARK,
  TOOL_OUTPUT_MAX_CHARS,
} from "../hooks/scripts/claude_code/tools.mjs";
import { assertIngestionContract, hookEnv, pollUntil, privateTmp, runScript, startCaptureServer } from "./contract_harness.mjs";

const MAX = TOOL_OUTPUT_MAX_CHARS;
const MARK = TOOL_OUTPUT_CUT_MARK;
const chars = (s) => Array.from(s).length;
const lines = (n, line) => Array.from({ length: n }, (_, i) => line(i)).join("\n");
const LONE_HIGH_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/;

/** The stored text: within the bound, valid JSON, and its parsed value. */
function bounded(response) {
  const text = boundToolOutput(response);
  assert.ok(chars(text) <= MAX, `stored output is ${chars(text)} characters, over ${MAX}`);
  assert.doesNotMatch(text, LONE_HIGH_SURROGATE, "a cut split a surrogate pair");
  return { text, value: JSON.parse(text) };
}

/** A cut string: the head of ``original`` followed by the mark. */
function assertCutString(value, original) {
  assert.ok(value.endsWith(MARK), `"${value.slice(-20)}" does not end with the mark`);
  const head = value.slice(0, -MARK.length);
  assert.ok(head.length > 0, "a cut kept nothing");
  assert.ok(original.startsWith(head), "the cut string is not the head of the original");
}

const bash = (stdout, stderr = "") => ({
  stdout,
  stderr,
  interrupted: false,
  isImage: false,
  noOutputExpected: false,
});

describe("boundToolOutput at and over the bound", () => {
  it("keeps a string response at the bound whole", () => {
    const text = "a".repeat(MAX);
    assert.equal(boundToolOutput(text), text);
  });

  it("cuts a string response one character over, keeping the head and the mark", () => {
    const text = "a".repeat(MAX + 1);
    const out = boundToolOutput(text);
    assert.equal(out, "a".repeat(MAX - 1) + MARK);
    assert.equal(chars(out), MAX);
  });

  it("keeps an object whose JSON is exactly the bound whole, with no list", () => {
    const empty = JSON.stringify(bash(""));
    const response = bash("x".repeat(MAX - empty.length));
    assert.equal(JSON.stringify(response).length, MAX);
    const { text, value } = bounded(response);
    assert.equal(text, JSON.stringify(response));
    assert.equal("truncated" in value, false);
  });

  it("cuts an object one character over inside its stdout and lists it", () => {
    const empty = JSON.stringify(bash(""));
    const stdout = "x".repeat(MAX - empty.length + 1);
    const { value } = bounded(bash(stdout));
    assertCutString(value.stdout, stdout);
    assert.deepEqual(value.truncated, ["stdout"]);
    assert.equal(value.stderr, "");
    assert.equal(value.interrupted, false);
    assert.equal(value.isImage, false);
    assert.equal(value.noOutputExpected, false);
  });
});

describe("boundToolOutput on each tool's shape", () => {
  it("Bash: a long stdout is cut, a short stderr stays whole, real line breaks kept", () => {
    const stdout = lines(400, (i) => `=== RUN   TestCase${i}\n--- PASS: TestCase${i} (0.00s)`);
    const stderr = "go: downloading example.com/mod v1.2.3";
    const { value } = bounded(bash(stdout, stderr));
    assertCutString(value.stdout, stdout);
    assert.ok(value.stdout.includes("\n--- PASS: TestCase0 (0.00s)\n"), "the stdout's lines are kept as lines");
    assert.equal(value.stderr, stderr);
    assert.deepEqual(value.truncated, ["stdout"]);
    // The common length goes to the field that needs it: almost all of
    // the bound is stdout.
    assert.ok(chars(value.stdout) > MAX * 0.8, `stdout kept only ${chars(value.stdout)} characters`);
  });

  it("Bash: a long stdout and a long stderr share the bound and are listed in key order", () => {
    const stdout = "o".repeat(6000);
    const stderr = "e".repeat(6000);
    const { value } = bounded(bash(stdout, stderr));
    assertCutString(value.stdout, stdout);
    assertCutString(value.stderr, stderr);
    assert.deepEqual(value.truncated, ["stdout", "stderr"]);
    assert.ok(Math.abs(chars(value.stdout) - chars(value.stderr)) <= 1, "the two long fields get the same length");
  });

  it("Read: the file's content is cut and listed on the file object, its path and counts kept", () => {
    const content = lines(500, (i) => `${i + 1}\tconst value${i} = "${i}";`);
    const response = {
      type: "text",
      file: { filePath: "/repo/src/app.ts", content, numLines: 500, startLine: 1, totalLines: 500 },
    };
    const { value } = bounded(response);
    assert.equal(value.type, "text");
    assert.equal("truncated" in value, false, "the cut is listed where it happened, on file");
    assert.equal(value.file.filePath, "/repo/src/app.ts");
    assert.equal(value.file.numLines, 500);
    assertCutString(value.file.content, content);
    assert.deepEqual(value.file.truncated, ["content"]);
  });

  it("Grep (content mode): the matched lines are cut", () => {
    const content = lines(300, (i) => `src/file${i}.ts:${i}:  const needle = ${i};`);
    const { value } = bounded({ mode: "content", numFiles: 300, filenames: [], content, numLines: 300 });
    assertCutString(value.content, content);
    assert.deepEqual(value.filenames, []);
    assert.deepEqual(value.truncated, ["content"]);
  });

  it("Glob: the leading file names stay whole, the list ends with the mark, and the list replaces Glob's own flag", () => {
    const filenames = Array.from({ length: 100 }, (_, i) => `/repo/dashboard/src/components/session/Component${i}.tsx`);
    const { value } = bounded({ filenames, durationMs: 12, numFiles: 100, truncated: false });
    assert.equal(value.filenames.at(-1), MARK);
    const kept = value.filenames.slice(0, -1);
    assert.ok(kept.length > 5, `only ${kept.length} file names kept`);
    assert.deepEqual(kept, filenames.slice(0, kept.length), "a kept file name is whole");
    assert.equal(value.numFiles, 100);
    assert.deepEqual(value.truncated, ["filenames"]);
  });

  it("Glob: a short result keeps the tool's own truncated flag as it is", () => {
    const response = { filenames: ["/repo/a.ts"], durationMs: 3, numFiles: 1, truncated: true };
    assert.equal(boundToolOutput(response), JSON.stringify(response));
  });

  it("Edit: the whole original file gives up the characters; the edit's strings and path stay", () => {
    const response = {
      filePath: "/repo/src/app.ts",
      oldString: "const a = 1;",
      newString: "const a = 2;",
      originalFile: lines(800, (i) => `line ${i}`),
      structuredPatch: [{ oldStart: 10, oldLines: 1, newStart: 10, newLines: 1, lines: ["-const a = 1;", "+const a = 2;"] }],
      userModified: false,
      replaceAll: false,
    };
    const { value } = bounded(response);
    assert.equal(value.filePath, response.filePath);
    assert.equal(value.oldString, response.oldString);
    assert.equal(value.newString, response.newString);
    assert.deepEqual(value.structuredPatch, response.structuredPatch);
    assertCutString(value.originalFile, response.originalFile);
    assert.deepEqual(value.truncated, ["originalFile"]);
  });

  it("WebFetch: the fetched result is cut, the status fields stay", () => {
    const result = "Lorem ipsum dolor sit amet. ".repeat(400);
    const { value } = bounded({ bytes: 120000, code: 200, codeText: "OK", result, durationMs: 840, url: "https://example.com/" });
    assertCutString(value.result, result);
    assert.equal(value.code, 200);
    assert.equal(value.url, "https://example.com/");
    assert.deepEqual(value.truncated, ["result"]);
  });

  it("Agent: the prompt and the report's text block are cut, each listed by its holder", () => {
    const prompt = "Investigate the failing test. ".repeat(100);
    const report = "The test fails because the fixture moved. ".repeat(150);
    const response = {
      status: "completed",
      prompt,
      agentId: "a1b2c3",
      content: [{ type: "text", text: report }],
      totalDurationMs: 51234,
      totalTokens: 18000,
      totalToolUseCount: 9,
      usage: { input_tokens: 12000, output_tokens: 6000 },
    };
    const { value } = bounded(response);
    assertCutString(value.prompt, prompt);
    assert.equal(value.content.length, 1, "nothing was dropped, so the list has no mark");
    assert.equal(value.content[0].type, "text");
    assertCutString(value.content[0].text, report);
    assert.deepEqual(value.content[0].truncated, ["text"]);
    assert.deepEqual(value.truncated, ["prompt"]);
    assert.deepEqual(value.usage, response.usage);
  });

  it("a list of content blocks: a long text block is cut and lists its text", () => {
    const text = "y".repeat(9000);
    const { value } = bounded([{ type: "text", text }]);
    assert.equal(value.length, 1);
    assertCutString(value[0].text, text);
    assert.deepEqual(value[0].truncated, ["text"]);
  });

  it("a list of content blocks: the trailing blocks that do not fit are dropped and the list ends with the mark", () => {
    const blocks = Array.from({ length: 6 }, (_, i) => ({ type: "text", text: `${i}`.repeat(700) }));
    const { value } = bounded(blocks);
    assert.equal(value.at(-1), MARK);
    assert.ok(value.length < blocks.length + 1);
    assert.equal(value[0].type, "text");
  });

  it("ToolSearch: a short response is sent whole", () => {
    const response = { matches: ["Monitor"], query: "select:Monitor", total_deferred_tools: 140 };
    assert.equal(boundToolOutput(response), JSON.stringify(response));
  });
});

describe("boundToolOutput's characters", () => {
  it("counts a 4-byte character as one and never splits it", () => {
    const emoji = "🔧"; // two UTF-16 units, one character
    assert.equal(boundToolOutput(emoji.repeat(MAX)), emoji.repeat(MAX));
    const cut = boundToolOutput(emoji.repeat(MAX + 3));
    assert.equal(cut, emoji.repeat(MAX - 1) + MARK);
    const { value } = bounded(bash(emoji.repeat(3000), "错误：找不到文件"));
    assertCutString(value.stdout, emoji.repeat(3000));
    assert.equal(value.stderr, "错误：找不到文件");
  });

  it("fits output heavy in escapes (quotes, backslashes, tabs, control characters)", () => {
    const stdout = '"quoted"\t\\path\\\n'.repeat(800);
    const stderr = "\u0001\u0002".repeat(400);
    const { value } = bounded(bash(stdout, stderr));
    assertCutString(value.stdout, stdout);
    assertCutString(value.stderr, stderr);
  });

  it("always yields JSON within the bound, over sizes and shapes", () => {
    // A fixed sweep, not random: each size crosses the bound in a
    // different place of the structure.
    for (const n of [1, 500, 1900, 1950, 1990, 1999, 2000, 2001, 2100, 5000, 50000]) {
      for (const response of [
        bash("s".repeat(n), "e".repeat(Math.floor(n / 3))),
        { type: "text", file: { filePath: "/f", content: "c\n".repeat(n) } },
        [{ type: "text", text: "t".repeat(n) }, { type: "text", text: "u".repeat(n) }],
        { filenames: Array.from({ length: Math.ceil(n / 20) }, (_, i) => `/r/${i}.ts`), numFiles: n },
        { nested: [[["a".repeat(n)]]], n },
      ]) {
        bounded(response);
      }
    }
  });

  it("keeps a response whose structure alone is over the bound as the head of its JSON text", () => {
    const response = Object.fromEntries(Array.from({ length: 600 }, (_, i) => [`key${i}`, i]));
    const { value } = bounded(response);
    assert.deepEqual(value.truncated, ["text"]);
    assertCutString(value.text, JSON.stringify(response));
  });

  it("keeps a response nested past the depth the cut walks as the head of its JSON text", () => {
    let response = { stdout: "z".repeat(3000) };
    for (let i = 0; i < 60; i++) response = { inner: response };
    const { value } = bounded(response);
    assert.deepEqual(value.truncated, ["text"]);
    assert.ok(value.text.startsWith('{"inner":{"inner":'));
  });

  it("keeps a __proto__ key of the tool's as a field", () => {
    const response = JSON.parse(`{"__proto__": {"x": 1}, "stdout": "${"p".repeat(3000)}"}`);
    const { value } = bounded(response);
    assert.ok(Object.prototype.hasOwnProperty.call(value, "__proto__"));
    assert.deepEqual(value.truncated, ["stdout"]);
  });
});

describe("a long tool output on the wire", () => {
  let capture;
  before(async () => {
    capture = await startCaptureServer();
  });
  after(() => {
    capture.server.closeAllConnections?.();
    capture.server.close();
  });

  it("reaches the tool_call's tool_result as JSON within the bound, stdout cut and listed", async () => {
    const stdout = lines(200, (i) => `=== RUN   TestEmission${i}\n--- PASS: TestEmission${i} (0.01s)`);
    const sessionId = randomUUID();
    const before = capture.bodies().length;
    const result = await runScript(
      JSON.stringify({
        hook_event_name: "PostToolUse",
        session_id: randomUUID(),
        cwd: privateTmp,
        tool_name: "Bash",
        tool_input: { command: "go test ./...", description: "run the tests" },
        tool_response: bash(stdout, "ok  \texample.com/mod\t0.42s"),
        tool_use_id: "toolu_01longoutput",
        duration_ms: 4200,
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
    assert.equal(event.has_content, true);
    assert.equal(event.tool_name, "Bash");
    const [block] = event.content.response;
    assert.equal(block.type, "tool_result");
    assert.equal(typeof block.content, "string");
    assert.ok(chars(block.content) <= MAX);
    const stored = JSON.parse(block.content);
    assertCutString(stored.stdout, stdout);
    assert.equal(stored.stderr, "ok  \texample.com/mod\t0.42s");
    assert.deepEqual(stored.truncated, ["stdout"]);
  });
});
