// hooks/hooks.json: every hook has an explicit timeout sized to its
// worst case, and PreToolUse runs only for MCP tools (the only tools the
// plugin gates).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOOKS = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "hooks", "hooks.json"), "utf8"),
).hooks;

describe("hooks.json", () => {
  it("gives every hook but SessionEnd an explicit timeout in seconds", () => {
    for (const [event, groups] of Object.entries(HOOKS)) {
      for (const group of groups) {
        for (const hook of group.hooks) {
          if (event === "SessionEnd") {
            // Claude Code's own 1.5 s SessionEnd budget governs it.
            assert.equal(hook.timeout, undefined, event);
            continue;
          }
          assert.ok(Number.isInteger(hook.timeout), `${event} timeout`);
          assert.ok(hook.timeout >= 10 && hook.timeout <= 30, `${event} timeout ${hook.timeout}s`);
        }
      }
    }
  });

  it("SessionStart's timeout covers its slowest path", () => {
    // claude auth status (5 s), the session_start POST (2 s), the MCP
    // policy fetch (1.5 s) and three git probes (0.5 s each), before any
    // per-server policy event.
    const [hook] = HOOKS.SessionStart[0].hooks;
    assert.ok(hook.timeout * 1000 > 5000 + 2000 + 1500 + 3 * 500);
  });

  it("runs PreToolUse only for MCP tools", () => {
    const groups = HOOKS.PreToolUse;
    assert.equal(groups.length, 1);
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
