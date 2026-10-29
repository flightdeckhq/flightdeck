#!/usr/bin/env node
// Flightdeck Claude Code hook. Reads hook event from stdin, reads the
// Claude Code JSONL transcript for token/content details, and POSTs
// metadata + optional content to the Flightdeck ingestion API.
//
// Design notes:
//   * Claude Code hooks have no visibility into the raw LLM request.
//     Every hook invocation receives `transcript_path` pointing at the
//     JSONL conversation log. That log carries the full Anthropic API
//     response envelope for every assistant turn, including model name,
//     usage object (input/output/cache tokens), and the message body.
//     The plugin reads that file to emit real post_call events rather
//     than the old "tokens_total = 0" placeholder.
//   * Every hook is a fresh Node child process. State that must survive
//     across invocations (session id, session-start de-dup, Stop dedup
//     per message.id, connection-refused one-shot log) lives on disk
//     under tmpdir()/flightdeck-plugin/.
//   * Defaults let a developer run `claude --plugin-dir <path>` against
//     a local `make dev` stack with zero env config. Production teams
//     override via shell rc or wrapper script.
//   * Hook failures never block Claude Code. Connection refused logs
//     once per session and then silently no-ops; anything else logs and
//     returns.
//
// Uses only Node.js built-in modules.
//
// Module layout. This file is the entry point every hook in
// hooks/hooks.json runs; it reads stdin, parses the hook event and
// hands it to the Claude Code dispatcher. The work lives in two layers:
//   * core/ -- client-agnostic pieces any hook adapter shares:
//     config.mjs (FLIGHTDECK_* knobs, value bounds, plugin version),
//     poster.mjs (the event POST), state.mjs (every on-disk marker and
//     cache under the plugin's temp directory) and events.mjs (the
//     hook-name -> event_type alias table a binding supplies).
//   * claude_code/ -- the Claude Code binding: session identity,
//     transcript reading, context and run-mode signals, tool and MCP
//     events, MCP policy dispatch, subagent routing, post_call
//     flushing, the SessionEnd worker and the dispatcher itself.
// Every symbol this file exported before the split is re-exported
// below, so importers keep a single entry point.

import { realpathSync } from "node:fs";
import { platform } from "node:os";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

import { dispatchHookEvent } from "./claude_code/dispatch.mjs";
import { SESSION_END_WORKER_FLAG } from "./claude_code/session_end.mjs";
import { resolveConfig } from "./core/config.mjs";

export {
  boundedIdentity,
  boundedToken,
  boundedVersion,
  MAX_MCP_IDENTITY_BYTES,
  MAX_SIGNAL_BYTES,
  MAX_VERSION_CHARS,
  parseBool,
  redactServerUrl,
  resolveConfig,
} from "./core/config.mjs";
export { redactUserinfo } from "./core/poster.mjs";
export {
  CI_PROVIDER_ENV,
  collectClaudeCodeSignals,
  collectContext,
  detectCiProvider,
  safeCollectContext,
} from "./claude_code/context.mjs";
export { EVENT_MAP } from "./claude_code/events.mjs";
export {
  buildToolCaptureContent,
  canonicalMcpServerName,
  flattenMcpServerName,
  loadMcpServerFingerprints,
  parseMcpToolName,
  resolveMcpToolIdentity,
} from "./claude_code/mcp.mjs";
export {
  dispatchMcpPolicyPostToolUse,
  dispatchMcpPolicyPreToolUse,
  dispatchMcpPolicySessionStart,
  writeHookDecision,
} from "./claude_code/mcp_policy_dispatch.mjs";
export {
  postCallEventId,
  resolveSessionEndpoint,
  turnTokenCostFields,
} from "./claude_code/post_call.mjs";
export {
  claudeCodeSessionId,
  clearSessionCacheFiles,
  getSessionId,
} from "./claude_code/session.mjs";
export {
  openSessionEndWorkerLog,
  SESSION_END_HOOK_BUDGET_MS,
  SESSION_END_WORKER_DEADLINE_MS,
  SESSION_END_WORKER_FLAG,
  SESSION_END_WORKER_GRACE_MAX_MS,
  SESSION_END_WORKER_GRACE_MS,
  SESSION_END_WORKER_LOG_MAX_BYTES,
  sessionEndWorkerGraceMs,
} from "./claude_code/session_end.mjs";
export {
  _subagentChildSessionId,
  _subagentCorrelator,
  _subagentInteriorContext,
  _subagentRole,
  _subagentTranscriptPath,
} from "./claude_code/subagent.mjs";
export {
  buildToolErrorBlock,
  captureErrorText,
  hookDurationMs,
  REDACTED_ERROR_MESSAGE,
  sanitizeToolInput,
} from "./claude_code/tools.mjs";
export {
  computeLatencyMs,
  isRealModel,
  readLatestTurn,
  readTurns,
  SYNTHETIC_MODEL,
  tokensFromUsage,
} from "./claude_code/transcript.mjs";

// ---------------------------------------------------------------------
// Main entry point.
// ---------------------------------------------------------------------

async function main() {
  const cfg = resolveConfig();
  // The detached SessionEnd worker is this script re-invoked with the
  // marker flag; it skips the hand-off below and does the network work.
  const sessionEndWorker = process.argv.includes(SESSION_END_WORKER_FLAG);

  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let hookEvent;
  try {
    hookEvent = JSON.parse(input);
  } catch {
    process.stderr.write("flightdeck: failed to parse hook event from stdin\n");
    return;
  }

  await dispatchHookEvent({
    cfg,
    hookEvent,
    input,
    sessionEndWorker,
    entryScript: fileURLToPath(import.meta.url),
  });
}

/**
 * True when this file is the process entry point. A plain string
 * comparison fails on Windows whenever ``process.argv[1]`` arrives with
 * forward slashes or a differently cased drive letter (both happen when
 * Claude Code expands ``${CLAUDE_PLUGIN_ROOT}`` into the hook command)
 * and anywhere the plugin directory is reached through a symlink, so
 * main() never ran and the plugin was silently inert. Both sides are
 * resolved and taken through realpath, and compared case-insensitively
 * on win32. The platform, path module and own path are injectable so
 * the win32 rule is testable from any host.
 */
export function isMainModule(
  argv1 = process.argv[1],
  {
    platform: plat = platform(),
    pathModule = nodePath,
    selfPath = fileURLToPath(import.meta.url),
  } = {},
) {
  if (!argv1) return false;
  const self = canonicalPath(selfPath, pathModule);
  const invoked = canonicalPath(argv1, pathModule);
  if (plat === "win32") {
    return self.toLowerCase() === invoked.toLowerCase();
  }
  return self === invoked;
}

// resolve() normalises separators and relative segments; realpath then
// follows symlinks, falling back to the resolved path when the file
// cannot be looked up (a path from another platform in tests).
function canonicalPath(p, pathModule) {
  const resolved = pathModule.resolve(p);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

if (isMainModule()) {
  // A hook must exit 0 and stay quiet: an unexpected throw is logged as
  // one line instead of an unhandled rejection's stack trace and
  // non-zero exit.
  main().catch((err) => {
    process.stderr.write(`[flightdeck] WARN: hook failed: ${err?.message || err}\n`);
  });
}
