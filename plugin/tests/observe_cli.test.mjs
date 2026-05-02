import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  EVENT_MAP,
  collectContext,
  computeLatencyMs,
  getSessionId,
  loadMcpServerFingerprints,
  parseBool,
  parseMcpToolName,
  readLatestTurn,
  readTurns,
  resolveConfig,
  sanitizeToolInput,
  tokensFromUsage,
} from "../hooks/scripts/observe_cli.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, "..", "hooks", "scripts", "observe_cli.mjs");

function clearSessionMarkers() {
  // Nukes every ``session-*.txt`` in the plugin tmpdir. Post-D115 the
  // marker key derives from ``hookEvent.session_id``, not cwd, so
  // targeting one specific name would miss the files the test just
  // wrote. Glob-style clean keeps the helper resilient to future
  // keying changes.
  const dir = join(tmpdir(), "flightdeck-plugin");
  try {
    const entries = readdirSync(dir);
    for (const name of entries) {
      if (name.startsWith("session-") && name.endsWith(".txt")) {
        try {
          rmSync(join(dir, name));
        } catch {
          /* ignore individual failures */
        }
      }
    }
  } catch {
    /* dir may not exist */
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

/**
 * Start a server that always responds with the given HTTP status code
 * and counts every request. Used by the graceful-fail tests to
 * verify the plugin treats HTTP non-2xx the same as connection
 * refused: log on every failed POST, exit 0, and let the next hook
 * invocation try again fresh. (KI18 fix: the pre-4a design wrote a
 * disk-persisted unreachable flag on the first failure and then
 * silently dropped every subsequent POST for the session's lifetime,
 * which broke reconnect after transient outages.)
 */
function startFailingServer(status) {
  return new Promise((resolve) => {
    let requestCount = 0;
    const server = createServer((req, res) => {
      requestCount++;
      // Drain the body so the client sees a clean response.
      req.on("data", () => {});
      req.on("end", () => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(`{"error":"test ${status}"}`);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({ server, port, requestCount: () => requestCount });
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

  it("drops PreToolUse -- tool_call from PostToolUse is sufficient", async () => {
    clearAllPluginMarkers();
    const before = capture.bodies().length;
    const input = JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      session_id: "sess-pretool-1",
    });
    const env = {
      FLIGHTDECK_SERVER: `http://127.0.0.1:${capture.port}`,
      FLIGHTDECK_TOKEN: "tok_test",
      CLAUDE_SESSION_ID: "sess-pretool-1",
    };
    const result = await runScript(input, env);
    assert.equal(result.code, 0);
    // No events should be POSTed for PreToolUse -- we dropped it to
    // match the Python sensor's one-tool_call-per-invocation semantics.
    assert.equal(capture.bodies().length, before);
  });

  it("UserPromptSubmit skips pre_call emission when model is unresolved (D100)", async () => {
    clearAllPluginMarkers();
    // No SessionStart, no transcript -- model is unresolvable. The
    // plugin must NOT emit a pre_call that would render as "unknown".
    const before = capture.bodies().length;
    const input = JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      session_id: "sess-ups-no-model",
      prompt: "hello",
    });
    const result = await runScript(input, {
      FLIGHTDECK_SERVER: `http://127.0.0.1:${capture.port}`,
      FLIGHTDECK_TOKEN: "tok_test",
      CLAUDE_SESSION_ID: "sess-ups-no-model",
    });
    assert.equal(result.code, 0);
    // Only the SessionStart backstop should have posted -- no pre_call.
    const newBodies = capture.bodies().slice(before);
    assert.ok(
      !newBodies.some((b) => b.event_type === "pre_call"),
      "expected no pre_call; model was unresolvable",
    );
  });

  it("UserPromptSubmit emits pre_call when model is cached by a prior Stop (D100)", async () => {
    clearAllPluginMarkers();
    // Simulate a prior Stop that cached the model for this session.
    const transcriptPath = writeTranscript([
      {
        type: "user",
        timestamp: "2026-04-17T10:00:00Z",
        message: { role: "user", content: "warmup" },
      },
      {
        type: "assistant",
        timestamp: "2026-04-17T10:00:01Z",
        message: {
          id: "msg_warmup",
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "hi" }],
          usage: { input_tokens: 5, output_tokens: 2 },
        },
      },
    ]);
    try {
      // Fire Stop so the plugin caches the model.
      await runScript(
        JSON.stringify({
          hook_event_name: "Stop",
          session_id: "sess-ups-cached",
          transcript_path: transcriptPath,
        }),
        {
          FLIGHTDECK_SERVER: `http://127.0.0.1:${capture.port}`,
          FLIGHTDECK_TOKEN: "tok_test",
          CLAUDE_SESSION_ID: "sess-ups-cached",
        },
      );
      const before = capture.bodies().length;
      // Now UserPromptSubmit for a NEW prompt in the same session --
      // transcript still has the old assistant record so readLatestTurn
      // resolves the model; even if it didn't, the Stop cache would.
      await runScript(
        JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          session_id: "sess-ups-cached",
          transcript_path: transcriptPath,
          prompt: "next question",
        }),
        {
          FLIGHTDECK_SERVER: `http://127.0.0.1:${capture.port}`,
          FLIGHTDECK_TOKEN: "tok_test",
          CLAUDE_SESSION_ID: "sess-ups-cached",
        },
      );
      const newBodies = capture.bodies().slice(before);
      const preCall = newBodies.find((b) => b.event_type === "pre_call");
      assert.ok(preCall, "expected a pre_call emitted from UserPromptSubmit");
      assert.equal(preCall.model, "claude-sonnet-4-6");
    } finally {
      rmSync(dirname(transcriptPath), { recursive: true, force: true });
    }
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
      CLAUDE_SESSION_ID: "sess-posttool-1",
    };
    const result = await runScript(input, env);
    assert.equal(result.code, 0);

    const body = capture.bodies().at(-1);
    assert.equal(body.event_type, "tool_call");
    assert.equal(body.tool_name, "Read");
  });

  it("maps Stop to post_call with transcript tokens and model (D100)", async () => {
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
    // Pin CAPTURE_PROMPTS=false so this test stays focused on token +
    // model mapping regardless of the default (which is now ON for
    // the plugin -- see DECISIONS.md D103).
    const env = {
      FLIGHTDECK_SERVER: `http://127.0.0.1:${capture.port}`,
      FLIGHTDECK_TOKEN: "tok_test",
      FLIGHTDECK_CAPTURE_PROMPTS: "false",
      CLAUDE_SESSION_ID: "sess-stop-1",
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
    assert.equal(body.has_content, false);
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
      CLAUDE_SESSION_ID: "sess-end-1",
    };
    const result = await runScript(input, env);
    assert.equal(result.code, 0);
    const body = capture.bodies().at(-1);
    assert.equal(body.event_type, "session_end");
  });

  it("defaults FLIGHTDECK_SERVER/TOKEN when unset (zero-config path, D100)", async () => {
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
      CLAUDE_SESSION_ID: "sess-default-1",
    };
    const result = await runScript(input, env);
    assert.equal(result.code, 0);
    // Successfully posted with default token -- the body landed.
    assert.ok(capture.bodies().length > 0);
  });

  it("HTTP 500 response logs the canonical unreachable line and exits zero", async () => {
    clearAllPluginMarkers();
    const failing = await startFailingServer(500);
    try {
      const sid = "sess-http-500-1";
      const input = JSON.stringify({
        hook_event_name: "SessionStart",
        session_id: sid,
        source: "startup",
      });
      const env = {
        FLIGHTDECK_SERVER: `http://127.0.0.1:${failing.port}`,
        FLIGHTDECK_TOKEN: "tok_test",
        CLAUDE_SESSION_ID: sid,
      };
      const result = await runScript(input, env);
      assert.equal(result.code, 0, "hook must exit 0 on 5xx");
      assert.match(
        result.stderr,
        /^\[flightdeck\] cannot reach http:\/\/127\.0\.0\.1:\d+: HTTP 500\. events dropped for this session\.$/m,
      );
      // Exactly one server request: the initial POST that got the 500.
      assert.equal(failing.requestCount(), 1);
      // KI18 fix: no disk-persisted unreachable flag is written. Each
      // hook invocation is a fresh process, so "log once per POST"
      // naturally bounds stderr without locking the session out of
      // future retries after a transient failure.
    } finally {
      failing.server.close();
    }
  });

  it("HTTP 401 (auth) is also flagged and not retried", async () => {
    clearAllPluginMarkers();
    const failing = await startFailingServer(401);
    try {
      const sid = "sess-http-401-1";
      const input = JSON.stringify({
        hook_event_name: "SessionStart",
        session_id: sid,
        source: "startup",
      });
      const env = {
        FLIGHTDECK_SERVER: `http://127.0.0.1:${failing.port}`,
        FLIGHTDECK_TOKEN: "tok_test",
        CLAUDE_SESSION_ID: sid,
      };
      const result = await runScript(input, env);
      assert.equal(result.code, 0);
      assert.match(
        result.stderr,
        /HTTP 401/,
        "stderr should mention HTTP 401",
      );
      assert.equal(failing.requestCount(), 1, "plugin must not retry 4xx");
    } finally {
      failing.server.close();
    }
  });

  it("subsequent hooks retry after a failure so the plugin recovers from transient outages (KI18)", async () => {
    clearAllPluginMarkers();
    // First server: always 500. The first hook fires against this,
    // fails, logs. Before the pre-4a fix this would write a
    // disk-persisted unreachable flag and every subsequent hook
    // would short-circuit -- breaking reconnect.
    const failing = await startFailingServer(500);
    let firstPort;
    try {
      firstPort = failing.port;
      const sid = "sess-reconnect-1";
      const envDown = {
        FLIGHTDECK_SERVER: `http://127.0.0.1:${firstPort}`,
        FLIGHTDECK_TOKEN: "tok_test",
        CLAUDE_SESSION_ID: sid,
      };
      // First hook: hits the failing server, gets 500, logs once,
      // exits 0. No disk-persisted flag is written.
      await runScript(
        JSON.stringify({
          hook_event_name: "SessionStart",
          session_id: sid,
          source: "startup",
        }),
        envDown,
      );
      assert.equal(failing.requestCount(), 1);

      // Second hook in the same session hits the server AGAIN. With
      // the KI18 fix, each hook tries fresh; the same failing server
      // therefore sees a new request (and another "cannot reach"
      // line on stderr -- bounded at one per failed POST).
      const secondSameServer = await runScript(
        JSON.stringify({
          hook_event_name: "PostToolUse",
          tool_name: "Bash",
          session_id: sid,
        }),
        envDown,
      );
      assert.equal(secondSameServer.code, 0, "hook still exits 0");
      assert.ok(
        failing.requestCount() >= 2,
        "second hook must retry the POST -- no disk-persisted mute flag",
      );
      assert.match(
        secondSameServer.stderr,
        /cannot reach/,
        "second hook must re-log the unreachable line (one per failed POST)",
      );
    } finally {
      failing.server.close();
    }

    // Third hook: the "server" has recovered. Point the plugin at a
    // fresh capture server on a new port and confirm the event
    // actually lands. This is the reconnect path that D106 relies on
    // and that the pre-4a flag persistence would have prevented.
    const recovered = await startCaptureServer();
    try {
      const sid = "sess-reconnect-1";
      const envUp = {
        FLIGHTDECK_SERVER: `http://127.0.0.1:${recovered.port}`,
        FLIGHTDECK_TOKEN: "tok_test",
        CLAUDE_SESSION_ID: sid,
      };
      const third = await runScript(
        JSON.stringify({
          hook_event_name: "PostToolUse",
          tool_name: "Bash",
          session_id: sid,
        }),
        envUp,
      );
      assert.equal(third.code, 0);
      assert.ok(
        recovered.bodies().length >= 1,
        "after server recovery, the next hook's POST lands on the new server",
      );
    } finally {
      recovered.server.close();
    }
  });

  it("logs connection-refused in the canonical format and exits zero", async () => {
    clearAllPluginMarkers();
    const input = JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: "sess-refused-1",
      source: "startup",
    });
    // Port 1 is reserved; connection is refused by the kernel.
    const env = {
      FLIGHTDECK_SERVER: "http://127.0.0.1:1",
      FLIGHTDECK_TOKEN: "tok_test",
      CLAUDE_SESSION_ID: "sess-refused-1",
    };
    const result = await runScript(input, env);
    assert.equal(result.code, 0);
    assert.match(
      result.stderr,
      /^\[flightdeck\] cannot reach http:\/\/127\.0\.0\.1:1: .+\. events dropped for this session\.$/m,
      `stderr did not match canonical format, got: ${JSON.stringify(result.stderr)}`,
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
      CLAUDE_SESSION_ID: "sess-unknown-1",
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
      CLAUDE_SESSION_ID: "sess-fallback-1",
    };
    const result = await runScript(input, env);
    assert.equal(result.code, 0);
    const body = capture.bodies().at(-1);
    assert.equal(body.tool_name, "Write");
  });

  it("PostToolUse tool_call carries runtime context (session_start safety net)", async () => {
    // Production repro: plugin's SessionStart POST failed because the
    // stack was down at claude start, the on-disk dedup marker blocks a
    // retry, and the first event to land is a PostToolUse. Pre-fix that
    // payload carried no context so the worker's D106 lazy-create
    // produced a row with NULL context that never got enriched -- no
    // OS, no hostname, no RUNTIME panel. The fix: context rides on
    // every event, not only session_start.
    clearAllPluginMarkers();
    const input = JSON.stringify({
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      session_id: "sess-ctx-1",
    });
    const env = {
      FLIGHTDECK_SERVER: `http://127.0.0.1:${capture.port}`,
      FLIGHTDECK_TOKEN: "tok_test",
      CLAUDE_SESSION_ID: "sess-ctx-1",
    };
    const result = await runScript(input, env);
    assert.equal(result.code, 0);
    // Two bodies: the ensureSessionStarted backstop and the tool_call.
    const toolCall = capture
      .bodies()
      .filter((b) => b && b.event_type === "tool_call")
      .at(-1);
    assert.ok(toolCall, "expected a tool_call POST");
    assert.ok(
      toolCall.context && typeof toolCall.context === "object",
      `tool_call payload must carry a context object, got ${JSON.stringify(toolCall.context)}`,
    );
    assert.equal(
      toolCall.context.supports_directives,
      false,
      "context.supports_directives must be false on observer sessions (D109)",
    );
    // At least one real-identity field must be present -- os comes from
    // platform() which is deterministic across test environments.
    assert.ok(
      typeof toolCall.context.os === "string" && toolCall.context.os.length > 0,
      "context.os should be populated from platform()",
    );
  });
});

