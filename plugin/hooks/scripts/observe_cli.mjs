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
//     than the old "tokens_total = 0" placeholder (D100).
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

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
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

// ---------------------------------------------------------------------
// Env var resolution + defaults (D100 zero-config flow).
// ---------------------------------------------------------------------

/**
 * Parse a string as a boolean, with an explicit fallback for the
 * "nothing here to interpret" cases: undefined, null, empty string,
 * and any value that doesn't clearly mean true or false. We fall back
 * to the default rather than guessing so a typo (e.g.
 * FLIGHTDECK_CAPTURE_PROMPTS=ture) preserves the documented default
 * behaviour instead of silently flipping.
 */
export function parseBool(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const v = String(value).trim().toLowerCase();
  if (v === "") return fallback;
  if (v === "true" || v === "1" || v === "yes" || v === "on") return true;
  if (v === "false" || v === "0" || v === "no" || v === "off") return false;
  return fallback;
}

/**
 * Resolve the plugin's four configuration knobs. Defaults target a
 * local ``make dev`` stack so ``claude --plugin-dir <path>`` works
 * with zero configuration for a developer who has just brought up the
 * stack. Production teams override via shell rc or a wrapper script.
 *
 * Rationale for each default:
 *   * ``server`` points at the dev nginx (localhost:4000). Any
 *     whitespace-only env var is treated as unset so a user who sets
 *     ``FLIGHTDECK_SERVER=""`` in a script does not silently break.
 *   * ``token`` defaults to ``tok_dev``, the seed token the dev
 *     compose stack accepts when ``ENVIRONMENT=dev``. Production
 *     deployments do not set ``ENVIRONMENT=dev`` so the seed token
 *     becomes inert there.
 *   * ``captureToolInputs`` defaults ON because the plugin only
 *     captures a sanitised whitelist (file paths, short command and
 *     query strings, <=200 chars). Without it tool events carry only
 *     the tool name which is far less useful for a developer
 *     inspecting their own work. Teams that want it off flip the env
 *     var.
 *   * ``capturePrompts`` defaults OFF because prompt / response
 *     content is sensitive. Strictly opt-in (matches the Python
 *     sensor's ``capture_prompts=False`` default).
 */
function resolveConfig(env = process.env) {
  const server = (env.FLIGHTDECK_SERVER ?? "").trim() || "http://localhost:4000";
  const token = (env.FLIGHTDECK_TOKEN ?? "").trim() || "tok_dev";
  return {
    server,
    token,
    captureToolInputs: parseBool(env.FLIGHTDECK_CAPTURE_TOOL_INPUTS, true),
    capturePrompts: parseBool(env.FLIGHTDECK_CAPTURE_PROMPTS, false),
  };
}

// ---------------------------------------------------------------------
// Session id -- stable for the lifetime of a Claude Code conversation
// in a given working directory.
// ---------------------------------------------------------------------

export function getSessionId(hookEvent = {}) {
  // Claude Code passes session_id on the hook payload itself for most
  // event types; prefer that so session_id matches Claude Code's own id
  // and the transcript_path lines up.
  if (hookEvent.session_id) return hookEvent.session_id;

  const env =
    process.env.CLAUDE_SESSION_ID || process.env.ANTHROPIC_CLAUDE_SESSION_ID;
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
      /* fall through to create */
    }
    const candidate = createHash("sha256")
      .update(`${Date.now()}-${process.pid}-${cwd}`)
      .digest("hex")
      .slice(0, 32);
    try {
      const fd = openSync(file, "wx");
      try {
        writeFileSync(fd, candidate);
      } finally {
        closeSync(fd);
      }
      return candidate;
    } catch (err) {
      if (err && err.code === "EEXIST") {
        const winner = readFileSync(file, "utf8").trim();
        if (winner) return winner;
      }
      throw err;
    }
  } catch {
    return createHash("sha256").update(cwd).digest("hex").slice(0, 32);
  }
}

