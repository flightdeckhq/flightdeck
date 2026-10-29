// Claude Code tool events: the input sanitiser, the tool's own
// duration, and the structured error block for a failed tool.

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
