import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  collectContext,
  EVENT_MAP,
  getSessionId,
  sanitizeToolInput,
} from "../hooks/scripts/observe_cli.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, "..", "hooks", "scripts", "observe_cli.mjs");

/**
 * Helper: clean up the cwd-scoped session marker files between
 * getSessionId tests so each test exercises the file-creation path
 * cleanly. Mirrors the path computation in observe_cli.mjs:getSessionId.
 */
function clearSessionMarkers() {
  const dir = join(tmpdir(), "flightdeck-plugin");
  const cwd = process.cwd();
  const key = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
  try {
    rmSync(join(dir, `session-${key}.txt`));
  } catch {
    /* file may not exist -- fine */
  }
}

/**
 * Helper: run observe_cli.mjs as a child process, piping stdinData,
 * returning { code, stdout, stderr }.
 */
function runScript(stdinData, env = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [SCRIPT],
      {
        env: { ...process.env, ...env },
        timeout: 10000,
      },
      (error, stdout, stderr) => {
        resolve({
          code: error ? error.code ?? 1 : 0,
          stdout,
          stderr,
        });
      }
    );
    if (stdinData != null) {
      child.stdin.write(stdinData);
    }
    child.stdin.end();
  });
}

/**
 * Helper: start a local HTTP server that captures POST bodies.
 * Returns { server, port, bodies() }.
 */
