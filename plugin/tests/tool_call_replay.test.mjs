// Claude Code tool events that survive a failed POST (ARCHITECTURE.md,
// Plugin > Tool calls and failures). The real hook
// script runs against a capture server that can fail chosen requests:
//
//   * a tool_call or mcp_tool_call carries an id derived from Claude
//     Code's tool_use_id;
//   * one whose POST fails is rebuilt by a later flush from its owed
//     record and the transcript's tool_use / tool_result, with the
//     hook's id and time, and stored once;
//   * one the server refuses as invalid is not retried, and a tool use no
//     hook reported is never rebuilt;
//   * a subagent's owed tool event is sent before the child's end.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { postCallEventId } from "../hooks/scripts/claude_code/post_call.mjs";
import { _subagentChildSessionId } from "../hooks/scripts/claude_code/subagent.mjs";
import { REDACTED_ERROR_MESSAGE, toolCallEventId } from "../hooks/scripts/claude_code/tools.mjs";
import { readToolUses } from "../hooks/scripts/claude_code/transcript.mjs";
import {
  assertIngestionContract,
  hookEnv,
  pollUntil,
  privateTmp,
  runScript,
  startFaultyServer,
} from "./contract_harness.mjs";

const now = () => new Date().toISOString();
const msgId = () => `msg_${randomUUID().replace(/-/g, "")}`;
const toolUseId = () => `toolu_${randomUUID().replace(/-/g, "").slice(0, 24)}`;

function userRecord(content) {
  return { type: "user", timestamp: now(), message: { role: "user", content } };
}

function assistantRecord(id, content = [{ type: "text", text: `turn ${id}` }]) {
  return {
    type: "assistant",
    timestamp: now(),
    version: "2.1.316",
    message: { id, model: "claude-sonnet-4-5", role: "assistant", content, usage: { input_tokens: 10, output_tokens: 5 } },
  };
}

const toolUseRecord = (messageId, id, name, input) =>
  assistantRecord(messageId, [{ type: "tool_use", id, name, input }]);

const toolResultRecord = (id, content, isError = false) =>
  userRecord([{ type: "tool_result", tool_use_id: id, content, is_error: isError }]);

function append(path, records) {
  appendFileSync(path, records.map((r) => `${JSON.stringify(r)}\n`).join(""));
}

/** A Claude Code conversation on disk: the parent transcript and one subagent's files. */
function conversation() {
  const native = randomUUID();
  const dir = mkdtempSync(join(privateTmp, "conv-"));
  const parent = join(dir, `${native}.jsonl`);
  const agent = `a${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const subagents = join(dir, native, "subagents");
  mkdirSync(subagents, { recursive: true });
  const sub = join(subagents, `agent-${agent}.jsonl`);
  writeFileSync(join(subagents, `agent-${agent}.meta.json`), JSON.stringify({ agentType: "general-purpose" }));
  append(parent, [userRecord("do the work")]);
  writeFileSync(sub, "");
  return { native, dir, parent, agent, sub };
}

function rootHook(conv, name, extra = {}) {
  return { hook_event_name: name, session_id: conv.native, transcript_path: conv.parent, cwd: conv.dir, ...extra };
}

function agentHook(conv, name, extra = {}) {
  return rootHook(conv, name, { agent_id: conv.agent, agent_type: "general-purpose", ...extra });
}

function machine(port, overrides = {}) {
  const root = mkdtempSync(join(privateTmp, "machine-"));
  const tmp = join(root, "tmp");
  mkdirSync(tmp, { recursive: true });
  return hookEnv(
    {},
    {
      FLIGHTDECK_SERVER: `http://127.0.0.1:${port}`,
      FLIGHTDECK_TOKEN: "tok_test",
      FLIGHTDECK_BILLING_MODE: "subscription",
      FLIGHTDECK_SESSION_END_GRACE_MS: "10000",
      CLAUDE_PLUGIN_DATA: join(root, "plugin-data"),
      TMPDIR: tmp,
      TEMP: tmp,
      TMP: tmp,
      ...overrides,
    },
  );
}

async function run(event, env) {
  const result = await runScript(JSON.stringify(event), env);
  assert.equal(result.code, 0, `${event.hook_event_name}: ${result.stderr}`);
  return result;
}

