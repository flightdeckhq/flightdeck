// Claude Code tool events: the input sanitiser, the tool's own
// duration, the structured error block for a failed tool, the event id
// derived from Claude Code's tool_use_id, the tool's response cut to
// its bound, and the tool_call payload.

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

// ---------------------------------------------------------------------
// Tool output -- the head of a tool's response, cut inside its
// structure, the cut values named beside it.
// ---------------------------------------------------------------------

// How much of a tool's response a tool_call's content keeps, in
// characters (code points) of the stored text. It is a preview for the
// Prompts tab: the head of a command's output or of a file read shows
// what the tool returned, while the whole response (a test run's log, a
// file of thousands of lines) would be stored again on every tool call
// of a session.
export const TOOL_OUTPUT_MAX_CHARS = 2000;

// What ends a cut string after the characters kept: the same mark a cut
// tool input ends with.
export const TOOL_OUTPUT_CUT_MARK = "…";

// Nesting below this depth is not walked: the response is then kept as
// the head of its JSON text (see boundToolOutput). Claude Code's tool
// responses nest three or four levels.
const TOOL_OUTPUT_MAX_DEPTH = 32;

/** The first ``n`` code points of ``s``, and whether ``s`` has more. */
function headChars(s, n) {
  let i = 0;
  let count = 0;
  while (i < s.length && count < n) {
    const unit = s.charCodeAt(i);
    const pair = unit >= 0xd800 && unit <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00;
    i += pair ? 2 : 1;
    count += 1;
  }
  return { head: s.slice(0, i), more: i < s.length };
}

/** The number of code points of ``s``. */
function charCount(s) {
  let count = 0;
  for (let i = 0; i < s.length; i += 1) {
    const unit = s.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) i += 1;
    count += 1;
  }
  return count;
}

/** One reference token of an RFC 6901 JSON Pointer. */
function pointerToken(key) {
  return String(key).replace(/~/g, "~0").replace(/\//g, "~1");
}

/**
 * ``value`` without what no cut keeps: strings shortened to one
 * character more than the bound, lists to one element more (an element
 * costs at least two characters of JSON), so every cut of it is the cut
 * of ``value``. Null when it nests deeper than TOOL_OUTPUT_MAX_DEPTH.
 * Bounds the work of every later step by the bound and the number of
 * keys, whatever the response's size.
 */
function trimForCut(value, depth = 0) {
  if (depth > TOOL_OUTPUT_MAX_DEPTH) return null;
  if (typeof value === "string") return headChars(value, TOOL_OUTPUT_MAX_CHARS + 1).head;
  if (Array.isArray(value)) {
    const out = [];
    for (const item of value.slice(0, TOOL_OUTPUT_MAX_CHARS + 1)) {
      const trimmed = trimForCut(item, depth + 1);
      if (trimmed === null && item !== null) return null;
      out.push(trimmed);
    }
    return out;
  }
  if (value && typeof value === "object") {
    const entries = [];
    for (const [key, item] of Object.entries(value)) {
      const trimmed = trimForCut(item, depth + 1);
      if (trimmed === null && item !== null) return null;
      entries.push([key, trimmed]);
    }
    // fromEntries defines every key as an own field, ``__proto__`` too.
    return Object.fromEntries(entries);
  }
  return value;
}

/**
 * ``value`` with every string and list longer than ``cap`` cut to it: a
 * string to its first ``cap`` characters followed by the mark, a list to
 * the leading elements whose JSON fits in ``cap`` characters (the first
 * always stays, cut in its turn). Keys, and every other value, stay as
 * the tool sent them. The JSON Pointer of each cut value is appended to
 * ``cuts``, in document order (a list before the values cut inside it).
 */
function cutAt(value, cap, pointer, cuts) {
  if (typeof value === "string") {
    const { head, more } = headChars(value, cap);
    if (!more) return value;
    cuts.push(pointer);
    return head + TOOL_OUTPUT_CUT_MARK;
  }
  if (Array.isArray(value)) {
    const at = cuts.length;
    const out = [];
    let used = 0;
    for (let i = 0; i < value.length; i += 1) {
      const itemCuts = [];
      const item = cutAt(value[i], cap, `${pointer}/${i}`, itemCuts);
      const cost = charCount(JSON.stringify(item)) + (out.length > 0 ? 1 : 0);
      if (out.length > 0 && used + cost > cap) break;
      out.push(item);
      used += cost;
      cuts.push(...itemCuts);
    }
    if (out.length < value.length) cuts.splice(at, 0, pointer);
    return out;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cutAt(item, cap, `${pointer}/${pointerToken(key)}`, cuts)]),
    );
  }
  return value;
}

