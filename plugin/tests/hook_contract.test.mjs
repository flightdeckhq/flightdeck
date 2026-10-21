// Hook-contract tests: the plugin replayed against hook payloads that a
// real Claude Code (2.1.306) sent to a stdin-recording probe plugin, with
// every emitted event checked against the ingestion validator's rules.
//
// Why replay recordings instead of hand-written hook events: the stub
// capture server accepts anything, so a payload the real ingestion API
// would reject with 400 passes a stub-only test while the plugin fails
// open and drops the event silently. assertIngestionContract mirrors
// ingestion/internal/handlers/events.go field by field so that gap is
// closed here, and the recorded inputs pin the plugin to what Claude
// Code actually sends (tool_use_id, duration_ms, mcp_server, source,
// reason, the CLAUDE_CODE_* environment) rather than to what we assume.
//
// The fixture lives in tests/fixtures/claude-code-2.1.306-hooks.jsonl:
// one record per hook, in firing order, with paths scrubbed. Two
// sessions are recorded -- a Bash failure + success run and a plugin
// provided MCP tool call.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SESSION_END_HOOK_BUDGET_MS,
  SESSION_END_WORKER_FLAG,
  buildToolErrorBlock,
  canonicalMcpServerName,
  claudeCodeSessionId,
  claudeCodeVersionFromEnv,
  collectClaudeCodeSignals,
  detectCiProvider,
  flattenMcpServerName,
  hookDurationMs,
  isMainModule,
  parseMcpToolName,
  resolveMcpToolIdentity,
} from "../hooks/scripts/observe_cli.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, "..", "hooks", "scripts", "observe_cli.mjs");
const FIXTURE = join(__dirname, "fixtures", "claude-code-2.1.306-hooks.jsonl");

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// Every hook subprocess in this file gets its own temp root. The plugin
// keeps its session / started / emitted markers under
// $TMPDIR/flightdeck-plugin, and node runs test files concurrently:
// observe_cli.test.mjs wipes the shared directory in several of its
// tests, which would delete this file's markers mid-run and turn a
// deterministic replay into a flaky one.
const privateTmp = mkdtempSync(join(tmpdir(), "fd-contract-"));
const markerDir = join(privateTmp, "flightdeck-plugin");
after(() => rmSync(privateTmp, { recursive: true, force: true }));

