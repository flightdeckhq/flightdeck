// Delivery of Claude Code transcript turns and the resume of subagents
// across coordinator sessions (ARCHITECTURE.md, Plugin > Subagent hooks).
// The real hook script runs against a capture server that can fail, slow
// down or hold chosen requests:
//
//   * a turn whose POST fails is sent again by the next hook, and a turn
//     ingestion refuses as invalid is not retried (a proxy's 400 and a
//     clock-skew refusal of a recent turn are retried);
//   * a turn is sent only under the Flightdeck session that was current
//     when it ran: after the plugin's markers are lost, and by a
//     SessionEnd worker still running when a resume minted a later one;
//   * a subagent resumed (SendMessage) or woken (task notification)
//     re-attaches its child with one session_start per execution, which
//     carries the message that resumed it and follows the previous
//     execution's end; a late hook of an ended execution never starts the
//     child again;
//   * a child session_end that failed is sent by a later hook, after the
//     child's turns.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { INGESTION_MAX_PAST_MS, postCallEventId, refusedForGood } from "../hooks/scripts/claude_code/post_call.mjs";
import {
  _subagentChildSessionId,
  subagentResumedAfterFinalTurn,
  subagentResumeMessage,
} from "../hooks/scripts/claude_code/subagent.mjs";
import { SESSION_END_WORKER_FLAG } from "../hooks/scripts/claude_code/session_end.mjs";
import { markerKeyFor } from "../hooks/scripts/core/state.mjs";
import { assertIngestionContract, hookEnv, isIngestPost, pollUntil, privateTmp, runScript } from "./contract_harness.mjs";

/**
 * A capture server that answers chosen requests otherwise than 200:
 * ``fail(predicate, {status, times, body})`` answers the next ``times``
 * matching POSTs (Infinity for all of them) with ``status`` and ``body``
 * (ingestion's JSON error by default); ``delay(predicate, ms)`` answers a
 * matching POST ``ms`` late, as a slow server would; ``hold(predicate)``
 * keeps matching POSTs unanswered until ``release()``. Every other POST is
 * answered 200. ``accepted()`` holds the bodies answered 200, in the order
 * they were answered; ``attempts()`` every body, in arrival order.
 */
function startFaultyServer() {
  const accepted = [];
  const attempts = [];
  const faults = [];
  const delays = [];
  const holds = [];
  const held = [];
  const accept = (parsed, res) => {
    accepted.push(parsed);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"status":"ok","attached":false}');
  };
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (!isIngestPost(req)) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end("{}");
        return;
      }
      const parsed = JSON.parse(body);
      attempts.push(parsed);
      const fault = faults.find((f) => f.times > 0 && f.predicate(parsed));
      if (fault) {
        fault.times -= 1;
        res.writeHead(fault.status, { "Content-Type": fault.contentType });
        res.end(fault.body);
        return;
      }
      if (holds.some((predicate) => predicate(parsed))) {
        held.push(() => accept(parsed, res));
        return;
      }
      const slow = delays.find((d) => d.predicate(parsed));
      if (slow) {
        setTimeout(() => accept(parsed, res), slow.ms);
        return;
      }
      accept(parsed, res);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({
        server,
        port: server.address().port,
        accepted: () => accepted,
        attempts: () => attempts,
        fail: (predicate, { status = 502, times = 1, body = '{"error":"injected"}', contentType = "application/json" } = {}) =>
          faults.push({ predicate, status, times, body, contentType }),
        delay: (predicate, ms) => delays.push({ predicate, ms }),
        hold: (predicate) => holds.push(predicate),
        heldCount: () => held.length,
        release: () => {
          holds.length = 0;
          while (held.length > 0) held.shift()();
        },
      }),
    );
  });
}

const now = () => new Date().toISOString();

function userRecord(content, at = now()) {
  return { type: "user", timestamp: at, message: { role: "user", content } };
}

