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

// Claude Code's ``error`` is coarse: a full context window arrives as
// invalid_request and a used-up subscription allowance as rate_limit.
// Its transcript records the finer kind for some failures, and its
// rendered message starts with a fixed phrase for others; either one
// refines the type. The message is read for this test only.
const API_ERROR_KIND_TYPES = Object.freeze({
  usage_limit_reached: "quota_exceeded",
  long_context_credits_required: "quota_exceeded",
});
const MESSAGE_PREFIX_TYPES = [
  [/^prompt is too long/i, "context_overflow"],
  [/^you've hit your [a-z ]*limit/i, "quota_exceeded"],
  [/^api error: usage credits required/i, "quota_exceeded"],
];

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

/**
 * The HTTP status leading ``error_details`` ("429 Too Many Requests"),
 * else the one the transcript recorded for the failed turn, else null.
 */
function httpStatusOf(details, failedTurn) {
  const match = typeof details === "string" ? details.match(/^\s*([1-5]\d\d)\b/) : null;
  if (match) return Number(match[1]);
  const recorded = failedTurn?.apiErrorStatus;
  return Number.isInteger(recorded) && recorded >= 100 && recorded <= 599 ? recorded : null;
}

/** Claude Code's error text on one line, cut as the sensor cuts a provider's message. */
function clipErrorText(text) {
  const oneLine = text.trim().replace(/[\r\n]+/g, " ");
  return oneLine.length > STOP_FAILURE_TEXT_MAX_CHARS
    ? `${oneLine.slice(0, STOP_FAILURE_TEXT_MAX_CHARS - 3)}...`
    : oneLine;
}

/**
 * The transcript's synthetic record for the failure this StopFailure
 * reports: the last API-error turn answering the hook's prompt. A hook
 * can run before Claude Code has written that record, and an earlier
 * failure's record must not stand in for it, so without a match there
 * is none.
 */
export function failedTurnFor(turns, hookEvent) {
  const promptId = hookEvent.prompt_id;
  if (typeof promptId !== "string" || promptId === "") return null;
  return turns.findLast((turn) => turn.apiError && turn.userTurn?.promptId === promptId) ?? null;
}

function errorTypeOf(code, failedTurn, text) {
  const kind = failedTurn?.apiErrorKind;
  if (kind && Object.hasOwn(API_ERROR_KIND_TYPES, kind)) return API_ERROR_KIND_TYPES[kind];
  const trimmed = typeof text === "string" ? text.trim() : "";
  for (const [pattern, type] of MESSAGE_PREFIX_TYPES) {
    if (pattern.test(trimmed)) return type;
  }
  return Object.hasOwn(STOP_FAILURE_ERROR_TYPES, code) ? STOP_FAILURE_ERROR_TYPES[code] : "other";
}

/**
 * The llm_error payload for a StopFailure hook. ``failedTurn`` is the
 * transcript's synthetic API-error turn for this failure (failedTurnFor),
 * when there is one; it supplies the event id, the timestamp, Claude
 * Code's finer error kind and the HTTP status.
 */
export function buildStopFailureEvent({ basePayload, hookEvent, model, failedTurn, capturePrompts }) {
  const code = boundedToken(hookEvent.error, MAX_SIGNAL_BYTES) ?? "unknown";
  const errorType = errorTypeOf(code, failedTurn, hookEvent.last_assistant_message);
  // Claude Code's finer kind, when the transcript has one, says more
  // than the hook's coarse code.
  const providerCode = boundedToken(failedTurn?.apiErrorKind, MAX_SIGNAL_BYTES) ?? code;
  let message = `StopFailure: ${code}`;
  const text = [hookEvent.last_assistant_message, hookEvent.error_details].find(
    (value) => typeof value === "string" && value.trim() !== "",
  );
  if (capturePrompts && text) {
    message += `: ${clipErrorText(text)}`;
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
      http_status: httpStatusOf(hookEvent.error_details, failedTurn),
      provider_error_code: providerCode,
      error_message: message,
      request_id: null,
      retry_after: null,
      is_retryable: RETRYABLE_ERROR_TYPES.has(errorType),
    },
  };
  if (failedTurn?.messageId) payload.id = llmErrorEventId(failedTurn.messageId);
  return payload;
}
