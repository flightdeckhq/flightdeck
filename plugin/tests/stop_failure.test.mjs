// claude_code/stop_failure.mjs: a StopFailure hook becomes an llm_error
// in the shared taxonomy, with Claude Code's own error code kept.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  STOP_FAILURE_ERROR_TYPES,
  STOP_FAILURE_TEXT_MAX_CHARS,
  buildStopFailureEvent,
  llmErrorEventId,
} from "../hooks/scripts/claude_code/stop_failure.mjs";

const base = { session_id: "s1", agent_id: "a1", flavor: "claude-code", model: "claude-opus-5-5" };

function build(hookEvent, extra = {}) {
  return buildStopFailureEvent({
    basePayload: base,
    hookEvent: { hook_event_name: "StopFailure", ...hookEvent },
    model: null,
    failedTurn: null,
    capturePrompts: true,
    ...extra,
  });
}

describe("StopFailure to llm_error", () => {
  it("maps every documented Claude Code error onto the llm_error taxonomy", () => {
    const expected = {
      rate_limit: ["rate_limit", true],
      overloaded: ["overloaded", true],
      authentication_failed: ["authentication", false],
      cloud_credential_error: ["authentication", false],
      oauth_org_not_allowed: ["permission", false],
      account_on_hold: ["permission", false],
      billing_error: ["quota_exceeded", false],
      invalid_request: ["invalid_request", false],
      model_not_found: ["not_found", false],
      server_error: ["api_error", true],
      max_output_tokens: ["other", false],
      unknown: ["other", false],
    };
    assert.deepEqual(Object.keys(STOP_FAILURE_ERROR_TYPES).sort(), Object.keys(expected).sort());
    for (const [code, [type, retryable]] of Object.entries(expected)) {
      const { error } = build({ error: code });
      assert.equal(error.error_type, type, code);
      assert.equal(error.is_retryable, retryable, code);
      assert.equal(error.provider_error_code, code);
    }
  });

  it("reports a code Claude Code adds later as other, keeping the code", () => {
    const { error } = build({ error: "quota_paused" });
    assert.equal(error.error_type, "other");
    assert.equal(error.provider_error_code, "quota_paused");
    // An inherited property name is not a known code either.
    assert.equal(build({ error: "toString" }).error.error_type, "other");
  });

  it("bounds a missing or hostile code to unknown", () => {
    for (const bad of [undefined, 42, "", "x".repeat(65), "bad\ncode"]) {
      const { error } = build({ error: bad });
      assert.equal(error.provider_error_code, "unknown", String(bad));
      assert.equal(error.error_type, "other");
    }
  });

  it("reads the HTTP status leading error_details", () => {
    assert.equal(build({ error: "rate_limit", error_details: "429 Too Many Requests" }).error.http_status, 429);
    assert.equal(build({ error: "rate_limit", error_details: "Too Many Requests" }).error.http_status, null);
    assert.equal(build({ error: "rate_limit" }).error.http_status, null);
  });

  it("appends Claude Code's error text only when capture is on, cut to the limit", () => {
    const text = "API Error: " + "r".repeat(400);
    const on = build({ error: "rate_limit", last_assistant_message: text }).error.error_message;
    assert.equal(on, `StopFailure: rate_limit: ${text.slice(0, STOP_FAILURE_TEXT_MAX_CHARS)}`);
    const off = build({ error: "rate_limit", last_assistant_message: text }, { capturePrompts: false }).error.error_message;
    assert.equal(off, "StopFailure: rate_limit");
    // error_details stands in when there is no rendered text.
    assert.equal(
      build({ error: "rate_limit", error_details: "429 Too Many Requests" }).error.error_message,
      "StopFailure: rate_limit: 429 Too Many Requests",
    );
  });

  it("is a terminal llm_error stamped with the failed turn's id and time", () => {
    const failedTurn = { messageId: "42e026be-b820-4ca4-91a1-394a492514f9", lastTimestamp: "2026-10-29T13:00:00.000Z" };
    const event = build({ error: "server_error" }, { failedTurn, model: "claude-sonnet-5-5" });
    assert.equal(event.event_type, "llm_error");
    assert.equal(event.terminal, true);
    assert.equal(event.id, llmErrorEventId(failedTurn.messageId));
    assert.equal(event.timestamp, failedTurn.lastTimestamp);
    assert.equal(event.model, "claude-sonnet-5-5");
    assert.equal(event.session_id, "s1");
  });

  it("without a failed turn in the transcript it has no client id and falls back to the session model", () => {
    const event = build({ error: "server_error" });
    assert.equal("id" in event, false);
    assert.equal(event.model, "claude-opus-5-5");
  });

  it("derives a stable UUID5 per failed turn", () => {
    const a = llmErrorEventId("msg_1");
    assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(llmErrorEventId("msg_1"), a);
    assert.notEqual(llmErrorEventId("msg_2"), a);
  });
});
