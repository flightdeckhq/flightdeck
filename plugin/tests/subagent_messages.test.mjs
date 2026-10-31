// claude_code/subagent.mjs: the prompt and report a subagent exchanges
// with its parent, read from the files Claude Code writes for it, and a
// fork's copied history left to the parent. Fixtures follow the layout
// and record shapes Claude Code 2.1.316 writes.

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  _subagentMetaPath,
  isForkSubagent,
  ownSubagentTurns,
  subagentIncomingMessage,
  subagentOutgoingMessage,
} from "../hooks/scripts/claude_code/subagent.mjs";
import { readTurns } from "../hooks/scripts/claude_code/transcript.mjs";

const root = mkdtempSync(join(tmpdir(), "fd-subagent-msg-"));
after(() => rmSync(root, { recursive: true, force: true }));

const usage = { input_tokens: 10, output_tokens: 5 };

function assistant(id, content, timestamp = "2026-10-31T09:00:01.000Z") {
  return { type: "assistant", timestamp, message: { id, role: "assistant", model: "claude-opus-5-5", usage, content } };
}

function user(content, timestamp = "2026-10-31T09:00:00.000Z") {
  return { type: "user", timestamp, message: { role: "user", content } };
}

function agentCall(toolUseId, prompt) {
  return { type: "tool_use", id: toolUseId, name: "Agent", input: { description: "d", subagent_type: "general-purpose", prompt } };
}