function startCaptureServer() {
  return new Promise((resolve) => {
    const captured = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
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

describe("observe_cli.mjs", () => {
  let capture;

  before(async () => {
    capture = await startCaptureServer();
  });

  after(() => {
    capture.server.close();
  });

  it("maps PreToolUse to pre_call", async () => {
    const input = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash" });
    const env = {
      FLIGHTDECK_SERVER: `http://127.0.0.1:${capture.port}`,
      FLIGHTDECK_TOKEN: "tok_test",
    };
    const result = await runScript(input, env);
    assert.equal(result.code, 0);

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
    const input = JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Read" });
    const env = {
      FLIGHTDECK_SERVER: `http://127.0.0.1:${capture.port}`,
      FLIGHTDECK_TOKEN: "tok_test",
    };
    const result = await runScript(input, env);
    assert.equal(result.code, 0);

    const body = capture.bodies().at(-1);
    assert.equal(body.event_type, "tool_call");
    assert.equal(body.tool_name, "Read");
    assert.equal(body.flavor, "claude-code");
    assert.equal(body.agent_type, "developer");
  });

  it("maps Stop to session_end", async () => {
    const input = JSON.stringify({ hook_event_name: "Stop" });
    const env = {
      FLIGHTDECK_SERVER: `http://127.0.0.1:${capture.port}`,
      FLIGHTDECK_TOKEN: "tok_test",
    };
    const result = await runScript(input, env);
    assert.equal(result.code, 0);

    const body = capture.bodies().at(-1);
    assert.equal(body.event_type, "session_end");
    assert.equal(body.tool_name, null);
  });

  it("exits zero when FLIGHTDECK_SERVER is missing", async () => {
    const input = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash" });
    const env = {
      FLIGHTDECK_SERVER: "",
      FLIGHTDECK_TOKEN: "tok_test",
    };
    const result = await runScript(input, env);
    assert.equal(result.code, 0);
    assert.ok(result.stderr.includes("FLIGHTDECK_SERVER"));
  });

  it("exits zero when FLIGHTDECK_TOKEN is missing", async () => {
    const input = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash" });
    const env = {
      FLIGHTDECK_SERVER: "http://localhost:9999",
      FLIGHTDECK_TOKEN: "",
    };
    const result = await runScript(input, env);
    assert.equal(result.code, 0);
    assert.ok(result.stderr.includes("FLIGHTDECK_TOKEN"));
  });

  it("exits zero on network error", async () => {
    const input = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash" });
    // Point to a port nothing is listening on
    const env = {
      FLIGHTDECK_SERVER: "http://127.0.0.1:1",
      FLIGHTDECK_TOKEN: "tok_test",
    };
    const result = await runScript(input, env);
    assert.equal(result.code, 0);
    assert.ok(result.stderr.includes("POST failed"));
  });

  it("exits zero on unknown hook event", async () => {
    const input = JSON.stringify({ hook_event_name: "SomeUnknownHook" });
    const env = {
      FLIGHTDECK_SERVER: `http://127.0.0.1:${capture.port}`,
      FLIGHTDECK_TOKEN: "tok_test",
    };
    const countBefore = capture.bodies().length;
    const result = await runScript(input, env);
    assert.equal(result.code, 0);
    // Should not have sent any request
    assert.equal(capture.bodies().length, countBefore);
  });

  it("populates tool_name from tool field fallback", async () => {
    const input = JSON.stringify({ hook_event_name: "PostToolUse", tool: "Write" });
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

// In-process unit tests for the helpers exported from observe_cli.mjs.
// These call the functions directly rather than spawning a child --
// they exercise the pure logic (session id derivation, context
// collection, tool input sanitisation) without going through the full
// stdin/HTTP roundtrip.
describe("observe_cli helpers", () => {
  describe("getSessionId", () => {
    beforeEach(() => {
      delete process.env.CLAUDE_SESSION_ID;
      delete process.env.ANTHROPIC_CLAUDE_SESSION_ID;
      clearSessionMarkers();
    });

    it("prefers CLAUDE_SESSION_ID env var when set", () => {
      process.env.CLAUDE_SESSION_ID = "claude-test-id";
      assert.equal(getSessionId(), "claude-test-id");
    });

    it("falls back to ANTHROPIC_CLAUDE_SESSION_ID when CLAUDE_SESSION_ID unset", () => {
      process.env.ANTHROPIC_CLAUDE_SESSION_ID = "anthropic-test-id";
      assert.equal(getSessionId(), "anthropic-test-id");
    });

    it("returns the same id on repeated calls in the same cwd", () => {
      // The first call creates the marker file, the second reads it.
      // Stability across hook invocations is the whole point of the
      // file fallback: each Claude Code hook is its own Node process
      // so a pid-based id would yield a fresh session per tool call.
      const a = getSessionId();
      const b = getSessionId();
      assert.equal(a, b);
      assert.equal(a.length, 32);
    });
  });

  describe("collectContext", () => {
    it("returns hostname, os, arch, node_version", () => {
      const ctx = collectContext();
      assert.equal(typeof ctx, "object");
      assert.ok(ctx !== null);
      assert.equal(typeof ctx.hostname, "string");
      assert.ok(ctx.hostname.length > 0);
      assert.equal(typeof ctx.os, "string");
      assert.equal(typeof ctx.arch, "string");
      assert.equal(typeof ctx.node_version, "string");
      assert.equal(ctx.process_name, "claude-code");
      assert.equal(typeof ctx.pid, "number");
    });

    it("never throws even on minimal environment", () => {
      // No mocking framework, but we can verify the contract: even
      // when called repeatedly with no setup the function returns a
      // dict and doesn't propagate exceptions. The two-layer try/catch
      // structure inside collectContext means a single broken probe
      // (e.g. git not installed) only drops that one field.
      assert.doesNotThrow(() => {
        const ctx = collectContext();
        assert.ok(typeof ctx === "object");
        assert.ok(typeof ctx.hostname === "string");
      });
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
      assert.equal(result.command, "a".repeat(200));
    });

    it("truncates Task prompt to 100 characters", () => {
      const result = sanitizeToolInput({ prompt: "x".repeat(250) });
      assert.equal(result.prompt.length, 100);
    });

    it("returns null for empty / non-object input", () => {
      assert.equal(sanitizeToolInput(null), null);
      assert.equal(sanitizeToolInput(undefined), null);
      assert.equal(sanitizeToolInput("string"), null);
      assert.equal(sanitizeToolInput({}), null);
      assert.equal(sanitizeToolInput({ unknown_field: "x" }), null);
    });

    it("retains query and pattern fields", () => {
      const result = sanitizeToolInput({
        query: "API endpoints",
        pattern: "**/*.ts",
      });
      assert.equal(result.query, "API endpoints");
      assert.equal(result.pattern, "**/*.ts");
    });

    it("truncates query to 200 characters", () => {
      const result = sanitizeToolInput({ query: "q".repeat(300) });
      assert.equal(result.query.length, 200);
      assert.equal(result.query, "q".repeat(200));
    });

    it("truncates pattern to 200 characters", () => {
      const result = sanitizeToolInput({ pattern: "p".repeat(300) });
      assert.equal(result.pattern.length, 200);
      assert.equal(result.pattern, "p".repeat(200));
    });
  });

  describe("EVENT_MAP", () => {
    it("maps the three documented hook events", () => {
      assert.equal(EVENT_MAP.PreToolUse, "pre_call");
      assert.equal(EVENT_MAP.PostToolUse, "tool_call");
      assert.equal(EVENT_MAP.Stop, "session_end");
    });
  });
});

// End-to-end behavioural tests for the new fields added by FIX 2-6:
// session_start emission, tool_input capture, is_subagent_call flag,
// and PostToolUse latency. These spawn the script as a child process
// against a capture HTTP server, same pattern as the suite at the top.
describe("observe_cli end-to-end (new fields)", () => {
  let capture;

  before(async () => {
    capture = await startCaptureServer();
    // The session-started marker may already exist from earlier test
    // runs in the same cwd. Clean both the session id file and any
    // started-* marker so the first test in this block actually fires
    // session_start.
    clearSessionMarkers();
    const dir = join(tmpdir(), "flightdeck-plugin");
    try {
      // Best-effort cleanup of all started-* markers in the dir.
      const { readdirSync } = await import("node:fs");
      for (const f of readdirSync(dir)) {
        if (f.startsWith("started-")) {
          try {
            rmSync(join(dir, f));
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      /* dir may not exist yet */
    }
  });

  after(() => {
    capture.server.close();
  });

  it("first hook invocation emits session_start with context", async () => {
    const input = JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_input: { file_path: "/src/app.ts" },
    });
    const env = {
      FLIGHTDECK_SERVER: `http://127.0.0.1:${capture.port}`,
      FLIGHTDECK_TOKEN: "tok_test",
    };
    const result = await runScript(input, env);
    assert.equal(result.code, 0);

    const bodies = capture.bodies();
    // Two POSTs: session_start, then the actual pre_call.
    assert.ok(bodies.length >= 2);
    const sessionStart = bodies.find((b) => b.event_type === "session_start");
    assert.ok(sessionStart, "expected a session_start event");
    assert.equal(typeof sessionStart.context, "object");
    assert.equal(typeof sessionStart.context.hostname, "string");
    assert.equal(sessionStart.context.process_name, "claude-code");
    assert.equal(sessionStart.flavor, "claude-code");
  });

  it("subsequent invocations skip session_start", async () => {
    const before = capture.bodies().length;
    const input = JSON.stringify({
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_input: { file_path: "/src/other.ts" },
    });
    const env = {
      FLIGHTDECK_SERVER: `http://127.0.0.1:${capture.port}`,
      FLIGHTDECK_TOKEN: "tok_test",
    };
    const result = await runScript(input, env);
    assert.equal(result.code, 0);
    const after = capture.bodies().length;
    // Only ONE new POST -- the actual tool_call. session_start is
    // skipped because the marker file already exists from the first
    // test in this describe block.
    assert.equal(after - before, 1);
    assert.equal(capture.bodies().at(-1).event_type, "tool_call");
  });

  it("tool_input is null by default (capture off)", async () => {
    // FIX 3b: capture is opt-in. Without
    // FLIGHTDECK_CAPTURE_TOOL_INPUTS=true the dashboard should
    // never see command/file_path/query strings, mirroring the
    // capture_prompts default in the Python sensor (D019).
    const input = JSON.stringify({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls -la /etc" },
    });
    const env = {
      FLIGHTDECK_SERVER: `http://127.0.0.1:${capture.port}`,
      FLIGHTDECK_TOKEN: "tok_test",
    };
    const result = await runScript(input, env);
    assert.equal(result.code, 0);

    const body = capture.bodies().at(-1);
    assert.equal(body.event_type, "tool_call");
    assert.equal(body.tool_name, "Bash");
    assert.equal(body.tool_input, null);
  });

  it("tool_input is captured when FLIGHTDECK_CAPTURE_TOOL_INPUTS=true", async () => {
    const input = JSON.stringify({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls -la /etc" },
    });
    const env = {
      FLIGHTDECK_SERVER: `http://127.0.0.1:${capture.port}`,
      FLIGHTDECK_TOKEN: "tok_test",
      FLIGHTDECK_CAPTURE_TOOL_INPUTS: "true",
    };
    const result = await runScript(input, env);
    assert.equal(result.code, 0);

    const body = capture.bodies().at(-1);
    assert.equal(body.event_type, "tool_call");
    assert.equal(body.tool_name, "Bash");
    assert.equal(typeof body.tool_input, "string");
    const parsed = JSON.parse(body.tool_input);
    assert.equal(parsed.command, "ls -la /etc");
  });

  it("strips secret-bearing fields from tool_input when capture is on", async () => {
    // The dashboard must never see file content -- only path. This
    // test sends both fields and verifies content does not appear
    // anywhere in the serialised tool_input.
    const input = JSON.stringify({
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_input: {
        file_path: "/src/secret.ts",
        content: "API_KEY=sk-supersecret",
      },
    });
    const env = {
      FLIGHTDECK_SERVER: `http://127.0.0.1:${capture.port}`,
      FLIGHTDECK_TOKEN: "tok_test",
      FLIGHTDECK_CAPTURE_TOOL_INPUTS: "true",
    };
    const result = await runScript(input, env);
    assert.equal(result.code, 0);

    const body = capture.bodies().at(-1);
    assert.equal(typeof body.tool_input, "string");
    assert.ok(!body.tool_input.includes("supersecret"));
    assert.ok(!body.tool_input.includes("API_KEY"));
    const parsed = JSON.parse(body.tool_input);
    assert.equal(parsed.file_path, "/src/secret.ts");
  });

  it("flags Task tool calls as subagent invocations and stamps parent_session_id", async () => {
    // FIX 3c: a Task tool call is the spawn point of a sub-agent.
    // The event payload includes parent_session_id = current session
    // so any downstream sub-agent rollup can correlate child sessions
    // back to the parent that issued the Task.
    const input = JSON.stringify({
      hook_event_name: "PostToolUse",
      tool_name: "Task",
      tool_input: { prompt: "audit the auth middleware" },
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
    assert.equal(typeof body.parent_session_id, "string");
    assert.equal(body.parent_session_id, body.session_id);
  });

  it("non-Task tool calls are not flagged as subagent and have null parent_session_id", async () => {
    const input = JSON.stringify({
      hook_event_name: "PostToolUse",
      tool_name: "Read",
    });
    const env = {
      FLIGHTDECK_SERVER: `http://127.0.0.1:${capture.port}`,
      FLIGHTDECK_TOKEN: "tok_test",
    };
    const result = await runScript(input, env);
    assert.equal(result.code, 0);

    const body = capture.bodies().at(-1);
    assert.equal(body.is_subagent_call, false);
    assert.equal(body.parent_session_id, null);
  });

  it("PostToolUse populates latency_ms; PreToolUse leaves it null", async () => {
    const post = await runScript(
      JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Read" }),
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
      JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Read" }),
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
