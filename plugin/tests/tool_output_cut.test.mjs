// A tool's response over its bound is cut inside its structure, so the
// tool_call's stored tool_result stays valid JSON: the dashboard's
// Prompts tab reads its fields (a Bash command's stdout and stderr, a
// Read's file content) instead of a JSON text cut mid-way. A cut string
// ends with "…", a cut list keeps its leading elements, and the block
// names each cut value beside the content, in `truncated`, as an RFC
// 6901 JSON Pointer into the parsed content. Nothing is added inside the
// tool's response.
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

/** The value an RFC 6901 pointer names in ``root``. */
function at(root, pointer) {
  if (pointer === "") return root;
  return pointer
    .slice(1)
    .split("/")
    .map((t) => t.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce((value, token) => {
      assert.ok(value !== null && typeof value === "object" && token in value, `pointer ${pointer} resolves`);
      return value[token];
    }, root);
}

/** The stored output of a structured response: within the bound, valid
 *  JSON, every listed pointer resolving in it. */
function bounded(response) {
  const out = boundToolOutput(response);
  assert.equal(typeof out.content, "string");
  assert.ok(chars(out.content) <= MAX, `stored output is ${chars(out.content)} characters, over ${MAX}`);
  assert.doesNotMatch(out.content, LONE_HIGH_SURROGATE, "a cut split a surrogate pair");
  const value = JSON.parse(out.content);
  for (const pointer of out.truncated ?? []) at(value, pointer);
  return { ...out, value };
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
  it("keeps a string response at the bound whole, with no list", () => {
    const text = "a".repeat(MAX);
    assert.deepEqual(boundToolOutput(text), { content: text, truncated: null });
  });

  it("cuts a string response one character over, keeping the head and the mark, and names the whole value", () => {
    const out = boundToolOutput("a".repeat(MAX + 1));
    assert.deepEqual(out, { content: "a".repeat(MAX - 1) + MARK, truncated: [""] });
  });

  it("keeps an object whose JSON is exactly the bound whole, with no list", () => {
    const empty = JSON.stringify(bash(""));
    const response = bash("x".repeat(MAX - empty.length));
    assert.equal(JSON.stringify(response).length, MAX);
    assert.deepEqual(boundToolOutput(response), { content: JSON.stringify(response), truncated: null });
  });

  it("cuts an object one character over inside its stdout and names it beside the content", () => {
    const empty = JSON.stringify(bash(""));
    const stdout = "x".repeat(MAX - empty.length + 1);
    const { value, truncated } = bounded(bash(stdout));
    assertCutString(value.stdout, stdout);
    assert.deepEqual(truncated, ["/stdout"]);
    // Nothing is added inside the response: its keys are the tool's own.
    assert.deepEqual(Object.keys(value), Object.keys(bash("")));
    assert.equal(value.stderr, "");
    assert.equal(value.noOutputExpected, false);
  });
});