// Mirror of the ingestion validator (ingestion/internal/handlers/
// events.go). Kept in the same order as the Go code so a reviewer can
// diff the two. Throws on the first rule the payload breaks.
export function assertIngestionContract(p) {
  assert.ok(p && typeof p === "object", "payload must be an object");
  assert.ok(
    typeof p.session_id === "string" && p.session_id !== "",
    "session_id is required",
  );
  assert.ok(
    typeof p.event_type === "string" && p.event_type !== "",
    "event_type is required",
  );
  assert.match(p.session_id, UUID_RE, "session_id must be a canonical UUID");
  if (typeof p.timestamp === "string" && p.timestamp !== "") {
    const ts = Date.parse(p.timestamp);
    assert.ok(!Number.isNaN(ts), `timestamp must be RFC 3339 (got ${p.timestamp})`);
    const now = Date.now();
    const maxPast = 48 * 60 * 60 * 1000;
    const maxFuture = 5 * 60 * 1000;
    assert.ok(
      ts >= now - maxPast && ts <= now + maxFuture,
      "timestamp outside the clock-skew window",
    );
  }
  for (const key of ["tokens_input", "tokens_output", "tokens_total"]) {
    if (p[key] != null) {
      assert.ok(
        typeof p[key] === "number" && p[key] >= 0,
        `${key} must be >= 0`,
      );
    }
  }
  assert.ok(typeof p.agent_id === "string" && p.agent_id !== "", "agent_id is required");
  assert.match(p.agent_id, UUID_RE, "agent_id must be a canonical UUID");
  assert.ok(
    ["coding", "production"].includes(p.agent_type),
    `agent_type must be coding|production (got ${p.agent_type})`,
  );
  assert.ok(
    ["claude_code", "flightdeck_sensor"].includes(p.client_type),
    `client_type must be claude_code|flightdeck_sensor (got ${p.client_type})`,
  );
  if (p.parent_session_id != null) {
    assert.equal(typeof p.parent_session_id, "string", "parent_session_id must be a string");
    if (p.parent_session_id !== "") {
      assert.match(p.parent_session_id, UUID_RE, "parent_session_id must be a canonical UUID");
    }
  }
  if (p.agent_role != null) {
    assert.equal(typeof p.agent_role, "string", "agent_role must be a string");
    assert.ok(p.agent_role.length <= 256, "agent_role exceeds 256 characters");
  }
  const assertDecisionBlock = (block, label) => {
    assert.ok(block && typeof block === "object", `${label} must be an object`);
    for (const field of ["policy_id", "scope", "decision", "reason"]) {
      assert.ok(
        typeof block[field] === "string" && block[field] !== "",
        `${label}.${field} is required`,
      );
    }
  };
  switch (p.event_type) {
    case "policy_warn":
    case "policy_degrade":
    case "policy_block":
      assertDecisionBlock(p.policy_decision, "policy_decision");
      break;
    case "policy_mcp_warn":
    case "policy_mcp_block":
      for (const field of [
        "server_url",
        "server_name",
        "fingerprint",
        "policy_id",
        "decision_path",
      ]) {
        assert.ok(
          typeof p[field] === "string" && p[field] !== "",
          `${field} is required for ${p.event_type}`,
        );
      }
      assert.ok(
        ["flavor_entry", "global_entry", "mode_default"].includes(p.decision_path),
        "decision_path enum",
      );
      assertDecisionBlock(p.policy_decision, "policy_decision");
      break;
    case "mcp_policy_user_remembered":
      for (const field of [
        "fingerprint",
        "server_url_canonical",
        "server_name",
        "flavor",
        "decided_at",
      ]) {
        assert.ok(
          typeof p[field] === "string" && p[field] !== "",
          `${field} is required for mcp_policy_user_remembered`,
        );
      }
      break;
    case "session_start":
      assert.equal(
        typeof p.sensor_version,
        "string",
        "sensor_version is required for session_start",
      );
      break;
    case "session_end":
      if ("close_reason" in p) {
        assert.ok(
          [
            "normal_exit",
            "directive_shutdown",
            "policy_block",
            "orphan_timeout",
            "sigkill_detected",
            "unknown",
          ].includes(p.close_reason),
          `close_reason enum (got ${p.close_reason})`,
        );
      }
      break;
    case "pre_call":
    case "post_call":
    case "embeddings":
      if ("estimated_via" in p) {
        assert.ok(
          ["tiktoken", "heuristic", "none"].includes(p.estimated_via),
          "estimated_via enum",
        );
      }
      if (p.event_type !== "pre_call" && "provider_metadata" in p) {
        assert.ok(
          p.provider_metadata && typeof p.provider_metadata === "object",
          "provider_metadata must be an object",
        );
      }
      break;
    default:
      break;
  }
}

function loadFixtureSessions() {
  const records = readFileSync(FIXTURE, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const sessions = new Map();
  for (const rec of records) {
    const id = rec.input.session_id;
    if (!sessions.has(id)) sessions.set(id, []);
    sessions.get(id).push(rec);
  }
  return [...sessions.values()];
}

function runScript(stdinData, env, extraArgs = []) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = execFile(
      process.execPath,
      [SCRIPT, ...extraArgs],
      { env, timeout: 20000 },
      (error, stdout, stderr) => {
        resolve({
          code: error ? error.code ?? 1 : 0,
          stdout,
          stderr,
          wallMs: Date.now() - started,
        });
      },
    );
    if (stdinData != null) child.stdin.write(stdinData);
    child.stdin.end();
  });
}

// A hook process environment: the recorded CLAUDE_CODE_* variables from
// the fixture on top of a scrubbed copy of ours, so the signals the
// plugin reads come from the recording and not from the shell running
// the tests (which may itself be a Claude Code session).
function hookEnv(recordEnv, overrides) {
  const base = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("CLAUDE") || k.startsWith("FLIGHTDECK") || k === "CI") continue;
    base[k] = v;
  }
  return {
    ...base,
    ...recordEnv,
    FLIGHTDECK_QUIET: "1",
    TMPDIR: privateTmp,
    TEMP: privateTmp,
    TMP: privateTmp,
    ...overrides,
  };
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
        res.end('{"status":"ok","attached":false}');
      });
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port, bodies: () => captured });
    });
  });
}

