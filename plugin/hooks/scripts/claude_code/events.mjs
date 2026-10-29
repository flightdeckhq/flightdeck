// The Claude Code binding's hook-name -> event_type alias table.

import { createEventAliasTable } from "../core/events.mjs";

// ---------------------------------------------------------------------
// Event-type mapping.
// ---------------------------------------------------------------------

// Maps Claude Code hook names to Flightdeck event_types. Notably
// PreToolUse is intentionally absent -- PostToolUse already emits a
// tool_call per invocation, matching the Python sensor's post-hoc
// tool_call extraction. A parallel pre-tool event would double-report
// every tool use and render as "unknown model" in the dashboard since
// pre-tool hooks do not know which LLM call triggered them.
// PostToolUseFailure fires for every tool (a non-zero Bash exit, a
// Read on a missing file, an MCP call that errored) and maps to the
// same tool_call event with a structured ``error`` block, so a failed
// tool and a successful one are the same row shape with one extra
// field.
export const EVENT_MAP = {
  SessionStart: "session_start",
  UserPromptSubmit: "pre_call",
  PostToolUse: "tool_call",
  PostToolUseFailure: "tool_call",
  Stop: "post_call",
  StopFailure: "llm_error",
  SessionEnd: "session_end",
  PreCompact: "tool_call",
};

// The table the Claude Code dispatcher resolves hook names through.
export const CLAUDE_CODE_EVENTS = createEventAliasTable(EVENT_MAP);