function assistantRecord(id, at = now()) {
  return {
    type: "assistant",
    timestamp: at,
    version: "2.1.316",
    message: {
      id,
      model: "claude-sonnet-4-5",
      role: "assistant",
      content: [{ type: "text", text: `turn ${id}` }],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  };
}

function append(path, records) {
  appendFileSync(path, records.map((r) => `${JSON.stringify(r)}\n`).join(""));
}

/**
 * A Claude Code conversation on disk: the parent transcript and one
 * subagent's transcript and meta file, where Claude Code keeps them.
 */
function conversation(agentType = "general-purpose") {
  const native = randomUUID();
  const dir = mkdtempSync(join(privateTmp, "conv-"));
  const parent = join(dir, `${native}.jsonl`);
  const agent = `a${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const subagents = join(dir, native, "subagents");
  mkdirSync(subagents, { recursive: true });
  const sub = join(subagents, `agent-${agent}.jsonl`);
  writeFileSync(join(subagents, `agent-${agent}.meta.json`), JSON.stringify({ agentType, toolUseId: "toolu_spawn" }));
  append(parent, [userRecord("coordinate the work")]);
  writeFileSync(sub, "");
  return { native, dir, parent, agent, agentType, sub, subagents };
}

const msgId = () => `msg_${randomUUID().replace(/-/g, "")}`;

// The prefix Claude Code puts on the message a SendMessage resumes a subagent with.
const RESUME_PREFIX = "The coordinator sent a message while you were working:\n";

/** The user record a SendMessage resume writes: a meta record naming its origin. */
function resumeRecord(text) {
  return {
    type: "user",
    timestamp: now(),
    isMeta: true,
    origin: { kind: "coordinator" },
    message: { role: "user", content: `${RESUME_PREFIX}${text}` },
  };
}

// The start of the notice Claude Code writes when a background task wakes a subagent.
const WAKE_NOTICE = "[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event, NOT a message from the user.";

/**
 * The record a finished background task wakes a subagent with, as Claude
 * Code writes it: a meta user record naming a task notification as its
 * origin, whose text is Claude Code's notice of the task.
 */
function wakeRecord() {
  return {
    type: "user",
    timestamp: now(),
    isMeta: true,
    origin: { kind: "task-notification", producer: "session-task" },
    message: {
      role: "user",
      content: `${WAKE_NOTICE}\n\n<task-notification>\n<task-id>b0wake</task-id>\n<status>completed</status>\n</task-notification>`,
    },
  };
}

function rootHook(conv, name, extra = {}) {
  return { hook_event_name: name, session_id: conv.native, transcript_path: conv.parent, cwd: conv.dir, ...extra };
}

function agentHook(conv, name, extra = {}) {
  return rootHook(conv, name, { agent_id: conv.agent, agent_type: conv.agentType, ...extra });
}

const toolUse = (id = `toolu_${randomUUID().slice(0, 8)}`) => ({
  tool_name: "Bash",
  tool_use_id: id,
  tool_input: { command: "echo ok" },
  tool_response: "ok",
  duration_ms: 12,
});

/** The hook environment of one machine state: its plugin data and temp directories. */
function machine(port, root = mkdtempSync(join(privateTmp, "machine-"))) {
  const tmp = join(root, "tmp");
  mkdirSync(tmp, { recursive: true });
  return {
    stateDir: join(root, "plugin-data", "state"),
    env: hookEnv(
      {},
      {
        FLIGHTDECK_SERVER: `http://127.0.0.1:${port}`,
        FLIGHTDECK_TOKEN: "tok_test",
        // Settles the billing mode without running `claude auth status`.
        FLIGHTDECK_BILLING_MODE: "subscription",
        // The SessionEnd hook waits for its worker, so the worker's
        // events are in before the hook returns.
        FLIGHTDECK_SESSION_END_GRACE_MS: "10000",
        CLAUDE_PLUGIN_DATA: join(root, "plugin-data"),
        TMPDIR: tmp,
        TEMP: tmp,
        TMP: tmp,
      },
    ),
  };
}

async function run(event, env) {
  const result = await runScript(JSON.stringify(event), env);
  assert.equal(result.code, 0, `${event.hook_event_name}: ${result.stderr}`);
  return result;
}

const ofConversation = (bodies, conv) => bodies.filter((b) => b.context?.claude_code_session_id === conv.native);
const rootStarts = (bodies) => bodies.filter((b) => b.event_type === "session_start" && b.parent_session_id == null);
const callsOf = (bodies, id) => bodies.filter((b) => b.event_type === "post_call" && b.id === postCallEventId(id));
const ofSession = (bodies, sid, type) => bodies.filter((b) => b.session_id === sid && (!type || b.event_type === type));

