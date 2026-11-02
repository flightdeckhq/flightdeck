// Claude Code tool events: the input sanitiser, the tool's own
// duration, the structured error block for a failed tool, the event id
// derived from Claude Code's tool_use_id, and the tool_call payload.

import { NAMESPACE_FLIGHTDECK } from "../agent_id.mjs";
import { boundedToken, MAX_MCP_IDENTITY_BYTES } from "../core/config.mjs";
import { readCachedModel } from "../core/state.mjs";
import { uuid5 } from "../uuid5.mjs";

// Placeholder for a failed tool's error text when capture is off. The
// text is content (a command's stderr, an Edit failure quoting the
// old_string it could not find, a token a failed command printed), so
// it follows the capture knobs; the block's class and abort flag stay.
export const REDACTED_ERROR_MESSAGE = "<redacted>";

// Tool error messages stay inline on the event payload, next to the
// metadata, so a failed tool is readable in the dashboard without a
// content fetch. 1000 characters holds a multi-line shell error or the
// head of a stack trace while keeping the row far below the ingestion
// request-body cap.
const TOOL_ERROR_MESSAGE_MAX_CHARS = 1000;

// ---------------------------------------------------------------------
// Tool input sanitisation -- safe whitelist only.
// ---------------------------------------------------------------------

export function sanitizeToolInput(input) {
  if (!input || typeof input !== "object") return null;
  const safe = {};
  if (input.file_path) safe.file_path = input.file_path;
  if (input.command) safe.command = String(input.command).slice(0, 200);
  if (input.query) safe.query = String(input.query).slice(0, 200);
  if (input.pattern) safe.pattern = String(input.pattern).slice(0, 200);
  if (input.prompt) safe.prompt = String(input.prompt).slice(0, 100);
  return Object.keys(safe).length > 0 ? safe : null;
}

/**
 * The tool's real wall time as measured by Claude Code
 * (``hookEvent.duration_ms`` on PostToolUse / PostToolUseFailure).
 * Null when the hook does not carry it (older Claude Code): the plugin
 * never substitutes its own process runtime, which says nothing about
 * the tool.
 */
export function hookDurationMs(hookEvent) {
  const value = hookEvent && hookEvent.duration_ms;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value);
}

/**
 * Whether a failed tool's error text may leave the machine. Claude
 * Code's ``error`` string is whatever the tool produced -- a command's
 * stderr, an Edit failure quoting the ``old_string`` it could not find,
 * a token a failed command printed -- so it is content and can carry
 * either tool input or tool output. Both knobs must be on.
 */
export function captureErrorText(cfg) {
  return Boolean(cfg && cfg.capturePrompts && cfg.captureToolInputs);
}

/**
 * Structured error block for a failed tool call, in the shape the
 * sensor's error taxonomy uses (``error_type`` / ``error_class`` /
 * ``message``). Claude Code reports the failure as a free-form
 * ``error`` string plus ``is_interrupt`` (true when the failure reached
 * Claude Code as an abort rather than as an error the tool reported),
 * so the taxonomy stays coarse: ``error_type=other``,
 * ``error_class=PluginToolError``, with ``interrupted`` carrying the
 * abort flag when the hook provides it. The message is content and is
 * sent only when ``captureText`` is true (see captureErrorText);
 * otherwise it is the fixed REDACTED_ERROR_MESSAGE, so the block still
 * says that the tool failed and how. A failure hook that carries no
 * error text still gets a block, otherwise the event would be
 * indistinguishable from a success.
 */
export function buildToolErrorBlock(hookEvent, captureText) {
  const raw = hookEvent ? hookEvent.error : null;
  let message;
  if (!captureText) {
    message = REDACTED_ERROR_MESSAGE;
  } else if (raw == null) {
    message = "tool failed (Claude Code reported no error detail)";
  } else if (typeof raw === "string") {
    message = raw;
  } else {
    message = JSON.stringify(raw);
  }
  const block = {
    error_type: "other",
    error_class: "PluginToolError",
    message:
      message.length > TOOL_ERROR_MESSAGE_MAX_CHARS
        ? `${message.slice(0, TOOL_ERROR_MESSAGE_MAX_CHARS)}…`
        : message,
  };
  if (hookEvent && typeof hookEvent.is_interrupt === "boolean") {
    block.interrupted = hookEvent.is_interrupt;
  }
  return block;
}

