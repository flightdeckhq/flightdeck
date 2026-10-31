// hooks/hooks.json: every hook has an explicit timeout sized for its
// normal worst case, and PreToolUse runs only for MCP tools (the only
// tools the plugin gates).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { AUTH_STATUS_TIMEOUT_MS } from "../hooks/scripts/billing.mjs";
import { HOOK_FLUSH_DEADLINE_MS, MAX_AUTH_PROBES, defaultFlushDeadline } from "../hooks/scripts/claude_code/post_call.mjs";
import { TIMEOUT_MS } from "../hooks/scripts/core/poster.mjs";
import { FETCH_TIMEOUT_MS } from "../hooks/scripts/mcp_policy.mjs";

const HOOKS = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "hooks", "hooks.json"), "utf8"),
).hooks;

// The timeouts ARCHITECTURE.md's "Hook configuration" table documents.
const EXPECTED_TIMEOUTS = {
  SessionStart: 30,
  UserPromptSubmit: 15,
  PreToolUse: 10,
  PostToolUse: 30,
  PostToolUseFailure: 30,
  Stop: 30,
  StopFailure: 30,
  SubagentStop: 30,
  PreCompact: 15,
  PostCompact: 15,
  PostModelSwitch: 15,
  Notification: 15,
  PermissionRequest: 15,
  PermissionDenied: 15,
  UserPromptExpansion: 15,
  TaskCreated: 15,
  TaskCompleted: 15,
  CwdChanged: 15,
  ConfigChange: 15,
  Elicitation: 15,
  ElicitationResult: 15,
  SubagentStart: 15,
};

// The git probes run three subprocesses at 500 ms each (context.mjs).
const GIT_PROBES_MS = 3 * 500;

function timeoutOf(event) {
  const [group] = HOOKS[event];
  return group.hooks[0].timeout;
}

describe("hooks.json", () => {
  it("gives every hook the documented timeout, and SessionEnd none", () => {
    assert.deepEqual(Object.keys(HOOKS).sort(), [...Object.keys(EXPECTED_TIMEOUTS), "SessionEnd"].sort());
    for (const [event, seconds] of Object.entries(EXPECTED_TIMEOUTS)) {
      assert.equal(timeoutOf(event), seconds, event);
    }
    // Claude Code's own 1.5 s SessionEnd budget governs it.
    assert.equal(timeoutOf("SessionEnd"), undefined);
  });

  it("SessionStart's timeout covers its fixed steps", () => {
    const fixed = AUTH_STATUS_TIMEOUT_MS + TIMEOUT_MS + FETCH_TIMEOUT_MS + GIT_PROBES_MS;
    assert.ok(timeoutOf("SessionStart") * 1000 > fixed, `${fixed} ms`);
  });

  it("the flushing hooks' timeouts cover the auth probes and a few turns", () => {
    const probes = MAX_AUTH_PROBES * AUTH_STATUS_TIMEOUT_MS;
    for (const event of ["PostToolUse", "PostToolUseFailure", "Stop", "StopFailure", "SubagentStop"]) {
      assert.ok(timeoutOf(event) * 1000 >= probes + 5 * TIMEOUT_MS, event);
    }
  });

  it("UserPromptSubmit's timeout covers the session_start backstop and the pre_call", () => {
    assert.ok(timeoutOf("UserPromptSubmit") * 1000 > GIT_PROBES_MS + 2 * TIMEOUT_MS);
  });

  it("runs PreToolUse only for MCP tools", () => {
    const groups = HOOKS.PreToolUse;
    assert.equal(groups.length, 1);
    // Claude Code reads a matcher with ^ as an unanchored JavaScript regex.
    const matcher = new RegExp(groups[0].matcher);
    for (const tool of ["mcp__github__create_issue", "mcp__plugin_claude-mem_mcp-search__search"]) {
      assert.ok(matcher.test(tool), tool);
    }
    for (const tool of ["Bash", "Read", "Edit", "Task", "WebFetch", "my_mcp__tool"]) {
      assert.equal(matcher.test(tool), false, tool);
    }
  });

  it("runs the reporting hooks asynchronously and the deciding ones synchronously", () => {
    const asyncHooks = [
      "UserPromptSubmit",
      "PostToolUseFailure",
      "Stop",
      "StopFailure",
      "Notification",
      "PermissionRequest",
      "PermissionDenied",
      "UserPromptExpansion",
      "TaskCreated",
      "TaskCompleted",
      "CwdChanged",
      "ConfigChange",
      "ElicitationResult",
      "SubagentStart",
      "SubagentStop",
    ];
    for (const event of Object.keys(HOOKS)) {
      if (event === "PostToolUse") continue;
      for (const hook of HOOKS[event][0].hooks) {
        assert.equal(hook.async === true, asyncHooks.includes(event), event);
      }
    }
  });

  it("PostToolUse is synchronous for MCP tools (it records approvals the next call reads) and async otherwise", () => {
    const groups = HOOKS.PostToolUse;
    assert.equal(groups.length, 2);
    const [mcp, other] = groups;
    assert.equal(mcp.hooks[0].async, undefined);
    assert.equal(other.hooks[0].async, true);
    const mcpMatch = new RegExp(mcp.matcher);
    const otherMatch = new RegExp(other.matcher);
    for (const tool of ["mcp__github__create_issue", "mcp__plugin_claude-mem_mcp-search__search"]) {
      assert.ok(mcpMatch.test(tool) && !otherMatch.test(tool), tool);
    }
    for (const tool of ["Bash", "Read", "Edit", "Task", "Agent", "my_mcp__tool"]) {
      assert.ok(otherMatch.test(tool) && !mcpMatch.test(tool), tool);
    }
  });

  it("a hook's flush defaults to a bounded deadline", () => {
    assert.equal(defaultFlushDeadline(1000), 1000 + HOOK_FLUSH_DEADLINE_MS);
    assert.ok(HOOK_FLUSH_DEADLINE_MS < timeoutOf("Stop") * 1000);
  });

  it("PostToolUseFailure still sees every tool", () => {
    assert.equal(HOOKS.PostToolUseFailure[0].matcher, "*");
  });
});