/** A parent transcript and its subagents' files, as Claude Code lays them out. */
function layout(name, parentRecords, subagents) {
  const dir = join(root, name);
  const parent = join(dir, "parent.jsonl");
  mkdirSync(join(dir, "parent", "subagents"), { recursive: true });
  writeFileSync(parent, parentRecords.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const paths = {};
  for (const [agentId, { records, meta }] of Object.entries(subagents)) {
    const path = join(dir, "parent", "subagents", `agent-${agentId}.jsonl`);
    writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    if (meta) writeFileSync(_subagentMetaPath(path), JSON.stringify(meta));
    paths[agentId] = path;
  }
  return { parent, paths };
}

describe("subagent incoming message", () => {
  const { parent, paths } = layout(
    "parallel",
    [user("launch two"), assistant("msg_parent", [agentCall("toolu_a", "Reply with APPLE"), agentCall("toolu_m", "Reply with MANGO")])],
    {
      a1: { records: [user("Reply with APPLE"), user("<system-reminder>handback</system-reminder>")], meta: { agentType: "general-purpose", toolUseId: "toolu_a" } },
      a2: { records: [user("Reply with MANGO")], meta: { agentType: "general-purpose", toolUseId: "toolu_m" } },
      a3: { records: [user("Find the TODOs")], meta: null },
    },
  );

  it("is the prompt of the Agent call the meta file names, so parallel subagents each get their own", () => {
    assert.equal(subagentIncomingMessage({ hookEvent: {}, subagentTranscript: paths.a1, parentTranscript: parent }), "Reply with APPLE");
    assert.equal(subagentIncomingMessage({ hookEvent: {}, subagentTranscript: paths.a2, parentTranscript: parent }), "Reply with MANGO");
  });

  it("falls back to the subagent transcript's first plain-text user message without a meta file", () => {
    assert.equal(subagentIncomingMessage({ hookEvent: {}, subagentTranscript: paths.a3, parentTranscript: parent }), "Find the TODOs");
  });

  it("prefers the hook's own tool_input.prompt and is null with nothing to read", () => {
    assert.equal(
      subagentIncomingMessage({ hookEvent: { tool_input: { prompt: "legacy" } }, subagentTranscript: paths.a1, parentTranscript: parent }),
      "legacy",
    );
    assert.equal(subagentIncomingMessage({ hookEvent: {}, subagentTranscript: join(root, "missing.jsonl"), parentTranscript: parent }), null);
    assert.equal(subagentIncomingMessage({ hookEvent: {}, subagentTranscript: null, parentTranscript: parent }), null);
  });
});

describe("subagent outgoing message", () => {
  const { parent, paths } = layout("report", [user("go"), assistant("msg_parent", [agentCall("toolu_r", "Reply with PINEAPPLE")])], {
    handback: {
      records: [
        user("Reply with PINEAPPLE"),
        assistant("msg_s1", [{ type: "text", text: "Working on it." }]),
        assistant("msg_s2", [{ type: "tool_use", id: "toolu_h", name: "SubagentHandback", input: { message: "PINEAPPLE" } }]),
      ],
      meta: { toolUseId: "toolu_r" },
    },
    textOnly: {
      records: [user("Say hi"), assistant("msg_t1", [{ type: "thinking", thinking: "" }, { type: "text", text: "hi there" }])],
      meta: { toolUseId: "toolu_r" },
    },
  });

  it("is the message of the subagent's last SubagentHandback call", () => {
    assert.equal(subagentOutgoingMessage({ hookEvent: {}, subagentTranscript: paths.handback, parentTranscript: parent }), "PINEAPPLE");
  });

  it("falls back to last_assistant_message, then to the last assistant turn's text", () => {
    assert.equal(
      subagentOutgoingMessage({ hookEvent: { last_assistant_message: "from the hook" }, subagentTranscript: paths.textOnly, parentTranscript: parent }),
      "from the hook",
    );
    assert.equal(subagentOutgoingMessage({ hookEvent: {}, subagentTranscript: paths.textOnly, parentTranscript: parent }), "hi there");
  });

  it("prefers the hook's own tool_response", () => {
    assert.equal(
      subagentOutgoingMessage({ hookEvent: { tool_response: "legacy" }, subagentTranscript: paths.handback, parentTranscript: parent }),
      "legacy",
    );
  });
});

describe("fork subagents", () => {
  const parentTurn = assistant("msg_parent_call", [agentCall("toolu_f", "Repeat the first word")]);
  const { parent, paths } = layout("fork", [user("say KIWI then fork"), parentTurn], {
    fork: {
      records: [
        { type: "fork-context-ref" },
        parentTurn,
        user([{ type: "tool_result", tool_use_id: "toolu_f", content: [{ type: "text", text: "Fork started" }] }]),
        user([{ type: "text", text: "<fork-boilerplate>You are a worker fork.</fork-boilerplate>" }]),
        assistant("msg_fork_own", [{ type: "text", text: "The first word was KIWI." }], "2026-10-31T09:00:05.000Z"),
      ],
      meta: { agentType: "fork", isFork: true, toolUseId: "toolu_f" },
    },
  });

  it("is recognised by its agent_type or its meta file", () => {
    assert.equal(isForkSubagent("fork", null), true);
    assert.equal(isForkSubagent("general-purpose", paths.fork), true);
    assert.equal(isForkSubagent("general-purpose", join(root, "missing.jsonl")), false);
  });

  it("keeps only the fork's own turns; the copied parent turn is the parent's", () => {
    const turns = readTurns(paths.fork);
    assert.deepEqual(turns.map((t) => t.messageId), ["msg_parent_call", "msg_fork_own"]);
    const own = ownSubagentTurns(turns, { role: "fork", subagentTranscript: paths.fork, parentTranscript: parent });
    assert.deepEqual(own.map((t) => t.messageId), ["msg_fork_own"]);
    const notFork = ownSubagentTurns(turns, { role: "Explore", subagentTranscript: join(root, "missing.jsonl"), parentTranscript: parent });
    assert.equal(notFork.length, 2);
  });

  it("takes its prompt from the copied Agent call and its report from its own turn", () => {
    assert.equal(subagentIncomingMessage({ hookEvent: {}, subagentTranscript: paths.fork, parentTranscript: parent }), "Repeat the first word");
    assert.equal(
      subagentOutgoingMessage({ hookEvent: {}, subagentTranscript: paths.fork, parentTranscript: parent, role: "fork" }),
      "The first word was KIWI.",
    );
  });
});
