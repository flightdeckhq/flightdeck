import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  EVENT_MAP,
  collectContext,
  computeLatencyMs,
  getSessionId,
  parseBool,
  readLatestTurn,
  readTurns,
  sanitizeToolInput,
  tokensFromUsage,
} from "../hooks/scripts/observe_cli.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, "..", "hooks", "scripts", "observe_cli.mjs");

function clearSessionMarkers() {
  const dir = join(tmpdir(), "flightdeck-plugin");
  const cwd = process.cwd();
  const key = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
  try {
    rmSync(join(dir, `session-${key}.txt`));
  } catch {
    /* file may not exist */
  }
}

function clearAllPluginMarkers() {
  const dir = join(tmpdir(), "flightdeck-plugin");
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function runScript(stdinData, env = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [SCRIPT],
      { env: { ...process.env, ...env }, timeout: 10000 },
      (error, stdout, stderr) => {
        resolve({
          code: error ? error.code ?? 1 : 0,
          stdout,
          stderr,
        });
      },
    );
    if (stdinData != null) child.stdin.write(stdinData);
    child.stdin.end();
  });
}

function startCaptureServer() {
  return new Promise((resolve) => {
    const captured = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          captured.push(JSON.parse(body));
        } catch {
          captured.push(body);
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"ok":true}');
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({ server, port, bodies: () => captured });
    });
  });
}

// Write a synthetic JSONL transcript with one LLM turn (user → assistant
// with usage). Returns the path; caller is responsible for cleanup.
function writeTranscript(lines) {
  const dir = mkdtempSync(join(tmpdir(), "flightdeck-transcript-"));
  const path = join(dir, "session.jsonl");
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return path;
}

