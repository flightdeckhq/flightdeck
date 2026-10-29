// hooks/hooks.json: every hook has an explicit timeout sized for its
// normal worst case, and PreToolUse runs only for MCP tools (the only
// tools the plugin gates).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { AUTH_STATUS_TIMEOUT_MS } from "../hooks/scripts/billing.mjs";
import { MAX_AUTH_PROBES } from "../hooks/scripts/claude_code/post_call.mjs";
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
  SubagentStop: 30,
  PreCompact: 15,
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
    for (const event of ["PostToolUse", "PostToolUseFailure", "Stop", "SubagentStop"]) {
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

  it("every other tool hook still sees every tool", () => {
    for (const event of ["PostToolUse", "PostToolUseFailure"]) {
      assert.equal(HOOKS[event][0].matcher, "*", event);
    }
  });
});