describe("a subagent across two coordinator sessions, a failed POST and two resumes", () => {
  let capture;
  before(async () => {
    capture = await startFaultyServer();
  });
  after(() => {
    capture.server.closeAllConnections();
    capture.server.close();
  });

  for (const variant of ["persistent", "reboot"]) {
    it(`reports every turn once, under the child of the session it ran in (${variant})`, async () => {
      const conv = conversation();
      let box = machine(capture.port);
      const [m1, m2, m3, m4] = [msgId(), msgId(), msgId(), msgId()];
      const mine = () => ofConversation(capture.accepted(), conv);
      const tried = () => ofConversation(capture.attempts(), conv);

      // Coordinator invocation S1: the subagent spawns, makes two calls
      // (the second one's POST fails once) and stops; its session_end
      // fails once too.
      await run(rootHook(conv, "SessionStart", { source: "startup" }), box.env);
      const [s1] = rootStarts(mine()).map((b) => b.session_id);
      assert.ok(s1, "S1 started");
      const c1 = _subagentChildSessionId(s1, conv.agent);
      append(conv.sub, [userRecord("count the files")]);
      await run(agentHook(conv, "SubagentStart"), box.env);
      append(conv.sub, [assistantRecord(m1), userRecord([{ type: "tool_result", content: "4" }]), assistantRecord(m2)]);
      capture.fail((b) => b.event_type === "post_call" && b.id === postCallEventId(m2));
      await run(agentHook(conv, "PostToolUse", toolUse()), box.env);
      assert.equal(callsOf(mine(), m1).length, 1, "m1 sent");
      assert.equal(callsOf(mine(), m2).length, 0, "m2's POST failed");
      await run(agentHook(conv, "PostToolUse", toolUse()), box.env);
      assert.equal(callsOf(mine(), m2).length, 1, "the next hook sent m2 again");
      capture.fail((b) => b.event_type === "session_end" && b.session_id === c1);
      await run(agentHook(conv, "SubagentStop", { agent_transcript_path: conv.sub, last_assistant_message: `turn ${m2}` }), box.env);
      assert.equal(ofSession(mine(), c1, "session_end").length, 0, "the child's end failed");
      await run(rootHook(conv, "Stop"), box.env);
      assert.equal(ofSession(mine(), c1, "session_end").length, 1, "the next flushing hook sent the owed end");
      await run(rootHook(conv, "SessionEnd", { reason: "prompt_input_exit" }), box.env);

      // Coordinator invocation S2: the conversation is resumed, on the
      // same machine state or after a reboot that lost it.
      if (variant === "reboot") box = machine(capture.port);
      await run(rootHook(conv, "SessionStart", { source: "resume" }), box.env);
      const [s2] = rootStarts(mine())
        .map((b) => b.session_id)
        .filter((id) => id !== s1);
      assert.ok(s2, "S2 started");
      const c2 = _subagentChildSessionId(s2, conv.agent);
      assert.notEqual(c2, c1);

      // First resume (SendMessage): a new child under S2.
      append(conv.sub, [userRecord("The coordinator sent a message while you were working:\nrecount"), assistantRecord(m3)]);
      await run(agentHook(conv, "SubagentStart"), box.env);
      const resumed = await run(agentHook(conv, "PostToolUse", toolUse()), box.env);
      if (variant === "reboot") {
        assert.match(resumed.stderr, /2 transcript turn\(s\) older than this session were not sent/);
      }
      await run(agentHook(conv, "SubagentStop", { agent_transcript_path: conv.sub }), box.env);

      // A late hook of the execution that ended, with the child's start
      // marker gone, must not start the child again. The marker is put
      // back afterwards, so the resume below has to re-send the start.
      const startedMarker = join(box.stateDir, `started-${c2}.txt`);
      assert.ok(existsSync(startedMarker), "the child's start was accepted");
      rmSync(startedMarker);
      await run(agentHook(conv, "Notification", { notification_type: "idle_prompt" }), box.env);
      assert.equal(ofSession(mine(), c2, "session_start").length, 1, "a late hook does not reopen the child");
      writeFileSync(startedMarker, now());

      // Second resume (a task-notification wake): the same child, re-attached.
      append(conv.sub, [userRecord("<task-notification>done</task-notification>"), assistantRecord(m4)]);
      await run(agentHook(conv, "SubagentStart"), box.env);
      await run(agentHook(conv, "PostToolUse", toolUse()), box.env);
      await run(agentHook(conv, "SubagentStop", { agent_transcript_path: conv.sub }), box.env);
      await run(rootHook(conv, "SessionEnd", { reason: "prompt_input_exit" }), box.env);

      const bodies = mine();
      for (const body of bodies) assertIngestionContract(body);
      // Every call is stored once, under its message-derived id, in the
      // child of the session that was current when it ran.
      const calls = bodies.filter((b) => b.event_type === "post_call");
      assert.deepEqual(
        calls.map((b) => b.id).sort(),
        [m1, m2, m3, m4].map(postCallEventId).sort(),
        "each call once, its id derived from its message id",
      );
      for (const [m, child, parent] of [
        [m1, c1, s1],
        [m2, c1, s1],
        [m3, c2, s2],
        [m4, c2, s2],
      ]) {
        const [call] = callsOf(bodies, m);
        assert.equal(call.session_id, child, `${m} under the child of the session it ran in`);
        assert.equal(call.parent_session_id, parent);
      }
      // The failed turn and the failed end were each sent again once.
      assert.equal(callsOf(tried(), m2).length, 2);
      assert.equal(ofSession(tried(), c1, "session_end").length, 2);
      // S1's child: one execution, its end after its calls.
      assert.equal(ofSession(bodies, c1, "session_start").length, 1);
      assert.equal(ofSession(bodies, c1, "session_end").length, 1);
      const c1Events = ofSession(bodies, c1).map((b) => b.event_type);
      assert.equal(c1Events.at(-1), "session_end", "the end follows the child's calls");
      // S2's child: two executions, each opened by its own start ahead
      // of its call and closed by its own end.
      const c2Events = ofSession(bodies, c2).filter((b) => b.event_type !== "tool_call" && b.event_type !== "session_signal");
      assert.deepEqual(
        c2Events.map((b) => (b.event_type === "post_call" ? b.id : b.event_type)),
        ["session_start", postCallEventId(m3), "session_end", "session_start", postCallEventId(m4), "session_end"],
      );
      assert.equal(new Set(ofSession(bodies, c2).map((b) => b.agent_id)).size, 1, "one agent identity");
      // The roots: S1 and S2, each started and ended once.
      for (const root of [s1, s2]) {
        assert.equal(ofSession(bodies, root, "session_start").length, 1);
        assert.equal(ofSession(bodies, root, "session_end").length, 1);
      }
    });
  }
});