// A server that parks every request until release() is called. Lets a
// test prove a hook returned without waiting on the network: the hook
// exits while the requests are still parked.
function startGatedServer() {
  return new Promise((resolve) => {
    const captured = [];
    const parked = [];
    let released = false;
    const answer = (body, res) => {
      try {
        captured.push(JSON.parse(body));
      } catch {
        captured.push(body);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"status":"ok","attached":false}');
    };
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (released) answer(body, res);
        else parked.push(() => answer(body, res));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({
        server,
        port: server.address().port,
        bodies: () => captured,
        parkedCount: () => parked.length,
        release: () => {
          released = true;
          while (parked.length > 0) parked.shift()();
        },
      });
    });
  });
}

// Polling helper: re-evaluates the predicate until it returns a truthy
// value. The deadline is a safety bound against a hung worker, not a
// wait -- the loop returns the moment the condition holds.
async function pollUntil(predicate, label, deadlineMs = 15000) {
  const start = Date.now();
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() - start > deadlineMs) {
      throw new Error(`pollUntil(${label}): condition not met within ${deadlineMs} ms`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

function writeTranscript(dir, turns) {
  const lines = [];
  const t0 = Date.now() - 10000;
  turns.forEach((turn, i) => {
    lines.push(
      JSON.stringify({
        type: "user",
        timestamp: new Date(t0 + i * 1000).toISOString(),
        message: { role: "user", content: `prompt ${i}` },
      }),
    );
    lines.push(
      JSON.stringify({
        type: "assistant",
        timestamp: new Date(t0 + i * 1000 + 400).toISOString(),
        version: "2.1.306",
        message: {
          id: turn.id,
          model: "claude-sonnet-4-5",
          role: "assistant",
          content: [{ type: "text", text: turn.text }],
          usage: { input_tokens: 12, output_tokens: 4 },
        },
      }),
    );
  });
  const path = join(dir, "transcript.jsonl");
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

const sessions = loadFixtureSessions();
const bashSession = sessions.find((recs) =>
  recs.some((r) => r.input.hook_event_name === "PostToolUseFailure"),
);
const mcpSession = sessions.find((recs) =>
  recs.some((r) => String(r.input.tool_name || "").startsWith("mcp__")),
);

describe("recorded Claude Code 2.1.306 hooks replayed through the plugin", () => {
  let capture;
  before(async () => {
    capture = await startCaptureServer();
  });
  after(() => capture.server.close());

  it("fixture holds both recorded sessions in firing order", () => {
    assert.ok(bashSession, "Bash failure/success session recorded");
    assert.ok(mcpSession, "plugin MCP tool session recorded");
    assert.deepEqual(
      bashSession.map((r) => r.input.hook_event_name),
      [
        "SessionStart",
        "UserPromptSubmit",
        "PreToolUse",
        "PostToolUseFailure",
        "PreToolUse",
        "PostToolUse",
        "Stop",
        "SessionEnd",
      ],
    );
  });

  it("every emitted event satisfies the ingestion validator; failures, durations, ids and reasons ride the wire", async () => {
    const flightdeckSessionId = randomUUID();
    const before = capture.bodies().length;
    for (const rec of bashSession) {
      const result = await runScript(
        JSON.stringify(rec.input),
        hookEnv(rec.env, {
          FLIGHTDECK_SERVER: `http://127.0.0.1:${capture.port}`,
          FLIGHTDECK_TOKEN: "tok_test",
          CLAUDE_SESSION_ID: flightdeckSessionId,
        }),
      );
      assert.equal(result.code, 0, `${rec.input.hook_event_name}: ${result.stderr}`);
      assert.doesNotMatch(
        result.stderr,
        /cannot reach/,
        `${rec.input.hook_event_name} must not log a failed POST`,
      );
    }
    // SessionEnd posts from a detached worker; wait for it to land.
    await pollUntil(
      () =>
        capture
          .bodies()
          .slice(before)
          .some((b) => b.event_type === "session_end" && b.session_id === flightdeckSessionId),
      "session_end from the detached worker",
    );
    const posted = capture.bodies().slice(before);
    for (const body of posted) assertIngestionContract(body);
    assert.ok(
      posted.every((b) => b.session_id === flightdeckSessionId),
      "every event lands under one Flightdeck session",
    );

    const types = posted.map((b) => b.event_type);
    // UserPromptSubmit has no model to label (no transcript, no cached
    // model) so its pre_call is skipped by design; PreToolUse and Stop
    // emit nothing without a transcript.
    assert.deepEqual(types, ["session_start", "tool_call", "tool_call", "session_end"]);

    const [start, failed, succeeded, end] = posted;

    // session_start: run-mode signals and the native id in context.
    assert.equal(start.agent_type, "coding");
    assert.equal(start.context.claude_code_session_id, bashSession[0].input.session_id);
    assert.equal(start.context.session_source, "startup");
    assert.equal(start.context.entrypoint, "sdk-cli");
    assert.equal(start.context.attended, false);
    assert.equal(start.context.child_session, true);
    assert.equal(start.context.claude_code_version, "2.1.304");
    assert.ok(start.context.frameworks.includes("claude-code/2.1.304"));
    assert.equal(start.context.remote, undefined);
    assert.equal(start.context.ci, undefined);

    // PostToolUseFailure on Bash: a tool_call with the structured error
    // and Claude Code's own duration -- not the hook's process runtime.
    const failedRec = bashSession.find((r) => r.input.hook_event_name === "PostToolUseFailure");
    assert.equal(failed.tool_name, "Bash");
    assert.equal(failed.tool_use_id, failedRec.input.tool_use_id);
    assert.equal(failed.duration_ms, failedRec.input.duration_ms);
    assert.equal(failed.latency_ms, failedRec.input.duration_ms);
    assert.equal(failed.error.error_type, "other");
    assert.equal(failed.error.error_class, "PluginToolError");
    assert.match(failed.error.message, /Exit code 2/);
    assert.equal(failed.error.interrupted, false);
    assert.equal(failed.has_content, true);
    assert.equal(JSON.parse(failed.tool_input).command, "ls /definitely_missing_dir_xyz");

    // PostToolUse on Bash: same shape, no error block.
    const okRec = bashSession.find((r) => r.input.hook_event_name === "PostToolUse");
    assert.equal(succeeded.tool_name, "Bash");
    assert.equal(succeeded.tool_use_id, okRec.input.tool_use_id);
    assert.equal(succeeded.duration_ms, okRec.input.duration_ms);
    assert.equal(succeeded.latency_ms, okRec.input.duration_ms);
    assert.equal(succeeded.error, undefined);

    // SessionEnd: enum close_reason plus Claude Code's own reason.
    assert.equal(end.close_reason, "normal_exit");
    assert.equal(end.end_reason, "other");
  });

  it("a plugin-provided MCP tool resolves to Claude Code's server key and source", async () => {
    const flightdeckSessionId = randomUUID();
    const before = capture.bodies().length;
    for (const rec of mcpSession) {
      const result = await runScript(
        JSON.stringify(rec.input),
        hookEnv(rec.env, {
          FLIGHTDECK_SERVER: `http://127.0.0.1:${capture.port}`,
          FLIGHTDECK_TOKEN: "tok_test",
          CLAUDE_SESSION_ID: flightdeckSessionId,
        }),
      );
      assert.equal(result.code, 0, `${rec.input.hook_event_name}: ${result.stderr}`);
    }
    await pollUntil(
      () =>
        capture
          .bodies()
          .slice(before)
          .some((b) => b.event_type === "session_end" && b.session_id === flightdeckSessionId),
      "session_end from the detached worker",
    );
    const posted = capture.bodies().slice(before);
    for (const body of posted) assertIngestionContract(body);
    const mcp = posted.find((b) => b.event_type === "mcp_tool_call");
    assert.ok(mcp, "mcp_tool_call emitted for the plugin MCP tool");
    const rec = mcpSession.find(
      (r) => r.input.hook_event_name === "PostToolUse" && r.input.mcp_server,
    );
    assert.equal(rec.input.tool_name, "mcp__plugin_claude-mem_mcp-search__list_corpora");
    assert.equal(mcp.server_name, "plugin:claude-mem:mcp-search");
    assert.equal(mcp.tool_name, "list_corpora");
    assert.deepEqual(mcp.mcp_server, { name: "plugin:claude-mem:mcp-search", source: "plugin" });
    assert.equal(mcp.tool_use_id, rec.input.tool_use_id);
    assert.equal(mcp.duration_ms, rec.input.duration_ms);
    assert.equal(mcp.error, undefined);
    // The ToolSearch call before it is an ordinary tool_call.
    const search = posted.find((b) => b.event_type === "tool_call" && b.tool_name === "ToolSearch");
    assert.ok(search, "ToolSearch tool_call emitted");
    assert.equal(typeof search.tool_use_id, "string");
  });
});

describe("SessionEnd stays inside Claude Code's 1.5 s budget", () => {
  let gated;
  let scratch;
  before(async () => {
    gated = await startGatedServer();
    scratch = mkdtempSync(join(tmpdir(), "fd-sessionend-"));
  });
  after(() => {
    gated.release();
    gated.server.close();
    rmSync(scratch, { recursive: true, force: true });
  });

  it("returns before the server answers, clears the markers inline, and the detached worker finishes the flush", async () => {
    const nativeSessionId = randomUUID();
    const transcript = writeTranscript(scratch, [
      { id: `msg_${nativeSessionId}_a`, text: "first" },
      { id: `msg_${nativeSessionId}_b`, text: "second" },
    ]);
    mkdirSync(markerDir, { recursive: true });
    const markerKey = createHash("sha256").update(nativeSessionId).digest("hex").slice(0, 16);
    const sessionMarker = join(markerDir, `session-${markerKey}.txt`);
    const flightdeckSessionId = randomUUID();
    writeFileSync(sessionMarker, flightdeckSessionId);
    const startedMarker = join(markerDir, `started-${flightdeckSessionId}.txt`);
    writeFileSync(startedMarker, new Date().toISOString());

    const result = await runScript(
      JSON.stringify({
        hook_event_name: "SessionEnd",
        session_id: nativeSessionId,
        transcript_path: transcript,
        cwd: scratch,
        reason: "prompt_input_exit",
      }),
      hookEnv(
        {},
        {
          FLIGHTDECK_SERVER: `http://127.0.0.1:${gated.port}`,
          FLIGHTDECK_TOKEN: "tok_test",
        },
      ),
    );
    assert.equal(result.code, 0, result.stderr);
    // The hook exited while every request it caused is still parked:
    // it never waited on the network.
    assert.equal(gated.bodies().length, 0, "no request answered while the hook ran");
    assert.ok(
      result.wallMs < SESSION_END_HOOK_BUDGET_MS,
      `SessionEnd hook took ${result.wallMs} ms, budget is ${SESSION_END_HOOK_BUDGET_MS} ms`,
    );
    // Markers were invalidated inline, so an immediately following
    // SessionStart mints a fresh session.
    assert.equal(existsSync(sessionMarker), false, "session marker cleared inline");
    assert.equal(existsSync(startedMarker), false, "started marker cleared inline");

    // The worker is parked on its first POST; let it through and watch
    // the flush and the session_end arrive under the ended session's id.
    await pollUntil(() => gated.parkedCount() > 0, "worker's first POST parked");
    gated.release();
    await pollUntil(
      () => gated.bodies().some((b) => b.event_type === "session_end"),
      "session_end from the detached worker",
    );
    const bodies = gated.bodies();
    for (const body of bodies) assertIngestionContract(body);
    assert.deepEqual(
      bodies.map((b) => b.event_type),
      ["post_call", "post_call", "session_end"],
    );
    assert.ok(bodies.every((b) => b.session_id === flightdeckSessionId));
    const end = bodies.at(-1);
    assert.equal(end.close_reason, "normal_exit");
    assert.equal(end.end_reason, "prompt_input_exit");
    assert.equal(end.context.claude_code_session_id, nativeSessionId);
  });

  it("worker mode posts the flush and session_end under the handed-over id and leaves markers alone", async () => {
    const capture = await startCaptureServer();
    try {
      const nativeSessionId = randomUUID();
      const flightdeckSessionId = randomUUID();
      mkdirSync(markerDir, { recursive: true });
      const markerKey = createHash("sha256").update(nativeSessionId).digest("hex").slice(0, 16);
      const foreignMarker = join(markerDir, `session-${markerKey}.txt`);
      // Simulate a new Claude Code session that already re-owns the
      // marker key by the time the worker runs.
      writeFileSync(foreignMarker, randomUUID());
      const transcript = writeTranscript(scratch, [
        { id: `msg_${nativeSessionId}_w`, text: "worker" },
      ]);
      const result = await runScript(
        JSON.stringify({
          hook_event_name: "SessionEnd",
          session_id: nativeSessionId,
          transcript_path: transcript,
          cwd: scratch,
          reason: "clear",
        }),
        hookEnv(
          {},
          {
            FLIGHTDECK_SERVER: `http://127.0.0.1:${capture.port}`,
            FLIGHTDECK_TOKEN: "tok_test",
            CLAUDE_SESSION_ID: flightdeckSessionId,
          },
        ),
        [SESSION_END_WORKER_FLAG],
      );
      assert.equal(result.code, 0, result.stderr);
      const bodies = capture.bodies();
      assert.deepEqual(
        bodies.map((b) => b.event_type),
        ["post_call", "session_end"],
      );
      assert.ok(bodies.every((b) => b.session_id === flightdeckSessionId));
      assert.equal(bodies.at(-1).end_reason, "clear");
      assert.equal(existsSync(foreignMarker), true, "worker must not clear markers");
      rmSync(foreignMarker, { force: true });
    } finally {
      capture.server.close();
    }
  });
});

describe("hook-contract helpers", () => {
  describe("MCP server identity", () => {
    it("rebuilds Claude Code's plugin server key from the flattened tool-name form", () => {
      assert.equal(
        canonicalMcpServerName("plugin_claude-mem_mcp-search"),
        "plugin:claude-mem:mcp-search",
      );
      assert.equal(canonicalMcpServerName("plugin_engineering_atlassian"), "plugin:engineering:atlassian");
      assert.equal(canonicalMcpServerName("filesystem"), "filesystem");
      assert.equal(canonicalMcpServerName("plugin_"), "plugin_");
      assert.equal(canonicalMcpServerName("plugin_only"), "plugin_only");
    });

    it("parseMcpToolName attributes plugin servers with source=plugin", () => {
      const parsed = parseMcpToolName("mcp__plugin_claude-mem_mcp-search__list_corpora");
      assert.deepEqual(parsed, {
        server_name: "plugin:claude-mem:mcp-search",
        server_key: "plugin_claude-mem_mcp-search",
        tool_name: "list_corpora",
        parsed: true,
        source: "plugin",
      });
      assert.equal(parseMcpToolName("mcp__filesystem__read_file").source, null);
      assert.equal(parseMcpToolName("mcp__filesystem__read_file").server_name, "filesystem");
    });

    it("resolveMcpToolIdentity prefers the hook's mcp_server field and makes a `__` server exact", () => {
      const withHint = resolveMcpToolIdentity(
        { mcp_server: { name: "my__odd__server", source: "project" } },
        "mcp__my__odd__server__do_thing",
      );
      assert.deepEqual(withHint, {
        server_name: "my__odd__server",
        server_key: "my__odd__server",
        tool_name: "do_thing",
        parsed: true,
        source: "project",
      });
      const withoutHint = resolveMcpToolIdentity({}, "mcp__my__odd__server__do_thing");
      assert.equal(withoutHint.server_name, "my");
      assert.equal(withoutHint.tool_name, "odd__server__do_thing");
      assert.equal(resolveMcpToolIdentity({ mcp_server: { name: "x" } }, "Bash"), null);
      // A hint whose flattened form does not prefix the tool name keeps
      // the parser's tool split but still reports the hint's identity.
      const mismatch = resolveMcpToolIdentity(
        { mcp_server: { name: "plugin:claude-mem:mcp-search", source: "plugin" } },
        "mcp__plugin_claude-mem_mcp-search____IMPORTANT",
      );
      assert.equal(mismatch.server_name, "plugin:claude-mem:mcp-search");
      assert.equal(mismatch.tool_name, "__IMPORTANT");
      assert.equal(flattenMcpServerName("plugin:claude-mem:mcp-search"), "plugin_claude-mem_mcp-search");
    });
  });

  describe("hookDurationMs", () => {
    it("takes Claude Code's duration_ms and rejects anything else", () => {
      assert.equal(hookDurationMs({ duration_ms: 449 }), 449);
      assert.equal(hookDurationMs({ duration_ms: 12.6 }), 13);
      assert.equal(hookDurationMs({ duration_ms: -1 }), null);
      assert.equal(hookDurationMs({ duration_ms: "449" }), null);
      assert.equal(hookDurationMs({}), null);
      assert.equal(hookDurationMs(null), null);
    });
  });

  describe("buildToolErrorBlock", () => {
    it("lifts the error string and the abort flag into the taxonomy shape", () => {
      assert.deepEqual(
        buildToolErrorBlock({ error: "Exit code 2\nno such file", is_interrupt: false }),
        {
          error_type: "other",
          error_class: "PluginToolError",
          message: "Exit code 2\nno such file",
          interrupted: false,
        },
      );
      const block = buildToolErrorBlock({ error: { code: 7 } });
      assert.equal(block.message, '{"code":7}');
      assert.equal("interrupted" in block, false);
    });

    it("still produces a block when the hook carries no error text", () => {
      const block = buildToolErrorBlock({});
      assert.equal(block.error_class, "PluginToolError");
      assert.match(block.message, /no error detail/);
    });

    it("truncates long messages at 1000 characters", () => {
      const block = buildToolErrorBlock({ error: "x".repeat(5000) });
      assert.equal(block.message.length, 1001);
      assert.ok(block.message.endsWith("…"));
    });
  });

  describe("Claude Code run-mode signals", () => {
    it("reports entrypoint, attended, child session and the native session id", () => {
      const signals = collectClaudeCodeSignals(
        {
          CLAUDE_CODE_ENTRYPOINT: "cli",
          CLAUDE_CODE_SESSION_ATTENDED: "1",
          CLAUDE_CODE_SESSION_ID: "2164ae84-deae-4978-8a1a-611543df06d2",
        },
        {},
      );
      assert.deepEqual(signals, {
        claude_code_session_id: "2164ae84-deae-4978-8a1a-611543df06d2",
        entrypoint: "cli",
        attended: true,
      });
    });

    it("headless, nested, cloud and CI runs are distinguishable", () => {
      const signals = collectClaudeCodeSignals(
        {
          CLAUDE_CODE_ENTRYPOINT: "sdk-cli",
          CLAUDE_CODE_SESSION_ATTENDED: "0",
          CLAUDE_CODE_CHILD_SESSION: "1",
          CLAUDE_CODE_REMOTE: "true",
          CLAUDE_CODE_REMOTE_SESSION_ID: "remote-123",
          GITHUB_ACTIONS: "true",
          CI: "true",
        },
        { claudeCodeSessionId: "hook-sid", sessionSource: "resume" },
      );
      assert.deepEqual(signals, {
        claude_code_session_id: "hook-sid",
        session_source: "resume",
        entrypoint: "sdk-cli",
        attended: false,
        child_session: true,
        remote: true,
        remote_session_id: "remote-123",
        ci: true,
        ci_provider: "github",
      });
    });

    it("an empty environment yields no signals", () => {
      assert.deepEqual(collectClaudeCodeSignals({}, {}), {});
    });

    it("detectCiProvider names the provider and falls back to the generic CI flag", () => {
      assert.equal(detectCiProvider({ GITLAB_CI: "true" }), "gitlab");
      assert.equal(detectCiProvider({ CI: "1" }), "unknown");
      assert.equal(detectCiProvider({ CI: "false" }), null);
      assert.equal(detectCiProvider({}), null);
    });

    it("claudeCodeVersionFromEnv reads the versions directory leaf on both path styles", () => {
      assert.equal(
        claudeCodeVersionFromEnv({ CLAUDE_CODE_EXECPATH: "/home/u/.local/share/claude/versions/2.1.304" }),
        "2.1.304",
      );
      assert.equal(
        claudeCodeVersionFromEnv({ CLAUDE_CODE_EXECPATH: "C:\\Users\\u\\AppData\\Local\\claude\\versions\\2.1.304\\" }),
        "2.1.304",
      );
      assert.equal(claudeCodeVersionFromEnv({ CLAUDE_CODE_EXECPATH: "/usr/bin/claude" }), null);
      assert.equal(claudeCodeVersionFromEnv({}), null);
    });

    it("claudeCodeSessionId prefers the hook payload over the environment", () => {
      assert.equal(claudeCodeSessionId({ session_id: "from-hook" }, { CLAUDE_CODE_SESSION_ID: "from-env" }), "from-hook");
      assert.equal(claudeCodeSessionId({}, { CLAUDE_CODE_SESSION_ID: " from-env " }), "from-env");
      assert.equal(claudeCodeSessionId({}, {}), null);
    });
  });

  describe("isMainModule", () => {
    it("matches the script path through normalisation and rejects other paths", () => {
      assert.equal(isMainModule(SCRIPT), true);
      assert.equal(isMainModule(join(dirname(SCRIPT), "..", "scripts", "observe_cli.mjs")), true);
      assert.equal(isMainModule(join(dirname(SCRIPT), "other.mjs")), false);
      assert.equal(isMainModule(undefined), false);
    });
  });
});