// ---------------------------------------------------------------------
// Runtime context collection (parallels sensor/core/context.py).
// ---------------------------------------------------------------------

export function collectContext(extras = {}) {
  const ctx = { pid: process.pid, process_name: "claude-code" };

  const frameworks = [];

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

  const gitOpts = { timeout: 500, stdio: ["ignore", "pipe", "ignore"] };
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
    const clean = remote.replace(/https?:\/\/[^@]+@/, "https://");
    const repo = clean.split("/").pop()?.replace(/\.git$/, "");
    if (repo) ctx.git_repo = repo;
  } catch {
    /* silent */
  }

  if (process.env.KUBERNETES_SERVICE_HOST) {
    ctx.orchestration = "kubernetes";
    const pod =
      process.env.MY_POD_NAME || process.env.POD_NAME || ctx.hostname;
    if (pod) ctx.k8s_pod = pod;
    const ns = process.env.MY_POD_NAMESPACE || process.env.POD_NAMESPACE;
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

  // Identify Claude Code itself in context.frameworks so the FRAMEWORK
  // facet in Investigate picks it up alongside sensor-reported frameworks
  // (D100). Version comes from the transcript when available.
  const version = extras.claudeCodeVersion;
  frameworks.push(version ? `claude-code/${version}` : "claude-code");
  ctx.frameworks = frameworks;

  // Mark hook-based sessions as observer-only so the dashboard hides
  // the kill-switch UI. Claude Code hooks fire after the event has
  // already happened and the plugin never sits in the agent's hot
  // path, so a "Stop Agent" click would be a silent no-op. Python
  // sensor sessions omit this field entirely and the dashboard
  // treats "unset" as directive-capable. See dashboard/src/lib/
  // directives.ts.
  ctx.supports_directives = false;

  return ctx;
}

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

// ---------------------------------------------------------------------
// Transcript reader. Pulls the final LLM turn out of Claude Code's
// JSONL transcript so post_call events carry real tokens + model.
// ---------------------------------------------------------------------

/**
 * Read a JSONL transcript and return every LLM turn, in order.
 *
 * One LLM call can span multiple assistant JSONL records (one per
 * streamed content block -- thinking, text, tool_use). All records
 * that belong to the same call share the same `message.id`. The final
 * record's `usage` object is the authoritative accumulated usage. We
 * group by `message.id` in order and pair each group with the most
 * recent user-role turn that preceded it (for latency calculation).
 *
 * Multi-LLM-turn conversations (assistant makes a tool call, gets a
 * tool_result user-role reply, makes another LLM call) produce one
 * entry in the returned array per LLM call, not per user prompt. That
 * matches the Python sensor's one-post_call-per-LLM-call semantics.
 *
 * Returns [] when the transcript is missing or has no assistant records.
 */