describe("flushPostCallTurns deadline", () => {
  it("stops before the first POST once the deadline has passed, and says how many turns are left", async () => {
    const { flushPostCallTurns } = await import("../hooks/scripts/claude_code/post_call.mjs");
    const writes = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => {
      writes.push(String(chunk));
      return true;
    };
    const savedData = process.env.CLAUDE_PLUGIN_DATA;
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    process.env.CLAUDE_PLUGIN_DATA = mkdtempSync(join(tmpdir(), "fd-deadline-"));
    try {
      await flushPostCallTurns({
        // Port 9 is never listening; reaching a POST would log a failure.
        cfg: { server: "http://127.0.0.1:9", token: "t" },
        sessionId: "s",
        basePayload: {},
        turns: [{ messageId: "msg_deadline_a" }, { messageId: "msg_deadline_b" }],
        capturePrompts: false,
        deadline: Date.now() - 1,
      });
    } finally {
      process.stderr.write = realWrite;
      rmSync(process.env.CLAUDE_PLUGIN_DATA, { recursive: true, force: true });
      if (savedData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
      else process.env.CLAUDE_PLUGIN_DATA = savedData;
    }
    assert.deepEqual(writes, ["flightdeck: transcript flush deadline reached; 2 transcript turn(s) left unflushed.\n"]);
  });
});

describe("plugin.json userConfig", () => {
  const MANIFEST = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", ".claude-plugin", "plugin.json"), "utf8"),
  );

  it("declares the server and a sensitive token, with no default Claude Code would not export", () => {
    const { server, token } = MANIFEST.userConfig;
    assert.equal(server.type, "string");
    assert.equal(token.type, "string");
    assert.equal(token.sensitive, true);
    assert.equal(server.sensitive, undefined);
    // Claude Code exports an option only once the user saves it; the
    // defaults live in core/config.mjs.
    assert.equal("default" in server, false);
    assert.equal("default" in token, false);
    for (const option of [server, token]) {
      assert.ok(option.title && option.description, "title and description are required");
      assert.equal(option.required, undefined, "both stay optional for a local stack");
    }
  });
});