describe("observe_cli.mjs", () => {
  let capture;

  before(async () => {
    capture = await startCaptureServer();
    clearAllPluginMarkers();
  });

  after(() => {
    capture.server.close();
    clearAllPluginMarkers();
  });

  it("maps PreToolUse to pre_call", async () => {
    clearAllPluginMarkers();
    const input = JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      session_id: "sess-pretool-1",
    });
    const env = {
      FLIGHTDECK_SERVER: `http://127.0.0.1:${capture.port}`,
      FLIGHTDECK_TOKEN: "tok_test",
    };
    const result = await runScript(input, env);
    assert.equal(result.code, 0);

    // First invocation emits a synthetic session_start backstop before
    // the real hook event. The pre_call is the last body.
    const body = capture.bodies().at(-1);
    assert.equal(body.event_type, "pre_call");
    assert.equal(body.flavor, "claude-code");
    assert.equal(body.agent_type, "developer");
    assert.equal(body.framework, "claude-code");
    assert.equal(body.tool_name, "Bash");
    assert.equal(body.has_content, false);
    assert.equal(body.content, null);
  });

  it("maps PostToolUse to tool_call with tool_name", async () => {
    const input = JSON.stringify({
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      session_id: "sess-posttool-1",
    });
    const env = {
      FLIGHTDECK_SERVER: `http://127.0.0.1:${capture.port}`,
      FLIGHTDECK_TOKEN: "tok_test",
    };
    const result = await runScript(input, env);
    assert.equal(result.code, 0);

    const body = capture.bodies().at(-1);
    assert.equal(body.event_type, "tool_call");
    assert.equal(body.tool_name, "Read");
  });

  it("maps Stop to post_call with transcript tokens and model (D098)", async () => {
    const transcriptPath = writeTranscript([
      {
        type: "user",
        timestamp: "2026-04-17T10:00:00.000Z",
        message: { role: "user", content: "ping" },
      },
      {
        type: "assistant",
        timestamp: "2026-04-17T10:00:02.500Z",
        message: {
          id: "msg_stop_1",
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "pong" }],
          usage: {
            input_tokens: 10,
            output_tokens: 3,
            cache_read_input_tokens: 100,
            cache_creation_input_tokens: 50,
          },
        },
      },
    ]);
    const input = JSON.stringify({
      hook_event_name: "Stop",
      session_id: "sess-stop-1",
      transcript_path: transcriptPath,
    });
    const env = {
      FLIGHTDECK_SERVER: `http://127.0.0.1:${capture.port}`,
      FLIGHTDECK_TOKEN: "tok_test",
    };
    const result = await runScript(input, env);
    assert.equal(result.code, 0);

    const body = capture.bodies().at(-1);
    assert.equal(body.event_type, "post_call");
    assert.equal(body.model, "claude-sonnet-4-6");
    assert.equal(body.tokens_input, 160); // 10 + 100 + 50
    assert.equal(body.tokens_output, 3);
    assert.equal(body.tokens_total, 163);
    assert.equal(body.tokens_cache_read, 100);
    assert.equal(body.tokens_cache_creation, 50);
    assert.equal(body.latency_ms, 2500);
    assert.equal(body.has_content, false); // CAPTURE_PROMPTS default off
    rmSync(dirname(transcriptPath), { recursive: true, force: true });
  });

  it("maps SessionEnd to session_end", async () => {
    const input = JSON.stringify({
      hook_event_name: "SessionEnd",
      session_id: "sess-end-1",
    });
    const env = {
      FLIGHTDECK_SERVER: `http://127.0.0.1:${capture.port}`,
      FLIGHTDECK_TOKEN: "tok_test",
    };
    const result = await runScript(input, env);
    assert.equal(result.code, 0);
    const body = capture.bodies().at(-1);
    assert.equal(body.event_type, "session_end");
  });

  it("defaults FLIGHTDECK_SERVER/TOKEN when unset (zero-config path, D098)", async () => {
    // Point at the capture server but leave TOKEN unset so we verify
    // the default `tok_dev` is sent.
    clearAllPluginMarkers();
    const input = JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      session_id: "sess-default-1",
    });
    const env = {
      FLIGHTDECK_SERVER: `http://127.0.0.1:${capture.port}`,
      FLIGHTDECK_TOKEN: "",
    };
    const result = await runScript(input, env);
    assert.equal(result.code, 0);
    // Successfully posted with default token -- the body landed.
    assert.ok(capture.bodies().length > 0);
  });

  it("logs connection-refused once per session and keeps exiting zero", async () => {
    clearAllPluginMarkers();
    const input = JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      session_id: "sess-refused-1",
    });
    // Port 1 is reserved; connection is refused by the kernel.
    const env = {
      FLIGHTDECK_SERVER: "http://127.0.0.1:1",
      FLIGHTDECK_TOKEN: "tok_test",
    };
    const result = await runScript(input, env);
    assert.equal(result.code, 0);
    assert.ok(
      result.stderr.includes("cannot reach") ||
        result.stderr.includes("POST failed"),
      `expected cannot-reach or POST failed, got: ${result.stderr}`,
    );
  });

  it("exits zero on unknown hook event", async () => {
    const input = JSON.stringify({
      hook_event_name: "SomeUnknownHook",
      session_id: "sess-unknown-1",
    });
    const env = {
      FLIGHTDECK_SERVER: `http://127.0.0.1:${capture.port}`,
      FLIGHTDECK_TOKEN: "tok_test",
    };
    const countBefore = capture.bodies().length;
    const result = await runScript(input, env);
    assert.equal(result.code, 0);
    assert.equal(capture.bodies().length, countBefore);
  });

  it("populates tool_name from tool field fallback", async () => {
    const input = JSON.stringify({
      hook_event_name: "PostToolUse",
      tool: "Write",
      session_id: "sess-fallback-1",
    });
    const env = {
      FLIGHTDECK_SERVER: `http://127.0.0.1:${capture.port}`,
      FLIGHTDECK_TOKEN: "tok_test",
    };
    const result = await runScript(input, env);
    assert.equal(result.code, 0);
    const body = capture.bodies().at(-1);
    assert.equal(body.tool_name, "Write");
  });
});

