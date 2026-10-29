// claude_code/stop_failure.mjs: a StopFailure hook becomes an llm_error
// in the shared taxonomy, with Claude Code's own error code kept.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  STOP_FAILURE_ERROR_TYPES,
  STOP_FAILURE_TEXT_MAX_CHARS,
  buildStopFailureEvent,
  failedTurnFor,
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

  it("reads the HTTP status leading error_details, else the one the transcript recorded", () => {
    assert.equal(build({ error: "rate_limit", error_details: "429 Too Many Requests" }).error.http_status, 429);
    assert.equal(build({ error: "rate_limit", error_details: "Too Many Requests" }).error.http_status, null);
    assert.equal(build({ error: "rate_limit" }).error.http_status, null);
    const failedTurn = { messageId: "m1", apiErrorStatus: 429 };
    assert.equal(build({ error: "rate_limit" }, { failedTurn }).error.http_status, 429);
    assert.equal(
      build({ error: "rate_limit", error_details: "503 Service Unavailable" }, { failedTurn }).error.http_status,
      503,
    );
    assert.equal(build({ error: "rate_limit" }, { failedTurn: { apiErrorStatus: 9000 } }).error.http_status, null);
  });

  it("refines Claude Code's coarse code from the transcript's kind or its fixed message phrases", () => {
    const cases = [
      // Claude Code sends a full context window as invalid_request.
      [{ error: "invalid_request", last_assistant_message: "Prompt is too long" }, null, "context_overflow"],
      [{ error: "invalid_request", last_assistant_message: "Prompt is too long · automatic compaction failed" }, null, "context_overflow"],
      // A used-up subscription allowance arrives as rate_limit.
      [{ error: "rate_limit", last_assistant_message: "You've hit your session limit · resets 1pm" }, null, "quota_exceeded"],
      [{ error: "rate_limit", last_assistant_message: "x" }, { apiErrorKind: "usage_limit_reached" }, "quota_exceeded"],
      [{ error: "rate_limit", last_assistant_message: "API Error: Usage credits required for 1M context" }, null, "quota_exceeded"],
      [{ error: "rate_limit", last_assistant_message: "x" }, { apiErrorKind: "long_context_credits_required" }, "quota_exceeded"],
      // Unrelated text and unknown kinds leave the mapping alone.
      [{ error: "invalid_request", last_assistant_message: "API Error: tool schema invalid" }, null, "invalid_request"],
      [{ error: "rate_limit", last_assistant_message: "x" }, { apiErrorKind: "something_new" }, "rate_limit"],
    ];
    for (const [hookEvent, failedTurn, type] of cases) {
      const { error } = build(hookEvent, { failedTurn, capturePrompts: false });
      assert.equal(error.error_type, type, JSON.stringify([hookEvent, failedTurn]));
      assert.equal(error.is_retryable, type === "rate_limit");
    }
    // The classification never puts the text on the wire with capture off.
    const off = build({ error: "invalid_request", last_assistant_message: "Prompt is too long" }, { capturePrompts: false });
    assert.equal(off.error.error_message, "StopFailure: invalid_request");
    // The transcript's finer kind is the provider code when it has one.
    const kind = build({ error: "rate_limit" }, { failedTurn: { apiErrorKind: "usage_limit_reached" } });
    assert.equal(kind.error.provider_error_code, "usage_limit_reached");
  });

  it("takes the failed turn answering this hook's prompt, never an earlier failure", () => {
    const turn = (messageId, promptId, apiError = true) => ({ messageId, apiError, userTurn: { promptId } });
    const first = turn("fail-1", "prompt-1");
    const ok = turn("ok-2", "prompt-2", false);
    // Failure 2's record not written yet when the hook reads the transcript.
    assert.equal(failedTurnFor([first, ok], { prompt_id: "prompt-2" }), null);
    const second = turn("fail-2", "prompt-2");
    assert.equal(failedTurnFor([first, ok, second], { prompt_id: "prompt-2" }), second);
    assert.equal(failedTurnFor([first, ok, second], { prompt_id: "prompt-1" }), first);
    assert.equal(failedTurnFor([first], {}), null);
    // So two failures get two ids, and an unmatched one none.
    const e1 = build({ error: "rate_limit", prompt_id: "prompt-1" }, { failedTurn: failedTurnFor([first], { prompt_id: "prompt-1" }) });
    const e2 = build({ error: "rate_limit", prompt_id: "prompt-2" }, { failedTurn: failedTurnFor([first, ok], { prompt_id: "prompt-2" }) });
    assert.equal(e1.id, llmErrorEventId("fail-1"));
    assert.equal("id" in e2, false);
  });

  it("appends Claude Code's error text only when capture is on, on one line and cut as the sensor cuts", () => {
    const text = "API Error: " + "r".repeat(400);
    const on = build({ error: "rate_limit", last_assistant_message: text }).error.error_message;
    assert.equal(on, `StopFailure: rate_limit: ${text.slice(0, STOP_FAILURE_TEXT_MAX_CHARS - 3)}...`);
    assert.equal(
      build({ error: "rate_limit", last_assistant_message: "API Error:\r\n  overloaded" }).error.error_message,
      "StopFailure: rate_limit: API Error:   overloaded",
    );
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
