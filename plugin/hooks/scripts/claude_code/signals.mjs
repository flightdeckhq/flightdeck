// Claude Code hooks that report a change in the session rather than a
// call (a compaction, a model switch) become session_signal events
// (ARCHITECTURE.md, session_signal): a signal name, a small metadata
// object, and the hook's text as content only while prompt capture is on.

import { boundedToken } from "../core/config.mjs";

// Bound on a string in signal_data, matching ingestion's.
export const MAX_SIGNAL_DATA_VALUE_BYTES = 256;

// The content envelope's provider, which tells the dashboard to render
// the signal's text rather than an LLM call.
export const SIGNAL_CONTENT_PROVIDER = "flightdeck-signal";

// Each hook's signal name, the metadata it keeps, and the hook field
// that is content.
const SIGNALS = {
  PreCompact: {
    signal: "context_compaction_started",
    fields: ["trigger"],
    text: "custom_instructions",
  },
  PostCompact: {
    signal: "context_compacted",
    fields: ["trigger"],
    text: "compact_summary",
  },
  PostModelSwitch: {
    signal: "model_switched",
    fields: [
      "from_model",
      "to_model",
      "requested_model",
      "source",
      "context_tokens",
      "prompt_cache_warm",
      "cache_ttl",
      "estimated_cache_write_usd",
      "pricing",
    ],
    text: null,
  },
};

/** The hook names reported as session_signal events. */
export const SIGNAL_HOOKS = Object.freeze(Object.keys(SIGNALS));

/**
 * One hook field as signal_data keeps it: a bounded string, a finite
 * number, a boolean or null; anything else is dropped.
 */
function signalValue(value) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") return boundedToken(value, MAX_SIGNAL_DATA_VALUE_BYTES) ?? undefined;
  return undefined;
}

/**
 * The session_signal payload for one of the SIGNAL_HOOKS. ``model`` is
 * the switched-to model for model_switched and null otherwise, so only
 * a model switch moves the session's model.
 */
export function buildSignalEvent({ hookName, hookEvent, basePayload, capturePrompts }) {
  const spec = SIGNALS[hookName];
  const signalData = {};
  for (const field of spec.fields) {
    const value = signalValue(hookEvent[field]);
    if (value !== undefined) signalData[field] = value;
  }
  const text = spec.text ? hookEvent[spec.text] : null;
  const hasContent = Boolean(capturePrompts && typeof text === "string" && text.trim() !== "");
  // Bedrock application-inference-profile ARNs run past 100 bytes, so
  // the model takes the signal_data bound rather than the 64-byte one
  // for short signal words.
  const toModel =
    hookName === "PostModelSwitch" ? boundedToken(hookEvent.to_model, MAX_SIGNAL_DATA_VALUE_BYTES) : null;
  return {
    ...basePayload,
    event_type: "session_signal",
    signal: spec.signal,
    signal_data: signalData,
    model: toModel,
    tool_name: null,
    tool_input: null,
    is_subagent_call: false,
    latency_ms: null,
    timestamp: new Date().toISOString(),
    has_content: hasContent,
    content: hasContent
      ? {
          provider: SIGNAL_CONTENT_PROVIDER,
          model: "",
          system: null,
          messages: [],
          tools: null,
          response: { [spec.text]: text },
        }
      : null,
  };
}
