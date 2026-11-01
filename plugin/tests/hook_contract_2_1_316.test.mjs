// Hook-contract replay of Claude Code 2.1.316: the hook payloads and
// transcripts a real Claude Code sent to the hook-recorder plugin
// (tests/tools/hook-recorder, record-scenarios.mjs), replayed through the
// plugin. Every emitted event must satisfy the ingestion validator, and
// each model call must carry the tokens its transcript records, so a
// Claude Code release that changes a hook payload or the transcript
// format fails here before it drops events in the field.
//
// Four recorded scenarios: a Bash call that needs permission and one
// that runs, an MCP tool call, a sub-agent, and a slash command.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertIngestionContract,
  hookEnv,
  pollUntil,
  privateTmp,
  runScript,
  startCaptureServer,
} from "./contract_harness.mjs";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "claude-code-2.1.316");
// Where the recorded payloads say the transcripts are; the replay points
// them at a copy of the fixture's.
const RECORDED_PROJECT_DIR = "/home/user/.claude/projects/-home-user-project";

/** The recorded hooks, grouped by Claude Code session, with transcript
 * paths moved to a temp copy of the fixture's transcripts. */
function loadSessions() {
  const transcripts = mkdtempSync(join(privateTmp, "transcripts-"));
  cpSync(join(FIXTURE, "transcripts"), transcripts, { recursive: true });
  const sessions = new Map();
  for (const line of readFileSync(join(FIXTURE, "hooks.jsonl"), "utf8").trim().split("\n")) {
    const rec = JSON.parse(line.split(RECORDED_PROJECT_DIR).join(transcripts));
    const id = rec.input.session_id;
    if (!sessions.has(id)) sessions.set(id, []);
    sessions.get(id).push(rec);
  }
  return { sessions: [...sessions.values()], transcripts };
}

/** Each real model call in a transcript, in order: its model and the
 * input (cache reads and writes included) and output tokens of its last
 * streamed record. */
function transcriptCalls(path) {
  const calls = new Map();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    const rec = JSON.parse(line);
    const message = rec.type === "assistant" ? rec.message : null;
    if (!message?.id || message.model === "<synthetic>") continue;
    const u = message.usage ?? {};
    calls.set(message.id, {
      model: message.model,
      input: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
      output: u.output_tokens ?? 0,
    });
  }
  return [...calls.values()];
}

const { sessions } = loadSessions();
const find = (pred) => sessions.find((recs) => recs.some((r) => pred(r.input)));
const permissionSession = find((i) => i.hook_event_name === "PermissionRequest");
const mcpSession = find((i) => String(i.tool_name ?? "").startsWith("mcp__"));
const subagentSession = find((i) => i.hook_event_name === "SubagentStart");
const commandSession = find((i) => i.hook_event_name === "UserPromptExpansion");