export function readTurns(transcriptPath) {
  if (!transcriptPath) return [];
  let raw;
  try {
    raw = readFileSync(transcriptPath, "utf8");
  } catch {
    return [];
  }
  const lines = raw.split("\n").filter((l) => l.length > 0);
  // "Last user-role record we saw" -- both real prompts and tool_result
  // injections. We track it per-record rather than per-prompt because
  // every new assistant turn (including follow-up turns after a
  // tool_result) wants its latency measured against the immediately
  // preceding user-role record, which is the tool_result reply when
  // the assistant is continuing a tool-use loop.
  let lastUser = null;
  let lastClaudeVersion = null;
  const groups = new Map();
  const groupOrder = [];
  for (const line of lines) {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof rec !== "object" || rec === null) continue;
    if (rec.version && typeof rec.version === "string") {
      lastClaudeVersion = rec.version;
    }
    if (rec.type === "user") {
      const content = rec.message?.content;
      // Normalise to a string for downstream content capture -- either
      // the raw prompt or a short description of the tool_result reply.
      const userContent =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content
            : null;
      if (userContent !== null) {
        lastUser = {
          content: userContent,
          timestamp: rec.timestamp,
          promptId: rec.promptId,
        };
      }
    } else if (rec.type === "assistant") {
      const messageId = rec.message?.id;
      if (!messageId) continue;
      let group = groups.get(messageId);
      if (!group) {
        group = {
          messageId,
          model: rec.message?.model || null,
          firstTimestamp: rec.timestamp,
          lastTimestamp: rec.timestamp,
          usage: rec.message?.usage || null,
          contentBlocks: [],
          userAtStart: lastUser,
        };
        groups.set(messageId, group);
        groupOrder.push(messageId);
      }
      group.lastTimestamp = rec.timestamp || group.lastTimestamp;
      if (rec.message?.usage) group.usage = rec.message.usage;
      const blocks = rec.message?.content;
      if (Array.isArray(blocks)) {
        for (const b of blocks) group.contentBlocks.push(b);
      }
    }
  }
  const out = [];
  for (const id of groupOrder) {
    const group = groups.get(id);
    out.push({
      messageId: group.messageId,
      model: group.model,
      firstTimestamp: group.firstTimestamp,
      lastTimestamp: group.lastTimestamp,
      usage: group.usage || {},
      contentBlocks: group.contentBlocks,
      userTurn: group.userAtStart,
      claudeCodeVersion: lastClaudeVersion,
    });
  }
  return out;
}

/**
 * Convenience wrapper: return the most recent turn, or null. Kept for
 * callers that only want the final turn (e.g. version-probe on
 * SessionStart).
 */
export function readLatestTurn(transcriptPath) {
  const turns = readTurns(transcriptPath);
  return turns.length > 0 ? turns.at(-1) : null;
}

/**
 * Compute token fields from a transcript usage object, matching the
 * Python sensor's AnthropicProvider semantics (D100):
 *   tokens_input = uncached + cache_read + cache_creation
 *   tokens_cache_read / tokens_cache_creation surfaced separately
 *   tokens_output = output_tokens
 * Missing fields default to 0.
 */
export function tokensFromUsage(usage = {}) {
  const uncached = Number(usage.input_tokens || 0);
  const cacheRead = Number(usage.cache_read_input_tokens || 0);
  const cacheCreation = Number(usage.cache_creation_input_tokens || 0);
  const output = Number(usage.output_tokens || 0);
  const input = uncached + cacheRead + cacheCreation;
  return {
    tokens_input: input,
    tokens_output: output,
    tokens_total: input + output,
    tokens_cache_read: cacheRead,
    tokens_cache_creation: cacheCreation,
  };
}

/**
 * Compute latency_ms between a user turn and the assistant response.
 * Falls back to null when either timestamp is missing or malformed.
 */
export function computeLatencyMs(userTurn, assistantLastTimestamp) {
  if (!userTurn || !userTurn.timestamp || !assistantLastTimestamp) return null;
  const t0 = Date.parse(userTurn.timestamp);
  const t1 = Date.parse(assistantLastTimestamp);
  if (Number.isNaN(t0) || Number.isNaN(t1) || t1 < t0) return null;
  return t1 - t0;
}

// ---------------------------------------------------------------------
// Event-type mapping.
// ---------------------------------------------------------------------

// Maps Claude Code hook names to Flightdeck event_types. Notably
// PreToolUse is intentionally absent -- PostToolUse already emits a
// tool_call per invocation, matching the Python sensor's post-hoc
// tool_call extraction. A parallel pre-tool event would double-report
// every tool use and render as "unknown model" in the dashboard since
// pre-tool hooks do not know which LLM call triggered them.
export const EVENT_MAP = {
  SessionStart: "session_start",
  UserPromptSubmit: "pre_call",
  PostToolUse: "tool_call",
  Stop: "post_call",
  SessionEnd: "session_end",
  PreCompact: "tool_call",
};