/**
 * A tool's response as the tool_call's ``tool_result``: ``content``, a
 * string of at most TOOL_OUTPUT_MAX_CHARS characters, and ``truncated``,
 * the RFC 6901 JSON Pointers of the values cut, relative to the parsed
 * content (null when nothing was cut). Nothing is added inside the
 * response: the list goes beside it, on the block.
 *
 * - A string response (plain text) over the bound keeps its first
 *   characters followed by TOOL_OUTPUT_CUT_MARK; ``truncated`` is
 *   ``[""]``, the whole value.
 * - Any other response is its JSON text. Over the bound, it is cut
 *   inside its structure so the text stays valid JSON: every string
 *   and list longer than one common length is cut to it (the largest
 *   length that fits), so short fields (a command's stderr, a path, a
 *   status) stay whole and the long ones (stdout, a file's content)
 *   give up the characters. A cut string ends with the mark; a cut list
 *   keeps its leading elements. ``truncated`` names each,
 *   ``["/stdout"]``, ``["/content/0/text"]``.
 * - A response whose structure alone is over the bound (hundreds of
 *   keys), or that nests deeper than TOOL_OUTPUT_MAX_DEPTH, is kept as
 *   the head of its JSON text followed by the mark, with ``[""]``: a
 *   text cut at the bound, as a string response is. Wrapping it in an
 *   object would put a key in the tool's output that the tool never
 *   sent.
 *
 * A response at or under the bound is kept whole, with no list.
 */
export function boundToolOutput(response) {
  if (typeof response === "string") {
    if (charCount(response) <= TOOL_OUTPUT_MAX_CHARS) return { content: response, truncated: null };
    return { content: headText(response), truncated: [""] };
  }
  let text;
  try {
    text = JSON.stringify(response);
  } catch {
    // Too deep for the serialiser (a response read from JSON has no
    // cycle): nothing of it can be kept as JSON.
    text = null;
  }
  if (text != null && charCount(text) <= TOOL_OUTPUT_MAX_CHARS) return { content: text, truncated: null };
  const trimmed = text == null ? null : trimForCut(response);
  if (trimmed !== null) {
    const fits = (cap) => {
      const cuts = [];
      const content = JSON.stringify(cutAt(trimmed, cap, "", cuts));
      return charCount(content) <= TOOL_OUTPUT_MAX_CHARS ? { content, truncated: cuts } : null;
    };
    let best = fits(0);
    if (best !== null) {
      // Binary search for the largest common length that fits: about
      // eleven serialisations of the trimmed response.
      let lo = 1;
      let hi = TOOL_OUTPUT_MAX_CHARS;
      while (lo <= hi) {
        const cap = Math.floor((lo + hi) / 2);
        const candidate = fits(cap);
        if (candidate !== null) {
          best = candidate;
          lo = cap + 1;
        } else {
          hi = cap - 1;
        }
      }
      return best;
    }
  }
  return { content: headText(text ?? ""), truncated: [""] };
}

/** ``text``'s first characters followed by the mark, within the bound. */
function headText(text) {
  return headChars(text, TOOL_OUTPUT_MAX_CHARS - 1).head + TOOL_OUTPUT_CUT_MARK;
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
      // The block names the values the bound cut beside its content,
      // never inside the tool's response.
      const output = boundToolOutput(hookEvent.tool_response);
      const block = { type: "tool_result", content: output.content };
      if (output.truncated) block.truncated = output.truncated;
      response.push(block);
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
