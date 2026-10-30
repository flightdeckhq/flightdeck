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

function build(hookName, hookEvent, capturePrompts = true) {
  return buildSignalEvent({ hookName, hookEvent: { hook_event_name: hookName, ...hookEvent }, basePayload: base, capturePrompts });
}

describe("session_signal events", () => {
  it("covers PreCompact, PostCompact and PostModelSwitch", () => {
    assert.deepEqual([...SIGNAL_HOOKS].sort(), ["PostCompact", "PostModelSwitch", "PreCompact"]);
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
});