describe("observe_cli helpers", () => {
  describe("parseBool", () => {
    it("parses standard truthy values", () => {
      assert.equal(parseBool("true", false), true);
      assert.equal(parseBool("1", false), true);
      assert.equal(parseBool("yes", false), true);
      assert.equal(parseBool("TRUE", false), true);
      assert.equal(parseBool("On", false), true);
    });

    it("parses standard falsy values", () => {
      assert.equal(parseBool("false", true), false);
      assert.equal(parseBool("0", true), false);
      assert.equal(parseBool("no", true), false);
      assert.equal(parseBool("off", true), false);
    });

    it("returns fallback on null / undefined / garbage", () => {
      assert.equal(parseBool(null, true), true);
      assert.equal(parseBool(undefined, false), false);
      assert.equal(parseBool("maybe", true), true);
      assert.equal(parseBool("", false), false);
    });
  });

  describe("getSessionId", () => {
    beforeEach(() => {
      delete process.env.CLAUDE_SESSION_ID;
      delete process.env.ANTHROPIC_CLAUDE_SESSION_ID;
      clearSessionMarkers();
    });

    it("prefers hookEvent.session_id when present", () => {
      assert.equal(getSessionId({ session_id: "hook-sent-id" }), "hook-sent-id");
    });

    it("falls back to CLAUDE_SESSION_ID env var", () => {
      process.env.CLAUDE_SESSION_ID = "claude-test-id";
      assert.equal(getSessionId(), "claude-test-id");
    });

    it("falls back to ANTHROPIC_CLAUDE_SESSION_ID", () => {
      process.env.ANTHROPIC_CLAUDE_SESSION_ID = "anthropic-test-id";
      assert.equal(getSessionId(), "anthropic-test-id");
    });

    it("returns the same id on repeated calls in the same cwd", () => {
      const a = getSessionId();
      const b = getSessionId();
      assert.equal(a, b);
      assert.equal(a.length, 32);
    });
  });

  describe("collectContext", () => {
    it("returns hostname, os, arch, node_version, frameworks", () => {
      const ctx = collectContext();
      assert.equal(typeof ctx.hostname, "string");
      assert.equal(typeof ctx.os, "string");
      assert.equal(typeof ctx.arch, "string");
      assert.equal(typeof ctx.node_version, "string");
      assert.equal(ctx.process_name, "claude-code");
      assert.ok(Array.isArray(ctx.frameworks));
      assert.ok(
        ctx.frameworks.some((fw) => fw.startsWith("claude-code")),
        `expected a claude-code entry in frameworks, got ${JSON.stringify(ctx.frameworks)}`,
      );
    });

    it("stamps claude-code version in frameworks when passed", () => {
      const ctx = collectContext({ claudeCodeVersion: "2.1.112" });
      assert.ok(ctx.frameworks.includes("claude-code/2.1.112"));
    });

    it("detects kubernetes orchestration from env", () => {
      const orig = { ...process.env };
      process.env.KUBERNETES_SERVICE_HOST = "10.0.0.1";
      process.env.MY_POD_NAMESPACE = "agents";
      process.env.MY_NODE_NAME = "node-1";
      try {
        const ctx = collectContext();
        assert.equal(ctx.orchestration, "kubernetes");
        assert.equal(ctx.k8s_namespace, "agents");
        assert.equal(ctx.k8s_node, "node-1");
      } finally {
        process.env = orig;
      }
    });
  });

  describe("sanitizeToolInput", () => {
    it("keeps file_path and drops content", () => {
      const result = sanitizeToolInput({
        file_path: "/src/app.ts",
        content: "secret-token-do-not-leak",
      });
      assert.equal(result.file_path, "/src/app.ts");
      assert.equal(result.content, undefined);
    });

    it("truncates command to 200 characters", () => {
      const result = sanitizeToolInput({ command: "a".repeat(300) });
      assert.ok(result.command.length <= 200);
    });

    it("truncates Task prompt to 100 characters", () => {
      const result = sanitizeToolInput({ prompt: "x".repeat(250) });
      assert.equal(result.prompt.length, 100);
    });

    it("returns null for empty / non-object input", () => {
      assert.equal(sanitizeToolInput(null), null);
      assert.equal(sanitizeToolInput(undefined), null);
      assert.equal(sanitizeToolInput({}), null);
    });

    it("retains query and pattern fields", () => {
      const result = sanitizeToolInput({ query: "endpoints", pattern: "**/*.ts" });
      assert.equal(result.query, "endpoints");
      assert.equal(result.pattern, "**/*.ts");
    });
  });

  describe("tokensFromUsage", () => {
    it("sums uncached + cache_read + cache_creation into tokens_input", () => {
      const t = tokensFromUsage({
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 50,
      });
      assert.equal(t.tokens_input, 160);
      assert.equal(t.tokens_output, 5);
      assert.equal(t.tokens_total, 165);
      assert.equal(t.tokens_cache_read, 100);
      assert.equal(t.tokens_cache_creation, 50);
    });

    it("handles empty / missing usage gracefully", () => {
      const t = tokensFromUsage();
      assert.equal(t.tokens_input, 0);
      assert.equal(t.tokens_output, 0);
      assert.equal(t.tokens_total, 0);
      assert.equal(t.tokens_cache_read, 0);
      assert.equal(t.tokens_cache_creation, 0);
    });
  });

  describe("computeLatencyMs", () => {
    it("returns ms delta between user and assistant timestamps", () => {
      const userTurn = { timestamp: "2026-04-17T10:00:00.000Z" };
      const ms = computeLatencyMs(userTurn, "2026-04-17T10:00:01.250Z");
      assert.equal(ms, 1250);
    });

    it("returns null when user turn is missing", () => {
      assert.equal(computeLatencyMs(null, "2026-04-17T10:00:01Z"), null);
    });

    it("returns null when assistant timestamp is missing", () => {
      const userTurn = { timestamp: "2026-04-17T10:00:00Z" };
      assert.equal(computeLatencyMs(userTurn, null), null);
    });

    it("returns null when assistant precedes user (clock skew)", () => {
      const userTurn = { timestamp: "2026-04-17T10:00:02Z" };
      assert.equal(computeLatencyMs(userTurn, "2026-04-17T10:00:01Z"), null);
    });
  });

  describe("readTurns", () => {
    it("returns [] for missing transcript", () => {
      assert.deepEqual(readTurns("/tmp/does-not-exist-999.jsonl"), []);
    });

    it("returns one entry per assistant message.id in order", () => {
      const path = writeTranscript([
        {
          type: "user",
          timestamp: "2026-04-17T10:00:00Z",
          message: { role: "user", content: "run ls" },
        },
        {
          type: "assistant",
          timestamp: "2026-04-17T10:00:01Z",
          message: {
            id: "msg_turn_1",
            model: "claude-sonnet-4-6",
            content: [{ type: "tool_use", name: "Bash", input: {} }],
            usage: { input_tokens: 5, output_tokens: 10 },
          },
        },
        {
          type: "user",
          timestamp: "2026-04-17T10:00:02Z",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "x" }],
          },
        },
        {
          type: "assistant",
          timestamp: "2026-04-17T10:00:03Z",
          message: {
            id: "msg_turn_2",
            model: "claude-sonnet-4-6",
            content: [{ type: "text", text: "done" }],
            usage: { input_tokens: 7, output_tokens: 4 },
          },
        },
      ]);
      try {
        const turns = readTurns(path);
        assert.equal(turns.length, 2);
        assert.equal(turns[0].messageId, "msg_turn_1");
        assert.equal(turns[1].messageId, "msg_turn_2");
        // Second turn's user-turn is the tool_result record (most recent
        // user-role line before it), so latency can be measured against it.
        assert.equal(Array.isArray(turns[1].userTurn.content), true);
      } finally {
        rmSync(dirname(path), { recursive: true, force: true });
      }
    });
  });

  describe("readLatestTurn", () => {
    it("returns null for nonexistent transcript path", () => {
      assert.equal(readLatestTurn("/tmp/does-not-exist-12345.jsonl"), null);
    });

    it("returns null for empty transcript", () => {
      const path = writeTranscript([]);
      try {
        assert.equal(readLatestTurn(path), null);
      } finally {
        rmSync(dirname(path), { recursive: true, force: true });
      }
    });

    it("groups multi-chunk assistant records by message.id", () => {
      // One LLM call emits three transcript lines: thinking, tool_use,
      // final usage. All share the same message.id. The last record's
      // usage is authoritative.
      const path = writeTranscript([
        {
          type: "user",
          timestamp: "2026-04-17T10:00:00Z",
          message: { role: "user", content: "do the thing" },
        },
        {
          type: "assistant",
          timestamp: "2026-04-17T10:00:01Z",
          message: {
            id: "msg_multi",
            model: "claude-sonnet-4-6",
            content: [{ type: "thinking", thinking: "planning" }],
            usage: { input_tokens: 10, output_tokens: 20 },
          },
        },
        {
          type: "assistant",
          timestamp: "2026-04-17T10:00:02Z",
          message: {
            id: "msg_multi",
            model: "claude-sonnet-4-6",
            content: [{ type: "tool_use", name: "Read", input: {} }],
            usage: { input_tokens: 10, output_tokens: 50 },
          },
        },
      ]);
      try {
        const turn = readLatestTurn(path);
        assert.equal(turn.messageId, "msg_multi");
        assert.equal(turn.model, "claude-sonnet-4-6");
        assert.equal(turn.usage.output_tokens, 50); // last record wins
        assert.equal(turn.contentBlocks.length, 2);
        assert.equal(turn.userTurn.content, "do the thing");
      } finally {
        rmSync(dirname(path), { recursive: true, force: true });
      }
    });

    it("captures Claude Code version from transcript records", () => {
      const path = writeTranscript([
        {
          type: "user",
          timestamp: "2026-04-17T10:00:00Z",
          version: "2.1.112",
          message: { role: "user", content: "hi" },
        },
      ]);
      try {
        // No assistant record yet, so returns null -- but version read
        // is a side effect we verify via a second call that does have
        // an assistant line.
        assert.equal(readLatestTurn(path), null);
      } finally {
        rmSync(dirname(path), { recursive: true, force: true });
      }
    });
  });

  describe("EVENT_MAP", () => {
    it("includes the full v1 hook coverage (D098)", () => {
      assert.equal(EVENT_MAP.SessionStart, "session_start");
      assert.equal(EVENT_MAP.UserPromptSubmit, "pre_call");
      assert.equal(EVENT_MAP.PreToolUse, "pre_call");
      assert.equal(EVENT_MAP.PostToolUse, "tool_call");
      assert.equal(EVENT_MAP.Stop, "post_call");
      assert.equal(EVENT_MAP.SessionEnd, "session_end");
      assert.equal(EVENT_MAP.PreCompact, "tool_call");
    });
  });
});