const ofConversation = (bodies, conv) => bodies.filter((b) => b.context?.claude_code_session_id === conv.native);
const toolEvents = (bodies, id) =>
  bodies.filter((b) => (b.event_type === "tool_call" || b.event_type === "mcp_tool_call") && b.tool_use_id === id);

describe("readToolUses", () => {
  it("pairs each tool_use with the tool_result that answered it", () => {
    const conv = conversation();
    const [done, open] = [toolUseId(), toolUseId()];
    append(conv.parent, [
      toolUseRecord(msgId(), done, "Read", { file_path: "/a" }),
      toolResultRecord(done, [{ type: "text", text: "body" }], false),
      toolUseRecord(msgId(), open, "Bash", { command: "sleep 9" }),
    ]);
    appendFileSync(conv.parent, "{not json\n");
    const uses = readToolUses(conv.parent);
    assert.equal(uses.get(done).name, "Read");
    assert.deepEqual(uses.get(done).input, { file_path: "/a" });
    assert.deepEqual(uses.get(done).result.content, [{ type: "text", text: "body" }]);
    assert.equal(uses.get(done).result.isError, false);
    assert.equal(uses.get(open).result, null, "no result recorded yet");
    assert.equal(readToolUses(join(conv.dir, "missing.jsonl")).size, 0);
  });
});