describe("the mint time that bounds a session's flushes", () => {
  let capture;
  before(async () => {
    capture = await startFaultyServer();
  });
  after(() => {
    capture.server.closeAllConnections();
    capture.server.close();
  });

  it("a resumed conversation's history is not sent under the new session; its new turns are", async () => {
    const conv = conversation();
    const box = machine(capture.port);
    const [old1, old2, fresh] = [msgId(), msgId(), msgId()];
    // The history of an earlier session whose markers were lost.
    append(conv.parent, [assistantRecord(old1), assistantRecord(old2)]);
    await run(rootHook(conv, "SessionStart", { source: "resume" }), box.env);
    append(conv.parent, [userRecord("go on"), assistantRecord(fresh)]);
    const stop = await run(rootHook(conv, "Stop"), box.env);
    const bodies = ofConversation(capture.accepted(), conv);
    for (const body of bodies) assertIngestionContract(body);
    assert.deepEqual(
      bodies.filter((b) => b.event_type === "post_call").map((b) => b.id),
      [postCallEventId(fresh)],
    );
    assert.match(stop.stderr, /2 transcript turn\(s\) older than this session were not sent/);
  });

  it("a session minted by a hook other than SessionStart records no time and sends every turn", async () => {
    const conv = conversation();
    const box = machine(capture.port);
    const early = msgId();
    append(conv.parent, [assistantRecord(early, new Date(Date.now() - 60_000).toISOString())]);
    await run(rootHook(conv, "Stop"), box.env);
    const bodies = ofConversation(capture.accepted(), conv);
    assert.equal(callsOf(bodies, early).length, 1, "the turn before the first hook is sent");
    const [sid] = bodies.map((b) => b.session_id);
    assert.equal(existsSync(join(box.stateDir, `minted-${sid}.txt`)), false);
  });

  it("a marker an earlier release wrote, without a mint time, keeps sending the whole transcript", async () => {
    const conv = conversation();
    const box = machine(capture.port);
    const sid = randomUUID();
    mkdirSync(box.stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(box.stateDir, `session-${markerKeyFor(conv.native)}.txt`), sid);
    const old = msgId();
    append(conv.parent, [assistantRecord(old, new Date(Date.now() - 3_600_000).toISOString())]);
    const stop = await run(rootHook(conv, "Stop"), box.env);
    assert.equal(callsOf(capture.accepted(), old).length, 1);
    assert.equal(callsOf(capture.accepted(), old)[0].session_id, sid);
    assert.doesNotMatch(stop.stderr, /older than this session/);
  });
});

describe("a failed POST", () => {
  let capture;
  before(async () => {
    capture = await startFaultyServer();
  });
  after(() => {
    capture.server.closeAllConnections();
    capture.server.close();
  });

  it("stops the flush, and the next hook sends the turn and the ones after it, in order", async () => {
    const conv = conversation();
    const box = machine(capture.port);
    const [m1, m2, m3] = [msgId(), msgId(), msgId()];
    await run(rootHook(conv, "SessionStart", { source: "startup" }), box.env);
    append(conv.parent, [assistantRecord(m1), assistantRecord(m2), assistantRecord(m3)]);
    capture.fail((b) => b.event_type === "post_call" && b.id === postCallEventId(m1), { status: 503 });
    await run(rootHook(conv, "Stop"), box.env);
    const tried = () => ofConversation(capture.attempts(), conv).filter((b) => b.event_type === "post_call");
    assert.deepEqual(tried().map((b) => b.id), [postCallEventId(m1)], "one failed POST, then the flush stops");
    await run(rootHook(conv, "Stop"), box.env);
    const sent = ofConversation(capture.accepted(), conv).filter((b) => b.event_type === "post_call");
    assert.deepEqual(sent.map((b) => b.id), [m1, m2, m3].map(postCallEventId));
    await run(rootHook(conv, "Stop"), box.env);
    assert.equal(tried().length, 4, "nothing is sent twice once accepted");
  });

  it("refused as invalid is not retried and does not hold back the turns after it", async () => {
    const conv = conversation();
    const box = machine(capture.port);
    const [bad, good] = [msgId(), msgId()];
    await run(rootHook(conv, "SessionStart", { source: "startup" }), box.env);
    append(conv.parent, [assistantRecord(bad), assistantRecord(good)]);
    capture.fail((b) => b.event_type === "post_call" && b.id === postCallEventId(bad), { status: 400, times: Infinity });
    await run(rootHook(conv, "Stop"), box.env);
    await run(rootHook(conv, "Stop"), box.env);
    assert.equal(callsOf(capture.attempts(), bad).length, 1, "a refused turn is tried once");
    assert.equal(callsOf(capture.accepted(), good).length, 1, "the turn after it is sent");
  });
});

