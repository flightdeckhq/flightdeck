#!/usr/bin/env node
// Flightdeck Claude Code hook -- reports tool calls and session lifecycle.
// Reads hook event from stdin, POSTs to Flightdeck ingestion API.
// Uses only Node.js built-in modules. Never blocks Claude Code.

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  arch,
  hostname as osHostname,
  platform,
  tmpdir,
  userInfo,
} from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const TIMEOUT_MS = 2000;

// Map Claude Code's TOOL lifecycle hooks to Flightdeck event types.
// Note: pre_call/tool_call here are the *tool* lifecycle, not the LLM
// call lifecycle. Claude Code hooks have no visibility into LLM calls,
// only into tool invocations and the session itself, so we reuse the
// schema's tool-related event_type values.
export const EVENT_MAP = {
  PreToolUse: "pre_call",
  PostToolUse: "tool_call",
  Stop: "session_end",
};

// ---------------------------------------------------------------------
// Session ID -- stable for the lifetime of a Claude Code conversation
// in a given working directory.
// ---------------------------------------------------------------------

/**
 * Resolve a stable session ID. Order of preference:
 *   1. CLAUDE_SESSION_ID env var (set by Claude Code)
 *   2. ANTHROPIC_CLAUDE_SESSION_ID env var (alternative name)
 *   3. File-based ID scoped to the current working directory
 *   4. Last-resort sha256(cwd) hash
 *
 * The file fallback exists because every hook invocation runs as a
 * separate Node child process spawned by Claude Code -- pid-based
 * fallbacks would create one session row per tool call. Different
 * cwds get different sessions so multi-project users don't collide.
 */
export function getSessionId() {
  const env =
    process.env.CLAUDE_SESSION_ID ||
    process.env.ANTHROPIC_CLAUDE_SESSION_ID;
  if (env) return env;

  const cwd = process.cwd();
  const dir = join(tmpdir(), "flightdeck-plugin");
  const key = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
  const file = join(dir, `session-${key}.txt`);

  try {
    mkdirSync(dir, { recursive: true });
    try {
      const existing = readFileSync(file, "utf8").trim();
      if (existing) return existing;
    } catch {
      // File does not exist yet -- fall through and create one.
    }
    const id = createHash("sha256")
      .update(`${Date.now()}-${cwd}`)
      .digest("hex")
      .slice(0, 32);
    writeFileSync(file, id);
    return id;
  } catch {
    // Filesystem unavailable -- last-resort cwd hash gives stability
    // across multiple invocations in the same working directory at
    // minimum.
    return createHash("sha256").update(cwd).digest("hex").slice(0, 32);
  }
}

// ---------------------------------------------------------------------
// Runtime context collection (parallels sensor/core/context.py)
// ---------------------------------------------------------------------

/**
 * Collect runtime environment fields. Every individual probe is
 * wrapped in try/catch so a single failure (e.g. git not installed,
 * platform() throwing on an exotic OS) cannot break the rest of the
 * snapshot. Returns a plain object suitable for inclusion in a
 * session_start event payload's `context` field.
 */
export function collectContext() {
  const ctx = {};

  ctx.pid = process.pid;
  ctx.process_name = "claude-code";

  try {
    const p = platform();
    ctx.os = p === "win32" ? "Windows" : p === "darwin" ? "Darwin" : "Linux";
  } catch {
    /* silent */
  }
  try {
    ctx.arch = arch();
  } catch {
    /* silent */
  }
  try {
    ctx.hostname = osHostname();
  } catch {
    /* silent */
  }
  try {
    ctx.user = userInfo().username;
  } catch {
    /* silent */
  }

  ctx.node_version = process.version;
  try {
    ctx.working_dir = process.cwd();
  } catch {
    /* silent */
  }

  // Git -- each call independently best-effort with a 500 ms timeout.
  const gitOpts = {
    timeout: 500,
    stdio: ["ignore", "pipe", "ignore"],
  };
  try {
    ctx.git_commit = execSync("git rev-parse --short HEAD", gitOpts)
      .toString()
      .trim();
  } catch {
    /* silent */
  }
  try {
    ctx.git_branch = execSync("git branch --show-current", gitOpts)
      .toString()
      .trim();
  } catch {
    /* silent */
  }
  try {
    const remote = execSync("git remote get-url origin", gitOpts)
      .toString()
      .trim();
    // Strip embedded credentials from the remote URL before extracting
    // the repo name.
    const clean = remote.replace(/https?:\/\/[^@]+@/, "https://");
    const repo = clean.split("/").pop()?.replace(/\.git$/, "");
    if (repo) ctx.git_repo = repo;
  } catch {
    /* silent */
  }

  // Orchestration -- first match wins (parallels the Python sensor's
  // KubernetesCollector > DockerComposeCollector ordering). Docker
  // Compose only fires when the env vars are explicitly set, since
  // /.dockerenv probing is unreliable on Windows / WSL hosts running
  // Claude Code natively.
  if (process.env.KUBERNETES_SERVICE_HOST) {
    ctx.orchestration = "kubernetes";
    const pod =
      process.env.MY_POD_NAME || process.env.POD_NAME || ctx.hostname;
    if (pod) ctx.k8s_pod = pod;
    const ns =
      process.env.MY_POD_NAMESPACE || process.env.POD_NAMESPACE;
    if (ns) ctx.k8s_namespace = ns;
    const node = process.env.MY_NODE_NAME || process.env.NODE_NAME;
    if (node) ctx.k8s_node = node;
  } else if (
    process.env.COMPOSE_PROJECT_NAME ||
    process.env.COMPOSE_SERVICE
  ) {
    ctx.orchestration = "docker-compose";
    if (process.env.COMPOSE_PROJECT_NAME)
      ctx.compose_project = process.env.COMPOSE_PROJECT_NAME;
    if (process.env.COMPOSE_SERVICE)
      ctx.compose_service = process.env.COMPOSE_SERVICE;
  }

  return ctx;
}