describe("tool events carry an id derived from tool_use_id and are rebuilt after a failed POST", () => {
  let capture;
  before(async () => {
    capture = await startFaultyServer();
  });
  after(() => {
    capture.server.closeAllConnections();
    capture.server.close();
  });

  it("a tool_call whose POST failed is rebuilt by the next flushing hook, once, with the hook's id and time", async () => {
    const conv = conversation();
    const env = machine(capture.port);
    const [m1, tu] = [msgId(), toolUseId()];
    await run(rootHook(conv, "SessionStart", { source: "startup" }), env);
    append(conv.parent, [toolUseRecord(m1, tu, "Bash", { command: "ls /tmp" }), toolResultRecord(tu, "a\nb")]);
    capture.fail((b) => b.event_type === "tool_call" && b.tool_use_id === tu);
    const hook = {
      tool_name: "Bash",
      tool_use_id: tu,
      tool_input: { command: "ls /tmp" },
      tool_response: { stdout: "a\nb", stderr: "" },
      duration_ms: 42,
    };
    await run(rootHook(conv, "PostToolUse", hook), env);
    assert.equal(toolEvents(ofConversation(capture.accepted(), conv), tu).length, 0, "the hook's POST failed");
    await run(rootHook(conv, "Stop"), env);
    const bodies = ofConversation(capture.accepted(), conv);
    for (const body of bodies) assertIngestionContract(body);
    const [failed, ...more] = toolEvents(ofConversation(capture.attempts(), conv), tu);
    assert.equal(more.length, 1, "sent once more");
    const [rebuilt] = toolEvents(bodies, tu);
    assert.equal(rebuilt.id, toolCallEventId(tu));
    assert.equal(failed.id, rebuilt.id, "the hook's copy and the rebuild share the id");
    assert.equal(rebuilt.timestamp, failed.timestamp, "the time the hook sent it");
    assert.equal(rebuilt.tool_name, "Bash");
    assert.equal(rebuilt.duration_ms, 42);
    assert.equal(rebuilt.tool_input, JSON.stringify({ command: "ls /tmp" }));
    assert.equal(rebuilt.content.response[0].content, "a\nb", "the result as the transcript records it");
    assert.equal("error" in rebuilt, false);
    // The call that decided on the tool came first.
    assert.ok(bodies.findIndex((b) => b.id === postCallEventId(m1)) < bodies.indexOf(rebuilt));
    await run(rootHook(conv, "Stop"), env);
    assert.equal(toolEvents(ofConversation(capture.attempts(), conv), tu).length, 2, "not sent again once accepted");
  });

  it("a failed tool is rebuilt with its error block, the text from the transcript", async () => {
    const conv = conversation();
    const env = machine(capture.port);
    const [m1, tu] = [msgId(), toolUseId()];
    const errorText = "Exit code 2\nls: cannot access '/missing': No such file or directory";
    await run(rootHook(conv, "SessionStart", { source: "startup" }), env);
    append(conv.parent, [toolUseRecord(m1, tu, "Bash", { command: "ls /missing" }), toolResultRecord(tu, errorText, true)]);
    capture.fail((b) => b.event_type === "tool_call" && b.tool_use_id === tu);
    await run(
      rootHook(conv, "PostToolUseFailure", {
        tool_name: "Bash",
        tool_use_id: tu,
        tool_input: { command: "ls /missing" },
        error: errorText,
        is_interrupt: false,
        duration_ms: 7,
      }),
      env,
    );
    await run(rootHook(conv, "Stop"), env);
    const [rebuilt] = toolEvents(ofConversation(capture.accepted(), conv), tu);
    assertIngestionContract(rebuilt);
    assert.deepEqual(rebuilt.error, {
      error_type: "other",
      error_class: "PluginToolError",
      message: errorText,
      interrupted: false,
    });
  });

  it("an MCP tool call is rebuilt as mcp_tool_call with the server the hook resolved", async () => {
    const conv = conversation();
    const env = machine(capture.port);
    const [m1, tu] = [msgId(), toolUseId()];
    const result = [{ type: "text", text: "file body" }];
    await run(rootHook(conv, "SessionStart", { source: "startup" }), env);
    append(conv.parent, [toolUseRecord(m1, tu, "mcp__fs__read_file", { path: "/x" }), toolResultRecord(tu, result)]);
    capture.fail((b) => b.event_type === "mcp_tool_call" && b.tool_use_id === tu);
    await run(
      rootHook(conv, "PostToolUse", {
        tool_name: "mcp__fs__read_file",
        tool_use_id: tu,
        tool_input: { path: "/x" },
        tool_response: { content: result },
        mcp_server: { name: "fs", source: "project" },
        duration_ms: 3,
      }),
      env,
    );
    await run(rootHook(conv, "Stop"), env);
    const [failed] = toolEvents(ofConversation(capture.attempts(), conv), tu);
    const [rebuilt] = toolEvents(ofConversation(capture.accepted(), conv), tu);
    assertIngestionContract(rebuilt);
    assert.equal(rebuilt.event_type, "mcp_tool_call");
    assert.equal(rebuilt.id, toolCallEventId(tu));
    assert.equal(rebuilt.timestamp, failed.timestamp);
    assert.equal(rebuilt.server_name, "fs");
    assert.equal(rebuilt.tool_name, "read_file");
    assert.deepEqual(rebuilt.mcp_server, { name: "fs", source: "project" });
    assert.equal(rebuilt.transport, failed.transport);
    assert.equal(rebuilt.duration_ms, 3);
    assert.deepEqual(rebuilt.content.tool_input, { path: "/x" });
    assert.deepEqual(rebuilt.content.tool_output, { content: result });
  });

  it("a tool event the server refuses as invalid is not retried", async () => {
    const conv = conversation();
    const env = machine(capture.port);
    const [m1, tu] = [msgId(), toolUseId()];
    await run(rootHook(conv, "SessionStart", { source: "startup" }), env);
    append(conv.parent, [toolUseRecord(m1, tu, "Bash", { command: "true" }), toolResultRecord(tu, "")]);
    capture.fail((b) => b.event_type === "tool_call" && b.tool_use_id === tu, { status: 400, times: Infinity });
    await run(rootHook(conv, "PostToolUse", { tool_name: "Bash", tool_use_id: tu, tool_input: { command: "true" } }), env);
    await run(rootHook(conv, "Stop"), env);
    assert.equal(toolEvents(ofConversation(capture.attempts(), conv), tu).length, 1);
  });

  it("a 400 that is not ingestion's own (a proxy's) leaves the tool event owed, and a later flush rebuilds it", async () => {
    const conv = conversation();
    const env = machine(capture.port);
    const [m1, tu] = [msgId(), toolUseId()];
    await run(rootHook(conv, "SessionStart", { source: "startup" }), env);
    append(conv.parent, [toolUseRecord(m1, tu, "Bash", { command: "date" }), toolResultRecord(tu, "Mon")]);
    capture.fail((b) => b.event_type === "tool_call" && b.tool_use_id === tu, {
      status: 400,
      body: "<html>400 Bad Request</html>",
      contentType: "text/html",
    });
    await run(rootHook(conv, "PostToolUse", { tool_name: "Bash", tool_use_id: tu, tool_input: { command: "date" } }), env);
    await run(rootHook(conv, "Stop"), env);
    assert.equal(toolEvents(ofConversation(capture.attempts(), conv), tu).length, 2);
    assert.equal(toolEvents(ofConversation(capture.accepted(), conv), tu).length, 1);
  });

  it("a tool use no hook reported is never rebuilt", async () => {
    const conv = conversation();
    const env = machine(capture.port);
    const [m1, tu] = [msgId(), toolUseId()];
    await run(rootHook(conv, "SessionStart", { source: "startup" }), env);
    // A denied permission: the transcript has the use and its refusal,
    // and no PostToolUse hook ran.
    append(conv.parent, [
      toolUseRecord(m1, tu, "Bash", { command: "rm -rf /" }),
      toolResultRecord(tu, "Permission to use Bash has been denied.", true),
    ]);
    await run(rootHook(conv, "Stop"), env);
    await run(rootHook(conv, "SessionEnd", { reason: "prompt_input_exit" }), env);
    assert.equal(toolEvents(ofConversation(capture.attempts(), conv), tu).length, 0);
  });

  it("with capture off the rebuild needs no transcript", async () => {
    const conv = conversation();
    const env = machine(capture.port, { FLIGHTDECK_CAPTURE_PROMPTS: "false", FLIGHTDECK_CAPTURE_TOOL_INPUTS: "false" });
    const tu = toolUseId();
    await run(rootHook(conv, "SessionStart", { source: "startup" }), env);
    capture.fail((b) => b.event_type === "tool_call" && b.tool_use_id === tu);
    await run(rootHook(conv, "PostToolUse", { tool_name: "Bash", tool_use_id: tu, tool_input: { command: "id" }, duration_ms: 5 }), env);
    rmSync(conv.parent);
    await run(rootHook(conv, "Stop"), env);
    const [rebuilt] = toolEvents(ofConversation(capture.accepted(), conv), tu);
    assertIngestionContract(rebuilt);
    assert.equal(rebuilt.id, toolCallEventId(tu));
    assert.equal(rebuilt.tool_input, null);
    assert.equal(rebuilt.has_content, false);
    assert.equal(rebuilt.duration_ms, 5);
  });

  // What a rebuild sends depends on the capture settings alone, never on
  // what the transcript holds: here the transcript and the hooks carry
  // markers in a tool's input, output and error text.
  const MARKERS = { input: "SECRET_INPUT_MARKER", output: "SECRET_OUTPUT_MARKER", error: "SECRET_ERROR_MARKER" };
  const leaked = (body) => Object.values(MARKERS).filter((marker) => JSON.stringify(body).includes(marker));
  for (const [prompts, inputs] of [
    [false, false],
    [false, true],
    [true, false],
  ]) {
    it(`with capturePrompts=${prompts} and captureToolInputs=${inputs}, a rebuild from a transcript that holds the content sends no more than the hook's own copy`, async () => {
      const conv = conversation();
      const env = machine(capture.port, {
        FLIGHTDECK_CAPTURE_PROMPTS: String(prompts),
        FLIGHTDECK_CAPTURE_TOOL_INPUTS: String(inputs),
      });
      const [bash, mcp] = [toolUseId(), toolUseId()];
      const errorText = `${MARKERS.error}: no such file`;
      await run(rootHook(conv, "SessionStart", { source: "startup" }), env);
      append(conv.parent, [
        toolUseRecord(msgId(), bash, "Bash", { command: `cat /${MARKERS.input}` }),
        toolResultRecord(bash, errorText, true),
        toolUseRecord(msgId(), mcp, "mcp__fs__read_file", { path: `/${MARKERS.input}` }),
        toolResultRecord(mcp, [{ type: "text", text: MARKERS.output }]),
      ]);
      // Each hook's own POST fails once; a later flushing hook rebuilds it.
      capture.fail((b) => b.tool_use_id === bash);
      capture.fail((b) => b.tool_use_id === mcp);
      await run(
        rootHook(conv, "PostToolUseFailure", {
          tool_name: "Bash",
          tool_use_id: bash,
          tool_input: { command: `cat /${MARKERS.input}` },
          error: errorText,
          is_interrupt: false,
          duration_ms: 4,
        }),
        env,
      );
      await run(
        rootHook(conv, "PostToolUse", {
          tool_name: "mcp__fs__read_file",
          tool_use_id: mcp,
          tool_input: { path: `/${MARKERS.input}` },
          tool_response: { content: [{ type: "text", text: MARKERS.output }] },
          mcp_server: { name: "fs", source: "project" },
          duration_ms: 6,
        }),
        env,
      );
      await run(rootHook(conv, "Stop"), env);
      for (const id of [bash, mcp]) {
        const [own, ...again] = toolEvents(ofConversation(capture.attempts(), conv), id);
        const [rebuilt] = toolEvents(ofConversation(capture.accepted(), conv), id);
        assert.equal(again.length, 1, "rebuilt once after the hook's failed POST");
        assertIngestionContract(rebuilt);
        assert.deepEqual(
          leaked(rebuilt).filter((marker) => !leaked(own).includes(marker)),
          [],
          "nothing the hook's own copy did not carry",
        );
        assert.equal(rebuilt.tool_input ?? null, own.tool_input ?? null);
        assert.equal(Boolean(rebuilt.has_content), Boolean(own.has_content));
        if (!inputs) assert.equal(leaked(rebuilt).includes(MARKERS.input), false, "no tool input");
        if (!prompts) assert.equal(leaked(rebuilt).includes(MARKERS.output), false, "no tool output");
      }
      // The error text is content that may quote input or output: it is
      // sent only when both settings are on.
      const [bashRebuilt] = toolEvents(ofConversation(capture.accepted(), conv), bash);
      assert.equal(bashRebuilt.error.message, REDACTED_ERROR_MESSAGE);
      assert.equal(leaked(bashRebuilt).includes(MARKERS.error), false);
      if (!prompts && !inputs) {
        for (const id of [bash, mcp]) {
          const [rebuilt] = toolEvents(ofConversation(capture.accepted(), conv), id);
          assert.deepEqual(leaked(rebuilt), [], "no input, output or error text");
          assert.equal(rebuilt.tool_input ?? null, null);
          assert.equal(Boolean(rebuilt.has_content), false);
          assert.equal(rebuilt.content ?? null, null);
        }
      }
    });
  }

  it("a regular hook waits for the transcript's records; the SessionEnd worker sends without them", async () => {
    const conv = conversation();
    const env = machine(capture.port);
    const tu = toolUseId();
    await run(rootHook(conv, "SessionStart", { source: "startup" }), env);
    capture.fail((b) => b.event_type === "tool_call" && b.tool_use_id === tu);
    // The transcript never records this tool use.
    await run(rootHook(conv, "PostToolUse", { tool_name: "Bash", tool_use_id: tu, tool_input: { command: "id" } }), env);
    await run(rootHook(conv, "Stop"), env);
    assert.equal(toolEvents(ofConversation(capture.accepted(), conv), tu).length, 0, "left for later");
    await run(rootHook(conv, "SessionEnd", { reason: "prompt_input_exit" }), env);
    const bodies = ofConversation(capture.accepted(), conv);
    const [rebuilt] = toolEvents(bodies, tu);
    assertIngestionContract(rebuilt);
    assert.equal(rebuilt.has_content, false, "sent without its content");
    assert.equal(rebuilt.tool_input, null);
    const end = bodies.findIndex((b) => b.event_type === "session_end" && b.session_id === rebuilt.session_id);
    assert.ok(bodies.indexOf(rebuilt) < end, "before the session's end");
  });

  it("a subagent's failed tool event is sent before the child's session_end", async () => {
    const conv = conversation();
    const env = machine(capture.port);
    const [m1, m2, tu] = [msgId(), msgId(), toolUseId()];
    await run(rootHook(conv, "SessionStart", { source: "startup" }), env);
    append(conv.sub, [userRecord("say hi")]);
    await run(agentHook(conv, "SubagentStart"), env);
    append(conv.sub, [toolUseRecord(m1, tu, "Bash", { command: "echo hi" }), toolResultRecord(tu, "hi")]);
    capture.fail((b) => b.event_type === "tool_call" && b.tool_use_id === tu);
    await run(agentHook(conv, "PostToolUse", { tool_name: "Bash", tool_use_id: tu, tool_input: { command: "echo hi" } }), env);
    append(conv.sub, [assistantRecord(m2)]);
    await run(agentHook(conv, "SubagentStop", { agent_transcript_path: conv.sub, last_assistant_message: `turn ${m2}` }), env);
    const [root] = ofConversation(capture.accepted(), conv).filter((b) => b.event_type === "session_start" && b.parent_session_id == null);
    const child = _subagentChildSessionId(root.session_id, conv.agent);
    const events = ofConversation(capture.accepted(), conv).filter((b) => b.session_id === child);
    for (const body of events) assertIngestionContract(body);
    assert.deepEqual(
      events.map((b) => (b.event_type === "post_call" ? b.id : b.event_type === "tool_call" ? b.id : b.event_type)),
      ["session_start", postCallEventId(m1), postCallEventId(m2), toolCallEventId(tu), "session_end"],
    );
  });
});

