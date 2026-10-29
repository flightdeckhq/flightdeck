// StopFailure: Claude Code ends a turn on an API error instead of
// firing Stop. The plugin reports it as an llm_error, the event the
// Python sensor emits for a failed provider call, so the dashboard's
// error views cover Claude Code sessions too.

import { NAMESPACE_FLIGHTDECK } from "../agent_id.mjs";
import { MAX_SIGNAL_BYTES, boundedToken } from "../core/config.mjs";
import { uuid5 } from "../uuid5.mjs";

// Claude Code's StopFailure ``error`` values mapped onto the llm_error
// taxonomy (ARCHITECTURE.md, llm_error). A value Claude Code adds later
// reports as ``other``, with the original kept in provider_error_code.
export const STOP_FAILURE_ERROR_TYPES = Object.freeze({
  rate_limit: "rate_limit",
  overloaded: "overloaded",
  authentication_failed: "authentication",
  cloud_credential_error: "authentication",
  oauth_org_not_allowed: "permission",
  account_on_hold: "permission",
  billing_error: "quota_exceeded",
  invalid_request: "invalid_request",
  model_not_found: "not_found",
  server_error: "api_error",
  max_output_tokens: "other",
  unknown: "other",
});

// The llm_error types the taxonomy marks retryable.
const RETRYABLE_ERROR_TYPES = new Set(["rate_limit", "overloaded", "api_error"]);

// Claude Code's rendered error text is appended to error_message only
// when prompt capture is on, cut to the 200 characters the sensor
// keeps of a provider's message; it can quote the provider's response.
export const STOP_FAILURE_TEXT_MAX_CHARS = 200;

/**
 * The event id of the llm_error for one failed turn, derived from the
 * id of the synthetic assistant record Claude Code wrote for it, so a
 * repeated hook stores it once.
 */
export function llmErrorEventId(messageId) {
  return uuid5(NAMESPACE_FLIGHTDECK, `flightdeck://claude-code/llm_error/${messageId}`);
}

/** The HTTP status leading ``error_details`` ("429 Too Many Requests"), or null. */
function httpStatusOf(details) {
  const match = typeof details === "string" ? details.match(/^\s*([1-5]\d\d)\b/) : null;
  return match ? Number(match[1]) : null;
}

/**
 * The llm_error payload for a StopFailure hook. ``failedTurn`` is the
 * transcript's synthetic API-error turn for this failure, when there is
 * one; it supplies the event id and the timestamp.
 */
export function buildStopFailureEvent({ basePayload, hookEvent, model, failedTurn, capturePrompts }) {
  const code = boundedToken(hookEvent.error, MAX_SIGNAL_BYTES) ?? "unknown";
  const errorType = Object.hasOwn(STOP_FAILURE_ERROR_TYPES, code) ? STOP_FAILURE_ERROR_TYPES[code] : "other";
  let message = `StopFailure: ${code}`;
  const text = [hookEvent.last_assistant_message, hookEvent.error_details].find(
    (value) => typeof value === "string" && value.trim() !== "",
  );
  if (capturePrompts && text) {
    message += `: ${text.trim().slice(0, STOP_FAILURE_TEXT_MAX_CHARS)}`;
  }
  const payload = {
    ...basePayload,
    event_type: "llm_error",
    model: model || basePayload.model || null,
    tool_name: null,
    tool_input: null,
    is_subagent_call: false,
    latency_ms: null,
    timestamp: failedTurn?.lastTimestamp || new Date().toISOString(),
    terminal: true,
    error: {
      error_type: errorType,
      provider: "anthropic",
      http_status: httpStatusOf(hookEvent.error_details),
      provider_error_code: code,
      error_message: message,
      request_id: null,
      retry_after: null,
      is_retryable: RETRYABLE_ERROR_TYPES.has(errorType),
    },
  };
  if (failedTurn?.messageId) payload.id = llmErrorEventId(failedTurn.messageId);
  return payload;
}