describe("boundToolOutput on each tool's shape", () => {
  it("Bash: a long stdout is cut, a short stderr stays whole, real line breaks kept", () => {
    const stdout = lines(400, (i) => `=== RUN   TestCase${i}\n--- PASS: TestCase${i} (0.00s)`);
    const stderr = "go: downloading example.com/mod v1.2.3";
    const { value, truncated } = bounded(bash(stdout, stderr));
    assertCutString(value.stdout, stdout);
    assert.ok(value.stdout.includes("\n--- PASS: TestCase0 (0.00s)\n"), "the stdout's lines are kept as lines");
    assert.equal(value.stderr, stderr);
    assert.deepEqual(truncated, ["/stdout"]);
    // The common length goes to the field that needs it: almost all of
    // the bound is stdout.
    assert.ok(chars(value.stdout) > MAX * 0.8, `stdout kept only ${chars(value.stdout)} characters`);
  });

  it("Bash: a long stdout and a long stderr share the bound and are named in document order", () => {
    const stdout = "o".repeat(6000);
    const stderr = "e".repeat(6000);
    const { value, truncated } = bounded(bash(stdout, stderr));
    assertCutString(value.stdout, stdout);
    assertCutString(value.stderr, stderr);
    assert.deepEqual(truncated, ["/stdout", "/stderr"]);
    assert.ok(Math.abs(chars(value.stdout) - chars(value.stderr)) <= 1, "the two long fields get the same length");
  });

  it("Read: the file's content is cut and named by its path, the file's path and counts kept", () => {
    const content = lines(500, (i) => `${i + 1}\tconst value${i} = "${i}";`);
    const response = {
      type: "text",
      file: { filePath: "/repo/src/app.ts", content, numLines: 500, startLine: 1, totalLines: 500 },
    };
    const { value, truncated } = bounded(response);
    assert.deepEqual(truncated, ["/file/content"]);
    assert.deepEqual(Object.keys(value.file), Object.keys(response.file));
    assert.equal(value.file.filePath, "/repo/src/app.ts");
    assert.equal(value.file.numLines, 500);
    assertCutString(value.file.content, content);
  });

  it("Grep (content mode): the matched lines are cut", () => {
    const content = lines(300, (i) => `src/file${i}.ts:${i}:  const needle = ${i};`);
    const { value, truncated } = bounded({ mode: "content", numFiles: 300, filenames: [], content, numLines: 300 });
    assertCutString(value.content, content);
    assert.deepEqual(value.filenames, []);
    assert.deepEqual(truncated, ["/content"]);
  });

  it("Glob: the leading file names stay whole, the list is named, and Glob's own truncated flag stays as Glob sent it", () => {
    const filenames = Array.from({ length: 100 }, (_, i) => `/repo/dashboard/src/components/session/Component${i}.tsx`);
    for (const flag of [false, true]) {
      const { value, truncated } = bounded({ filenames, durationMs: 12, numFiles: 100, truncated: flag });
      assert.equal(value.truncated, flag, "Glob's own flag is untouched");
      assert.ok(value.filenames.length > 5, `only ${value.filenames.length} file names kept`);
      assert.ok(value.filenames.length < filenames.length);
      assert.deepEqual(value.filenames, filenames.slice(0, value.filenames.length), "kept file names are whole, no mark element");
      assert.equal(value.numFiles, 100);
      assert.deepEqual(truncated, ["/filenames"]);
    }
  });

  it("Glob: a short result is sent whole, its own flag included", () => {
    const response = { filenames: ["/repo/a.ts"], durationMs: 3, numFiles: 1, truncated: true };
    assert.deepEqual(boundToolOutput(response), { content: JSON.stringify(response), truncated: null });
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
    const { value, truncated } = bounded(response);
    assert.equal(value.filePath, response.filePath);
    assert.equal(value.oldString, response.oldString);
    assert.equal(value.newString, response.newString);
    assert.deepEqual(value.structuredPatch, response.structuredPatch);
    assertCutString(value.originalFile, response.originalFile);
    assert.deepEqual(truncated, ["/originalFile"]);
  });

  it("WebFetch: the fetched result is cut, the status fields stay", () => {
    const result = "Lorem ipsum dolor sit amet. ".repeat(400);
    const { value, truncated } = bounded({ bytes: 120000, code: 200, codeText: "OK", result, durationMs: 840, url: "https://example.com/" });
    assertCutString(value.result, result);
    assert.equal(value.code, 200);
    assert.equal(value.url, "https://example.com/");
    assert.deepEqual(truncated, ["/result"]);
  });

  it("Agent: the prompt and the report's text block are cut and named by their pointers", () => {
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
    const { value, truncated } = bounded(response);
    assertCutString(value.prompt, prompt);
    assert.equal(value.content.length, 1, "nothing was dropped");
    assert.deepEqual(Object.keys(value.content[0]), ["type", "text"]);
    assertCutString(value.content[0].text, report);
    assert.deepEqual(truncated, ["/prompt", "/content/0/text"]);
    assert.deepEqual(value.usage, response.usage);
  });

  it("a list of content blocks: a long text block is cut and named", () => {
    const text = "y".repeat(9000);
    const { value, truncated } = bounded([{ type: "text", text }]);
    assert.equal(value.length, 1);
    assertCutString(value[0].text, text);
    assert.deepEqual(truncated, ["/0/text"]);
  });

  it("a list of content blocks: the trailing blocks that do not fit are dropped and the list is named first", () => {
    const blocks = Array.from({ length: 6 }, (_, i) => ({ type: "text", text: `${i}`.repeat(700) }));
    const { value, truncated } = bounded(blocks);
    assert.ok(value.length < blocks.length);
    assert.ok(value.every((b) => b.type === "text"), "no element that is not the tool's");
    assert.equal(truncated[0], "");
  });

  it("names a key with / or ~ by its escaped pointer", () => {
    const { truncated } = bounded({ "a/b~c": "z".repeat(3000) });
    assert.deepEqual(truncated, ["/a~1b~0c"]);
  });

  it("ToolSearch: a short response is sent whole", () => {
    const response = { matches: ["Monitor"], query: "select:Monitor", total_deferred_tools: 140 };
    assert.deepEqual(boundToolOutput(response), { content: JSON.stringify(response), truncated: null });
  });
});