/**
 * The event id of a tool event (``tool_call`` or ``mcp_tool_call``),
 * derived from Claude Code's tool_use_id: every copy of one tool use,
 * the hook's and a rebuild's, has the same id, and the worker stores it
 * once.
 */
export function toolCallEventId(toolUseId) {
  return uuid5(NAMESPACE_FLIGHTDECK, `flightdeck://claude-code/tool_call/${toolUseId}`);
}

/**
 * The ``tool_call`` a PostToolUse / PostToolUseFailure hook reports for
 * a tool that is not an MCP tool, from the hook's fields: the tool's
 * name, its sanitised input, its response, its duration and, on a
 * failure, the error block. A rebuild after a failed POST passes the
 * same fields read back from its owed record and the transcript, and the
 * time the hook sent it.
 */
export function buildToolCallPayload({
  cfg,
  hookName,
  hookEvent,
  eventType = "tool_call",
  toolName,
  basePayload,
  sessionId,
  timestamp = new Date().toISOString(),
}) {
  const sanitizedInput =
    cfg.captureToolInputs && hookEvent.tool_input
      ? sanitizeToolInput(hookEvent.tool_input)
      : null;
  const toolInputJson = sanitizedInput ? JSON.stringify(sanitizedInput) : null;

  const isSubagentCall = toolName === "Task";
  const toolDurationMs = hookDurationMs(hookEvent);

  // Build event_content payload so the drawer's Prompts tab can show
  // real tool input + output.
  // Privacy tiers: input is gated on captureToolInputs (default ON);
  // output is gated on capturePrompts (default ON for the plugin,
  // OFF for the Python sensor -- see resolveConfig rationale).
  let content = null;
  let hasContent = false;
  if (cfg.captureToolInputs && toolName && sanitizedInput) {
    const tools = [{ type: "tool_use", name: toolName, input: sanitizedInput }];
    const response = [];
    if (cfg.capturePrompts && hookEvent.tool_response != null) {
      const out =
        typeof hookEvent.tool_response === "string"
          ? hookEvent.tool_response
          : JSON.stringify(hookEvent.tool_response);
      response.push({
        type: "tool_result",
        content: out.length > 2000 ? out.slice(0, 2000) + "…" : out,
      });
    }
    content = {
      provider: "anthropic",
      model: readCachedModel(sessionId) || basePayload.model || "",
      system: null,
      messages: [],
      tools,
      response,
    };
    hasContent = true;
  }

  // Preserve basePayload's parent_session_id when interior
  // subagent context set it (the modern Agent tool path). Fall back
  // to the legacy ``isSubagentCall ? sessionId : null`` shape for
  // the deprecated Task-tool informational hint (retained as
  // forward-compat on the parent's tool_call event for any consumer
  // still reading it). The two paths are mutually exclusive — when
  // interior context is active, basePayload.parent_session_id is
  // the OUTER session id; when it isn't, the legacy line applies.
  const payload = {
    ...basePayload,
    event_type: eventType,
    tool_name: toolName,
    tool_input: toolInputJson,
    tool_result: null,
    is_subagent_call: isSubagentCall,
    parent_session_id:
      basePayload.parent_session_id ??
      (isSubagentCall ? sessionId : null),
    // Real tool wall time from Claude Code on PostToolUse /
    // PostToolUseFailure, null when the hook does not carry it. The
    // same value lands as duration_ms so tool_call and mcp_tool_call
    // report the tool's duration under one name.
    latency_ms: toolDurationMs,
    duration_ms: toolDurationMs,
    timestamp,
    has_content: hasContent,
    content,
  };
  const toolUseId = boundedToken(hookEvent.tool_use_id, MAX_MCP_IDENTITY_BYTES);
  if (toolUseId) {
    payload.id = toolCallEventId(toolUseId);
    payload.tool_use_id = toolUseId;
  }
  if (hookName === "PostToolUseFailure") {
    payload.error = buildToolErrorBlock(hookEvent, captureErrorText(cfg));
  }
  return payload;
}