describe("an end still owed when the subagent is resumed", () => {
  let capture;
  before(async () => {
    capture = await startFaultyServer();
  });
  after(() => {
    capture.server.closeAllConnections();
    capture.server.close();
  });

  it("is sent before the resume's session_start, so it cannot close the resumed child", async () => {
    const conv = conversation();
    const box = machine(capture.port);
    const [first, second] = [msgId(), msgId()];
    await run(rootHook(conv, "SessionStart", { source: "startup" }), box.env);
    const [sid] = rootStarts(ofConversation(capture.accepted(), conv)).map((b) => b.session_id);
    const child = _subagentChildSessionId(sid, conv.agent);
    append(conv.sub, [userRecord("count the files")]);
    await run(agentHook(conv, "SubagentStart"), box.env);
    append(conv.sub, [assistantRecord(first)]);
    capture.fail((b) => b.event_type === "session_end" && b.session_id === child);
    await run(agentHook(conv, "SubagentStop", { agent_transcript_path: conv.sub, last_assistant_message: `turn ${first}` }), box.env);
    // No hook ran in between: the end is still owed when the subagent is resumed.
    append(conv.sub, [userRecord("The coordinator sent a message while you were working:\nagain")]);
    await run(agentHook(conv, "SubagentStart"), box.env);
    append(conv.sub, [assistantRecord(second)]);
    await run(agentHook(conv, "SubagentStop", { agent_transcript_path: conv.sub, last_assistant_message: `turn ${second}` }), box.env);
    const bodies = ofSession(ofConversation(capture.accepted(), conv), child);
    for (const body of bodies) assertIngestionContract(body);
    assert.deepEqual(
      bodies.map((b) => (b.event_type === "post_call" ? b.id : b.event_type)),
      ["session_start", postCallEventId(first), "session_end", "session_start", postCallEventId(second), "session_end"],
    );
    assert.equal(ofSession(ofConversation(capture.attempts(), conv), child, "session_end").length, 3, "the first end was sent twice");
  });
});

describe("SubagentStop and a final turn Claude Code writes after the hook starts", () => {
  let capture;
  before(async () => {
    capture = await startFaultyServer();
  });
  after(() => {
    capture.server.closeAllConnections();
    capture.server.close();
  });

  it("waits for the final turn, so the end follows the call it closes", async () => {
    const conv = conversation();
    const box = machine(capture.port);
    const [first, last] = [msgId(), msgId()];
    await run(rootHook(conv, "SessionStart", { source: "startup" }), box.env);
    const [sid] = rootStarts(ofConversation(capture.accepted(), conv)).map((b) => b.session_id);
    const child = _subagentChildSessionId(sid, conv.agent);
    append(conv.sub, [userRecord("count the files")]);
    await run(agentHook(conv, "SubagentStart"), box.env);
    append(conv.sub, [assistantRecord(first)]);
    const stopping = runScript(
      JSON.stringify(agentHook(conv, "SubagentStop", { agent_transcript_path: conv.sub, last_assistant_message: `turn ${last}` })),
      box.env,
    );
    // The hook records the owed end, then waits for the final turn, which
    // Claude Code writes only now.
    await pollUntil(() => existsSync(join(box.stateDir, `subagent-ends-${sid}.json`)), "SubagentStop waiting");
    append(conv.sub, [assistantRecord(last)]);
    const result = await stopping;
    assert.equal(result.code, 0, result.stderr);
    const bodies = ofSession(ofConversation(capture.accepted(), conv), child);
    for (const body of bodies) assertIngestionContract(body);
    assert.deepEqual(
      bodies.map((b) => (b.event_type === "post_call" ? b.id : b.event_type)),
      ["session_start", postCallEventId(first), postCallEventId(last), "session_end"],
    );
  });
});