describe("recorded Claude Code 2.1.316 hooks replayed through the plugin", () => {
  let capture;
  before(async () => {
    capture = await startCaptureServer();
  });
  after(() => capture.server.close());

  /** Replay one recorded session; returns the Flightdeck session id and
   * every event the plugin posted for it, sub-agents included. */
  async function replay(recs) {
    const sessionId = randomUUID();
    const from = capture.bodies().length;
    for (const rec of recs) {
      const result = await runScript(
        JSON.stringify(rec.input),
        hookEnv(rec.env, {
          FLIGHTDECK_SERVER: `http://127.0.0.1:${capture.port}`,
          FLIGHTDECK_TOKEN: "tok_test",
          CLAUDE_SESSION_ID: sessionId,
        }),
      );
      assert.equal(result.code, 0, `${rec.input.hook_event_name}: ${result.stderr}`);
      assert.equal(result.stderr, "", `${rec.input.hook_event_name} wrote to stderr`);
    }
    await pollUntil(
      () => capture.bodies().slice(from).some((b) => b.event_type === "session_end" && b.session_id === sessionId),
      "session_end from the detached worker",
    );
    const posted = capture.bodies().slice(from);
    for (const body of posted) assertIngestionContract(body);
    return { sessionId, posted };
  }

  function checkCalls(posted, sessionId, transcriptPath) {
    const calls = posted.filter((b) => b.event_type === "post_call" && b.session_id === sessionId);
    const expected = transcriptCalls(transcriptPath);
    assert.ok(expected.length > 0, `the transcript records model calls (${transcriptPath})`);
    assert.deepEqual(
      calls.map((c) => ({ model: c.model, input: c.tokens_input, output: c.tokens_output })),
      expected,
      "one post_call per model call, with the transcript's tokens",
    );
  }

  function checkLifecycle(posted, sessionId) {
    const own = posted.filter((b) => b.session_id === sessionId).map((b) => b.event_type);
    assert.equal(own.filter((t) => t === "session_start").length, 1, "one session_start");
    assert.equal(own.filter((t) => t === "session_end").length, 1, "one session_end");
    assert.equal(own[0], "session_start");
    assert.equal(own.at(-1), "session_end");
  }

  it("fixture holds the four recorded scenarios", () => {
    assert.ok(permissionSession && mcpSession && subagentSession && commandSession);
    assert.equal(sessions.length, 4);
  });

  it("a permission request is a session_signal and the Bash call a tool_call", async () => {
    const { sessionId, posted } = await replay(permissionSession);
    checkLifecycle(posted, sessionId);
    checkCalls(posted, sessionId, permissionSession[0].input.transcript_path);
    assert.ok(posted.some((b) => b.event_type === "session_signal" && b.signal === "permission_requested"));
    assert.deepEqual(
      posted.filter((b) => b.event_type === "tool_call").map((b) => b.tool_name),
      ["Bash"],
    );
    const start = posted[0];
    assert.equal(start.context.entrypoint, "sdk-cli");
    assert.equal(start.context.claude_code_session_id, permissionSession[0].input.session_id);
  });

  it("an MCP tool call is an mcp_tool_call naming its server", async () => {
    const { sessionId, posted } = await replay(mcpSession);
    checkLifecycle(posted, sessionId);
    checkCalls(posted, sessionId, mcpSession[0].input.transcript_path);
    const [mcp] = posted.filter((b) => b.event_type === "mcp_tool_call");
    assert.equal(mcp.server_name, "flightdeck-mcp-reference");
    assert.equal(mcp.tool_name, "echo");
  });

  it("a sub-agent is a child session with its own calls, from its own transcript", async () => {
    const { sessionId, posted } = await replay(subagentSession);
    checkLifecycle(posted, sessionId);
    checkCalls(posted, sessionId, subagentSession[0].input.transcript_path);
    const childStart = posted.filter((b) => b.event_type === "session_start" && b.session_id !== sessionId);
    assert.equal(childStart.length, 1, "one session_start for the sub-agent");
    const child = childStart[0];
    assert.equal(child.parent_session_id, sessionId);
    assert.equal(child.agent_role, "general-purpose");
    checkLifecycle(posted, child.session_id);
    const stop = subagentSession.find((r) => r.input.hook_event_name === "SubagentStop");
    checkCalls(posted, child.session_id, stop.input.agent_transcript_path);
    assert.ok(
      posted.some((b) => b.event_type === "tool_call" && b.session_id === child.session_id && b.tool_name === "Bash"),
      "the sub-agent's Bash call is its own tool_call",
    );
  });

  it("a slash command is a command_expanded session_signal", async () => {
    const { sessionId, posted } = await replay(commandSession);
    checkLifecycle(posted, sessionId);
    checkCalls(posted, sessionId, commandSession[0].input.transcript_path);
    assert.ok(posted.some((b) => b.event_type === "session_signal" && b.signal === "command_expanded"));
  });

  it("the fixture's transcripts are the ones the scenarios name", () => {
    const names = readdirSync(join(FIXTURE, "transcripts")).filter((n) => n.endsWith(".jsonl"));
    const named = new Set(sessions.map((recs) => `${recs[0].input.session_id}.jsonl`));
    assert.deepEqual([...named].sort(), names.sort());
  });
});