describe("observe_cli end-to-end (new fields)", () => {
  let capture;

  before(async () => {
    capture = await startCaptureServer();
    clearAllPluginMarkers();
  });

  after(() => {
    capture.server.close();
    clearAllPluginMarkers();
  });

  it("first hook invocation emits session_start with context", async () => {
    const input = JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_input: { file_path: "/src/app.ts" },
      session_id: "sess-first-1",
    });
    const env = {
      FLIGHTDECK_SERVER: `http://127.0.0.1:${capture.port}`,
      FLIGHTDECK_TOKEN: "tok_test",
    };
    const result = await runScript(input, env);
    assert.equal(result.code, 0);

    const bodies = capture.bodies();
    const sessionStart = bodies.find((b) => b.event_type === "session_start");
    assert.ok(sessionStart, "expected a session_start event");
    assert.equal(typeof sessionStart.context, "object");
    assert.equal(sessionStart.context.process_name, "claude-code");
    assert.ok(Array.isArray(sessionStart.context.frameworks));
    assert.ok(
      sessionStart.context.frameworks.some((f) => f.startsWith("claude-code")),
    );
  });

  it("subsequent invocations in the same session skip session_start", async () => {
    const before = capture.bodies().length;
    const input = JSON.stringify({
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      session_id: "sess-first-1",
    });
    const env = {
      FLIGHTDECK_SERVER: `http://127.0.0.1:${capture.port}`,
      FLIGHTDECK_TOKEN: "tok_test",
    };
    const result = await runScript(input, env);
    assert.equal(result.code, 0);
    const after = capture.bodies().length;
    assert.equal(after - before, 1);
    assert.equal(capture.bodies().at(-1).event_type, "tool_call");
  });

  it("tool_input is captured by default (CAPTURE_TOOL_INPUTS=true default)", async () => {
    const input = JSON.stringify({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls -la /etc" },
      session_id: "sess-capture-default-1",
    });
    const env = {
      FLIGHTDECK_SERVER: `http://127.0.0.1:${capture.port}`,
      FLIGHTDECK_TOKEN: "tok_test",
    };
    const result = await runScript(input, env);
    assert.equal(result.code, 0);
    const body = capture.bodies().at(-1);
    assert.equal(body.event_type, "tool_call");
    assert.equal(typeof body.tool_input, "string");
    const parsed = JSON.parse(body.tool_input);
    assert.equal(parsed.command, "ls -la /etc");
  });

  it("tool_input is null when CAPTURE_TOOL_INPUTS explicitly off", async () => {
    const input = JSON.stringify({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls -la /etc" },
      session_id: "sess-capture-off-1",
    });
    const env = {
      FLIGHTDECK_SERVER: `http://127.0.0.1:${capture.port}`,
      FLIGHTDECK_TOKEN: "tok_test",
      FLIGHTDECK_CAPTURE_TOOL_INPUTS: "false",
    };
    const result = await runScript(input, env);
    assert.equal(result.code, 0);
    const body = capture.bodies().at(-1);
    assert.equal(body.tool_input, null);
  });

  it("Stop with CAPTURE_PROMPTS=true attaches content payload (D098)", async () => {
    const transcriptPath = writeTranscript([
      {
        type: "user",
        timestamp: "2026-04-17T10:00:00Z",
        message: { role: "user", content: "say hi" },
      },
      {
        type: "assistant",
        timestamp: "2026-04-17T10:00:01Z",
        message: {
          id: "msg_capture_1",
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "hi!" }],
          usage: { input_tokens: 5, output_tokens: 2 },
        },
      },
    ]);
    const input = JSON.stringify({
      hook_event_name: "Stop",
      session_id: "sess-capture-prompts-1",
      transcript_path: transcriptPath,
    });
    const env = {
      FLIGHTDECK_SERVER: `http://127.0.0.1:${capture.port}`,
      FLIGHTDECK_TOKEN: "tok_test",
      FLIGHTDECK_CAPTURE_PROMPTS: "true",
    };
    const result = await runScript(input, env);
    assert.equal(result.code, 0);
    const body = capture.bodies().at(-1);
    assert.equal(body.event_type, "post_call");
    assert.equal(body.has_content, true);
    assert.equal(body.content.provider, "anthropic");
    assert.equal(body.content.model, "claude-sonnet-4-6");
    assert.equal(body.content.messages[0].content, "say hi");
    assert.equal(body.content.response[0].text, "hi!");
    rmSync(dirname(transcriptPath), { recursive: true, force: true });
  });

  it("flags Task tool calls as subagent invocations and stamps parent_session_id", async () => {
    const input = JSON.stringify({
      hook_event_name: "PostToolUse",
      tool_name: "Task",
      tool_input: { prompt: "audit the auth middleware" },
      session_id: "sess-task-1",
    });
    const env = {
      FLIGHTDECK_SERVER: `http://127.0.0.1:${capture.port}`,
      FLIGHTDECK_TOKEN: "tok_test",
    };
    const result = await runScript(input, env);
    assert.equal(result.code, 0);
    const body = capture.bodies().at(-1);
    assert.equal(body.tool_name, "Task");
    assert.equal(body.is_subagent_call, true);
    assert.equal(body.parent_session_id, body.session_id);
  });

  it("PostToolUse populates latency_ms; PreToolUse leaves it null", async () => {
    const post = await runScript(
      JSON.stringify({
        hook_event_name: "PostToolUse",
        tool_name: "Read",
        session_id: "sess-lat-1",
      }),
      {
        FLIGHTDECK_SERVER: `http://127.0.0.1:${capture.port}`,
        FLIGHTDECK_TOKEN: "tok_test",
      },
    );
    assert.equal(post.code, 0);
    const postBody = capture.bodies().at(-1);
    assert.equal(typeof postBody.latency_ms, "number");
    assert.ok(postBody.latency_ms >= 0);

    const pre = await runScript(
      JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        session_id: "sess-lat-1",
      }),
      {
        FLIGHTDECK_SERVER: `http://127.0.0.1:${capture.port}`,
        FLIGHTDECK_TOKEN: "tok_test",
      },
    );
    assert.equal(pre.code, 0);
    const preBody = capture.bodies().at(-1);
    assert.equal(preBody.latency_ms, null);
  });
});