describe("the SessionEnd worker's last pass over the subagents", () => {
  let capture;
  before(async () => {
    capture = await startFaultyServer();
  });
  after(() => {
    capture.server.closeAllConnections();
    capture.server.close();
  });

  it("sends the turns no hook sent, a dead hook's claim included, only under the session they ran in", async () => {
    const conv = conversation("Explore");
    const box = machine(capture.port);
    const [claimed, unsent] = [msgId(), msgId()];
    // A subagent of an earlier session, its transcript untouched since:
    // its unsent turn stays unsent.
    const earlier = `a${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const earlierTranscript = join(conv.subagents, `agent-${earlier}.jsonl`);
    const earlierTurn = msgId();
    append(earlierTranscript, [assistantRecord(earlierTurn, new Date(Date.now() - 600_000).toISOString())]);
    writeFileSync(join(conv.subagents, `agent-${earlier}.meta.json`), JSON.stringify({ agentType: "Explore" }));
    const past = (Date.now() - 600_000) / 1000;
    utimesSync(earlierTranscript, past, past);

    await run(rootHook(conv, "SessionStart", { source: "startup" }), box.env);
    const [sid] = rootStarts(ofConversation(capture.accepted(), conv)).map((b) => b.session_id);
    await run(agentHook(conv, "SubagentStart"), box.env);
    // The user stops the subagent: a hook killed mid-flush left its claim
    // on one turn, and the last turn had no hook at all.
    append(conv.sub, [assistantRecord(claimed), assistantRecord(unsent)]);
    writeFileSync(join(box.stateDir, `emitted-${claimed}.txt`), "claimed 2147483646");
    await run(rootHook(conv, "SessionEnd", { reason: "prompt_input_exit" }), box.env);

    const child = _subagentChildSessionId(sid, conv.agent);
    const bodies = ofConversation(capture.accepted(), conv);
    for (const body of bodies) assertIngestionContract(body);
    for (const m of [claimed, unsent]) {
      const [call] = callsOf(bodies, m);
      assert.equal(call?.session_id, child, `${m} under the subagent's own child`);
      assert.equal(call.parent_session_id, sid);
      assert.equal(call.agent_role, "Explore");
    }
    assert.equal(callsOf(bodies, earlierTurn).length, 0, "an earlier session's turn is not sent");
    // The pass runs after the root's session_end, which it cannot delay.
    const rootEnd = bodies.findIndex((b) => b.session_id === sid && b.event_type === "session_end");
    assert.ok(rootEnd >= 0, "the root ended");
    for (const m of [claimed, unsent]) {
      assert.ok(bodies.indexOf(callsOf(bodies, m)[0]) > rootEnd, `${m} follows the root's session_end`);
    }
    assert.deepEqual(readdirSync(box.stateDir).filter((n) => n.startsWith("subagent-ends-")), []);
  });
});

describe("a SessionEnd worker still running when a resume mints a later session", () => {
  let capture;
  before(async () => {
    capture = await startFaultyServer();
  });
  after(() => {
    capture.server.closeAllConnections();
    capture.server.close();
  });

  for (const s2Ends of [false, true]) {
    const variant = s2Ends ? "the later session has ended too" : "the later session still runs";
    it(`leaves the later session's turns to it, rather than sending them under the ended session's child (${variant})`, async () => {
      const conv = conversation();
      const box = machine(capture.port);
      const [m1, m3] = [msgId(), msgId()];
      const mine = () => ofConversation(capture.accepted(), conv);
      await run(rootHook(conv, "SessionStart", { source: "startup" }), box.env);
      const [s1] = rootStarts(mine()).map((b) => b.session_id);
      const c1 = _subagentChildSessionId(s1, conv.agent);
      append(conv.sub, [userRecord("count the files")]);
      await run(agentHook(conv, "SubagentStart"), box.env);
      append(conv.sub, [assistantRecord(m1)]);
      await run(agentHook(conv, "SubagentStop", { agent_transcript_path: conv.sub, last_assistant_message: `turn ${m1}` }), box.env);
      // S1 ends: its SessionEnd hook clears the marker and leaves the
      // ended-session marker. The worker it hands off to finds no server
      // and sends nothing. S1's worker is slow (a slow server, a backlog):
      // it runs here later, in the foreground, once the conversation has
      // been resumed (S2) and the subagent, resumed too, has written a turn
      // that no hook of S2 has flushed yet. (Holding the worker's POST
      // instead would not do: the poster gives up on a POST after two
      // seconds, and a worker whose session_end failed skips its pass.)
      await run(rootHook(conv, "SessionEnd", { reason: "prompt_input_exit" }), { ...box.env, FLIGHTDECK_SERVER: await unreachableServer() });
      await run(rootHook(conv, "SessionStart", { source: "resume" }), box.env);
      const [s2] = rootStarts(mine())
        .map((b) => b.session_id)
        .filter((id) => id !== s1);
      append(conv.sub, [resumeRecord("count again"), assistantRecord(m3)]);
      if (s2Ends) {
        // S2 ends as well before S1's worker reads the subagent's
        // transcript. Its SessionEnd deletes the marker that named it, and
        // its root session_end fails, so its own pass over the subagents,
        // m3's last chance in S2, does not run.
        capture.fail((b) => b.event_type === "session_end" && b.session_id === s2 && !b.parent_session_id, {
          times: Infinity,
        });
        await run(rootHook(conv, "SessionEnd", { reason: "prompt_input_exit" }), box.env);
        assert.equal(callsOf(mine(), m3).length, 0, "S2's pass did not run");
      }
      const done = await runScript(
        JSON.stringify(rootHook(conv, "SessionEnd", { reason: "prompt_input_exit" })),
        { ...box.env, CLAUDE_SESSION_ID: s1 },
        [SESSION_END_WORKER_FLAG],
      );
      assert.equal(done.code, 0, done.stderr);
      // Its session_end was accepted and no POST failed, so its pass over
      // the subagents ran and read the transcript with m3 in it.
      assert.equal(ofSession(mine(), s1, "session_end").length, 1, "S1's worker sent its session_end");
      assert.doesNotMatch(done.stderr, /cannot reach/, "every POST of S1's worker was answered");
      assert.equal(ofSession(mine(), c1).some((b) => b.id === postCallEventId(m3)), false, "never under S1's child");
      // S1's worker is done; a later hook of S2 (after its end, one that
      // reports under the ended S2) sends m3 under S2's child.
      await run(agentHook(conv, "SubagentStart"), box.env);
      await run(agentHook(conv, "PostToolUse", toolUse()), box.env);
      const calls = callsOf(mine(), m3);
      assert.equal(calls.length, 1, "m3 sent once");
      assert.equal(calls[0].session_id, _subagentChildSessionId(s2, conv.agent), "under S2's child");
      assert.equal(calls[0].parent_session_id, s2);
    });
  }
});

