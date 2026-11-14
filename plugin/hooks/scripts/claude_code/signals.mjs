// Claude Code hooks that report a change in the session rather than a
// call (a compaction, a model switch, a slash command, a task) become
// session_signal events (ARCHITECTURE.md, session_signal): a signal
// name, a small metadata object, and the hook's text as content only
// while prompt capture is on.

import { boundedToken, truncateUtf8 } from "../core/config.mjs";
import { sanitizeToolInput, TOOL_INPUT_CUT_MARK } from "./tools.mjs";

// Bound on a string in signal_data, matching ingestion's.
export const MAX_SIGNAL_DATA_VALUE_BYTES = 256;

// The content envelope's provider, which tells the dashboard to render
// the signal's text rather than an LLM call.
export const SIGNAL_CONTENT_PROVIDER = "flightdeck-signal";

// Each hook's signal name, the metadata it keeps, and the hook fields
// that are content (an object one, such as a form's schema, is sent as
// JSON text). ``renamed`` maps a signal_data key to the hook field it
// comes from. ``paths`` are metadata fields holding a path, which
// are cut to the signal_data bound rather than dropped. ``toolInput``
// marks a hook about a tool call: its tool's sanitised arguments join
// signal_data while tool-input capture is on, and an MCP tool's server
// name joins it always.
const SIGNALS = {
  PreCompact: {
    signal: "context_compaction_started",
    fields: ["trigger"],
    texts: ["custom_instructions"],
  },
  PostCompact: {
    signal: "context_compacted",
    fields: ["trigger"],
    texts: ["compact_summary"],
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
    texts: [],
  },
  Notification: {
    signal: "notification",
    fields: ["notification_type"],
    texts: ["message", "title"],
  },
  PermissionRequest: {
    signal: "permission_requested",
    fields: ["tool_name"],
    texts: [],
    toolInput: true,
  },
  PermissionDenied: {
    signal: "permission_denied",
    fields: ["tool_name", "tool_use_id", "reason"],
    texts: [],
    toolInput: true,
  },
  // The hook's ``prompt`` stays out: the prompt the user typed is the
  // turn's pre_call content already.
  UserPromptExpansion: {
    signal: "command_expanded",
    fields: ["expansion_type", "command_name", "command_source"],
    texts: ["command_args"],
  },
  TaskCreated: {
    signal: "task_created",
    fields: ["task_id", "teammate_name"],
    texts: ["task_subject", "task_description"],
  },
  TaskCompleted: {
    signal: "task_completed",
    fields: ["task_id", "teammate_name"],
    texts: ["task_subject", "task_description"],
  },
  CwdChanged: {
    signal: "cwd_changed",
    fields: [],
    paths: ["old_cwd", "new_cwd"],
    texts: [],
  },
  ConfigChange: {
    signal: "config_changed",
    fields: ["source"],
    paths: ["file_path"],
    texts: [],
  },
  // An agent-team teammate that finished its turn and is waiting.
  TeammateIdle: {
    signal: "teammate_idle",
    fields: ["teammate_name"],
    texts: [],
  },
  // An MCP server asking the user for input, and the user's answer. A
  // URL-mode request's URL can carry a token, so it is content.
  Elicitation: {
    signal: "elicitation_requested",
    renamed: { mcp_server: "mcp_server_name" },
    fields: ["mode", "elicitation_id"],
    texts: ["message", "url", "requested_schema"],
  },
  ElicitationResult: {
    signal: "elicitation_responded",
    renamed: { mcp_server: "mcp_server_name" },
    fields: ["mode", "elicitation_id", "action"],
    texts: ["content"],
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
 * A string cut to the signal_data bound, with line breaks and tabs as
 * spaces, or undefined when nothing printable is left.
 */
function cutValue(value) {
  if (typeof value !== "string") return undefined;
  const oneLine = value.replace(/[\x00-\x1f\x7f]+/g, " ");
  const bounded = signalValue(truncateUtf8(oneLine, MAX_SIGNAL_DATA_VALUE_BYTES));
  return typeof bounded === "string" ? bounded : undefined;
}

/**
 * A tool input value for signal_data: on one line and within
 * MAX_SIGNAL_DATA_VALUE_BYTES, ending with TOOL_INPUT_CUT_MARK when the
 * bound cut it. ``cut`` says whether it did. Undefined when nothing
 * usable is left.
 */
function cutMarkedValue(value) {
  const oneLine = value.replace(/[\x00-\x1f\x7f]+/g, " ");
  if (Buffer.byteLength(oneLine, "utf8") <= MAX_SIGNAL_DATA_VALUE_BYTES) {
    const whole = signalValue(oneLine);
    return typeof whole === "string" ? { value: whole, cut: false } : undefined;
  }
  const room = MAX_SIGNAL_DATA_VALUE_BYTES - Buffer.byteLength(TOOL_INPUT_CUT_MARK, "utf8");
  const kept = truncateUtf8(oneLine, room).replace(new RegExp(`${TOOL_INPUT_CUT_MARK}$`), "");
  const marked = signalValue(kept + TOOL_INPUT_CUT_MARK);
  return typeof marked === "string" ? { value: marked, cut: true } : undefined;
}

/**
 * The session_signal payload for one of the SIGNAL_HOOKS. ``model`` is
 * the switched-to model for model_switched and null otherwise, so only
 * a model switch moves the session's model.
 */
export function buildSignalEvent({ hookName, hookEvent, basePayload, capturePrompts, captureToolInputs = false }) {
  const spec = SIGNALS[hookName];
  const signalData = {};
  for (const [key, field] of Object.entries(spec.renamed ?? {})) {
    const value = signalValue(hookEvent[field]);
    if (value !== undefined) signalData[key] = value;
  }
  for (const field of spec.fields) {
    const value = signalValue(hookEvent[field]);
    if (value !== undefined) signalData[field] = value;
  }
  for (const field of spec.paths ?? []) {
    const value = cutValue(hookEvent[field]);
    if (value !== undefined) signalData[field] = value;
  }
  if (spec.toolInput) {
    const server = signalValue(hookEvent.mcp_server?.name);
    if (typeof server === "string") signalData.mcp_server = server;
    // A built-in tool's input goes through the same whitelist tool_call
    // events use (file path, command, query, pattern, prompt). An MCP
    // tool's arguments stay out: its mcp_tool_call keeps them in
    // event_content only. Line breaks and tabs (a heredoc command)
    // become spaces so the value is cut to the signal_data bound
    // rather than dropped.
    const isMcp = typeof server === "string" || String(hookEvent.tool_name ?? "").startsWith("mcp__");
    const safe = captureToolInputs && !isMcp ? sanitizeToolInput(hookEvent.tool_input) : null;
    // A value the whitelist cut, or that this byte bound cuts, ends with
    // the cut mark, and signal_data's ``truncated`` names it: a cut
    // command must not read as the whole command. signal_data holds
    // scalars only, so the list is comma-separated.
    const truncated = new Set(safe?.truncated ?? []);
    for (const [key, value] of Object.entries(safe ?? {})) {
      if (key === "truncated") continue;
      const bounded = cutMarkedValue(String(value));
      if (bounded === undefined) continue;
      signalData[key] = bounded.value;
      if (bounded.cut) truncated.add(key);
    }
    if (truncated.size > 0) signalData.truncated = [...truncated].join(",");
  }
  const texts = {};
  if (capturePrompts) {
    for (const field of spec.texts) {
      const value = hookEvent[field];
      const text = value !== null && typeof value === "object" ? JSON.stringify(value, null, 2) : value;
      if (typeof text === "string" && text.trim() !== "") texts[field] = text;
    }
  }
  const hasContent = Object.keys(texts).length > 0;
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
          response: texts,
        }
      : null,
  };
}
