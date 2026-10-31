// claude_code/control.mjs: how a directive becomes a stopped session, a
// budget notice and the events it owes, and the gate's decision.

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  GATE_POLL_IDLE_MS,
  eventsForDirective,
  finishControl,
  gateDecision,
  recordDirective,
  sendPendingControlEvents,
  stopMessage,
} from "../hooks/scripts/claude_code/control.mjs";
import { setDirectiveSink } from "../hooks/scripts/core/poster.mjs";
import { readControlState, updateControlState } from "../hooks/scripts/core/state.mjs";

let root;
let savedData;
before(() => {
  root = mkdtempSync(join(tmpdir(), "fd-control-"));
  savedData = process.env.CLAUDE_PLUGIN_DATA;
});
after(() => {
  if (savedData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  else process.env.CLAUDE_PLUGIN_DATA = savedData;
  rmSync(root, { recursive: true, force: true });
});
beforeEach(() => {
  process.env.CLAUDE_PLUGIN_DATA = join(root, randomUUID());
});

const base = { session_id: "s", agent_id: "a", flavor: "claude-code", model: "claude-opus-5-5" };
const recentPoll = () => updateControlState("s1", (s) => ({ ...s, lastPollAt: new Date().toISOString() }));

describe("recordDirective", () => {
  it("does nothing with enforcement off", () => {
    recordDirective(false, "s1", { id: "d1", action: "shutdown", reason: "operator" });
    assert.deepEqual(readControlState("s1"), {});
  });

  it("stops the session on a shutdown and keeps its events pending, once per directive id", () => {
    const d = { id: "d1", action: "shutdown", reason: "manual stop" };
    recordDirective(true, "s1", d);
    recordDirective(true, "s1", d);
    const state = readControlState("s1");
    assert.equal(state.stopped.reason, "manual stop");
    assert.equal(state.pending.length, 1);
    assert.deepEqual(state.applied, ["d1"]);
  });

  it("turns a warn and a degrade into notices for the user", () => {
    recordDirective(true, "s1", { id: "w", action: "warn", reason: "token_budget_warning" });
    recordDirective(true, "s1", { id: "g", action: "degrade", reason: "token_budget_degrade", degrade_to: "claude-haiku-5-5" });
    const state = readControlState("s1");
    assert.equal(state.stopped, undefined);
    assert.equal(state.notices.length, 2);
    assert.match(state.notices[1], /\/model \(claude-haiku-5-5\)/);
  });
});

describe("eventsForDirective", () => {
  it("acknowledges a stop and ends the session", () => {
    const events = eventsForDirective({ action: "shutdown", reason: "manual" }, base);
    assert.deepEqual(events.map((e) => e.event_type), ["directive_result", "session_end"]);
    assert.equal(events[0].directive_status, "acknowledged");
    assert.equal(events[1].close_reason, "directive_shutdown");
  });

  it("adds a policy_block for a budget stop, with the policy_decision ingestion requires", () => {
    const events = eventsForDirective({ action: "shutdown", reason: "token_budget_exceeded" }, base);
    assert.deepEqual(events.map((e) => e.event_type), ["directive_result", "policy_block", "session_end"]);
    const decision = events[1].policy_decision;
    for (const field of ["policy_id", "scope", "decision", "reason"]) assert.ok(decision[field], field);
    assert.equal(decision.decision, "block");
  });

  it("reports a warn, and a degrade as advisory with its acknowledgement", () => {
    assert.deepEqual(eventsForDirective({ action: "warn", reason: "token_budget_warning" }, base).map((e) => e.event_type), ["policy_warn"]);
    const degrade = eventsForDirective({ action: "degrade", reason: "token_budget_degrade", degrade_to: "claude-haiku-5-5" }, base);
    assert.deepEqual(degrade.map((e) => e.event_type), ["policy_degrade", "directive_result"]);
    assert.equal(degrade[0].to_model, "claude-haiku-5-5");
    assert.equal(degrade[0].from_model, "claude-opus-5-5");
    assert.equal(degrade[1].result.advisory, true);
  });

  it("refuses a custom directive and ignores a policy update", () => {
    const [custom] = eventsForDirective({ action: "custom" }, base);
    assert.equal(custom.directive_status, "error");
    assert.deepEqual(eventsForDirective({ action: "policy_update" }, base), []);
  });
});

describe("gateDecision", () => {
  const cfg = { enforcement: true, server: "http://127.0.0.1:9", token: "t" };

  it("lets everything through with enforcement off", async () => {
    recordDirective(true, "s1", { id: "d", action: "shutdown" });
    assert.equal(await gateDecision({ cfg: { ...cfg, enforcement: false }, hookName: "PreToolUse", sessionIds: ["s1"] }), null);
  });

  it("denies a stopped session's tool calls and ends the turn, and blocks its prompts", async () => {
    recordDirective(true, "s1", { id: "d", action: "shutdown", reason: "token_budget_exceeded" });
    const tool = await gateDecision({ cfg, hookName: "PreToolUse", sessionIds: ["s1"] });
    assert.equal(tool.continue, false);
    assert.equal(tool.hookSpecificOutput.permissionDecision, "deny");
    assert.equal(tool.stopReason, stopMessage("token_budget_exceeded"));
    const prompt = await gateDecision({ cfg, hookName: "UserPromptSubmit", sessionIds: ["s1"] });
    assert.deepEqual(prompt, { decision: "block", reason: stopMessage("token_budget_exceeded") });
  });

  it("stops a subagent's hook when its parent session is stopped", async () => {
    recordDirective(true, "parent", { id: "d", action: "shutdown" });
    const out = await gateDecision({ cfg, hookName: "PreToolUse", sessionIds: ["parent", "child"] });
    assert.equal(out.continue, false);
  });

  it("shows budget notices once, and not to a stop-only gate", async () => {
    recentPoll();
    recordDirective(true, "s1", { id: "w", action: "warn" });
    assert.equal(await gateDecision({ cfg, hookName: "PreToolUse", sessionIds: ["s1"], stopOnly: true }), null);
    const first = await gateDecision({ cfg, hookName: "PreToolUse", sessionIds: ["s1"] });
    assert.match(first.systemMessage, /warning threshold/);
    assert.equal(await gateDecision({ cfg, hookName: "PreToolUse", sessionIds: ["s1"] }), null);
  });

  it("polls the heartbeat for a pending stop when the session has been quiet, and allows when the server is down", async () => {
    let heartbeats = 0;
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        heartbeats += 1;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", directive: { id: "hb1", action: "shutdown", reason: "operator" } }));
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    setDirectiveSink((sid, d) => recordDirective(true, sid, d));
    try {
      const live = { ...cfg, server: `http://127.0.0.1:${server.address().port}` };
      const out = await gateDecision({ cfg: live, hookName: "PreToolUse", sessionIds: ["s1"] });
      assert.equal(out.continue, false);
      assert.equal(heartbeats, 1);
      // Within the idle window the gate does not poll again.
      await gateDecision({ cfg: live, hookName: "PreToolUse", sessionIds: ["s2"], now: Date.now() });
      await gateDecision({ cfg: live, hookName: "PreToolUse", sessionIds: ["s2"], now: Date.now() + GATE_POLL_IDLE_MS / 2 });
      assert.equal(heartbeats, 2);
      // An unreachable server fails open.
      assert.equal(await gateDecision({ cfg, hookName: "PreToolUse", sessionIds: ["s3"] }), null);
    } finally {
      setDirectiveSink(null);
      server.closeAllConnections();
      server.close();
    }
  });
});

describe("sendPendingControlEvents", () => {
  it("sends the owed events once", async () => {
    const bodies = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        bodies.push(JSON.parse(body));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"status":"ok"}');
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const cfg = { enforcement: true, server: `http://127.0.0.1:${server.address().port}`, token: "t" };
      recordDirective(true, "s1", { id: "d", action: "shutdown", reason: "manual" });
      await sendPendingControlEvents({ cfg, sessionId: "s1", basePayload: base });
      await sendPendingControlEvents({ cfg, sessionId: "s1", basePayload: base });
      assert.deepEqual(bodies.map((b) => b.event_type), ["directive_result", "session_end"]);
      assert.ok(readControlState("s1").stopped, "the stop stays in force after its events are sent");
      // At the session's end nothing more is owed; the state goes, and the
      // caller learns the session was stopped so it sends no other end.
      assert.equal(await finishControl({ cfg, sessionId: "s1", basePayload: base }), true);
      assert.deepEqual(readControlState("s1"), {});
      assert.equal(bodies.length, 2);
      recordDirective(true, "s2", { id: "e", action: "shutdown" });
      assert.equal(await finishControl({ cfg, sessionId: "s2", basePayload: base }), true);
      assert.deepEqual(bodies.slice(2).map((b) => b.event_type), ["directive_result", "session_end"]);
      assert.equal(await finishControl({ cfg, sessionId: "s3", basePayload: base }), false);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});

describe("hostile or malformed directives", () => {
  it("bounds and cleans the text a directive carries, and ignores one without a string action", () => {
    recordDirective(true, "s1", { id: "h1", action: "degrade", degrade_to: "\u001b[31mmodel\u0007", reason: "r".repeat(500) });
    const state = readControlState("s1");
    assert.equal(state.pending[0].degrade_to, "[31mmodel");
    assert.equal(state.pending[0].reason, "");
    assert.doesNotMatch(state.notices[0], /[\x00-\x1f]/);
    recordDirective(true, "s2", { id: "h2", action: 7 });
    recordDirective(true, "s2", ["shutdown"]);
    recordDirective(true, "s2", null);
    assert.deepEqual(readControlState("s2"), {});
  });
});

describe("events the server did not accept", () => {
  it("go back to pending and are sent later, in order, none twice", async () => {
    const bodies = [];
    let refuseEnd = true;
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const event = JSON.parse(body);
        if (event.event_type === "session_end" && refuseEnd) {
          refuseEnd = false;
          res.writeHead(503);
          res.end();
          return;
        }
        bodies.push(event.event_type);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"status":"ok"}');
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const cfg = { enforcement: true, server: `http://127.0.0.1:${server.address().port}`, token: "t" };
      recordDirective(true, "s1", { id: "b", action: "shutdown", reason: "token_budget_exceeded" });
      await sendPendingControlEvents({ cfg, sessionId: "s1", basePayload: base });
      assert.deepEqual(bodies, ["directive_result", "policy_block"]);
      assert.deepEqual(readControlState("s1").pending[0].sent, ["directive_result", "policy_block"]);
      await sendPendingControlEvents({ cfg, sessionId: "s1", basePayload: base });
      assert.deepEqual(bodies, ["directive_result", "policy_block", "session_end"]);
      assert.deepEqual(readControlState("s1").pending, []);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});