// ---------------------------------------------------------------------
// HTTP POST helper + one-shot unreachable-session logging.
//
// The plugin must never block Claude Code on a broken or missing
// Flightdeck stack. Every failure path -- connection refused, DNS
// failure, HTTP non-2xx, abort timeout -- writes a single stderr line
// the first time it happens in a session and then silently drops
// every subsequent POST for that session via a flag file at
// tmpdir()/flightdeck-plugin/unreachable-<sessionId>.flag. Hook
// process still returns 0 so Claude Code sees the hook as healthy.
// ---------------------------------------------------------------------

function unreachableFlagPath(sessionId) {
  return join(tmpdir(), "flightdeck-plugin", `unreachable-${sessionId}.flag`);
}

function isSessionMarkedUnreachable(sessionId) {
  try {
    readFileSync(unreachableFlagPath(sessionId), "utf8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Log once per session that the Flightdeck stack cannot be reached,
 * then drop a flag file so subsequent hooks skip the POST path
 * entirely (avoids one log line per hook invocation on a broken
 * stack). The message format is stable -- it is documented in the
 * plugin README troubleshooting section and in tests.
 */
function logUnreachableOnce(sessionId, server, shortError) {
  if (isSessionMarkedUnreachable(sessionId)) return;
  process.stderr.write(
    `[flightdeck] cannot reach ${server}: ${shortError}. events dropped for this session.\n`,
  );
  try {
    mkdirSync(join(tmpdir(), "flightdeck-plugin"), { recursive: true });
    writeFileSync(unreachableFlagPath(sessionId), new Date().toISOString());
  } catch {
    /* silent -- the flag is an optimisation, not a correctness gate */
  }
}

// ``fetch failed`` is the generic umbrella Node uses to wrap underlying
// network errors whose ``cause.code`` we also check explicitly. Keeping
// both the string substring test and the code check covers libuv
// errors that surface through either path.
function shortErrorFrom(err) {
  if (!err) return "unknown error";
  const code = err.cause?.code || err.code;
  if (code) return String(code);
  if (err.name === "AbortError") return "timeout";
  return (err.message || "unknown error").split("\n")[0];
}

async function postEvent(server, token, sessionId, payload) {
  // Short-circuit every future POST for a session already flagged
  // unreachable -- a broken stack at turn 1 is still broken at turn 10.
  if (isSessionMarkedUnreachable(sessionId)) return;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response = null;
  try {
    response = await fetch(`${server}/ingest/v1/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    // Network-level failure: connection refused, DNS miss, abort
    // timeout, fetch rejection. Collapse to a one-shot log.
    logUnreachableOnce(sessionId, server, shortErrorFrom(err));
    return;
  } finally {
    clearTimeout(timeout);
  }

  // HTTP-level failure: auth, payload validation, server error. fetch()
  // returns normally for these so the catch above does not fire. Treat
  // 4xx and 5xx the same way -- log once, drop subsequent POSTs. We do
  // NOT retry; the sensor is fire-and-forget and a downed stack may
  // stay down for longer than any sensible retry schedule.
  if (!response.ok) {
    logUnreachableOnce(sessionId, server, `HTTP ${response.status}`);
  }
}

// ---------------------------------------------------------------------
// Per-session model cache -- SessionStart's `model` field survives on
// disk so UserPromptSubmit can populate pre_call.model without waiting
// for the assistant response to land in the transcript. Without this,
// LLM pre_calls all carry model=null and the dashboard renders them
// as "unknown".
// ---------------------------------------------------------------------

function modelCachePath(sessionId) {
  return join(tmpdir(), "flightdeck-plugin", `model-${sessionId}.txt`);
}

function cacheSessionModel(sessionId, model) {
  if (!model) return;
  try {
    mkdirSync(join(tmpdir(), "flightdeck-plugin"), { recursive: true });
    writeFileSync(modelCachePath(sessionId), String(model));
  } catch {
    /* silent */
  }
}

function readCachedModel(sessionId) {
  try {
    return readFileSync(modelCachePath(sessionId), "utf8").trim() || null;
  } catch {
    return null;
  }
}

/**
 * Resolve the model for the upcoming LLM turn. Prefers the most recent
 * assistant record in the transcript (captures mid-session model
 * switches), falls back to the SessionStart-cached model, and finally
 * to the hook payload itself.
 */
function resolvePreCallModel(sessionId, hookEvent, transcriptPath) {
  const latest = readLatestTurn(transcriptPath);
  return latest?.model || readCachedModel(sessionId) || hookEvent.model || null;
}

// ---------------------------------------------------------------------
// Session-start de-duplication -- once per session id per machine.
// ---------------------------------------------------------------------

async function ensureSessionStarted(server, token, sessionId, basePayload, extras = {}) {
  const dir = join(tmpdir(), "flightdeck-plugin");
  const startFile = join(dir, `started-${sessionId}.txt`);
  try {
    readFileSync(startFile, "utf8");
    return;
  } catch {
    /* fall through */
  }

  const startPayload = {
    ...basePayload,
    event_type: "session_start",
    tool_name: null,
    tool_input: null,
    is_subagent_call: false,
    latency_ms: null,
    timestamp: new Date().toISOString(),
    context: collectContext({ claudeCodeVersion: extras.claudeCodeVersion }),
  };
  if (extras.model) startPayload.model = extras.model;

  await postEvent(server, token, sessionId, startPayload);

  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(startFile, new Date().toISOString());
  } catch {
    /* silent */
  }
}

// ---------------------------------------------------------------------
// post_call de-duplication -- per assistant message.id.
// Stop fires after every assistant turn. Without dedup, a replay or
// double-hook would duplicate the turn in the dashboard.
// ---------------------------------------------------------------------

function markEmittedTurn(messageId) {
  const dir = join(tmpdir(), "flightdeck-plugin");
  const file = join(dir, `emitted-${messageId}.txt`);
  try {
    mkdirSync(dir, { recursive: true });
    const fd = openSync(file, "wx");
    try {
      writeFileSync(fd, new Date().toISOString());
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (err) {
    if (err && err.code === "EEXIST") return false;
    return true; // fail open -- better to re-emit than silently drop
  }
}

// ---------------------------------------------------------------------
// Build content payload for prompt capture (D100). Mirrors the Python
// sensor's AnthropicProvider.extract_content shape: provider, model,
// messages (user turn), tools (assistant tool_use blocks), response
// (assistant text + thinking blocks). system is null -- Claude Code's
// system prompt is not in the transcript.
// ---------------------------------------------------------------------

function buildContent(turn) {
  const toolUses = [];
  const responseBlocks = [];
  for (const block of turn.contentBlocks) {
    if (!block || !block.type) continue;
    if (block.type === "tool_use") {
      toolUses.push(block);
    } else {
      // text, thinking, redacted_thinking, etc.
      responseBlocks.push(block);
    }
  }
  const messages = turn.userTurn
    ? [{ role: "user", content: turn.userTurn.content }]
    : [];
  return {
    provider: "anthropic",
    model: turn.model || "",
    system: null,
    messages,
    tools: toolUses,
    response: responseBlocks,
  };
}

// ---------------------------------------------------------------------
// Main entry point.
// ---------------------------------------------------------------------

async function main() {
  const startTime = Date.now();
  const cfg = resolveConfig();

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
  if (!eventType) return; // unknown / unhandled hook, silently ignore

  const sessionId = getSessionId(hookEvent);
  const transcriptPath = hookEvent.transcript_path;

  // Base identity fields used by every event for this session.
  const basePayload = {
    session_id: sessionId,
    flavor: "claude-code",
    agent_type: "developer",
    host: osHostname(),
    framework: "claude-code",
    model: hookEvent.model || null,
    tokens_input: 0,
    tokens_output: 0,
    tokens_total: 0,
    tokens_cache_read: 0,
    tokens_cache_creation: 0,
    tokens_used_session: 0,
    token_limit_session: null,
    has_content: false,
    content: null,
  };

  // Read transcript lazily -- some hooks don't need it and the file
  // may not exist yet (first-hook SessionStart before the JSONL is
  // flushed).
  let cachedTurns = null;
  const getTurns = () => {
    if (cachedTurns !== null) return cachedTurns;
    cachedTurns = readTurns(transcriptPath);
    return cachedTurns;
  };
  const getLatestTurn = () => {
    const turns = getTurns();
    return turns.length > 0 ? turns.at(-1) : null;
  };

  // SessionStart: real first hook. Emit session_start with the model
  // and context, cache the model for subsequent UserPromptSubmit hooks,
  // and mark the dedup file so later hooks skip the backstop.
  if (hookName === "SessionStart") {
    const turn = getLatestTurn();
    const model = hookEvent.model || turn?.model || null;
    cacheSessionModel(sessionId, model);
    await ensureSessionStarted(cfg.server, cfg.token, sessionId, basePayload, {
      model,
      claudeCodeVersion: turn?.claudeCodeVersion || hookEvent.version || null,
    });
    return;
  }

  // SessionEnd: real session teardown. Before emitting session_end,
  // flush any LLM turns that the Stop hook didn't get to see -- in
  // `claude -p` mode Claude Code fires Stop once before the final
  // tool-loop turn is flushed to the transcript, so a post_call for
  // the final turn can still be missing when SessionEnd arrives.
  // Dedup via the per-messageId marker keeps this idempotent with Stop.
  if (hookName === "SessionEnd") {
    const turns = readTurns(hookEvent.transcript_path);
    for (const turn of turns) {
      if (!markEmittedTurn(turn.messageId)) continue;
      const tokens = tokensFromUsage(turn.usage);
      const latencyMs = computeLatencyMs(turn.userTurn, turn.lastTimestamp);
      const hasContent = cfg.capturePrompts;
      const content = hasContent ? buildContent(turn) : null;
      const resolvedModel = turn.model || basePayload.model;
      cacheSessionModel(sessionId, resolvedModel);
      await postEvent(cfg.server, cfg.token, sessionId, {
        ...basePayload,
        event_type: "post_call",
        model: resolvedModel,
        tool_name: null,
        tool_input: null,
        is_subagent_call: false,
        latency_ms: latencyMs,
        timestamp: turn.lastTimestamp || new Date().toISOString(),
        ...tokens,
        has_content: hasContent,
        content,
      });
    }
    const payload = {
      ...basePayload,
      event_type: "session_end",
      tool_name: null,
      tool_input: null,
      is_subagent_call: false,
      latency_ms: null,
      timestamp: new Date().toISOString(),
    };
    await postEvent(cfg.server, cfg.token, sessionId, payload);
    return;
  }

  // Every other event type goes through the common session_start
  // backstop so an initial hook that is NOT SessionStart still produces
  // a session row.
  await ensureSessionStarted(cfg.server, cfg.token, sessionId, basePayload, {
    model: hookEvent.model || null,
    claudeCodeVersion: hookEvent.version || null,
  });

  // Stop: every un-emitted LLM turn in the transcript becomes a
  // post_call. Multi-turn tool-use conversations produce multiple
  // assistant message.ids and Stop only fires once at the end, so we
  // must iterate every group and dedup via the per-messageId marker
  // file rather than emitting only the latest. We also cache the
  // latest model so any future UserPromptSubmit can label its pre_call
  // correctly (SessionStart does not carry model on Claude Code v2.1.x).
  if (hookName === "Stop") {
    const turns = getTurns();
    for (const turn of turns) {
      if (!markEmittedTurn(turn.messageId)) continue; // already emitted
      const tokens = tokensFromUsage(turn.usage);
      const latencyMs = computeLatencyMs(turn.userTurn, turn.lastTimestamp);
      const hasContent = cfg.capturePrompts;
      const content = hasContent ? buildContent(turn) : null;
      const resolvedModel = turn.model || basePayload.model;
      cacheSessionModel(sessionId, resolvedModel);
      const payload = {
        ...basePayload,
        event_type: "post_call",
        model: resolvedModel,
        tool_name: null,
        tool_input: null,
        is_subagent_call: false,
        latency_ms: latencyMs,
        timestamp: turn.lastTimestamp || new Date().toISOString(),
        ...tokens,
        has_content: hasContent,
        content,
      };
      await postEvent(cfg.server, cfg.token, sessionId, payload);
    }
    return;
  }

  // UserPromptSubmit: user hit enter on a prompt. Emit pre_call for
  // the upcoming LLM turn, but only when we can resolve a concrete
  // model. Resolution order: (1) most recent assistant in the
  // transcript, (2) cached model from a prior post_call this session,
  // (3) hook payload. If all three are empty the dashboard would
  // render the pre_call as "unknown", so we skip the emission entirely
  // and rely on the Stop-emitted post_call (which always has a model
  // because it reads usage directly from the transcript). First-turn
  // prompts in a brand-new session thus have no pre_call; second and
  // subsequent prompts are labelled correctly.
  if (hookName === "UserPromptSubmit") {
    const model = resolvePreCallModel(sessionId, hookEvent, transcriptPath);
    if (!model) return;
    const hasContent = cfg.capturePrompts && typeof hookEvent.prompt === "string";
    const content = hasContent
      ? {
          provider: "anthropic",
          model,
          system: null,
          messages: [{ role: "user", content: hookEvent.prompt }],
          tools: [],
          response: [],
        }
      : null;
    const payload = {
      ...basePayload,
      event_type: "pre_call",
      model,
      tool_name: null,
      tool_input: null,
      is_subagent_call: false,
      latency_ms: null,
      timestamp: new Date().toISOString(),
      has_content: hasContent,
      content,
    };
    await postEvent(cfg.server, cfg.token, sessionId, payload);
    return;
  }

  // PreCompact: context compaction is about to happen. Emit a synthetic
  // tool_call so the dashboard timeline shows the compaction event.
  if (hookName === "PreCompact") {
    const payload = {
      ...basePayload,
      event_type: "tool_call",
      tool_name: "compact_context",
      tool_input: hookEvent.trigger ? JSON.stringify({ trigger: hookEvent.trigger }) : null,
      is_subagent_call: false,
      latency_ms: null,
      timestamp: new Date().toISOString(),
    };
    await postEvent(cfg.server, cfg.token, sessionId, payload);
    return;
  }

  // PreToolUse / PostToolUse: tool-lifecycle events. Keep the same
  // sanitised-whitelist capture semantics the plugin has shipped since
  // Phase 4.
  const toolName =
    hookEvent.tool_name ||
    hookEvent.tool_use?.name ||
    hookEvent.tool ||
    null;

  let toolInputJson = null;
  if (cfg.captureToolInputs && hookEvent.tool_input) {
    const sanitized = sanitizeToolInput(hookEvent.tool_input);
    if (sanitized) toolInputJson = JSON.stringify(sanitized);
  }

  const isSubagentCall = toolName === "Task";

  const payload = {
    ...basePayload,
    event_type: eventType,
    tool_name: toolName,
    tool_input: toolInputJson,
    tool_result: null,
    is_subagent_call: isSubagentCall,
    parent_session_id: isSubagentCall ? sessionId : null,
    latency_ms: hookName === "PostToolUse" ? Date.now() - startTime : null,
    timestamp: new Date().toISOString(),
  };
  await postEvent(cfg.server, cfg.token, sessionId, payload);
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === process.argv[1]
) {
  main();
}