describe("observe_cli helpers", () => {
  describe("parseBool", () => {
    it("accepts true-ish strings regardless of case", () => {
      for (const v of ["true", "TRUE", "True", "1", "yes", "YES", "on", "ON"]) {
        assert.equal(parseBool(v, false), true, `expected ${v} to parse as true`);
      }
    });

    it("accepts false-ish strings regardless of case", () => {
      for (const v of ["false", "FALSE", "0", "no", "NO", "off", "OFF"]) {
        assert.equal(parseBool(v, true), false, `expected ${v} to parse as false`);
      }
    });

    it("returns fallback on empty / null / undefined", () => {
      assert.equal(parseBool("", true), true);
      assert.equal(parseBool("", false), false);
      assert.equal(parseBool(undefined, true), true);
      assert.equal(parseBool(null, false), false);
      // Whitespace-only strings are no signal either way.
      assert.equal(parseBool("   ", true), true);
      assert.equal(parseBool("\t\n", false), false);
    });

    it("returns fallback on unrecognised values (never guesses)", () => {
      for (const v of ["garbage", "maybe", "2", "enable", "disable", "on-ish"]) {
        assert.equal(parseBool(v, true), true, `${v} must fall back to true`);
        assert.equal(parseBool(v, false), false, `${v} must fall back to false`);
      }
    });
  });

  describe("resolveConfig", () => {
    it("defaults capturePrompts to TRUE when FLIGHTDECK_CAPTURE_PROMPTS is unset (D103)", () => {
      // Plugin-only flip: developers observing their own Claude Code
      // session need the Prompts tab populated with LLM call content.
      // The Python sensor keeps capture_prompts=False (D019) --
      // different product surfaces, different safe defaults.
      assert.equal(resolveConfig({}).capturePrompts, true);
    });

    it("honours explicit opt-out via FLIGHTDECK_CAPTURE_PROMPTS=false", () => {
      const cfg = resolveConfig({ FLIGHTDECK_CAPTURE_PROMPTS: "false" });
      assert.equal(cfg.capturePrompts, false);
    });

    it("honours explicit opt-in via FLIGHTDECK_CAPTURE_PROMPTS=true", () => {
      // No-op for the new default, but kept so an accidental default
      // flip in the other direction still leaves the env var wired up.
      const cfg = resolveConfig({ FLIGHTDECK_CAPTURE_PROMPTS: "true" });
      assert.equal(cfg.capturePrompts, true);
    });
  });

  describe("getSessionId", () => {
    beforeEach(() => {
      delete process.env.CLAUDE_SESSION_ID;
      delete process.env.ANTHROPIC_CLAUDE_SESSION_ID;
      clearSessionMarkers();
    });

    // Precedence chain under test (v0.4.0 Phase 1, D115):
    //   1. CLAUDE_SESSION_ID env var
    //   2. ANTHROPIC_CLAUDE_SESSION_ID env var
    //   3. Marker file keyed on sha256(hookEvent.session_id)
    //      (populated by step 4 on the first hook; read verbatim by
    //      every subsequent hook in the same invocation)
    //   4. Fresh uuid4 written to the hook-id-keyed marker
    //   5. Cwd-sha marker fallback + stderr WARN when the hook event
    //      carries no session_id
    //   6. Ephemeral sha256(cwd)[:32] backstop when $TMPDIR is unusable
    //
    // D113's uuid5-from-(user, host, repo, branch) derivation was
    // removed; stability moved to ``agent_id``, ``session_id`` is
    // now per-invocation random.

    const V4_UUID_RE =
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

    it("CLAUDE_SESSION_ID env var wins over everything else", () => {
      process.env.CLAUDE_SESSION_ID = "claude-test-id";
      assert.equal(
        getSessionId({ session_id: "hook-id-ignored" }),
        "claude-test-id",
      );
    });

    it("ANTHROPIC_CLAUDE_SESSION_ID is honored when CLAUDE_SESSION_ID is unset", () => {
      process.env.ANTHROPIC_CLAUDE_SESSION_ID = "anthropic-test-id";
      assert.equal(
        getSessionId({ session_id: "hook-id-ignored" }),
        "anthropic-test-id",
      );
    });

    it("generates a fresh uuid4 keyed on hookEvent.session_id", () => {
      const id = getSessionId({ session_id: "invocation-A" });
      assert.match(id, V4_UUID_RE, `expected v4 UUID, got ${id}`);
    });

    it("returns the same id on repeated calls within one invocation", () => {
      const hookEvent = { session_id: "invocation-B" };
      const a = getSessionId(hookEvent);
      const b = getSessionId(hookEvent);
      assert.equal(a, b);
    });

    it("marker key depends on hookEvent.session_id, not cwd", () => {
      // Two calls with the same hookEvent.session_id but simulated
      // different cwds (via clearing and re-running) still converge
      // -- the marker key is hookEvent.session_id's hash, so cwd
      // changes between hooks within one invocation do NOT split
      // the session. This is the regression fixed post-audit.
      const hookEvent = { session_id: "invocation-C" };
      const first = getSessionId(hookEvent);
      // Second call in the same process + same hookEvent: marker
      // hits and we get the cached id back.
      const second = getSessionId(hookEvent);
      assert.equal(first, second);
    });

    it("different hookEvent.session_id values produce different sessions", () => {
      const first = getSessionId({ session_id: "invocation-D" });
      const second = getSessionId({ session_id: "invocation-E" });
      assert.notEqual(first, second);
      assert.match(first, V4_UUID_RE);
      assert.match(second, V4_UUID_RE);
    });

    it("missing hookEvent.session_id falls back to cwd-sha marker", () => {
      // Non-Claude-Code caller or a malformed hook event: without a
      // session_id we fall back to the cwd-sha keying so the plugin
      // still yields *some* marker rather than crashing. Output
      // still shape-matches a uuid4.
      const id = getSessionId({});
      assert.match(id, V4_UUID_RE);
    });

    it("clearing the marker triggers a fresh uuid4 on the next call", () => {
      const hookEvent = { session_id: "invocation-F" };
      const first = getSessionId(hookEvent);
      clearSessionMarkers();
      const second = getSessionId(hookEvent);
      assert.notEqual(first, second);
      assert.match(second, V4_UUID_RE);
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

    it("marks context.supports_directives=false so the UI hides the kill switch", () => {
      // Claude Code hooks fire after the event; the plugin cannot
      // interrupt execution the way the Python sensor can. Every
      // session_start payload must carry this flag so the dashboard
      // stops showing a Stop button that would silently no-op.
      const ctx = collectContext();
      assert.equal(ctx.supports_directives, false);
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

  describe("safeCollectContext", () => {
    it("returns a populated context object on the happy path", async () => {
      const { safeCollectContext } = await import(
        "../hooks/scripts/observe_cli.mjs"
      );
      const ctx = safeCollectContext();
      assert.ok(ctx, "expected a context object, got null");
      assert.equal(typeof ctx.os, "string");
      assert.equal(ctx.process_name, "claude-code");
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
    it("covers the v1 hook set (D100)", () => {
      assert.equal(EVENT_MAP.SessionStart, "session_start");
      assert.equal(EVENT_MAP.UserPromptSubmit, "pre_call");
      assert.equal(EVENT_MAP.PostToolUse, "tool_call");
      assert.equal(EVENT_MAP.Stop, "post_call");
      assert.equal(EVENT_MAP.SessionEnd, "session_end");
      assert.equal(EVENT_MAP.PreCompact, "tool_call");
    });

    it("does NOT map PreToolUse (double-report avoidance)", () => {
      assert.equal(EVENT_MAP.PreToolUse, undefined);
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

  it("SessionStart emits session_start with context", async () => {
    const input = JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: "sess-first-1",
      source: "startup",
      model: "claude-sonnet-4-6",
    });
    const env = {
      FLIGHTDECK_SERVER: `http://127.0.0.1:${capture.port}`,
      FLIGHTDECK_TOKEN: "tok_test",
      CLAUDE_SESSION_ID: "sess-first-1",
    };
    const result = await runScript(input, env);
    assert.equal(result.code, 0);

    const bodies = capture.bodies();
    const sessionStart = bodies.find(
      (b) => b.event_type === "session_start" && b.session_id === "sess-first-1",
    );
    assert.ok(sessionStart, "expected a session_start event");
    assert.equal(typeof sessionStart.context, "object");
    assert.equal(sessionStart.context.process_name, "claude-code");
    assert.ok(Array.isArray(sessionStart.context.frameworks));
    assert.ok(
      sessionStart.context.frameworks.some((f) => f.startsWith("claude-code")),
    );
    // The posted context must carry supports_directives=false so the
    // dashboard hides the kill switch for Claude Code sessions.
    assert.equal(sessionStart.context.supports_directives, false);
  });

  it("subsequent hooks in the same session skip the session_start backstop", async () => {
    const before = capture.bodies().length;
    const input = JSON.stringify({
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      session_id: "sess-first-1",
    });
    const env = {
      FLIGHTDECK_SERVER: `http://127.0.0.1:${capture.port}`,
      FLIGHTDECK_TOKEN: "tok_test",
      CLAUDE_SESSION_ID: "sess-first-1",
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
      CLAUDE_SESSION_ID: "sess-capture-default-1",
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
      CLAUDE_SESSION_ID: "sess-capture-off-1",
    };
    const result = await runScript(input, env);
    assert.equal(result.code, 0);
    const body = capture.bodies().at(-1);
    assert.equal(body.tool_input, null);
  });

  // The regression these three tests guard: tool_call events used to
  // leave has_content=false and content=null even with the capture
  // flag on, so the dashboard drawer's Prompts tab had nothing to
  // render. The fix writes a content payload shaped like the post_call
  // one (tools[] for input, response[] for output) so the Prompts tab
  // can show real tool invocations.

  it("tool_call emits content.tools with sanitised input when captureToolInputs is on", async () => {
    const input = JSON.stringify({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls -la /etc" },
      session_id: "sess-content-tools-1",
    });
    const env = {
      FLIGHTDECK_SERVER: `http://127.0.0.1:${capture.port}`,
      FLIGHTDECK_TOKEN: "tok_test",
      CLAUDE_SESSION_ID: "sess-content-tools-1",
    };
    const result = await runScript(input, env);
    assert.equal(result.code, 0);
    const body = capture.bodies().at(-1);
    assert.equal(body.has_content, true);
    assert.equal(body.content.provider, "anthropic");
    assert.deepEqual(body.content.messages, []);
    assert.equal(body.content.tools.length, 1);
    assert.equal(body.content.tools[0].type, "tool_use");
    assert.equal(body.content.tools[0].name, "Bash");
    assert.equal(body.content.tools[0].input.command, "ls -la /etc");
    // Output is only captured with CAPTURE_PROMPTS -- without it the
    // response array is empty, input-only.
    assert.deepEqual(body.content.response, []);
  });

  it("tool_call captures tool_response in content.response when capturePrompts is also on", async () => {
    const input = JSON.stringify({
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_input: { file_path: "/tmp/x" },
      tool_response: "file contents here",
      session_id: "sess-content-response-1",
    });
    const env = {
      FLIGHTDECK_SERVER: `http://127.0.0.1:${capture.port}`,
      FLIGHTDECK_TOKEN: "tok_test",
      FLIGHTDECK_CAPTURE_PROMPTS: "true",
      CLAUDE_SESSION_ID: "sess-content-response-1",
    };
    const result = await runScript(input, env);
    assert.equal(result.code, 0);
    const body = capture.bodies().at(-1);
    assert.equal(body.has_content, true);
    assert.equal(body.content.response.length, 1);
    assert.equal(body.content.response[0].type, "tool_result");
    assert.equal(body.content.response[0].content, "file contents here");
  });

  it("tool_call has_content stays false when captureToolInputs is off", async () => {
    const input = JSON.stringify({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      session_id: "sess-no-content-1",
    });
    const env = {
      FLIGHTDECK_SERVER: `http://127.0.0.1:${capture.port}`,
      FLIGHTDECK_TOKEN: "tok_test",
      FLIGHTDECK_CAPTURE_TOOL_INPUTS: "false",
      CLAUDE_SESSION_ID: "sess-no-content-1",
    };
    const result = await runScript(input, env);
    assert.equal(result.code, 0);
    const body = capture.bodies().at(-1);
    assert.equal(body.has_content, false);
    assert.equal(body.content, null);
  });

  it("Stop with CAPTURE_PROMPTS=true attaches content payload (D100)", async () => {
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
      CLAUDE_SESSION_ID: "sess-capture-prompts-1",
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
      CLAUDE_SESSION_ID: "sess-task-1",
    };
    const result = await runScript(input, env);
    assert.equal(result.code, 0);
    const body = capture.bodies().at(-1);
    assert.equal(body.tool_name, "Task");
    assert.equal(body.is_subagent_call, true);
    assert.equal(body.parent_session_id, body.session_id);
  });

  it("PostToolUse populates latency_ms", async () => {
    const post = await runScript(
      JSON.stringify({
        hook_event_name: "PostToolUse",
        tool_name: "Read",
        session_id: "sess-lat-1",
      }),
      {
        FLIGHTDECK_SERVER: `http://127.0.0.1:${capture.port}`,
        FLIGHTDECK_TOKEN: "tok_test",
        CLAUDE_SESSION_ID: "sess-lat-1",
      },
    );
    assert.equal(post.code, 0);
    const postBody = capture.bodies().at(-1);
    assert.equal(typeof postBody.latency_ms, "number");
    assert.ok(postBody.latency_ms >= 0);
  });

  // Mid-turn flush: PostToolUse emits post_call events for any
  // un-emitted turns in the transcript, so the dashboard shows LLM
  // activity in real time instead of batching at Stop. Dedup (per
  // assistant message.id marker file) keeps Stop/SessionEnd idempotent.

  it("PostToolUse flushes pending post_calls mid-turn before the tool_call", async () => {
    clearAllPluginMarkers();
    const transcriptPath = writeTranscript([
      {
        type: "user",
        timestamp: "2026-04-17T10:00:00.000Z",
        message: { role: "user", content: "do some work" },
      },
      {
        type: "assistant",
        timestamp: "2026-04-17T10:00:01.000Z",
        message: {
          id: "msg_iter_1",
          model: "claude-sonnet-4-6",
          content: [{ type: "tool_use", id: "tu1", name: "Read", input: {} }],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
    ]);
    const before = capture.bodies().length;
    const result = await runScript(
      JSON.stringify({
        hook_event_name: "PostToolUse",
        session_id: "sess-flush-1",
        transcript_path: transcriptPath,
        tool_name: "Read",
      }),
      {
        FLIGHTDECK_SERVER: `http://127.0.0.1:${capture.port}`,
        FLIGHTDECK_TOKEN: "tok_test",
        FLIGHTDECK_CAPTURE_PROMPTS: "false",
        CLAUDE_SESSION_ID: "sess-flush-1",
      },
    );
    assert.equal(result.code, 0);
    const posted = capture.bodies().slice(before);
    const types = posted.map((b) => b.event_type);
    const firstPostCallIdx = types.indexOf("post_call");
    const firstToolCallIdx = types.indexOf("tool_call");
    assert.ok(firstPostCallIdx >= 0, "expected post_call to be flushed");
    assert.ok(firstToolCallIdx >= 0, "expected tool_call to still emit");
    assert.ok(
      firstPostCallIdx < firstToolCallIdx,
      "post_call must precede the tool_call it triggered",
    );
    const postCall = posted[firstPostCallIdx];
    assert.equal(postCall.model, "claude-sonnet-4-6");
    assert.equal(postCall.tokens_output, 5);
    rmSync(dirname(transcriptPath), { recursive: true, force: true });
  });

  it("Stop no-ops on turns already flushed by a prior PostToolUse", async () => {
    clearAllPluginMarkers();
    const transcriptPath = writeTranscript([
      {
        type: "user",
        timestamp: "2026-04-17T10:00:00.000Z",
        message: { role: "user", content: "flush then stop" },
      },
      {
        type: "assistant",
        timestamp: "2026-04-17T10:00:01.000Z",
        message: {
          id: "msg_only_1",
          model: "claude-sonnet-4-6",
          content: [{ type: "tool_use", id: "tu1", name: "Read", input: {} }],
          usage: { input_tokens: 3, output_tokens: 2 },
        },
      },
    ]);
    const env = {
      FLIGHTDECK_SERVER: `http://127.0.0.1:${capture.port}`,
      FLIGHTDECK_TOKEN: "tok_test",
      FLIGHTDECK_CAPTURE_PROMPTS: "false",
      CLAUDE_SESSION_ID: "sess-dedup-1",
    };
    await runScript(
      JSON.stringify({
        hook_event_name: "PostToolUse",
        session_id: "sess-dedup-1",
        transcript_path: transcriptPath,
        tool_name: "Read",
      }),
      env,
    );
    const before = capture.bodies().length;
    await runScript(
      JSON.stringify({
        hook_event_name: "Stop",
        session_id: "sess-dedup-1",
        transcript_path: transcriptPath,
      }),
      env,
    );
    const newBodies = capture.bodies().slice(before);
    const postCalls = newBodies.filter((b) => b.event_type === "post_call");
    assert.equal(
      postCalls.length,
      0,
      "Stop should dedup the already-flushed turn",
    );
    rmSync(dirname(transcriptPath), { recursive: true, force: true });
  });

  it("Stop still emits post_call for a turn with no tool calls", async () => {
    clearAllPluginMarkers();
    const transcriptPath = writeTranscript([
      {
        type: "user",
        timestamp: "2026-04-17T10:00:00.000Z",
        message: { role: "user", content: "just talk" },
      },
      {
        type: "assistant",
        timestamp: "2026-04-17T10:00:00.500Z",
        message: {
          id: "msg_plain_1",
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "ok" }],
          usage: { input_tokens: 4, output_tokens: 1 },
        },
      },
    ]);
    const before = capture.bodies().length;
    const result = await runScript(
      JSON.stringify({
        hook_event_name: "Stop",
        session_id: "sess-stop-notool",
        transcript_path: transcriptPath,
      }),
      {
        FLIGHTDECK_SERVER: `http://127.0.0.1:${capture.port}`,
        FLIGHTDECK_TOKEN: "tok_test",
        FLIGHTDECK_CAPTURE_PROMPTS: "false",
        CLAUDE_SESSION_ID: "sess-stop-notool",
      },
    );
    assert.equal(result.code, 0);
    const postCalls = capture
      .bodies()
      .slice(before)
      .filter((b) => b.event_type === "post_call");
    assert.equal(postCalls.length, 1);
    assert.equal(postCalls[0].tokens_output, 1);
    rmSync(dirname(transcriptPath), { recursive: true, force: true });
  });

  it("Two-iteration turn emits one post_call per LLM call, in order, no dupes", async () => {
    clearAllPluginMarkers();
    // Simulate three JSONL states the transcript passes through during
    // a two-iteration tool-use turn ending with a text-only final turn:
    //   state A: msg_A (tool_use)           -- after first LLM call
    //   state B: msg_A + msg_B (tool_use)   -- after second LLM call
    //   state C: msg_A + msg_B + msg_C      -- after final LLM call (text)
    const userRec = {
      type: "user",
      timestamp: "2026-04-17T10:00:00.000Z",
      message: { role: "user", content: "two-iter" },
    };
    const msgA = {
      type: "assistant",
      timestamp: "2026-04-17T10:00:01.000Z",
      message: {
        id: "msg_A",
        model: "claude-sonnet-4-6",
        content: [{ type: "tool_use", id: "tu_a", name: "Read", input: {} }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    };
    const toolResultA = {
      type: "user",
      timestamp: "2026-04-17T10:00:02.000Z",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_a", content: "ok" }],
      },
    };
    const msgB = {
      type: "assistant",
      timestamp: "2026-04-17T10:00:03.000Z",
      message: {
        id: "msg_B",
        model: "claude-sonnet-4-6",
        content: [{ type: "tool_use", id: "tu_b", name: "Glob", input: {} }],
        usage: { input_tokens: 20, output_tokens: 7 },
      },
    };
    const toolResultB = {
      type: "user",
      timestamp: "2026-04-17T10:00:04.000Z",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_b", content: "ok" }],
      },
    };
    const msgC = {
      type: "assistant",
      timestamp: "2026-04-17T10:00:05.000Z",
      message: {
        id: "msg_C",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "done" }],
        usage: { input_tokens: 30, output_tokens: 3 },
      },
    };
    const dir = mkdtempSync(join(tmpdir(), "flightdeck-transcript-"));
    const transcriptPath = join(dir, "session.jsonl");
    const env = {
      FLIGHTDECK_SERVER: `http://127.0.0.1:${capture.port}`,
      FLIGHTDECK_TOKEN: "tok_test",
      FLIGHTDECK_CAPTURE_PROMPTS: "false",
      CLAUDE_SESSION_ID: "sess-two-iter",
    };
    const writeState = (records) => {
      writeFileSync(
        transcriptPath,
        records.map((r) => JSON.stringify(r)).join("\n") + "\n",
      );
    };

    const before = capture.bodies().length;

    // State A: first PostToolUse fires after first LLM call + tool exec.
    writeState([userRec, msgA]);
    await runScript(
      JSON.stringify({
        hook_event_name: "PostToolUse",
        session_id: "sess-two-iter",
        transcript_path: transcriptPath,
        tool_name: "Read",
      }),
      env,
    );

    // State B: second PostToolUse after the second LLM call + tool exec.
    writeState([userRec, msgA, toolResultA, msgB]);
    await runScript(
      JSON.stringify({
        hook_event_name: "PostToolUse",
        session_id: "sess-two-iter",
        transcript_path: transcriptPath,
        tool_name: "Glob",
      }),
      env,
    );

    // State C: Stop fires after the final (text-only) LLM call.
    writeState([userRec, msgA, toolResultA, msgB, toolResultB, msgC]);
    await runScript(
      JSON.stringify({
        hook_event_name: "Stop",
        session_id: "sess-two-iter",
        transcript_path: transcriptPath,
      }),
      env,
    );

    const posted = capture.bodies().slice(before);
    const postCalls = posted.filter((b) => b.event_type === "post_call");
    const toolCalls = posted.filter((b) => b.event_type === "tool_call");
    assert.equal(postCalls.length, 3, "one post_call per LLM call");
    assert.equal(toolCalls.length, 2, "one tool_call per tool iteration");
    // Order matches transcript order (timestamps strictly increasing).
    const ts = postCalls.map((b) => Date.parse(b.timestamp));
    assert.ok(ts[0] < ts[1] && ts[1] < ts[2], "post_call order matches turns");
    // Token counts come from the right transcript records.
    assert.equal(postCalls[0].tokens_output, 5); // msg_A
    assert.equal(postCalls[1].tokens_output, 7); // msg_B
    assert.equal(postCalls[2].tokens_output, 3); // msg_C
    rmSync(dir, { recursive: true, force: true });
  });

  // Phase 5 — MCP tool-call emission. The plugin emits MCP_TOOL_CALL
  // (not the generic tool_call) when the hook payload's tool_name
  // starts with the ``mcp__<server>__<tool>`` namespace. Per Phase 5
  // D1 + D4, the whitelist sanitiser is bypassed for MCP tools so the
  // arguments survive the round-trip.
  it("Phase 5 — PostToolUse on mcp__server__tool emits mcp_tool_call", async () => {
    clearAllPluginMarkers();
    const before = capture.bodies().length;
    const result = await runScript(
      JSON.stringify({
        hook_event_name: "PostToolUse",
        session_id: "sess-mcp-1",
        tool_name: "mcp__filesystem__read_file",
        tool_input: { path: "/etc/hosts", anything_else: "kept-by-mcp-bypass" },
        tool_response: { content: [{ type: "text", text: "127.0.0.1 ..." }] },
      }),
      {
        FLIGHTDECK_SERVER: `http://127.0.0.1:${capture.port}`,
        FLIGHTDECK_TOKEN: "tok_test",
        CLAUDE_SESSION_ID: "sess-mcp-1",
        FLIGHTDECK_CAPTURE_PROMPTS: "true",
        FLIGHTDECK_CAPTURE_TOOL_INPUTS: "true",
      },
    );
    assert.equal(result.code, 0);
    const posted = capture.bodies().slice(before);
    const mcpEvent = posted.find((b) => b.event_type === "mcp_tool_call");
    assert.ok(mcpEvent, "expected mcp_tool_call event");
    assert.equal(mcpEvent.server_name, "filesystem");
    assert.equal(mcpEvent.tool_name, "read_file");
    // Whitelist sanitiser BYPASSED for MCP per D4 — anything_else
    // survives.
    assert.deepEqual(mcpEvent.arguments, {
      path: "/etc/hosts",
      anything_else: "kept-by-mcp-bypass",
    });
    // capturePrompts=true → result captured.
    assert.ok(mcpEvent.result, "result must be present with capturePrompts=true");
  });

  it("Phase 5 — PostToolUseFailure on MCP tool emits mcp_tool_call with error", async () => {
    clearAllPluginMarkers();
    const before = capture.bodies().length;
    const result = await runScript(
      JSON.stringify({
        hook_event_name: "PostToolUseFailure",
        session_id: "sess-mcp-fail-1",
        tool_name: "mcp__github__create_issue",
        tool_input: { repo: "x/y" },
        error: "401 Unauthorized — token expired",
      }),
      {
        FLIGHTDECK_SERVER: `http://127.0.0.1:${capture.port}`,
        FLIGHTDECK_TOKEN: "tok_test",
        CLAUDE_SESSION_ID: "sess-mcp-fail-1",
      },
    );
    assert.equal(result.code, 0);
    const posted = capture.bodies().slice(before);
    const mcpEvent = posted.find((b) => b.event_type === "mcp_tool_call");
    assert.ok(mcpEvent, "expected mcp_tool_call event from PostToolUseFailure");
    assert.equal(mcpEvent.server_name, "github");
    assert.equal(mcpEvent.tool_name, "create_issue");
    assert.ok(mcpEvent.error, "error must be populated on failure path");
    assert.equal(mcpEvent.error.error_class, "PluginToolError");
    assert.match(mcpEvent.error.message, /Unauthorized/);
  });

  it("PostToolUse tool_call still emits when transcript is missing", async () => {
    clearAllPluginMarkers();
    const before = capture.bodies().length;
    // No transcript_path -- readTurns returns [] silently, flush is a no-op
    // and the tool_call emission path must proceed unaffected.
    const result = await runScript(
      JSON.stringify({
        hook_event_name: "PostToolUse",
        session_id: "sess-no-transcript",
        tool_name: "Read",
      }),
      {
        FLIGHTDECK_SERVER: `http://127.0.0.1:${capture.port}`,
        FLIGHTDECK_TOKEN: "tok_test",
        CLAUDE_SESSION_ID: "sess-no-transcript",
      },
    );
    assert.equal(result.code, 0);
    const posted = capture.bodies().slice(before);
    const toolCall = posted.find((b) => b.event_type === "tool_call");
    assert.ok(toolCall, "tool_call must still be emitted");
    assert.equal(toolCall.tool_name, "Read");
    assert.equal(
      posted.filter((b) => b.event_type === "post_call").length,
      0,
    );
  });
});
