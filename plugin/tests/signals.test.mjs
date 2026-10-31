// claude_code/signals.mjs: compaction and model-switch hooks become
// session_signal events with bounded metadata and capture-gated text.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_SIGNAL_DATA_VALUE_BYTES,
  SIGNAL_CONTENT_PROVIDER,
  SIGNAL_HOOKS,
  buildSignalEvent,
} from "../hooks/scripts/claude_code/signals.mjs";

const base = { session_id: "s1", agent_id: "a1", flavor: "claude-code", model: "claude-sonnet-5", has_content: false, content: null };

function build(hookName, hookEvent, capturePrompts = true, captureToolInputs = true) {
  return buildSignalEvent({
    hookName,
    hookEvent: { hook_event_name: hookName, ...hookEvent },
    basePayload: base,
    capturePrompts,
    captureToolInputs,
  });
}

describe("session_signal events", () => {
  it("covers the compaction, model-switch, notification, permission, command, task, cwd, config and elicitation hooks", () => {
    assert.deepEqual([...SIGNAL_HOOKS].sort(), [
      "ConfigChange",
      "CwdChanged",
      "Elicitation",
      "ElicitationResult",
      "Notification",
      "PermissionDenied",
      "PermissionRequest",
      "PostCompact",
      "PostModelSwitch",
      "PreCompact",
      "TaskCompleted",
      "TaskCreated",
      "TeammateIdle",
      "UserPromptExpansion",
    ]);
  });

  it("keeps only the documented metadata fields, bounded", () => {
    const event = build("PostModelSwitch", {
      from_model: "claude-sonnet-5",
      to_model: "claude-opus-5",
      requested_model: null,
      source: "auto",
      context_tokens: 0,
      prompt_cache_warm: false,
      cache_ttl: "1h",
      estimated_cache_write_usd: Number.NaN,
      pricing: "x".repeat(MAX_SIGNAL_DATA_VALUE_BYTES + 1),
      session_id: "ignored",
      transcript_path: "/secret/path.jsonl",
    });
    assert.deepEqual(event.signal_data, {
      from_model: "claude-sonnet-5",
      to_model: "claude-opus-5",
      requested_model: null,
      source: "auto",
      context_tokens: 0,
      prompt_cache_warm: false,
      cache_ttl: "1h",
    });
  });

  it("drops a nested or control-character value", () => {
    const event = build("PreCompact", { trigger: { nested: true } });
    assert.deepEqual(event.signal_data, {});
    assert.deepEqual(build("PreCompact", { trigger: "auto\nmanual" }).signal_data, {});
  });

  it("only a model switch carries a model, so only it moves the session's model", () => {
    assert.equal(build("PostModelSwitch", { to_model: "claude-opus-5" }).model, "claude-opus-5");
    assert.equal(build("PostCompact", { trigger: "auto" }).model, null);
    assert.equal(build("PreCompact", { trigger: "auto" }).model, null);
  });

  it("sends the hook's text as content only under capture, and never empty text", () => {
    const on = build("PostCompact", { trigger: "auto", compact_summary: "Summary." });
    assert.equal(on.has_content, true);
    assert.deepEqual(on.content, {
      provider: SIGNAL_CONTENT_PROVIDER,
      model: "",
      system: null,
      messages: [],
      tools: null,
      response: { compact_summary: "Summary." },
    });
    const off = build("PostCompact", { trigger: "auto", compact_summary: "Summary." }, false);
    assert.equal(off.has_content, false);
    assert.equal(off.content, null);
    // /compact with no instructions: custom_instructions is null.
    const none = build("PreCompact", { trigger: "manual", custom_instructions: null });
    assert.equal(none.has_content, false);
    assert.equal(none.content, null);
    assert.equal(build("PreCompact", { trigger: "manual", custom_instructions: "  " }).has_content, false);
  });

  it("reports a notification by type, its text only under capture", () => {
    const on = build("Notification", {
      notification_type: "permission_prompt",
      message: "Claude needs your permission to use Bash",
      title: "Permission needed",
    });
    assert.equal(on.signal, "notification");
    assert.deepEqual(on.signal_data, { notification_type: "permission_prompt" });
    assert.deepEqual(on.content.response, {
      message: "Claude needs your permission to use Bash",
      title: "Permission needed",
    });
    const off = build("Notification", { notification_type: "idle_prompt", message: "Waiting" }, false);
    assert.equal(off.has_content, false);
    assert.equal(off.content, null);
    assert.ok(!JSON.stringify(off).includes("Waiting"));
  });

  it("reports a permission request with the tool, its whitelisted input under tool-input capture", () => {
    const hookEvent = {
      tool_name: "Bash",
      tool_input: { command: "rm -rf node_modules", description: "Remove node_modules directory" },
      permission_suggestions: [{ type: "addRules" }],
    };
    const on = build("PermissionRequest", hookEvent);
    assert.equal(on.signal, "permission_requested");
    assert.deepEqual(on.signal_data, { tool_name: "Bash", command: "rm -rf node_modules" });
    assert.equal(on.has_content, false);
    const off = build("PermissionRequest", hookEvent, true, false);
    assert.deepEqual(off.signal_data, { tool_name: "Bash" });
  });

  it("names an MCP tool's server and keeps its arguments out", () => {
    const withServer = build("PermissionRequest", {
      tool_name: "mcp__github__search",
      tool_input: { query: "secret customer text", file_path: "/x" },
      mcp_server: { name: "github", source: "project" },
    });
    assert.deepEqual(withServer.signal_data, { tool_name: "mcp__github__search", mcp_server: "github" });
    // Without the hook's mcp_server object the mcp__ prefix still marks it.
    const byName = build("PermissionDenied", { tool_name: "mcp__db__run", tool_input: { query: "select 1" } });
    assert.equal("query" in byName.signal_data, false);
  });

  it("cuts a long or multi-line tool input to the bound instead of dropping it", () => {
    const long = build("PermissionRequest", { tool_name: "Read", tool_input: { file_path: "/x/" + "p".repeat(400) } });
    assert.equal(Buffer.byteLength(long.signal_data.file_path, "utf8"), MAX_SIGNAL_DATA_VALUE_BYTES);
    const heredoc = build("PermissionRequest", {
      tool_name: "Bash",
      tool_input: { command: "git commit -m \"$(cat <<'EOF'\nfix: the thing\n\tdetails\nEOF\n)\"" },
    });
    assert.equal(heredoc.signal_data.command, "git commit -m \"$(cat <<'EOF' fix: the thing details EOF )\"");
    const tab = build("PermissionRequest", { tool_name: "Grep", tool_input: { pattern: "a\tb" } });
    assert.equal(tab.signal_data.pattern, "a b");
  });

  it("reports an auto-mode denial with the tool, its use id and the matched rule", () => {
    const event = build("PermissionDenied", {
      tool_name: "Bash",
      tool_input: { command: "rm -rf /tmp/build" },
      tool_use_id: "toolu_01ABC",
      reason: "[Irreversible Local Destruction]",
    });
    assert.equal(event.signal, "permission_denied");
    assert.deepEqual(event.signal_data, {
      tool_name: "Bash",
      tool_use_id: "toolu_01ABC",
      reason: "[Irreversible Local Destruction]",
      command: "rm -rf /tmp/build",
    });
    assert.equal(event.model, null);
  });
  it("reports a slash command by name and source, its arguments only under capture, never the prompt", () => {
    const hook = {
      expansion_type: "mcp_prompt",
      command_name: "mcp__docs__summarise",
      command_source: "mcp",
      command_args: "chapter 3",
      prompt: "/mcp__docs__summarise chapter 3",
    };
    const on = build("UserPromptExpansion", hook);
    assert.equal(on.signal, "command_expanded");
    assert.deepEqual(on.signal_data, { expansion_type: "mcp_prompt", command_name: "mcp__docs__summarise", command_source: "mcp" });
    assert.deepEqual(on.content.response, { command_args: "chapter 3" });
    const off = build("UserPromptExpansion", hook, false);
    assert.equal(off.has_content, false);
    assert.equal(off.content, null);
    assert.ok(!JSON.stringify(off).includes("chapter 3"));
    const noArgs = build("UserPromptExpansion", { expansion_type: "slash_command", command_name: "compact", command_args: "" });
    assert.equal(noArgs.has_content, false);
  });

  it("reports a task with its id and teammate, the subject and description only under capture", () => {
    const hook = {
      task_id: "task-12",
      task_subject: "Migrate the auth tests",
      task_description: "Move them to the new fixture",
      teammate_name: "reviewer",
      team_name: "default",
    };
    for (const [hookName, signal] of [
      ["TaskCreated", "task_created"],
      ["TaskCompleted", "task_completed"],
    ]) {
      const on = build(hookName, hook);
      assert.equal(on.signal, signal);
      assert.deepEqual(on.signal_data, { task_id: "task-12", teammate_name: "reviewer" });
      assert.deepEqual(on.content.response, {
        task_subject: "Migrate the auth tests",
        task_description: "Move them to the new fixture",
      });
      const off = build(hookName, hook, false);
      assert.equal(off.content, null);
      assert.ok(!JSON.stringify(off).includes("auth tests"));
    }
  });

  it("reports a working-directory change with both paths, cutting a long path instead of dropping it", () => {
    const longPath = "/" + "d".repeat(MAX_SIGNAL_DATA_VALUE_BYTES + 40);
    const event = build("CwdChanged", { old_cwd: "/repo", new_cwd: longPath }, false);
    assert.equal(event.signal, "cwd_changed");
    assert.equal(event.signal_data.old_cwd, "/repo");
    assert.equal(event.signal_data.new_cwd, longPath.slice(0, MAX_SIGNAL_DATA_VALUE_BYTES));
    assert.equal(event.has_content, false);
  });

  it("reports a settings change with its source and file", () => {
    const event = build("ConfigChange", { source: "skills", file_path: "/home/u/.claude/skills/x/SKILL.md" }, false);
    assert.equal(event.signal, "config_changed");
    assert.deepEqual(event.signal_data, { source: "skills", file_path: "/home/u/.claude/skills/x/SKILL.md" });
    const noFile = build("ConfigChange", { source: "policy_settings" }, false);
    assert.deepEqual(noFile.signal_data, { source: "policy_settings" });
  });
  it("reports an MCP server's request for input by server and mode, its message, URL and form only under capture", () => {
    const hook = {
      mcp_server_name: "billing",
      mode: "url",
      elicitation_id: "el-7",
      message: "Sign in to continue",
      url: "https://auth.example.com/approve?token=secret-123",
      requested_schema: { type: "object", properties: { code: { type: "string" } } },
    };
    const on = build("Elicitation", hook);
    assert.equal(on.signal, "elicitation_requested");
    assert.deepEqual(on.signal_data, { mcp_server: "billing", mode: "url", elicitation_id: "el-7" });
    assert.equal(on.content.response.message, "Sign in to continue");
    assert.equal(on.content.response.url, "https://auth.example.com/approve?token=secret-123");
    assert.deepEqual(JSON.parse(on.content.response.requested_schema), hook.requested_schema);
    const off = build("Elicitation", hook, false);
    assert.equal(off.content, null);
    assert.ok(!JSON.stringify(off).includes("secret-123"));
    assert.ok(!JSON.stringify(off).includes("Sign in"));
  });

  it("reports the user's response to an elicitation, the answer only under capture", () => {
    const hook = { mcp_server_name: "billing", mode: "form", action: "accept", content: { code: "4242" } };
    const on = build("ElicitationResult", hook);
    assert.equal(on.signal, "elicitation_responded");
    assert.deepEqual(on.signal_data, { mcp_server: "billing", mode: "form", action: "accept" });
    assert.deepEqual(JSON.parse(on.content.response.content), { code: "4242" });
    const off = build("ElicitationResult", hook, false);
    assert.equal(off.has_content, false);
    assert.ok(!JSON.stringify(off).includes("4242"));
    const declined = build("ElicitationResult", { mcp_server_name: "billing", action: "decline" });
    assert.equal(declined.has_content, false);
  });
  it("reports an idle agent-team teammate by name", () => {
    const event = build("TeammateIdle", { teammate_name: "reviewer", team_name: "default" }, false);
    assert.equal(event.signal, "teammate_idle");
    assert.deepEqual(event.signal_data, { teammate_name: "reviewer" });
    assert.equal(event.has_content, false);
  });
});