describe("a tool event a live hook is still sending holds back only its own subagent's end", () => {
  let capture;
  before(async () => {
    capture = await startFaultyServer();
  });
  after(() => {
    capture.server.closeAllConnections();
    capture.server.close();
  });

  /** Another subagent of ``conv``'s conversation: its transcript and meta file. */
  function anotherAgent(conv) {
    const agent = `a${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const dir = dirname(conv.sub);
    writeFileSync(join(dir, `agent-${agent}.meta.json`), JSON.stringify({ agentType: "general-purpose" }));
    const sub = join(dir, `agent-${agent}.jsonl`);
    writeFileSync(sub, "");
    return { agent, sub };
  }
  const hookOf = (conv, agent, name, extra = {}) =>
    rootHook(conv, name, { agent_id: agent, agent_type: "general-purpose", ...extra });

  /** A subagent that runs and stops; its session_end POST fails when ``endFails``, so the end is owed. */
  async function runAndStop(conv, agent, sub, env, endFails) {
    const s = rootStarts(conv)[0].session_id;
    const child = _subagentChildSessionId(s, agent);
    const m = msgId();
    append(sub, [userRecord("work")]);
    await run(hookOf(conv, agent, "SubagentStart"), env);
    append(sub, [assistantRecord(m)]);
    if (endFails) capture.fail((b) => b.event_type === "session_end" && b.session_id === child);
    await run(hookOf(conv, agent, "SubagentStop", { agent_transcript_path: sub, last_assistant_message: `turn ${m}` }), env);
    return child;
  }

  /** A live hook (this test process stands in for it) is still sending one of ``child``'s tool events. */
  function holdToolEvent(env, child, transcript) {
    const held = toolUseId();
    const file = join(env.CLAUDE_PLUGIN_DATA, "state", `tool-calls-${child}.json`);
    const entry = {
      eventType: "tool_call",
      toolName: "Bash",
      hook: "PostToolUse",
      durationMs: 5,
      interrupted: null,
      mcpServer: null,
      transport: null,
      at: now(),
      transcript,
      pid: process.pid,
    };
    writeFileSync(file, JSON.stringify({ [held]: entry }));
    return { held, file };
  }

  const rootStarts = (conv) =>
    ofConversation(capture.accepted(), conv).filter((b) => b.event_type === "session_start" && b.parent_session_id == null);
  const endOf = (conv, sid) => ofConversation(capture.accepted(), conv).findIndex((b) => b.session_id === sid && b.event_type === "session_end");
  const owedEnds = (env, s) => JSON.parse(readFileSync(join(env.CLAUDE_PLUGIN_DATA, "state", `subagent-ends-${s}.json`), "utf8"));

  /**
   * Subagent X has stopped and still owes its end, while a live hook still
   * sends one of X's tool events; subagent Y was killed with the session,
   * its last turn unsent, which only the SessionEnd worker's pass sends.
   */
  async function heldEndAndKilledSubagent(env) {
    const conv = conversation();
    const y = anotherAgent(conv);
    await run(rootHook(conv, "SessionStart", { source: "startup" }), env);
    const s = rootStarts(conv)[0].session_id;
    const cx = await runAndStop(conv, conv.agent, conv.sub, env, true);
    const holder = holdToolEvent(env, cx, conv.sub);
    const cy = _subagentChildSessionId(s, y.agent);
    const my = msgId();
    append(y.sub, [userRecord("work")]);
    await run(hookOf(conv, y.agent, "SubagentStart"), env);
    append(y.sub, [assistantRecord(my)]);
    return { conv, s, cx, cy, my, holder };
  }

  it("the SessionEnd worker goes on to the other subagents and leaves the held subagent's end owed", async () => {
    const env = machine(capture.port);
    const { conv, s, cx, cy, my } = await heldEndAndKilledSubagent(env);
    await run(rootHook(conv, "SessionEnd", { reason: "prompt_input_exit" }), env);
    const bodies = ofConversation(capture.accepted(), conv);
    assert.ok(endOf(conv, s) >= 0, "the root's end");
    assert.ok(
      bodies.some((b) => b.session_id === cy && b.id === postCallEventId(my)),
      "the killed subagent's last turn, in the pass that is its last chance",
    );
    assert.equal(endOf(conv, cx), -1, "X's end waits for the hook still sending X's tool event");
    const owed = owedEnds(env, s);
    assert.ok(cx in owed, "X's end is still owed");
    assert.equal(owed[cx].pid, null, "and released for a later flush");
  });

  it("the worker sends that end once the hook is done, after the hook's event", async () => {
    const env = machine(capture.port);
    const { conv, cx, my, holder } = await heldEndAndKilledSubagent(env);
    const ending = runScript(JSON.stringify(rootHook(conv, "SessionEnd", { reason: "prompt_input_exit" })), env);
    // The worker has passed over the subagents (the killed one's last turn
    // is in) with X's end left pending; now the hook's POST is answered and
    // it lets go of the event, as sendToolEvent does.
    await pollUntil(() => capture.accepted().some((b) => b.id === postCallEventId(my)), "the killed subagent's last turn");
    await fetch(`http://127.0.0.1:${capture.port}/ingest/v1/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event_type: "tool_call",
        session_id: cx,
        tool_use_id: holder.held,
        context: { claude_code_session_id: conv.native },
      }),
    });
    unlinkSync(holder.file);
    const done = await ending;
    assert.equal(done.code, 0, done.stderr);
    const bodies = ofConversation(capture.accepted(), conv);
    const end = endOf(conv, cx);
    assert.ok(end >= 0, "X's end, the worker's last try");
    assert.ok(bodies.findIndex((b) => b.tool_use_id === holder.held) < end, "after the hook's event");
  });

  it("SubagentStop leaves its end owed behind the held event and still sends the session's other owed ends", async () => {
    const env = machine(capture.port);
    const conv = conversation();
    const z = anotherAgent(conv);
    await run(rootHook(conv, "SessionStart", { source: "startup" }), env);
    const s = rootStarts(conv)[0].session_id;
    // Z stopped earlier and its end's POST failed: the end is owed.
    const cz = await runAndStop(conv, z.agent, z.sub, env, true);
    assert.equal(endOf(conv, cz), -1);
    // X runs; a live hook is still sending one of its tool events when it stops.
    const cx = _subagentChildSessionId(s, conv.agent);
    const mx = msgId();
    append(conv.sub, [userRecord("work")]);
    await run(agentHook(conv, "SubagentStart"), env);
    append(conv.sub, [assistantRecord(mx)]);
    holdToolEvent(env, cx, conv.sub);
    await run(agentHook(conv, "SubagentStop", { agent_transcript_path: conv.sub, last_assistant_message: `turn ${mx}` }), env);
    assert.equal(endOf(conv, cx), -1, "X's end waits for the hook");
    assert.ok(cx in owedEnds(env, s), "and stays owed");
    assert.ok(endOf(conv, cz) >= 0, "the same SubagentStop sends Z's owed end");
  });
});