describe("boundToolOutput's characters", () => {
  it("counts a 4-byte character as one and never splits it", () => {
    const emoji = "🔧"; // two UTF-16 units, one character
    assert.equal(boundToolOutput(emoji.repeat(MAX)).content, emoji.repeat(MAX));
    assert.equal(boundToolOutput(emoji.repeat(MAX + 3)).content, emoji.repeat(MAX - 1) + MARK);
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

  it("always yields JSON within the bound whose pointers resolve, over sizes and shapes", () => {
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

  it("keeps a response whose structure alone is over the bound as the head of its JSON text, named whole", () => {
    const response = Object.fromEntries(Array.from({ length: 600 }, (_, i) => [`key${i}`, i]));
    const out = boundToolOutput(response);
    assert.deepEqual(out.truncated, [""]);
    assert.equal(chars(out.content), MAX);
    assertCutString(out.content, JSON.stringify(response));
  });

  it("does not copy or cut a response whose kept objects hold more keys than any cut can fit", () => {
    // A key costs at least four characters of JSON, so 20,000 keys never
    // fit 2000 characters. JSON.stringify reads each key once for the
    // head of the text; the guard stops at its limit. Copying the
    // response for a cut would read every key again (and a million keys
    // took seconds in the hook).
    const n = 20_000;
    const target = Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, i]));
    let reads = 0;
    const response = new Proxy(target, {
      get(t, key, receiver) {
        if (typeof key === "string") reads += 1;
        return Reflect.get(t, key, receiver);
      },
    });
    const out = boundToolOutput(response);
    assert.deepEqual(out.truncated, [""]);
    assert.ok(out.content.startsWith('{"k0":0,"k1":1,'));
    assert.equal(chars(out.content), MAX);
    assert.ok(reads < n + MAX / 2, `read ${reads} keys of ${n}`);
  });

  it("stops a list at the first element no cut can keep, and names the list", () => {
    const huge = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`k${i}`, i]));
    const { value, truncated } = bounded([{ type: "text", text: "first" }, huge, { type: "text", text: "after" }]);
    assert.deepEqual(value, [{ type: "text", text: "first" }]);
    // The list at the root is the whole content: its pointer is "".
    assert.deepEqual(truncated, [""]);
  });

  it("still cuts inside the structure when the keys alone fit", () => {
    const fields = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`k${i}`, i]));
    const log = "x".repeat(5000);
    const { value, truncated } = bounded({ ...fields, log });
    assert.deepEqual(truncated, ["/log"]);
    assert.equal(value.k149, 149);
    assertCutString(value.log, log);
  });

  it("keeps a response nested past the depth the cut walks as the head of its JSON text", () => {
    let response = { stdout: "z".repeat(3000) };
    for (let i = 0; i < 60; i++) response = { inner: response };
    const out = boundToolOutput(response);
    assert.deepEqual(out.truncated, [""]);
    assert.ok(out.content.startsWith('{"inner":{"inner":'));
    assert.ok(chars(out.content) <= MAX);
  });

  it("keeps a __proto__ key of the tool's as a field", () => {
    const response = JSON.parse(`{"__proto__": {"x": 1}, "stdout": "${"p".repeat(3000)}"}`);
    const { value, truncated } = bounded(response);
    assert.ok(Object.prototype.hasOwnProperty.call(value, "__proto__"));
    assert.deepEqual(truncated, ["/stdout"]);
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

  it("reaches the tool_call's tool_result as JSON within the bound, the cut named on the block", async () => {
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
    assert.deepEqual(Object.keys(block).sort(), ["content", "truncated", "type"]);
    assert.equal(block.type, "tool_result");
    assert.deepEqual(block.truncated, ["/stdout"]);
    assert.equal(typeof block.content, "string");
    assert.ok(chars(block.content) <= MAX);
    const stored = JSON.parse(block.content);
    assert.deepEqual(Object.keys(stored), Object.keys(bash("")));
    assertCutString(stored.stdout, stdout);
    assert.equal(stored.stderr, "ok  \texample.com/mod\t0.42s");
  });

  it("sends a short output whole, with no list on the block", async () => {
    const before = capture.bodies().length;
    const result = await runScript(
      JSON.stringify({
        hook_event_name: "PostToolUse",
        session_id: randomUUID(),
        cwd: privateTmp,
        tool_name: "Bash",
        tool_input: { command: "echo ok" },
        tool_response: bash("ok\n"),
        tool_use_id: "toolu_01shortoutput",
        duration_ms: 3,
      }),
      hookEnv({}, {
        FLIGHTDECK_SERVER: `http://127.0.0.1:${capture.port}`,
        FLIGHTDECK_TOKEN: "tok_test",
        CLAUDE_SESSION_ID: randomUUID(),
      }),
    );
    assert.equal(result.code, 0, result.stderr);
    await pollUntil(
      () => capture.bodies().slice(before).some((b) => b.event_type === "tool_call"),
      "the tool_call event",
    );
    const event = capture.bodies().slice(before).find((b) => b.event_type === "tool_call");
    assertIngestionContract(event);
    assert.deepEqual(event.content.response, [{ type: "tool_result", content: JSON.stringify(bash("ok\n")) }]);
  });
});