// ---------------------------------------------------------------------
// Tool input sanitisation -- safe whitelist only.
// ---------------------------------------------------------------------

/**
 * Reduce a hook tool_input to a small whitelist of fields safe for
 * dashboard display. Never captures content / messages / output --
 * those may contain secrets and are out of scope for the plugin.
 * Returns null if no whitelisted field was present, so the caller can
 * skip serialisation entirely.
 */
export function sanitizeToolInput(input) {
  if (!input || typeof input !== "object") return null;
  const safe = {};
  if (input.file_path) safe.file_path = input.file_path;
  if (input.command) safe.command = String(input.command).slice(0, 200);
  if (input.query) safe.query = input.query;
  if (input.pattern) safe.pattern = input.pattern;
  if (input.prompt) safe.prompt = String(input.prompt).slice(0, 100);
  return Object.keys(safe).length > 0 ? safe : null;
}

// ---------------------------------------------------------------------
// HTTP POST helper -- best-effort, never blocks the hook.
// ---------------------------------------------------------------------

async function postEvent(server, token, payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    await fetch(`${server}/ingest/v1/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------
// Session-start de-duplication -- file-based, scoped to session id.
// ---------------------------------------------------------------------

/**
 * Send a session_start event for `sessionId` exactly once per machine
 * lifetime (modulo tmpdir cleanup). The marker file lives next to the
 * session id file under tmpdir/flightdeck-plugin. The session_start
 * payload carries the same identity fields as a normal event plus the
 * runtime context dict, which Flightdeck stores once in
 * sessions.context (set-once via UpsertSession ON CONFLICT).
 *
 * If the POST fails, we deliberately skip writing the marker so the
 * next hook invocation gets another chance. UpsertSession is
 * idempotent and ON CONFLICT preserves the original context, so a
 * duplicate session_start is harmless.
 */
async function ensureSessionStarted(server, token, sessionId, basePayload) {
  const dir = join(tmpdir(), "flightdeck-plugin");
  const startFile = join(dir, `started-${sessionId}.txt`);
  try {
    readFileSync(startFile, "utf8");
    return; // Already started.
  } catch {
    // Not yet started -- fall through.
  }

  const startPayload = {
    ...basePayload,
    event_type: "session_start",
    tool_name: null,
    tool_input: null,
    is_subagent_call: false,
    latency_ms: null,
    timestamp: new Date().toISOString(),
    context: collectContext(),
  };

  try {
    await postEvent(server, token, startPayload);
  } catch (err) {
    process.stderr.write(
      `flightdeck: session_start POST failed: ${err.message}\n`,
    );
    return;
  }

  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(startFile, new Date().toISOString());
  } catch {
    // Marker write failed -- worst case we send another session_start
    // on the next hook, which is harmless.
  }
}

// ---------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------

async function main() {
  // Stamp the start of the hook invocation. PostToolUse events report
  // (now - startTime) as latency_ms; this is HOOK PROCESSING time, not
  // the actual tool execution time. Claude Code does not expose tool
  // start/end timestamps to hooks, so this is the closest proxy we
  // have.
  const startTime = Date.now();

  const server = process.env.FLIGHTDECK_SERVER;
  const token = process.env.FLIGHTDECK_TOKEN;
  if (!server || !token) {
    process.stderr.write(
      "flightdeck: FLIGHTDECK_SERVER and FLIGHTDECK_TOKEN must be set\n",
    );
    return;
  }

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

  const hookName = hookEvent.hook_event_name || hookEvent.event || "";
  const eventType = EVENT_MAP[hookName];
  if (!eventType) {
    return; // Unknown hook event, silently ignore.
  }

  const sessionId = getSessionId();
  const toolName =
    hookEvent.tool_name ||
    hookEvent.tool_use?.name ||
    hookEvent.tool ||
    null;

  // Identity fields shared by every event for this session. Used as
  // the spread base for both the session_start and the actual event.
  const basePayload = {
    session_id: sessionId,
    flavor: "claude-code",
    agent_type: "developer",
    host: osHostname(),
    framework: "claude-code",
    model: null,
    tokens_input: 0,
    tokens_output: 0,
    tokens_total: 0,
    tokens_used_session: 0,
    token_limit_session: null,
    has_content: false,
    content: null,
  };

  // Send session_start exactly once per session id, before the actual
  // event. Carries runtime context which the worker stores once in
  // sessions.context.
  await ensureSessionStarted(server, token, sessionId, basePayload);

  const sanitizedInput = hookEvent.tool_input
    ? sanitizeToolInput(hookEvent.tool_input)
    : null;

  const payload = {
    ...basePayload,
    event_type: eventType,
    tool_name: toolName,
    tool_input: sanitizedInput ? JSON.stringify(sanitizedInput) : null,
    tool_result: null,
    is_subagent_call: toolName === "Task",
    latency_ms: hookName === "PostToolUse" ? Date.now() - startTime : null,
    timestamp: new Date().toISOString(),
  };

  try {
    await postEvent(server, token, payload);
  } catch (err) {
    process.stderr.write(`flightdeck: POST failed: ${err.message}\n`);
  }
  // Deliberately do NOT call process.exit() -- letting main() return
  // lets undici drain its connection pool cleanly. Calling exit while
  // a fetch is mid-cleanup crashes Node on Windows with
  // STATUS_STACK_BUFFER_OVERRUN (0xC0000409).
}

// Run main() only when invoked as a script. When imported as a module
// (e.g., from tests), the helpers above are exported but main() does
// not run automatically.
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === process.argv[1]
) {
  main();
}
