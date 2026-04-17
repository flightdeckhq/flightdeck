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
//     than the old "tokens_total = 0" placeholder (D098).
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
// Env var resolution + defaults (D098 zero-config flow).
// ---------------------------------------------------------------------

export function parseBool(raw, fallback) {
  if (raw == null) return fallback;
  const s = String(raw).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(s)) return true;
  if (["false", "0", "no", "off"].includes(s)) return false;
  return fallback;
}

function resolveConfig(env = process.env) {
  return {
    server: env.FLIGHTDECK_SERVER || "http://localhost:4000",
    token: env.FLIGHTDECK_TOKEN || "tok_dev",
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
  // (D098). Version comes from the transcript when available.
  const version = extras.claudeCodeVersion;
  frameworks.push(version ? `claude-code/${version}` : "claude-code");
  ctx.frameworks = frameworks;

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
 * Read a JSONL transcript and return the most recent LLM turn.
 *
 * One LLM call can span multiple assistant JSONL records (one per
 * streamed content block -- thinking, text, tool_use). All records
 * that belong to the same call share the same `message.id`. The final
 * record's `usage` object is the authoritative accumulated usage. We
 * group by `message.id` in order, keep the last record's usage, and
 * pair the group with the most recent user turn that preceded it for
 * latency calculation.
 *
 * Returns null when the transcript has no assistant records yet (e.g.
 * first Stop hook fires before the JSONL is flushed -- unlikely but
 * defensive).
 */
export function readLatestTurn(transcriptPath) {
  if (!transcriptPath) return null;
  let raw;
  try {
    raw = readFileSync(transcriptPath, "utf8");
  } catch {
    return null;
  }
  const lines = raw.split("\n").filter((l) => l.length > 0);
  let lastUser = null;
  let lastClaudeVersion = null;
  // Map message.id -> { model, timestamp, usage, contentBlocks[] }
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
      // A "user" line is either the real user prompt (message.content
      // is a string) or a tool-result injection (content is an array
      // of tool_result blocks). Only plain-string user turns count as
      // the trigger for LLM latency. Tool-result replies are part of
      // an in-flight turn and we keep rolling forward.
      const content = rec.message?.content;
      if (typeof content === "string") {
        lastUser = {
          content,
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
  if (groupOrder.length === 0) return null;
  const latestId = groupOrder[groupOrder.length - 1];
  const group = groups.get(latestId);
  return {
    messageId: group.messageId,
    model: group.model,
    firstTimestamp: group.firstTimestamp,
    lastTimestamp: group.lastTimestamp,
    usage: group.usage || {},
    contentBlocks: group.contentBlocks,
    userTurn: group.userAtStart,
    claudeCodeVersion: lastClaudeVersion,
  };
}

/**
 * Compute token fields from a transcript usage object, matching the
 * Python sensor's AnthropicProvider semantics (D098):
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

// Maps Claude Code hook names to Flightdeck event_types. `null` values
// mean the hook is handled with a custom path (e.g. Stop derives
// post_call from the transcript).
export const EVENT_MAP = {
  SessionStart: "session_start",
  UserPromptSubmit: "pre_call",
  PreToolUse: "pre_call",
  PostToolUse: "tool_call",
  Stop: "post_call",
  SessionEnd: "session_end",
  PreCompact: "tool_call",
};

// ---------------------------------------------------------------------
// HTTP POST helper + connection-refused one-shot log.
// ---------------------------------------------------------------------

function refusedMarkerPath(sessionId) {
  return join(tmpdir(), "flightdeck-plugin", `refused-${sessionId}.txt`);
}

function logRefusedOnce(sessionId, server) {
  const marker = refusedMarkerPath(sessionId);
  try {
    readFileSync(marker, "utf8");
    return; // already logged
  } catch {
    /* fall through */
  }
  process.stderr.write(
    `flightdeck: cannot reach ${server}; skipping event POSTs for this session. ` +
      `Is the stack up? (make dev)\n`,
  );
  try {
    mkdirSync(join(tmpdir(), "flightdeck-plugin"), { recursive: true });
    writeFileSync(marker, new Date().toISOString());
  } catch {
    /* silent */
  }
}

function isConnectionRefused(err) {
  if (!err) return false;
  const msg = (err.message || "").toLowerCase();
  const code = err.cause?.code || err.code;
  return (
    code === "ECONNREFUSED" ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN" ||
    msg.includes("econnrefused") ||
    msg.includes("fetch failed")
  );
}

async function postEvent(server, token, sessionId, payload) {
  // Short-circuit when we've already seen connection refused for this
  // session. Avoids one fetch-failure log per hook invocation.
  try {
    readFileSync(refusedMarkerPath(sessionId), "utf8");
    return;
  } catch {
    /* fall through */
  }
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
  } catch (err) {
    if (isConnectionRefused(err)) {
      logRefusedOnce(sessionId, server);
    } else {
      process.stderr.write(`flightdeck: POST failed: ${err.message}\n`);
    }
  } finally {
    clearTimeout(timeout);
  }
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
// Build content payload for prompt capture (D098). Mirrors the Python
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
  let cachedTurn = null;
  const getTurn = () => {
    if (cachedTurn === undefined) return cachedTurn;
    if (cachedTurn !== null) return cachedTurn;
    cachedTurn = readLatestTurn(transcriptPath);
    return cachedTurn;
  };

  // SessionStart: real first hook. Emit session_start with the model
  // and context, mark the dedup file so later hooks skip the synthetic
  // session_start path.
  if (hookName === "SessionStart") {
    const turn = getTurn();
    await ensureSessionStarted(cfg.server, cfg.token, sessionId, basePayload, {
      model: hookEvent.model || turn?.model || null,
      claudeCodeVersion: turn?.claudeCodeVersion || hookEvent.version || null,
    });
    return;
  }

  // SessionEnd: real session teardown. Emit session_end.
  if (hookName === "SessionEnd") {
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

  // Stop: the last LLM turn is now in the transcript. Read it, emit a
  // post_call with real tokens / model / latency, and optionally
  // attach content when FLIGHTDECK_CAPTURE_PROMPTS is on.
  if (hookName === "Stop") {
    const turn = getTurn();
    if (!turn) return; // transcript not ready; Claude Code will fire another hook.
    if (!markEmittedTurn(turn.messageId)) return; // already emitted

    const tokens = tokensFromUsage(turn.usage);
    const latencyMs = computeLatencyMs(turn.userTurn, turn.lastTimestamp);
    const hasContent = cfg.capturePrompts;
    const content = hasContent ? buildContent(turn) : null;

    const payload = {
      ...basePayload,
      event_type: "post_call",
      model: turn.model || basePayload.model,
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
    return;
  }

  // UserPromptSubmit: user hit enter on a prompt. Emit pre_call for the
  // upcoming LLM turn. Content is the raw prompt when capture is on.
  if (hookName === "UserPromptSubmit") {
    const hasContent = cfg.capturePrompts && typeof hookEvent.prompt === "string";
    const content = hasContent
      ? {
          provider: "anthropic",
          model: basePayload.model || "",
          system: null,
          messages: [{ role: "user", content: hookEvent.prompt }],
          tools: [],
          response: [],
        }
      : null;
    const payload = {
      ...basePayload,
      event_type: "pre_call",
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
