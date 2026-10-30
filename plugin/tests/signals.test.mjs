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
  it("covers PreCompact, PostCompact and PostModelSwitch", () => {
    assert.deepEqual([...SIGNAL_HOOKS].sort(), [
      "Notification",
      "PermissionDenied",
      "PermissionRequest",
      "PostCompact",
      "PostModelSwitch",
      "PreCompact",
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

  it("names an MCP tool's server and cuts a long tool input to the bound", () => {
    const event = build("PermissionRequest", {
      tool_name: "mcp__github__create_issue",
      tool_input: { file_path: "/x/" + "p".repeat(400) },
      mcp_server: { name: "github", source: "project" },
    });
    assert.equal(event.signal_data.mcp_server, "github");
    assert.equal(Buffer.byteLength(event.signal_data.file_path, "utf8"), MAX_SIGNAL_DATA_VALUE_BYTES);
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
});