/** A server address nothing listens on: a POST to it fails at once. */
async function unreachableServer() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${port}`;
}

describe("a resume and the previous execution's end", () => {
  let capture;
  before(async () => {
    capture = await startFaultyServer();
  });
  after(() => {
    capture.server.closeAllConnections();
    capture.server.close();
  });

  const childEvents = (conv, child) =>
    ofSession(ofConversation(capture.accepted(), conv), child)
      .filter((b) => b.event_type !== "tool_call")
      .map((b) => (b.event_type === "post_call" ? b.id : b.event_type));

  it("a resume waits for the end a live SubagentStop is still sending, so its start follows that end", async () => {
    const conv = conversation();
    const box = machine(capture.port);
    const [m1, m2] = [msgId(), msgId()];
    await run(rootHook(conv, "SessionStart", { source: "startup" }), box.env);
    const [sid] = rootStarts(ofConversation(capture.accepted(), conv)).map((b) => b.session_id);
    const child = _subagentChildSessionId(sid, conv.agent);
    append(conv.sub, [userRecord("count the files")]);
    await run(agentHook(conv, "SubagentStart"), box.env);
    append(conv.sub, [assistantRecord(m1)]);
    // The server is slow to answer the end, so SubagentStop still holds it
    // when the resume's SubagentStart runs.
    capture.delay((b) => b.event_type === "session_end" && b.session_id === child, 1500);
    const stopping = runScript(
      JSON.stringify(agentHook(conv, "SubagentStop", { agent_transcript_path: conv.sub, last_assistant_message: `turn ${m1}` })),
      box.env,
    );
    await pollUntil(
      () => capture.attempts().some((b) => b.event_type === "session_end" && b.session_id === child),
      "the end on its way",
    );
    append(conv.sub, [resumeRecord("count again")]);
    await run(agentHook(conv, "SubagentStart"), box.env);
    const stopped = await stopping;
    assert.equal(stopped.code, 0, stopped.stderr);
    append(conv.sub, [assistantRecord(m2)]);
    await run(agentHook(conv, "SubagentStop", { agent_transcript_path: conv.sub, last_assistant_message: `turn ${m2}` }), box.env);
    assert.deepEqual(childEvents(conv, child), [
      "session_start",
      postCallEventId(m1),
      "session_end",
      "session_start",
      postCallEventId(m2),
      "session_end",
    ]);
  });

  it("SubagentStop leaves the child open when a resume is already queued after the final turn", async () => {
    const conv = conversation();
    const box = machine(capture.port);
    const [m1, m2] = [msgId(), msgId()];
    await run(rootHook(conv, "SessionStart", { source: "startup" }), box.env);
    const [sid] = rootStarts(ofConversation(capture.accepted(), conv)).map((b) => b.session_id);
    const child = _subagentChildSessionId(sid, conv.agent);
    append(conv.sub, [userRecord("count the files")]);
    await run(agentHook(conv, "SubagentStart"), box.env);
    append(conv.sub, [assistantRecord(m1)]);
    // The subagent is resumed right as it stops: the resume's prompt is in
    // the transcript, and its SubagentStart runs before SubagentStop has
    // marked the child ended, so it sends no session_start.
    append(conv.sub, [resumeRecord("count again")]);
    await run(agentHook(conv, "SubagentStart"), box.env);
    await run(agentHook(conv, "SubagentStop", { agent_transcript_path: conv.sub, last_assistant_message: `turn ${m1}` }), box.env);
    append(conv.sub, [assistantRecord(m2)]);
    await run(agentHook(conv, "PostToolUse", toolUse()), box.env);
    await run(agentHook(conv, "SubagentStop", { agent_transcript_path: conv.sub, last_assistant_message: `turn ${m2}` }), box.env);
    assert.deepEqual(
      childEvents(conv, child),
      ["session_start", postCallEventId(m1), postCallEventId(m2), "session_end"],
      "one execution, open until its last stop",
    );
  });

  it("a resume's session_start carries the message that resumed it, or none", async () => {
    const conv = conversation();
    const box = machine(capture.port);
    const [m1, m2] = [msgId(), msgId()];
    await run(rootHook(conv, "SessionStart", { source: "startup" }), box.env);
    const [sid] = rootStarts(ofConversation(capture.accepted(), conv)).map((b) => b.session_id);
    const child = _subagentChildSessionId(sid, conv.agent);
    const starts = () => ofSession(ofConversation(capture.accepted(), conv), child, "session_start");
    append(conv.sub, [userRecord("count the files")]);
    await run(agentHook(conv, "SubagentStart"), box.env);
    append(conv.sub, [assistantRecord(m1)]);
    await run(agentHook(conv, "SubagentStop", { agent_transcript_path: conv.sub, last_assistant_message: `turn ${m1}` }), box.env);
    append(conv.sub, [resumeRecord("count them again")]);
    await run(agentHook(conv, "SubagentStart"), box.env);
    append(conv.sub, [assistantRecord(m2)]);
    await run(agentHook(conv, "SubagentStop", { agent_transcript_path: conv.sub, last_assistant_message: `turn ${m2}` }), box.env);
    // A finished background task wakes it: a meta user record whose text
    // is Claude Code's notice, not a message to the subagent.
    append(conv.sub, [wakeRecord()]);
    await run(agentHook(conv, "SubagentStart"), box.env);
    const [spawn, resumed, woken] = starts();
    for (const body of starts()) assertIngestionContract(body);
    assert.equal(spawn.incoming_message?.body, "count the files", "the spawn's prompt");
    assert.equal(resumed.incoming_message?.body, `${RESUME_PREFIX}count them again`, "the message that resumed it");
    assert.equal("incoming_message" in woken, false, "a wake: no message, neither the notice nor the spawn's prompt");
  });
});

describe("the message a subagent is resumed with", () => {
  /** The transcript arguments for a subagent whose transcript holds ``records``. */
  function transcriptOf(records) {
    const conv = conversation();
    append(conv.sub, records);
    return { subagentTranscript: conv.sub, parentTranscript: conv.parent, role: conv.agentType };
  }
  const ran = () => [userRecord("count the files"), assistantRecord(msgId())];

  it("a wake carries no message but is a resume; a coordinator's resume carries its message", () => {
    const woken = transcriptOf([...ran(), wakeRecord()]);
    assert.equal(subagentResumeMessage(woken), null, "a wake: no message, not Claude Code's notice");
    assert.equal(subagentResumedAfterFinalTurn(woken), true, "a wake is still a resume");

    const resumed = transcriptOf([...ran(), resumeRecord("count them again")]);
    assert.equal(subagentResumeMessage(resumed), `${RESUME_PREFIX}count them again`);
    assert.equal(subagentResumedAfterFinalTurn(resumed), true);

    // A coordinator's message and a wake both waiting when it runs again:
    // the message, whichever came last.
    const both = transcriptOf([...ran(), resumeRecord("and the dirs"), wakeRecord()]);
    assert.equal(subagentResumeMessage(both), `${RESUME_PREFIX}and the dirs`);

    const idle = transcriptOf(ran());
    assert.equal(subagentResumeMessage(idle), null, "nothing after its last turn");
    assert.equal(subagentResumedAfterFinalTurn(idle), false);
  });
});

describe("refusals that are not for good", () => {
  let capture;
  before(async () => {
    capture = await startFaultyServer();
  });
  after(() => {
    capture.server.closeAllConnections();
    capture.server.close();
  });

  for (const [label, fault] of [
    ["a 400 that is not ingestion's own (a proxy's)", { status: 400, body: "<html>400 Bad Request</html>", contentType: "text/html" }],
    [
      "ingestion's clock-skew refusal of a recent turn",
      { status: 400, body: JSON.stringify({ error: "timestamp out of allowed clock-skew window; check sensor host clock" }) },
    ],
  ]) {
    it(`${label} is a failed POST: the next hook sends the turn again`, async () => {
      const conv = conversation();
      const box = machine(capture.port);
      const m1 = msgId();
      await run(rootHook(conv, "SessionStart", { source: "startup" }), box.env);
      append(conv.parent, [assistantRecord(m1)]);
      capture.fail((b) => b.event_type === "post_call" && b.id === postCallEventId(m1), fault);
      await run(rootHook(conv, "Stop"), box.env);
      await run(rootHook(conv, "Stop"), box.env);
      assert.equal(callsOf(capture.attempts(), m1).length, 2);
      assert.equal(callsOf(capture.accepted(), m1).length, 1);
    });
  }

  it("a clock-skew refusal is for good only once the event is older than ingestion's past window", () => {
    const now = Date.parse("2026-11-02T12:00:00Z");
    const skew = { accepted: false, retryable: false, status: 400, clockSkew: true };
    const invalid = { accepted: false, retryable: false, status: 400, clockSkew: false };
    const recent = new Date(now - 60_000).toISOString();
    const stale = new Date(now - INGESTION_MAX_PAST_MS - 60_000).toISOString();
    assert.equal(refusedForGood(skew, recent, now), false);
    assert.equal(refusedForGood(skew, stale, now), true);
    assert.equal(refusedForGood(invalid, recent, now), true);
    assert.equal(refusedForGood({ ...invalid, retryable: true }, recent, now), false);
    assert.equal(refusedForGood({ ...invalid, accepted: true }, recent, now), false);
  });
});
