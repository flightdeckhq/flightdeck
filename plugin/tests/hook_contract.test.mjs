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
// provided MCP tool call. They were recorded from `claude -p` runs
// started inside another Claude Code session, which is why the env's
// CLAUDE_CODE_EXECPATH names the OUTER binary (2.1.304) while the
// session itself ran 2.1.306 (`claude --version`): the variable
// cannot be trusted for the version and the plugin does not use it.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CI_PROVIDER_ENV,
  MAX_MCP_IDENTITY_BYTES,
  MAX_SIGNAL_BYTES,
  REDACTED_ERROR_MESSAGE,
  SESSION_END_HOOK_BUDGET_MS,
  SESSION_END_WORKER_FLAG,
  SESSION_END_WORKER_LOG_MAX_BYTES,
  boundedToken,
  boundedVersion,
  buildToolErrorBlock,
  canonicalMcpServerName,
  captureErrorText,
  claudeCodeSessionId,
  collectClaudeCodeSignals,
  collectContext,
  detectCiProvider,
  flattenMcpServerName,
  hookDurationMs,
  isMainModule,
  openSessionEndWorkerLog,
  parseMcpToolName,
  postCallEventId,
  redactServerUrl,
  redactUserinfo,
  resolveMcpToolIdentity,
} from "../hooks/scripts/observe_cli.mjs";
import { llmErrorEventId } from "../hooks/scripts/claude_code/stop_failure.mjs";
import {
  assertIngestionContract,
  hookEnv,
  markerDir,
  pollUntil,
  privateTmp,
  runScript,
  startCaptureServer,
  startGatedServer,
} from "./contract_harness.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, "..", "hooks", "scripts", "observe_cli.mjs");
const FIXTURE = join(__dirname, "fixtures", "claude-code-2.1.306-hooks.jsonl");

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
    // No transcript exists at SessionStart, and CLAUDE_CODE_EXECPATH is
    // not trusted (see the fixture note above), so no version is
    // reported here.
    assert.equal(start.context.claude_code_version, undefined);
    assert.deepEqual(start.context.frameworks, ["claude-code"]);
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

  it("with capture off a failed tool keeps its class and abort flag but not its error text", async () => {
    const rec = bashSession.find((r) => r.input.hook_event_name === "PostToolUseFailure");
    const knobs = [
      { FLIGHTDECK_CAPTURE_PROMPTS: "false", FLIGHTDECK_CAPTURE_TOOL_INPUTS: "false" },
      { FLIGHTDECK_CAPTURE_PROMPTS: "false" },
      { FLIGHTDECK_CAPTURE_TOOL_INPUTS: "false" },
    ];
    for (const knob of knobs) {
      const flightdeckSessionId = randomUUID();
      const before = capture.bodies().length;
      const result = await runScript(
        JSON.stringify(rec.input),
        hookEnv(rec.env, {
          FLIGHTDECK_SERVER: `http://127.0.0.1:${capture.port}`,
          FLIGHTDECK_TOKEN: "tok_test",
          CLAUDE_SESSION_ID: flightdeckSessionId,
          ...knob,
        }),
      );
      assert.equal(result.code, 0, result.stderr);
      const failed = capture
        .bodies()
        .slice(before)
        .find((b) => b.event_type === "tool_call" && b.session_id === flightdeckSessionId);
      assert.ok(failed, `tool_call emitted with ${JSON.stringify(knob)}`);
      assertIngestionContract(failed);
      assert.deepEqual(failed.error, {
        error_type: "other",
        error_class: "PluginToolError",
        message: REDACTED_ERROR_MESSAGE,
        interrupted: false,
      });
      // The tool's error text ("cannot access ...") must not leave the
      // machine; the sanitised tool_input is governed by its own knob.
      assert.equal(
        JSON.stringify(failed).includes("cannot access"),
        false,
        "the tool's error text must not leave the machine with capture off",
      );
      if (knob.FLIGHTDECK_CAPTURE_TOOL_INPUTS === "false") {
        assert.equal(failed.tool_input, null);
        assert.equal(failed.has_content, false);
      }
    }
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

  it("without the hook's mcp_server field the server is still resolved and mcp_server is absent", async () => {
    const recorded = mcpSession.find(
      (r) => r.input.hook_event_name === "PostToolUse" && r.input.mcp_server,
    );
    // The recorded plugin-MCP record with the hint removed, as an older
    // Claude Code would send it, plus a hand-made project-server call.
    const { mcp_server: _omitted, ...hintless } = recorded.input;
    const cases = [
      {
        input: {
          hook_event_name: "PostToolUse",
          session_id: randomUUID(),
          tool_name: "mcp__filesystem__read_file",
          tool_input: {},
          tool_response: [{ type: "text", text: "[]" }],
          tool_use_id: "toolu_01nohint",
          duration_ms: 4,
        },
        server: "filesystem",
        toolName: "read_file",
        toolUseId: "toolu_01nohint",
        durationMs: 4,
      },
      {
        input: { ...hintless, session_id: randomUUID() },
        server: "plugin:claude-mem:mcp-search",
        toolName: "list_corpora",
        toolUseId: recorded.input.tool_use_id,
        durationMs: recorded.input.duration_ms,
      },
    ];
    for (const tc of cases) {
      const flightdeckSessionId = randomUUID();
      const before = capture.bodies().length;
      const result = await runScript(
        JSON.stringify(tc.input),
        hookEnv({}, {
          FLIGHTDECK_SERVER: `http://127.0.0.1:${capture.port}`,
          FLIGHTDECK_TOKEN: "tok_test",
          CLAUDE_SESSION_ID: flightdeckSessionId,
        }),
      );
      assert.equal(result.code, 0, result.stderr);
      const mcp = capture
        .bodies()
        .slice(before)
        .find((b) => b.event_type === "mcp_tool_call" && b.session_id === flightdeckSessionId);
      assert.ok(mcp, `mcp_tool_call emitted for ${tc.input.tool_name}`);
      assertIngestionContract(mcp);
      assert.equal(mcp.server_name, tc.server);
      assert.equal(mcp.tool_name, tc.toolName);
      assert.equal("mcp_server" in mcp, false, "mcp_server is only passed through when Claude Code sent it");
      assert.equal(mcp.tool_use_id, tc.toolUseId);
      assert.equal(mcp.duration_ms, tc.durationMs);
    }
  });

  it("is_interrupt=true reaches the wire as error.interrupted=true", async () => {
    const rec = bashSession.find((r) => r.input.hook_event_name === "PostToolUseFailure");
    const flightdeckSessionId = randomUUID();
    const before = capture.bodies().length;
    const result = await runScript(
      JSON.stringify({ ...rec.input, is_interrupt: true }),
      hookEnv(rec.env, {
        FLIGHTDECK_SERVER: `http://127.0.0.1:${capture.port}`,
        FLIGHTDECK_TOKEN: "tok_test",
        CLAUDE_SESSION_ID: flightdeckSessionId,
      }),
    );
    assert.equal(result.code, 0, result.stderr);
    const failed = capture
      .bodies()
      .slice(before)
      .find((b) => b.event_type === "tool_call" && b.session_id === flightdeckSessionId);
    assert.ok(failed, "tool_call emitted");
    assert.equal(failed.error.interrupted, true);
    assert.equal(failed.error.error_class, "PluginToolError");
  });

  it("an MCP tool name without the server separator lands with server_name null and one stderr line", async () => {
    const flightdeckSessionId = randomUUID();
    const before = capture.bodies().length;
    const result = await runScript(
      JSON.stringify({
        hook_event_name: "PostToolUse",
        session_id: randomUUID(),
        tool_name: "mcp__noseparator",
        tool_input: {},
        tool_response: "ok",
        tool_use_id: "toolu_01nosep",
        duration_ms: 2,
      }),
      hookEnv({}, {
        FLIGHTDECK_SERVER: `http://127.0.0.1:${capture.port}`,
        FLIGHTDECK_TOKEN: "tok_test",
        CLAUDE_SESSION_ID: flightdeckSessionId,
      }),
    );
    assert.equal(result.code, 0);
    assert.match(result.stderr, /ambiguous MCP tool name "mcp__noseparator"/);
    const mcp = capture
      .bodies()
      .slice(before)
      .find((b) => b.event_type === "mcp_tool_call" && b.session_id === flightdeckSessionId);
    assert.ok(mcp, "mcp_tool_call still emitted");
    assertIngestionContract(mcp);
    assert.equal(mcp.server_name, null);
    assert.equal(mcp.tool_name, "noseparator");
    assert.equal("mcp_server" in mcp, false);
  });

  it("hostile hook input is bounded: oversize or non-UUID session ids, oversize mcp_server, control characters", async () => {
    const flightdeckSessionId = randomUUID();
    const before = capture.bodies().length;
    for (const nativeId of ["x".repeat(5000), "not-a-uuid"]) {
      const result = await runScript(
        JSON.stringify({
          hook_event_name: "PostToolUse",
          session_id: nativeId,
          tool_name: "mcp__filesystem__read_file",
          tool_input: {},
          tool_use_id: "t".repeat(MAX_MCP_IDENTITY_BYTES + 1),
          duration_ms: 1,
          mcp_server: { name: "n".repeat(MAX_MCP_IDENTITY_BYTES + 1), source: "project" },
        }),
        hookEnv({ CLAUDE_CODE_EXECPATH: "/home/user/.local/share/claude/versions/2.1.304; rm -rf /" }, {
          FLIGHTDECK_SERVER: `http://127.0.0.1:${capture.port}`,
          FLIGHTDECK_TOKEN: "tok_test",
          CLAUDE_SESSION_ID: flightdeckSessionId,
        }),
      );
      assert.equal(result.code, 0, result.stderr);
    }
    const posted = capture.bodies().slice(before).filter((b) => b.session_id === flightdeckSessionId);
    assert.ok(posted.length >= 2, "events still land");
    for (const body of posted) {
      assertIngestionContract(body);
      assert.equal(body.context.claude_code_session_id, undefined, "non-UUID native id is not reported");
      assert.equal(body.context.claude_code_version, undefined, "no version is derived from the environment");
      if (body.event_type === "mcp_tool_call") {
        assert.equal("mcp_server" in body, false, "oversize mcp_server is dropped");
        assert.equal("tool_use_id" in body, false, "oversize tool_use_id is dropped");
        assert.equal(body.server_name, "filesystem");
      }
    }
    // A multibyte reason that fits in code units but not in bytes is
    // withheld too; one that fits in bytes is sent and passes the
    // contract check (server_name on an MCP call is cut on a code point).
    for (const [reason, kept] of [["é".repeat(40), false], ["é".repeat(32), true]]) {
      const mbCapture = await startCaptureServer();
      try {
        const result = await runScript(
          JSON.stringify({ hook_event_name: "SessionEnd", session_id: randomUUID(), reason }),
          hookEnv({}, {
            FLIGHTDECK_SERVER: `http://127.0.0.1:${mbCapture.port}`,
            FLIGHTDECK_TOKEN: "tok_test",
            CLAUDE_SESSION_ID: randomUUID(),
          }),
          [SESSION_END_WORKER_FLAG],
        );
        assert.equal(result.code, 0, result.stderr);
        const end = mbCapture.bodies().find((b) => b.event_type === "session_end");
        assertIngestionContract(end);
        assert.equal("end_reason" in end, kept, `end_reason kept=${kept} for ${reason.length} chars`);
      } finally {
        mbCapture.server.close();
      }
    }
    // Control characters in SessionEnd's reason: the field is withheld.
    const endCapture = await startCaptureServer();
    try {
      const result = await runScript(
        JSON.stringify({
          hook_event_name: "SessionEnd",
          session_id: randomUUID(),
          reason: "clear\n\u0000x",
        }),
        hookEnv({}, {
          FLIGHTDECK_SERVER: `http://127.0.0.1:${endCapture.port}`,
          FLIGHTDECK_TOKEN: "tok_test",
          CLAUDE_SESSION_ID: randomUUID(),
        }),
        [SESSION_END_WORKER_FLAG],
      );
      assert.equal(result.code, 0, result.stderr);
      const end = endCapture.bodies().find((b) => b.event_type === "session_end");
      assert.ok(end, "session_end emitted");
      assert.equal("end_reason" in end, false);
      assert.equal(end.close_reason, "normal_exit");
    } finally {
      endCapture.server.close();
    }
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
    mkdirSync(markerDir, { recursive: true, mode: 0o700 });
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
    // The server answers nothing until release(), so a hook that waited
    // on any POST could not have exited: exit code 0 before release() is
    // the proof it did not wait on the network.
    assert.ok(
      result.wallMs < SESSION_END_HOOK_BUDGET_MS,
      `SessionEnd hook took ${result.wallMs} ms, budget is ${SESSION_END_HOOK_BUDGET_MS} ms`,
    );
    // Deterministic backstop for the timing bound: a hook that had
    // waited on a POST would have logged the abort as "cannot reach".
    assert.doesNotMatch(result.stderr, /cannot reach/);
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
      mkdirSync(markerDir, { recursive: true, mode: 0o700 });
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
      // The post_call's id comes from the model call's message id, so a
      // re-send of the same call is recognised as a duplicate.
      assert.equal(bodies[0].id, postCallEventId(`msg_${nativeSessionId}_w`));
      assert.equal(bodies.at(-1).end_reason, "clear");
      assert.equal(existsSync(foreignMarker), true, "worker must not clear markers");
      rmSync(foreignMarker, { force: true });
    } finally {
      capture.server.close();
    }
  });

  it("a fast server receives the flush and session_end before the hook returns", async () => {
    const capture = await startCaptureServer();
    const own = mkdtempSync(join(scratch, "fast-"));
    try {
      const nativeSessionId = randomUUID();
      const transcript = writeTranscript(own, [
        { id: `msg_${nativeSessionId}_fast`, text: "fast" },
      ]);
      // The grace is raised far above the worker's run so the hook
      // deterministically waits for it; the default-grace path (a parked
      // worker is let go inside the budget) is the gated test above.
      const result = await runScript(
        JSON.stringify({
          hook_event_name: "SessionEnd",
          session_id: nativeSessionId,
          transcript_path: transcript,
          cwd: own,
          reason: "other",
        }),
        hookEnv({}, {
          FLIGHTDECK_SERVER: `http://127.0.0.1:${capture.port}`,
          FLIGHTDECK_TOKEN: "tok_test",
          FLIGHTDECK_SESSION_END_GRACE_MS: "10000",
          TMPDIR: own,
          TEMP: own,
          TMP: own,
        }),
      );
      assert.equal(result.code, 0, result.stderr);
      const seenAtExit = capture.bodies().map((b) => b.event_type);
      await pollUntil(
        () => capture.bodies().some((b) => b.event_type === "session_end"),
        "session_end delivered",
      );
      assert.deepEqual(
        capture.bodies().map((b) => b.event_type),
        ["post_call", "session_end"],
      );
      assert.deepEqual(seenAtExit, ["post_call", "session_end"], "delivered before the hook returned");
    } finally {
      capture.server.close();
    }
  });

  it("the worker survives a SIGKILL of the hook's process group (pins detached: true)", { skip: process.platform === "win32" }, async () => {
    const nativeSessionId = randomUUID();
    const own = mkdtempSync(join(scratch, "kill-"));
    const transcript = writeTranscript(own, [
      { id: `msg_${nativeSessionId}_kill`, text: "survive" },
    ]);
    const flightdeckSessionId = randomUUID();
    const gatedKill = await startGatedServer();
    try {
      // The hook gets its own process group so the kill below cannot
      // reach this test process; the worker must be outside that group.
      const hook = spawn(process.execPath, [SCRIPT], {
        detached: true,
        stdio: ["pipe", "ignore", "pipe"],
        env: hookEnv({}, {
          FLIGHTDECK_SERVER: `http://127.0.0.1:${gatedKill.port}`,
          FLIGHTDECK_TOKEN: "tok_test",
          CLAUDE_SESSION_ID: flightdeckSessionId,
          TMPDIR: own,
          TEMP: own,
          TMP: own,
        }),
      });
      hook.stdin.end(JSON.stringify({
        hook_event_name: "SessionEnd",
        session_id: nativeSessionId,
        transcript_path: transcript,
        cwd: scratch,
        reason: "other",
      }));
      // The worker is up once its first POST is parked; kill the hook's
      // whole group then (the hook itself is still inside its wait).
      await pollUntil(() => gatedKill.parkedCount() > 0, "worker's first POST parked");
      try {
        process.kill(-hook.pid, "SIGKILL");
      } catch {
        /* the hook had already exited on its own; the group is gone */
      }
      gatedKill.release();
      await pollUntil(
        () => gatedKill.bodies().some((b) => b.event_type === "session_end"),
        "session_end from the surviving worker",
      );
      assert.deepEqual(
        gatedKill.bodies().map((b) => b.event_type),
        ["post_call", "session_end"],
      );
      assert.ok(gatedKill.bodies().every((b) => b.session_id === flightdeckSessionId));
    } finally {
      gatedKill.release();
      gatedKill.server.close();
    }
  });

  it("the worker log receives the failed-POST line with userinfo redacted, owner-only", async () => {
    const nativeSessionId = randomUUID();
    const flightdeckSessionId = randomUUID();
    const own = mkdtempSync(join(scratch, "log-"));
    const logDir = join(own, "plugin-data", "state");
    const logFile = join(logDir, "session-end-worker.log");
    // Port 1 is closed on any host; the worker's POST is refused.
    const result = await runScript(
      JSON.stringify({ hook_event_name: "SessionEnd", session_id: nativeSessionId, reason: "other" }),
      hookEnv({}, {
        FLIGHTDECK_SERVER: "http://user:hunter2@127.0.0.1:1",
        FLIGHTDECK_TOKEN: "tok_test",
        CLAUDE_SESSION_ID: flightdeckSessionId,
        TMPDIR: own,
        TEMP: own,
        TMP: own,
      }),
    );
    assert.equal(result.code, 0);
    assert.doesNotMatch(result.stderr, /hunter2/);
    const line = await pollUntil(() => {
      try {
        const text = readFileSync(logFile, "utf8");
        return text.includes("cannot reach") ? text : null;
      } catch {
        return null;
      }
    }, "worker log line");
    // The refusal reads "ECONNREFUSED" or Node's generic "fetch failed"
    // depending on how libuv surfaces it; the redaction is the point.
    assert.match(line, /cannot reach http:\/\/127\.0\.0\.1:1: \S+/);
    assert.doesNotMatch(line, /hunter2/, "userinfo must not reach the log");
    assert.doesNotMatch(line, /user@/);
    if (process.platform !== "win32") {
      assert.equal(statSync(logFile).mode & 0o777, 0o600);
      assert.equal(statSync(logDir).mode & 0o777, 0o700);
    }
  });

  // A StopFailure as Claude Code 2.1.312 sent it for `claude -p --model
  // claude-nonexistent-model-9`, and the synthetic assistant record the
  // transcript gets for the failed turn (model <synthetic>, zero usage,
  // isApiErrorMessage).
  function stopFailureRun(own, nativeSessionId, { capture }) {
    const transcript = writeTranscript(own, [{ id: `msg_${nativeSessionId}_ok`, text: "done" }]);
    const failedId = randomUUID();
    const failedAt = new Date().toISOString();
    const promptId = randomUUID();
    writeFileSync(
      transcript,
      JSON.stringify({
        type: "user",
        timestamp: failedAt,
        promptId,
        message: { role: "user", content: "Reply ok." },
      }) +
        "\n" +
        JSON.stringify({
        type: "assistant",
        timestamp: failedAt,
        isApiErrorMessage: true,
        message: {
          id: failedId,
          model: "<synthetic>",
          role: "assistant",
          content: [{ type: "text", text: "There's an issue with the selected model." }],
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }) + "\n",
      { flag: "a" },
    );
    const input = {
      session_id: nativeSessionId,
      transcript_path: transcript,
      cwd: own,
      prompt_id: promptId,
      effort: { level: "high" },
      hook_event_name: "StopFailure",
      error: "model_not_found",
      last_assistant_message:
        "There's an issue with the selected model (claude-nonexistent-model-9). It may not exist or you may not have access to it.",
    };
    const rec = bashSession.find((r) => r.input.hook_event_name === "Stop");
    return {
      failedId,
      failedAt,
      run: (port) =>
        runScript(
          JSON.stringify(input),
          hookEnv(rec.env, {
            FLIGHTDECK_SERVER: `http://127.0.0.1:${port}`,
            FLIGHTDECK_TOKEN: "tok_test",
            FLIGHTDECK_CAPTURE_PROMPTS: capture ? "true" : "false",
            CLAUDE_SESSION_ID: randomUUID(),
            TMPDIR: own,
            TEMP: own,
            TMP: own,
          }),
        ),
    };
  }

  it("StopFailure sends the completed turn, then the failure as an llm_error, and no call for the failed turn", async () => {
    const capture = await startCaptureServer();
    try {
      const own = mkdtempSync(join(scratch, "stopfail-"));
      const { failedId, failedAt, run } = stopFailureRun(own, randomUUID(), { capture: true });
      const result = await run(capture.port);
      assert.equal(result.code, 0, result.stderr);
      const bodies = capture.bodies();
      assert.deepEqual(
        bodies.map((b) => b.event_type),
        ["session_start", "post_call", "llm_error"],
      );
      for (const body of bodies) assertIngestionContract(body);
      const error = bodies[2];
      assert.equal(error.id, llmErrorEventId(failedId));
      assert.equal(error.timestamp, failedAt);
      assert.equal(error.terminal, true);
      assert.deepEqual(error.error, {
        error_type: "not_found",
        provider: "anthropic",
        http_status: null,
        provider_error_code: "model_not_found",
        error_message:
          "StopFailure: model_not_found: There's an issue with the selected model (claude-nonexistent-model-9). It may not exist or you may not have access to it.",
        request_id: null,
        retry_after: null,
        is_retryable: false,
      });
    } finally {
      capture.server.close();
    }
  });

  it("with capture off the llm_error keeps its classification but not Claude Code's error text", async () => {
    const capture = await startCaptureServer();
    try {
      const own = mkdtempSync(join(scratch, "stopfail-off-"));
      const { run } = stopFailureRun(own, randomUUID(), { capture: false });
      const result = await run(capture.port);
      assert.equal(result.code, 0, result.stderr);
      const error = capture.bodies().find((b) => b.event_type === "llm_error");
      assert.equal(error.error.error_message, "StopFailure: model_not_found");
      assert.equal(error.error.error_type, "not_found");
    } finally {
      capture.server.close();
    }
  });

  it("PostToolUseFailure flushes pending transcript turns before the failed tool_call", async () => {
    const capture = await startCaptureServer();
    try {
      const nativeSessionId = randomUUID();
      const own = mkdtempSync(join(scratch, "fail-"));
      const transcript = writeTranscript(own, [
        { id: `msg_${nativeSessionId}_fail`, text: "about to fail" },
      ]);
      const rec = bashSession.find((r) => r.input.hook_event_name === "PostToolUseFailure");
      const result = await runScript(
        JSON.stringify({ ...rec.input, session_id: nativeSessionId, transcript_path: transcript }),
        hookEnv(rec.env, {
          FLIGHTDECK_SERVER: `http://127.0.0.1:${capture.port}`,
          FLIGHTDECK_TOKEN: "tok_test",
          CLAUDE_SESSION_ID: randomUUID(),
          TMPDIR: own,
          TEMP: own,
          TMP: own,
        }),
      );
      assert.equal(result.code, 0, result.stderr);
      const types = capture.bodies().map((b) => b.event_type);
      assert.deepEqual(types, ["session_start", "post_call", "tool_call"]);
      assert.ok(capture.bodies()[2].error, "the failed tool_call carries its error block");
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
        buildToolErrorBlock({ error: "Exit code 2\nno such file", is_interrupt: false }, true),
        {
          error_type: "other",
          error_class: "PluginToolError",
          message: "Exit code 2\nno such file",
          interrupted: false,
        },
      );
      const block = buildToolErrorBlock({ error: { code: 7 } }, true);
      assert.equal(block.message, '{"code":7}');
      assert.equal("interrupted" in block, false);
    });

    it("still produces a block when the hook carries no error text", () => {
      const block = buildToolErrorBlock({}, true);
      assert.equal(block.error_class, "PluginToolError");
      assert.match(block.message, /no error detail/);
    });

    it("redacts the message when capture is off and keeps the class and abort flag", () => {
      assert.deepEqual(buildToolErrorBlock({ error: "token=abc123", is_interrupt: true }, false), {
        error_type: "other",
        error_class: "PluginToolError",
        message: REDACTED_ERROR_MESSAGE,
        interrupted: true,
      });
      assert.equal(captureErrorText({ capturePrompts: true, captureToolInputs: true }), true);
      assert.equal(captureErrorText({ capturePrompts: false, captureToolInputs: true }), false);
      assert.equal(captureErrorText({ capturePrompts: true, captureToolInputs: false }), false);
      assert.equal(captureErrorText(undefined), false);
    });

    it("truncates long messages at 1000 characters", () => {
      const block = buildToolErrorBlock({ error: "x".repeat(5000) }, true);
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
        { claudeCodeSessionId: "9d357e42-dcec-411f-b0a7-787ce564ecfb", sessionSource: "resume" },
      );
      assert.deepEqual(signals, {
        claude_code_session_id: "9d357e42-dcec-411f-b0a7-787ce564ecfb",
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

    it("case-folds and normalises separators on win32 only", () => {
      const win32 = { platform: "win32", pathModule: nodePath.win32, selfPath: "c:\\plugin\\hooks\\observe_cli.mjs" };
      assert.equal(isMainModule("C:/Plugin/Hooks/observe_cli.mjs", win32), true);
      assert.equal(isMainModule("C:/Plugin/Hooks/OTHER.mjs", win32), false);
      assert.equal(isMainModule("C:/Plugin/Hooks/observe_cli.mjs", { ...win32, platform: "linux" }), false);
    });

    it("follows a symlinked plugin directory to the real script", () => {
      const linkDir = join(privateTmp, "linked-plugin");
      try {
        symlinkSync(dirname(dirname(dirname(SCRIPT))), linkDir, "dir");
      } catch {
        return; // symlinks unavailable on this host (Windows without the privilege)
      }
      assert.equal(isMainModule(join(linkDir, "hooks", "scripts", "observe_cli.mjs")), true);
    });
  });

  describe("bounds and redaction", () => {
    it("boundedToken keeps short clean strings and rejects the rest", () => {
      assert.equal(boundedToken(" sdk-cli ", MAX_SIGNAL_BYTES), "sdk-cli");
      assert.equal(boundedToken("x".repeat(MAX_SIGNAL_BYTES), MAX_SIGNAL_BYTES), "x".repeat(MAX_SIGNAL_BYTES));
      assert.equal(boundedToken("x".repeat(MAX_SIGNAL_BYTES + 1), MAX_SIGNAL_BYTES), null);
      // Surrounding whitespace is trimmed; interior control characters reject.
      assert.equal(boundedToken("clear\n", MAX_SIGNAL_BYTES), "clear");
      assert.equal(boundedToken("clear\nx", MAX_SIGNAL_BYTES), null);
      assert.equal(boundedToken("a\u0000b", MAX_SIGNAL_BYTES), null);
      // Bounds are UTF-8 bytes, as ingestion counts them: 40 "é" are 80
      // bytes and would be rejected with 400, dropping the whole event.
      assert.equal(boundedToken("é".repeat(40), MAX_SIGNAL_BYTES), null);
      assert.equal(boundedToken("é".repeat(32), MAX_SIGNAL_BYTES), "é".repeat(32));
      assert.equal(boundedToken("", MAX_SIGNAL_BYTES), null);
      assert.equal(boundedToken(42, MAX_SIGNAL_BYTES), null);
      assert.equal(boundedToken(undefined, MAX_SIGNAL_BYTES), null);
    });

    it("boundedVersion accepts anchored semver only", () => {
      assert.equal(boundedVersion("2.1.306"), "2.1.306");
      assert.equal(boundedVersion("2.1.306-beta.1+build.5"), "2.1.306-beta.1+build.5");
      assert.equal(boundedVersion("2.1.304; rm -rf /"), null);
      assert.equal(boundedVersion("v2.1.306"), null);
      assert.equal(boundedVersion("2.1"), null);
      assert.equal(boundedVersion("1.0.0-" + "a".repeat(80)), null);
      const ctx = collectContext({ claudeCodeVersion: "2.1.304; rm -rf /" });
      assert.equal(ctx.claude_code_version, undefined);
      assert.deepEqual(ctx.frameworks, ["claude-code"]);
      assert.equal(collectContext({ claudeCodeVersion: "2.1.306" }).claude_code_version, "2.1.306");
    });

    it("signals are bounded and the native id must be a UUID", () => {
      const signals = collectClaudeCodeSignals(
        {
          CLAUDE_CODE_ENTRYPOINT: "e".repeat(MAX_SIGNAL_BYTES + 1),
          CLAUDE_CODE_SESSION_ID: "not-a-uuid",
          CLAUDE_CODE_REMOTE: "true",
          CLAUDE_CODE_REMOTE_SESSION_ID: "r\u0007",
        },
        { sessionSource: "startup" },
      );
      assert.deepEqual(signals, { session_source: "startup", remote: true });
      assert.equal(
        collectClaudeCodeSignals({}, { claudeCodeSessionId: "2164AE84-DEAE-4978-8A1A-611543DF06D2" }).claude_code_session_id,
        "2164AE84-DEAE-4978-8A1A-611543DF06D2",
      );
    });

    it("redactServerUrl strips userinfo and leaves everything else", () => {
      assert.equal(redactServerUrl("https://user:tok_secret@fd.example.com:8443/base"), "https://fd.example.com:8443/base");
      assert.equal(redactServerUrl("http://localhost:4000"), "http://localhost:4000");
      assert.equal(redactServerUrl("not a url"), "not a url");
      assert.equal(
        redactUserinfo("fetch failed: http://u:p@h:1/x and https://a:b@c/"),
        "fetch failed: http://h:1/x and https://c/",
      );
    });
  });

  describe("openSessionEndWorkerLog", () => {
    it("creates the log owner-only and truncates it once it passes the cap", () => {
      const dir = join(privateTmp, "worker-log");
      const file = join(dir, "session-end-worker.log");
      closeSync(openSessionEndWorkerLog(dir));
      if (process.platform !== "win32") {
        assert.equal(statSync(file).mode & 0o777, 0o600);
        assert.equal(statSync(dir).mode & 0o777, 0o700);
        // A symlink planted at the log path is refused, not followed.
        const trapDir = join(privateTmp, "worker-log-trap");
        mkdirSync(trapDir, { recursive: true, mode: 0o700 });
        const target = join(privateTmp, "victim.txt");
        writeFileSync(target, "victim\n");
        symlinkSync(target, join(trapDir, "session-end-worker.log"));
        assert.throws(() => closeSync(openSessionEndWorkerLog(trapDir)), /ELOOP|EMLINK/);
        assert.equal(readFileSync(target, "utf8"), "victim\n");
      }
      writeFileSync(file, "x".repeat(SESSION_END_WORKER_LOG_MAX_BYTES + 1));
      closeSync(openSessionEndWorkerLog(dir));
      assert.equal(statSync(file).size, 0, "log past the cap is truncated");
      writeFileSync(file, "keep\n");
      closeSync(openSessionEndWorkerLog(dir));
      assert.equal(statSync(file).size, 5, "log under the cap is appended to");
    });
  });
});
