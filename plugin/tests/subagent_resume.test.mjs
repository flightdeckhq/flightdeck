// Delivery of Claude Code transcript turns and the resume of subagents
// across coordinator sessions (ARCHITECTURE.md, Plugin > Subagent hooks;
// DECISIONS.md D236). The real hook script runs against a capture server
// that can fail chosen requests:
//
//   * a turn whose POST fails is sent again by the next hook, and a turn
//     the server refuses as invalid is not retried;
//   * a turn is sent only under the Flightdeck session that was current
//     when it ran, also after the plugin's markers are lost;
//   * a subagent resumed (SendMessage) or woken (task notification)
//     re-attaches its child with one session_start per execution, and a
//     late hook of an ended execution never starts the child again;
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

import { postCallEventId } from "../hooks/scripts/claude_code/post_call.mjs";
import { _subagentChildSessionId } from "../hooks/scripts/claude_code/subagent.mjs";
import { markerKeyFor } from "../hooks/scripts/core/state.mjs";
import { assertIngestionContract, hookEnv, isIngestPost, pollUntil, privateTmp, runScript } from "./contract_harness.mjs";

/**
 * A capture server that answers chosen requests with an error status:
 * ``fail(predicate, {status, times})`` answers the next ``times``
 * matching POSTs (Infinity for all of them) with ``status``. Every other
 * POST is answered 200. ``accepted()`` holds the bodies answered 200, in
 * arrival order; ``attempts()`` every body.
 */
function startFaultyServer() {
  const accepted = [];
  const attempts = [];
  const faults = [];
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
        res.writeHead(fault.status, { "Content-Type": "application/json" });
        res.end('{"error":"injected"}');
        return;
      }
      accepted.push(parsed);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"status":"ok","attached":false}');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({
        server,
        port: server.address().port,
        accepted: () => accepted,
        attempts: () => attempts,
        fail: (predicate, { status = 502, times = 1 } = {}) => faults.push({ predicate, status, times }),
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
