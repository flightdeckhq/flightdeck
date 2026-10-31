// claude_code/subagent.mjs: the prompt and report a subagent exchanges
// with its parent, read from the files Claude Code writes for it, and a
// fork's copied history left to the parent. Fixtures follow the layout
// and record shapes Claude Code 2.1.316 writes.

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SUBAGENT_FILES_WAIT_MS,
  _subagentMetaPath,
  isForkSubagent,
  ownSubagentTurns,
  subagentIncomingMessage,
  subagentOutgoingMessage,
  waitForSubagentFiles,
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

describe("subagent files that are partial, malformed or missing", () => {
  const { parent, paths } = layout("malformed", [user("go"), assistant("msg_p", [agentCall("toolu_x", "Count the files")])], {
    partial: { records: [user("Count the files"), assistant("msg_s", [{ type: "text", text: "12 files" }])], meta: { toolUseId: "toolu_x" } },
    badMeta: { records: [user("From the transcript")], meta: null },
    split: {
      records: [
        user("Summarise"),
        assistant("msg_split", [{ type: "text", text: "First part." }]),
        assistant("msg_split", [{ type: "text", text: "Second part." }]),
        assistant("msg_empty", [{ type: "tool_use", id: "toolu_h", name: "SubagentHandback", input: { message: "  " } }]),
      ],
      meta: null,
    },
  });
  appendFileSync(paths.partial, '{"type":"assistant","message":{"id":"msg_cut","content":[{"type":"te');
  writeFileSync(_subagentMetaPath(paths.badMeta), "[1, 2]");

  it("skips a partly written last line", () => {
    assert.equal(subagentIncomingMessage({ hookEvent: {}, subagentTranscript: paths.partial, parentTranscript: parent }), "Count the files");
    assert.equal(subagentOutgoingMessage({ hookEvent: {}, subagentTranscript: paths.partial, parentTranscript: parent }), "12 files");
  });

  it("treats a meta file that is not an object as missing", () => {
    assert.equal(subagentIncomingMessage({ hookEvent: {}, subagentTranscript: paths.badMeta, parentTranscript: parent }), "From the transcript");
  });

  it("passes over an empty handback and joins the text blocks of the last message", () => {
    assert.equal(
      subagentOutgoingMessage({ hookEvent: {}, subagentTranscript: paths.split, parentTranscript: parent }),
      "First part.\nSecond part.",
    );
  });
});

describe("fork subagents without the parent's transcript", () => {
  const copiedHandback = assistant("msg_old_handback", [
    { type: "tool_use", id: "toolu_old", name: "SubagentHandback", input: { message: "the parent's old report" } },
  ]);
  const parentCall = assistant("msg_call", [agentCall("toolu_fk", "Check the build")]);
  const { paths } = layout("fork-alone", [], {
    withMeta: {
      records: [
        { type: "fork-context-ref" },
        user("original task"),
        copiedHandback,
        parentCall,
        user([{ type: "text", text: "<fork-boilerplate/>" }]),
        assistant("msg_own", [{ type: "text", text: "Build is green." }], "2026-10-31T09:00:09.000Z"),
      ],
      meta: { agentType: "fork", isFork: true, toolUseId: "toolu_fk" },
    },
    noMeta: { records: [user("original task"), assistant("msg_own2", [{ type: "text", text: "done" }])], meta: null },
  });
  const missingParent = join(root, "no-parent.jsonl");

  it("ends the copied history at the Agent call the meta file names", () => {
    const own = ownSubagentTurns(readTurns(paths.withMeta), { role: "fork", subagentTranscript: paths.withMeta, parentTranscript: missingParent });
    assert.deepEqual(own.map((t) => t.messageId), ["msg_own"]);
  });

  it("ignores a SubagentHandback in the copied history", () => {
    assert.equal(
      subagentOutgoingMessage({ hookEvent: {}, subagentTranscript: paths.withMeta, parentTranscript: missingParent, role: "fork" }),
      "Build is green.",
    );
  });

  it("has no incoming message without a meta file: its first user message is the parent's", () => {
    assert.equal(subagentIncomingMessage({ hookEvent: {}, subagentTranscript: paths.noMeta, parentTranscript: missingParent, role: "fork" }), null);
  });
});

describe("waitForSubagentFiles", () => {
  it("returns once Claude Code has written the transcript and the meta file", async () => {
    const dir = mkdtempSync(join(root, "wait-"));
    const transcript = join(dir, "agent-late.jsonl");
    setTimeout(() => {
      writeFileSync(transcript, "");
      writeFileSync(_subagentMetaPath(transcript), "{}");
    }, 200);
    const started = Date.now();
    await waitForSubagentFiles(transcript);
    assert.ok(existsSync(transcript) && existsSync(_subagentMetaPath(transcript)));
    assert.ok(Date.now() - started < SUBAGENT_FILES_WAIT_MS);
  });

  it("gives up at SUBAGENT_FILES_WAIT_MS when the files never appear", async () => {
    const started = Date.now();
    await waitForSubagentFiles(join(root, "never.jsonl"));
    const waited = Date.now() - started;
    assert.ok(waited >= SUBAGENT_FILES_WAIT_MS - 10, `waited ${waited} ms`);
    assert.ok(waited < SUBAGENT_FILES_WAIT_MS * 3, `waited ${waited} ms`);
  });
});

