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
import { createHash, randomUUID } from "node:crypto";
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
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { deriveAgentId, NAMESPACE_FLIGHTDECK } from "./agent_id.mjs";
import { uuid5 } from "./uuid5.mjs";

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
 *   * ``capturePrompts`` defaults ON for the Claude Code plugin --
 *     developers running ``claude`` locally are observing their own
 *     session, and the Prompts tab is empty without captured LLM
 *     call content. The Python sensor keeps ``capture_prompts=False``
 *     as its default because it runs in production where prompts
 *     may carry PII and proprietary context (D019, D103). Users can
 *     opt out on the plugin with ``FLIGHTDECK_CAPTURE_PROMPTS=false``.
 */
export function resolveConfig(env = process.env) {
  const server = (env.FLIGHTDECK_SERVER ?? "").trim() || "http://localhost:4000";
  const token = (env.FLIGHTDECK_TOKEN ?? "").trim() || "tok_dev";
  return {
    server,
    token,
    captureToolInputs: parseBool(env.FLIGHTDECK_CAPTURE_TOOL_INPUTS, true),
    capturePrompts: parseBool(env.FLIGHTDECK_CAPTURE_PROMPTS, true),
  };
}

// ---------------------------------------------------------------------
// Session id -- v0.4.0 Phase 1 (D115): uuid4 random, cached once per
// Claude Code invocation in a marker file keyed on the
// Claude-Code-supplied invocation id so every hook in the same run
// shares one session_id -- regardless of ``cd`` or whatever cwd the
// hook process happens to inherit.
//
// The v0.3-era derivation (D113) keyed on ``sha256(user, host, repo,
// branch)`` and produced a stable uuid5; stability now lives in
// ``agent_id`` so ``session_id`` can be a per-invocation random
// uuid4. An earlier Phase 1 implementation briefly keyed the marker
// on ``sha256(cwd)[:16]`` which broke the "one session per
// invocation" invariant whenever a user ran ``cd`` between hooks --
// three sessions landed for one Claude Code invocation in the audit
// smoke. Keying on ``hookEvent.session_id`` closes that regression
// because Claude Code guarantees a stable per-invocation id on every
// hook event.
// ---------------------------------------------------------------------

/**
 * Resolve a session id for the current hook invocation. Precedence
 * (top wins):
 *   1. process.env.CLAUDE_SESSION_ID
 *   2. process.env.ANTHROPIC_CLAUDE_SESSION_ID
 *   3. Marker file cache keyed on ``hookEvent.session_id``
 *      (populated by step 4 on the first hook of this invocation;
 *      read verbatim by every subsequent hook in the same run)
 *   4. Fresh uuid4 -- written to the hook-id-keyed marker file so
 *      steps 3 and 4 converge the moment the file lands
 *   5. Cwd-sha fallback (keys the marker on ``sha256(cwd)[:16]``
 *      AND emits a ``[flightdeck] WARN`` stderr line) when the hook
 *      event carries no session_id. Only triggered on malformed or
 *      missing hook payloads -- the supported Claude Code path
 *      always provides a session_id.
 *   6. Final ephemeral sha256(cwd)[:32] backstop when even
 *      ``$TMPDIR`` is unusable (tests + recovery path only).
 */
export function getSessionId(hookEvent = {}) {
  const env =
    process.env.CLAUDE_SESSION_ID || process.env.ANTHROPIC_CLAUDE_SESSION_ID;
  if (env) return env;

  const cwd = process.cwd();
  const dir = join(tmpdir(), "flightdeck-plugin");

  // Primary: Claude Code's per-invocation session id. Hook events
  // carry this reliably; when present it is the authoritative
  // invocation scope and the marker key.
  let markerKey;
  if (hookEvent && typeof hookEvent.session_id === "string" && hookEvent.session_id) {
    markerKey = createHash("sha256")
      .update(hookEvent.session_id)
      .digest("hex")
      .slice(0, 16);
  } else {
    // Fallback: cwd-sha marker + a single stderr warning so operators
    // know the plugin lost per-invocation scope. Kept as a safety net
    // for non-Claude-Code callers (playground scripts, integration
    // harnesses) that may invoke the entrypoint without a hook event.
    markerKey = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
    process.stderr.write(
      "[flightdeck] WARN: hook event missing session_id; " +
        "falling back to cwd-keyed marker. Sessions may split on cd.\n",
    );
  }
  const file = join(dir, `session-${markerKey}.txt`);

  const fallback = () =>
    createHash("sha256")
      .update(`${Date.now()}-${process.pid}-${cwd}`)
      .digest("hex")
      .slice(0, 32);

  try {
    mkdirSync(dir, { recursive: true });
    try {
      const existing = readFileSync(file, "utf8").trim();
      if (existing) return existing;
    } catch {
      /* fall through to create */
    }
    const candidate = randomUUID();
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
        // Concurrent first-hook race: another process beat us to the
        // file. Read whatever they wrote so every hook in the same
        // Claude Code run still agrees on one session id.
        const winner = readFileSync(file, "utf8").trim();
        if (winner) return winner;
      }
      throw err;
    }
  } catch {
    return fallback();
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

  // Phase 5 — MCP server fingerprint capture from .mcp.json + ~/.claude.json.
  // Per Phase 5 D1, the Claude Code plugin emits MCP_TOOL_CALL events
  // and the session-level mcp_servers context but cannot observe MCP
  // resource reads / prompt fetches / list operations (those bypass
  // the hook surface entirely). The mcp_servers fingerprint list
  // surfaces in the SessionDrawer's MCP SERVERS panel and feeds the
  // Investigate MCP SERVER facet aggregation. Version + capabilities
  // are best-effort because the plugin can't inspect the actual MCP
  // handshake — see plugin/README.md for the documented gap.
  try {
    const mcpServers = loadMcpServerFingerprints(extras.cwd || process.cwd());
    if (mcpServers && mcpServers.length > 0) {
      ctx.mcp_servers = mcpServers;
    }
  } catch {
    /* silent — never crash a hook on broken user config */
  }

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

/**
 * Wrap ``collectContext`` so a throw or an empty result returns ``null``
 * instead of propagating. Callers use ``null`` to signal "omit the
 * context field from the outbound payload" rather than sending
 * ``context: {}``.
 *
 * A non-session_start event that arrives without context would leave the
 * worker's COALESCE upgrade as a no-op, so there is no correctness cost
 * to omitting; the benefit is that the worker-side logs don't report a
 * pointless upgrade attempt and the DB doesn't see an extra UPDATE. The
 * "or throws" branch is defensive -- ``collectContext`` already wraps
 * each syscall in try/catch, so in practice the check on
 * ``Object.keys(ctx).length === 0`` guards the "everything I tried to
 * read failed" edge case.
 */
export function safeCollectContext(extras = {}) {
  try {
    const ctx = collectContext(extras);
    if (!ctx || typeof ctx !== "object") return null;
    if (Object.keys(ctx).length === 0) return null;
    return ctx;
  } catch {
    return null;
  }
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
// Phase 5 — MCP tool-name parsing + server fingerprint discovery.
//
// Claude Code namespaces MCP tools as ``mcp__<server>__<tool>``. The
// hook payload's ``tool_name`` is the prefixed string; this helper
// splits it back into (server_name, tool_name) for per-event
// attribution. Server names containing ``__`` cannot be unambiguously
// disambiguated from a plain tool name with double underscores — the
// parser falls back to a "best-effort split on the first inner ``__``"
// strategy with a documented limitation. ``claude mcp list`` could
// validate at SessionStart but spawning a subprocess on every hook is
// not free; we accept the ambiguity and document.
//
// A null return signals "this is NOT an MCP tool name." Callers use
// that to route the event through the standard tool_call path
// instead.
// ---------------------------------------------------------------------

const MCP_TOOL_PREFIX = "mcp__";

export function parseMcpToolName(name) {
  if (typeof name !== "string" || !name.startsWith(MCP_TOOL_PREFIX)) {
    return null;
  }
  const rest = name.slice(MCP_TOOL_PREFIX.length);
  if (rest.length === 0) {
    return null;
  }
  const split = rest.indexOf("__");
  if (split <= 0 || split >= rest.length - 2) {
    // No inner ``__``, or it lands at the very start / end — the name
    // is malformed. Best-effort fallback: treat the whole rest as the
    // tool name with a null server attribution. Callers log a warn.
    return { server_name: null, tool_name: rest, parsed: false };
  }
  return {
    server_name: rest.slice(0, split),
    tool_name: rest.slice(split + 2),
    parsed: true,
  };
}

// ``.mcp.json`` (project-scoped) + ``~/.claude.json`` (user-scoped)
// declare the MCP servers Claude Code is configured with for the
// current working directory. Both files are JSON; missing or
// malformed files yield an empty list (we never crash a hook on
// corrupt user config). Fields per server entry mirror the
// MCPServerFingerprint shape the Python sensor emits, with one
// asymmetry per Phase 5 D1: the plugin cannot inspect the actual
// MCP handshake (handshakes are invisible to hooks), so capability
// discovery + server version are best-effort or absent. Operators
// reading the dashboard see name + transport + command/URL — the
// fingerprint shape the asymmetric-coverage README documents.

export function loadMcpServerFingerprints(cwd) {
  const fingerprints = [];
  const seen = new Set();

  // Project-scoped .mcp.json sits at the repository root. Walk up
  // from cwd until we find one or hit filesystem root — the same
  // walk Claude Code itself does to resolve project-scoped servers.
  let dir = cwd;
  for (let i = 0; i < 32; i++) {
    const candidate = join(dir, ".mcp.json");
    try {
      const raw = readFileSync(candidate, "utf8");
      const parsed = JSON.parse(raw);
      const servers = parsed && typeof parsed === "object" ? parsed.mcpServers : null;
      if (servers && typeof servers === "object") {
        for (const [name, spec] of Object.entries(servers)) {
          if (seen.has(name)) continue;
          seen.add(name);
          fingerprints.push(buildFingerprintFromSpec(name, spec));
        }
      }
      break;
    } catch {
      /* continue walking up */
    }
    const parent = dirname(dir);
    if (!parent || parent === dir) break;
    dir = parent;
  }

  // User-scoped ~/.claude.json carries a ``projects.<cwd>.mcpServers``
  // block per project plus a top-level ``mcpServers`` block for
  // user-global servers. We parse both. The walk-up cwd matching is
  // approximate — Claude Code normalizes paths internally; we accept
  // an exact-match-or-no-match here because the alternative
  // (re-implementing Claude's path normalization) is fragile.
  try {
    const home = process.env.HOME || process.env.USERPROFILE;
    if (home) {
      const userFile = join(home, ".claude.json");
      const raw = readFileSync(userFile, "utf8");
      const parsed = JSON.parse(raw);
      // Top-level user-global servers.
      if (parsed && typeof parsed === "object" && parsed.mcpServers) {
        for (const [name, spec] of Object.entries(parsed.mcpServers)) {
          if (seen.has(name)) continue;
          seen.add(name);
          fingerprints.push(buildFingerprintFromSpec(name, spec));
        }
      }
      // Per-project servers — find the entry matching cwd.
      const projects = parsed?.projects;
      if (projects && typeof projects === "object" && projects[cwd]?.mcpServers) {
        for (const [name, spec] of Object.entries(projects[cwd].mcpServers)) {
          if (seen.has(name)) continue;
          seen.add(name);
          fingerprints.push(buildFingerprintFromSpec(name, spec));
        }
      }
    }
  } catch {
    /* silent */
  }

  return fingerprints;
}

function buildFingerprintFromSpec(name, spec) {
  // The mcpServers entry shape varies by transport:
  //   stdio: {"command": "npx", "args": [...], "env": {...}}
  //   http:  {"url": "https://...", "headers": {...}}
  //   sse:   {"type": "sse", "url": "..."}
  // We surface the human-readable fingerprint fields the dashboard's
  // MCPServersPanel renders. Capabilities are absent (the plugin
  // can't observe a handshake) — emitted as an empty object so the
  // wire shape matches what the sensor produces.
  let transport = null;
  let endpoint = null;
  if (spec && typeof spec === "object") {
    if (spec.url) {
      endpoint = String(spec.url);
      transport =
        typeof spec.type === "string"
          ? String(spec.type)
          : spec.url.startsWith("https://") || spec.url.startsWith("http://")
            ? "http"
            : "sse";
    } else if (spec.command) {
      transport = "stdio";
      const args = Array.isArray(spec.args) ? spec.args.join(" ") : "";
      endpoint = args ? `${spec.command} ${args}` : String(spec.command);
    }
  }
  return {
    name: String(name),
    transport,
    protocol_version: "",
    version: null,
    capabilities: {},
    instructions: null,
    // ``endpoint`` is plugin-only metadata — the Python sensor cannot
    // observe it because the SDK hides transport details below the
    // ClientSession surface. Documented in the dashboard contract as
    // "may be null on Python-sensor sessions, populated on plugin-
    // sourced sessions."
    endpoint,
  };
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
// Phase 5 — MCP tool-call emission (Claude Code plugin path).
//
// Per Phase 5 D1, the plugin emits MCP_TOOL_CALL only — resource
// reads, prompt fetches, and list operations are invisible to the
// hook surface. The wire shape matches what the Python sensor's
// MCP interceptor produces (Phase 5 addition C parity check):
//
//   server_name, transport, tool_name, arguments, result, duration_ms
//
// Differences from the sensor path:
//
//   * ``transport`` is read from the session's mcp_servers fingerprint
//     list (loaded from .mcp.json + ~/.claude.json). The hook payload
//     itself does not carry transport metadata, so we look up by
//     server_name. If the server isn't in the fingerprint list (e.g.
//     a server added mid-session via ``claude mcp add``) we emit
//     transport=null and the dashboard renders "—".
//   * ``error`` is populated on PostToolUseFailure events with the
//     hookEvent.error string lifted into the structured taxonomy
//     shape (error_type=other, error_class=PluginToolError). The
//     plugin doesn't get JSON-RPC error codes — those live below the
//     hook surface — so the taxonomy stays coarse.
//   * ``arguments`` and ``result`` capture is gated on the existing
//     captureToolInputs / capturePrompts knobs (D4 + D103). MCP
//     bypasses the sanitiser whitelist (the keep-list would drop
//     every MCP arg shape).
// ---------------------------------------------------------------------

async function emitMCPToolCallEvent({
  cfg,
  sessionId,
  basePayload,
  hookEvent,
  hookName,
  mcpParse,
  startTime,
}) {
  // Look up transport by server_name from the session's fingerprint
  // list. The cache is built once per process via collectContext for
  // SessionStart but the dispatch branch here runs in fresh hook
  // processes — re-load each time. Best-effort; on failure transport
  // is null and the dashboard renders that gracefully.
  let transport = null;
  try {
    const fingerprints = loadMcpServerFingerprints(process.cwd());
    if (mcpParse.server_name) {
      const match = fingerprints.find(
        (s) => s.name === mcpParse.server_name,
      );
      if (match) transport = match.transport;
    }
  } catch {
    /* silent */
  }

  // Capture-on arguments: bypass the whitelist sanitiser per D4.
  const argumentsCapture =
    cfg.captureToolInputs && hookEvent.tool_input != null
      ? hookEvent.tool_input
      : null;

  // Capture-on result: same posture as the existing tool_call path,
  // gated on capturePrompts. The wire shape mirrors what the sensor
  // produces — a CallToolResult-like dict with the response content.
  let resultCapture = null;
  if (cfg.capturePrompts && hookEvent.tool_response != null) {
    resultCapture =
      typeof hookEvent.tool_response === "string"
        ? { content: [{ type: "text", text: hookEvent.tool_response }] }
        : hookEvent.tool_response;
  }

  // Failure path — PostToolUseFailure. Hook event carries an ``error``
  // (string or object). Lift into the structured MCP error shape so
  // the dashboard's MCPEventDetails error block renders consistently
  // with sensor-produced errors.
  let errorPayload = null;
  if (hookName === "PostToolUseFailure" && hookEvent.error != null) {
    const message =
      typeof hookEvent.error === "string"
        ? hookEvent.error
        : JSON.stringify(hookEvent.error);
    errorPayload = {
      error_type: "other",
      error_class: "PluginToolError",
      message: message.length > 1000 ? `${message.slice(0, 1000)}…` : message,
    };
  }

  const duration_ms =
    hookName === "PostToolUse" || hookName === "PostToolUseFailure"
      ? Date.now() - startTime
      : null;

  const payload = {
    ...basePayload,
    event_type: "mcp_tool_call",
    server_name: mcpParse.server_name,
    transport,
    tool_name: mcpParse.tool_name,
    duration_ms,
    timestamp: new Date().toISOString(),
  };
  if (argumentsCapture != null) payload.arguments = argumentsCapture;
  if (resultCapture != null) payload.result = resultCapture;
  if (errorPayload != null) payload.error = errorPayload;

  await postEvent(cfg.server, cfg.token, sessionId, payload);
}

// ---------------------------------------------------------------------
// D126 — SubagentStart / SubagentStop emission.
//
// The plugin's standard dispatch emits events for the OUTER session
// — the one Claude Code invocation owns. When a Task subagent
// spawns, Claude Code fires SubagentStart with a hookEvent that
// carries:
//
//   * ``session_id`` — the outer session's id (the parent)
//   * the subagent's type / role (``subagent_type`` or
//     ``agent_type``, depending on Claude Code version; we read
//     either as the role string)
//   * ``tool_use_id`` — a stable correlator for THIS specific Task
//     invocation; SubagentStop carries the same value
//   * ``tool_input.prompt`` — the parent's input to the subagent
//   * (SubagentStop only) ``tool_response`` — the subagent's
//     response back to the parent
//
// We emit a CHILD session_start (or session_end) whose ``session_id``
// is a deterministic uuid5 derived from
// ``(outer_session_id, tool_use_id)`` so SubagentStart and the
// matching SubagentStop produce the same child id without any
// disk-marker plumbing. ``parent_session_id`` carries the outer
// session's id so the worker writes the relationship column.
// ``agent_role`` joins the agent_id derivation as the conditional
// 6th input (D126 § 1) — same uuid the Python sensor produces for
// a parent / role pair on the same identity 5-tuple.
//
// SubagentStop is the canonical child end-of-life signal (D126 § 5).
// PostToolUseFailure on a Task tool stays in the existing tool_call
// dispatch path (parent's event with the error block); we do NOT
// emit a child session_end here, because a delayed real
// SubagentStop would then race a synthetic one.
// ---------------------------------------------------------------------

export function _subagentRole(hookEvent) {
  // Claude Code's exact field name for the subagent's type label
  // varies by version. Try the documented ones in order; fall back
  // to the empty string (which the agent_id derivation collapses
  // to the 5-tuple form).
  const raw =
    hookEvent.subagent_type ||
    hookEvent.agent_type ||
    hookEvent.subagent ||
    "";
  return typeof raw === "string" ? raw : String(raw || "");
}

export function _subagentCorrelator(hookEvent) {
  // Stable correlator linking SubagentStart, every interior hook
  // fired during the subagent's execution, and SubagentStop to the
  // same child session.
  //
  // Real Claude Code (Opus 4.7+) populates ``agent_id`` on every
  // hook fired in subagent context — SubagentStart, every interior
  // PostToolUse / PreToolUse / Stop, and SubagentStop — with the
  // SAME value. This is the authoritative correlator for the modern
  // Agent tool surface and the only field present on SubagentStart
  // (which Claude Code does NOT supply tool_use_id for).
  //
  // ``tool_use_id`` / ``subagent_id`` / ``id`` remain as fallbacks
  // for older Claude Code versions, the playground/14 synthetic
  // harness, and any future surface that uses a different field
  // name. The first non-empty value wins; agent_id is checked first
  // so the modern surface routes correctly without touching the
  // playground / unit-test fixtures.
  return (
    hookEvent.agent_id ||
    hookEvent.tool_use_id ||
    hookEvent.subagent_id ||
    hookEvent.id ||
    null
  );
}

export function _subagentChildSessionId(outerSessionId, correlator) {
  // Deterministic uuid5 in the same NAMESPACE_FLIGHTDECK as agent_id
  // so future reverse-derivation tools have one constant to anchor
  // against. The path scheme starts with ``flightdeck:subagent://``
  // so it can't collide with the agent_id derivation's
  // ``flightdeck://`` paths even if a clever adversary chose
  // colliding inputs.
  return uuid5(
    NAMESPACE_FLIGHTDECK,
    `flightdeck:subagent://${outerSessionId}/${correlator}`,
  );
}

// D126 — derive the subagent's per-execution transcript path from
// the parent's transcript path and the subagent's agent_id.
//
// Claude Code stores each subagent's LLM turns in a SEPARATE JSONL
// file at:
//
//   <parent_transcript_dir>/<parent_session_id>/subagents/agent-<agent_id>.jsonl
//
// e.g. parent ``…/<dir>/47a0eaef-…-9130fcdca5df.jsonl`` →
//   subagent ``…/<dir>/47a0eaef-…-9130fcdca5df/subagents/agent-a3017….jsonl``
//
// The plugin's transcript reader (``readTurns``) operates on a
// single .jsonl file. Without this derivation, interior PostToolUse
// hooks fired during a subagent's execution see the PARENT'S
// transcript — which contains the subagent's tool calls but NOT
// the subagent's LLM assistant turns (those live in the per-
// subagent file). The result: post_call events for the subagent
// land with tokens_input/output/total = 0 because the assistant
// turn carrying ``message.usage`` was never read.
//
// SubagentStop hooks DO carry an explicit ``agent_transcript_path``
// field on the hook payload — when present we prefer that over
// the derivation. Interior PostToolUse hooks don't, so the
// derivation is the only path.
//
// Returns null when either input is missing — callers must fall
// back to the parent's transcript_path so the function never
// silently produces a malformed path.
export function _subagentTranscriptPath(parentTranscriptPath, subagentAgentId) {
  if (!parentTranscriptPath || typeof parentTranscriptPath !== "string") {
    return null;
  }
  if (!subagentAgentId || typeof subagentAgentId !== "string") {
    return null;
  }
  const parentDir = dirname(parentTranscriptPath);
  const parentBase = basename(parentTranscriptPath).replace(/\.jsonl$/i, "");
  if (!parentBase) return null;
  return join(parentDir, parentBase, "subagents", `agent-${subagentAgentId}.jsonl`);
}

// D126 — interior-event routing for Claude Code subagents.
//
// When Claude Code runs an Agent-tool subagent, every interior hook
// (PostToolUse, PreToolUse, Stop, etc.) fires with the OUTER session's
// ``session_id`` but with two extra fields populated:
//
//   * ``agent_id``   — the subagent's stable correlator (same value
//                      Claude Code passed on SubagentStart and will
//                      pass on SubagentStop).
//   * ``agent_type`` — the subagent's role label (e.g. ``"Explore"``).
//
// Both fields are absent (null / undefined) on hooks fired outside
// subagent context — i.e. the parent's own tool-call lifecycle.
// Their presence is the discriminator: when we see ``agent_id`` set
// on a non-Subagent-named hook, we are inside the subagent's
// execution and the event must land under the CHILD session, not
// the parent.
//
// Pre-fix the plugin used the parent's session_id for these interior
// events, leaving the child session row empty in the dashboard while
// the parent collected the subagent's tool calls and LLM turns —
// architecturally wrong, and the gap that survived the playground/14
// synthetic harness because the harness never simulates the
// SubagentStart → interior-PostToolUse → SubagentStop sequence (it
// fires the boundary events alone). See DECISIONS.md D126 § 5
// "interior-event routing" for the lesson.
//
// Returns null when the hook is NOT in subagent context (parent's
// own event); returns a context object with the remapped child
// identity when it IS. The caller (main()) overlays the returned
// fields onto basePayload before emission so every downstream event
// type — pre_call, post_call, tool_call, mcp_*, the synthetic
// session_start backstop — automatically lands under the child.
export function _subagentInteriorContext({
  hookEvent,
  hookName,
  parentSessionId,
  parentAgentName,
  identityUser,
  identityHostname,
}) {
  // SubagentStart / SubagentStop have their own dedicated dispatch
  // (emitSubagentEvent) and do NOT take this path. Recognising them
  // here would double-emit the child session_start / session_end.
  if (hookName === "SubagentStart" || hookName === "SubagentStop") {
    return null;
  }
  const agentIdField = hookEvent && hookEvent.agent_id;
  if (!agentIdField || typeof agentIdField !== "string") {
    return null;
  }
  const role =
    hookEvent.subagent_type ||
    hookEvent.agent_type ||
    hookEvent.subagent ||
    "";
  const childSessionId = _subagentChildSessionId(parentSessionId, agentIdField);
  const childAgentName = role ? `${parentAgentName}/${role}` : parentAgentName;
  const childAgentId = deriveAgentId({
    agent_type: "coding",
    user: identityUser,
    hostname: identityHostname,
    client_type: "claude_code",
    agent_name: parentAgentName,
    agent_role: role,
  });
  // Subagent's per-execution transcript path. Interior PostToolUse
  // hooks fired during the subagent's run carry the PARENT'S
  // transcript_path on hookEvent — the per-subagent JSONL lives at
  // a derived location (see _subagentTranscriptPath). flushPostCall
  // Turns reads this path so the subagent's assistant turns
  // (carrying ``message.usage``) emit post_call events with real
  // tokens_input/output/total instead of zeros.
  const subagentTranscriptPath = _subagentTranscriptPath(
    hookEvent && hookEvent.transcript_path,
    agentIdField,
  );
  return {
    sessionId: childSessionId,
    parentSessionId,
    agentRole: role || null,
    agentId: childAgentId,
    agentName: childAgentName,
    subagentTranscriptPath,
  };
}

function _captureMessage(body) {
  if (body == null) return null;
  return {
    body,
    captured_at: new Date().toISOString(),
  };
}

// D126 § 6 sub-agent message routing thresholds. Mirror the
// constants in sensor/flightdeck_sensor/core/session.py so the
// plugin and Python sensor produce identical wire shapes for
// equivalent body sizes — same inline / overflow / hard-reject
// boundaries.
//
// Bodies up to SUBAGENT_INLINE_THRESHOLD_BYTES ride inline on the
// payload's ``incoming_message`` / ``outgoing_message`` field;
// bodies above the threshold but at or below SUBAGENT_HARD_CAP_BYTES
// route through the existing D119 event_content path
// (has_content=true on the event, full body on payload.content
// in the PromptContent envelope shape the worker's
// InsertEventContent expects); bodies above the hard cap are
// dropped with a stderr WARN.
const SUBAGENT_INLINE_THRESHOLD_BYTES = 8 * 1024;
const SUBAGENT_HARD_CAP_BYTES = 2 * 1024 * 1024;
const SUBAGENT_OVERFLOW_PROVIDER = "flightdeck-subagent";

/**
 * Resolve a sub-agent message into ``{stubOrInline, contentEnvelope}``
 * per D126 § 6. Mirrors :py:meth:`Session._route_subagent_message`
 * on the sensor side — same byte-size measurement (JSON-encoded
 * body), same threshold values, same wire shapes for inline / stub
 * / overflow envelopes.
 *
 * Returns ``{stubOrInline: null, contentEnvelope: null}`` when the
 * body is absent / capture is off / body exceeds the hard cap.
 */
function _routeSubagentMessage(body, capturePrompts, direction) {
  if (body == null || !capturePrompts) {
    return { stubOrInline: null, contentEnvelope: null };
  }
  // JSON-encode once to size — same encoding the worker sees, so
  // this byte count is the authoritative measure for the
  // inline-vs-overflow decision.
  const jsonBody = JSON.stringify(body);
  const size = Buffer.byteLength(jsonBody, "utf8");
  const capturedAt = new Date().toISOString();
  if (size > SUBAGENT_HARD_CAP_BYTES) {
    process.stderr.write(
      `flightdeck: sub-agent ${direction}_message body exceeds ` +
        `${SUBAGENT_HARD_CAP_BYTES}-byte hard cap (size=${size} ` +
        `bytes); dropped per D126 § 6.\n`,
    );
    return { stubOrInline: null, contentEnvelope: null };
  }
  if (size <= SUBAGENT_INLINE_THRESHOLD_BYTES) {
    return {
      stubOrInline: { body, captured_at: capturedAt },
      contentEnvelope: null,
    };
  }
  // Overflow → event_content via the existing D119 path. The
  // PromptContent envelope's NOT NULL columns
  // (``messages`` default ``[]``, ``response`` JSONB NOT NULL) are
  // satisfied by an empty messages list and a response object that
  // carries the body + direction discriminator. ``provider`` =
  // "flightdeck-subagent" lets the dashboard's content-fetch
  // consumer pick the sub-agent renderer over PromptViewer.
  return {
    stubOrInline: {
      has_content: true,
      content_bytes: size,
      captured_at: capturedAt,
    },
    contentEnvelope: {
      provider: SUBAGENT_OVERFLOW_PROVIDER,
      model: "",
      system: null,
      messages: [],
      tools: null,
      response: { direction, body, captured_at: capturedAt },
      input: null,
    },
  };
}

async function emitSubagentEvent({
  cfg,
  hookName,
  hookEvent,
  outerSessionId,
  basePayload,
  agentName,
  identityUser,
  identityHostname,
}) {
  const role = _subagentRole(hookEvent);
  const correlator = _subagentCorrelator(hookEvent);
  if (!correlator) {
    // Without a correlator we can't pair Start with Stop. Log and
    // bail rather than emitting half a relationship that the
    // worker would later struggle to close. The modern Claude Code
    // surface populates ``agent_id`` on Subagent hooks; older
    // surfaces fell back to ``tool_use_id``. Either should be
    // present; absence here means a Claude Code version skew the
    // plugin's correlator list doesn't yet cover.
    process.stderr.write(
      `flightdeck: ${hookName} payload missing agent_id and ` +
        `tool_use_id; child session emission skipped.\n`,
    );
    return;
  }

  const childSessionId = _subagentChildSessionId(outerSessionId, correlator);
  const childAgentName = role ? `${agentName}/${role}` : agentName;
  const childAgentId = deriveAgentId({
    agent_type: "coding",
    user: identityUser,
    hostname: identityHostname,
    client_type: "claude_code",
    agent_name: agentName,
    agent_role: role,
  });

  const payload = {
    ...basePayload,
    session_id: childSessionId,
    parent_session_id: outerSessionId,
    agent_role: role || null,
    agent_id: childAgentId,
    agent_name: childAgentName,
    event_type: hookName === "SubagentStart" ? "session_start" : "session_end",
    tool_name: null,
    tool_input: null,
    is_subagent_call: false,
    latency_ms: null,
    timestamp: new Date().toISOString(),
    has_content: false,
    content: null,
  };

  // D126 § 6 — sub-agent message routing. Body size decides
  // whether the message lives inline on payload (≤ 8 KiB) or rides
  // through the existing D119 event_content path (> 8 KiB and ≤ 2
  // MiB). _routeSubagentMessage handles capture-off + hard-cap
  // rejection inline; here we just stamp whatever it returns.
  if (hookName === "SubagentStart") {
    const promptBody =
      hookEvent.tool_input && typeof hookEvent.tool_input === "object"
        ? hookEvent.tool_input.prompt ?? null
        : null;
    const { stubOrInline, contentEnvelope } = _routeSubagentMessage(
      promptBody, cfg.capturePrompts, "incoming",
    );
    if (stubOrInline) payload.incoming_message = stubOrInline;
    if (contentEnvelope) {
      payload.has_content = true;
      payload.content = contentEnvelope;
    }
  } else {
    // SubagentStop. Two responsibilities here:
    //
    //   1. Flush any unemitted assistant turns from the subagent's
    //      per-execution transcript as post_call events, mirroring
    //      what SessionEnd does for parent sessions. Without this
    //      the subagent's FINAL LLM turn (the one not followed by
    //      a tool call, so no interior PostToolUse triggered the
    //      flush) lands as zero-token void in the dashboard.
    //      Prefer the explicit ``agent_transcript_path`` field on
    //      the SubagentStop payload (Claude Code provides it);
    //      fall back to the derived path so older Claude Code
    //      versions or subtle layout differences still work.
    //
    //   2. Stamp ``outgoing_message`` with the subagent's response
    //      back to the parent (D126 § 6 cross-agent message
    //      capture).
    const subagentTranscript =
      (typeof hookEvent.agent_transcript_path === "string" &&
        hookEvent.agent_transcript_path) ||
      _subagentTranscriptPath(hookEvent.transcript_path, correlator);
    if (subagentTranscript) {
      try {
        const childBasePayload = {
          ...basePayload,
          session_id: childSessionId,
          parent_session_id: outerSessionId,
          agent_role: role || null,
          agent_id: childAgentId,
          agent_name: childAgentName,
        };
        await flushPostCallTurns({
          cfg,
          sessionId: childSessionId,
          basePayload: childBasePayload,
          turns: readTurns(subagentTranscript),
          capturePrompts: cfg.capturePrompts,
        });
      } catch (err) {
        // Transcript-read failures are not fatal — we still emit
        // the session_end so the child session closes cleanly. The
        // missing post_calls just means the subagent's final turn
        // won't show in the dashboard; D106 lazy-create still
        // tracks the session itself.
        process.stderr.write(
          `flightdeck: SubagentStop transcript flush failed for ` +
            `${childSessionId}: ${err?.message || err}\n`,
        );
      }
    }
    const { stubOrInline, contentEnvelope } = _routeSubagentMessage(
      hookEvent.tool_response ?? null,
      cfg.capturePrompts,
      "outgoing",
    );
    if (stubOrInline) payload.outgoing_message = stubOrInline;
    if (contentEnvelope) {
      payload.has_content = true;
      payload.content = contentEnvelope;
    }
  }

  await postEvent(cfg.server, cfg.token, childSessionId, payload);
}

// ---------------------------------------------------------------------
// HTTP POST helper + unreachable-session logging.
//
// The plugin must never block Claude Code on a broken or missing
// Flightdeck stack. Every failure path -- connection refused, DNS
// failure, HTTP non-2xx, abort timeout -- writes a single stderr line
// and returns; the hook still exits 0 so Claude Code sees it healthy.
//
// Each hook invocation is a fresh Node process, so "each POST logs at
// most once" naturally yields bounded stderr output: one line per
// failed POST, at most two lines per hook (ensureSessionStarted's
// POST + the real event's POST). No disk-persisted unreachable flag
// -- that design broke reconnect: once the flag was written, every
// subsequent hook short-circuited even after the server recovered,
// so transient outages turned into permanent session mute. Retrying
// each hook's POST costs at most two stderr lines on a dead stack
// and unlocks the "server recovers mid-session, events resume
// landing" path that D106 handles on the server side. See KI18
// resolution / commit 4a.
// ---------------------------------------------------------------------

/**
 * Log a single "cannot reach" stderr line for this failed POST. The
 * message format is stable -- it is documented in the plugin README
 * troubleshooting section and in tests. Called once per failed POST;
 * the caller process exits shortly after so the volume of log lines
 * is bounded by the number of POST attempts per hook (at most two).
 */
function logUnreachable(server, shortError) {
  process.stderr.write(
    `[flightdeck] cannot reach ${server}: ${shortError}. events dropped for this session.\n`,
  );
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
    // timeout, fetch rejection. Log and return -- the next hook
    // invocation is a fresh process and will try again.
    logUnreachable(server, shortErrorFrom(err));
    return;
  } finally {
    clearTimeout(timeout);
  }

  // HTTP-level failure: auth, payload validation, server error.
  // fetch() returns normally for these so the catch above does not
  // fire. We do NOT retry within this hook -- one attempt per POST
  // is the whole contract. A subsequent hook will try again when
  // Claude Code invokes a fresh plugin process.
  if (!response.ok) {
    logUnreachable(server, `HTTP ${response.status}`);
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
  };
  const startContext = safeCollectContext({
    claudeCodeVersion: extras.claudeCodeVersion,
  });
  if (startContext) startPayload.context = startContext;
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
// Emit one post_call per un-emitted transcript turn.
//
// Called from Stop, SessionEnd, and PostToolUse. markEmittedTurn dedup
// (per assistant message.id) keeps emission idempotent across the three
// call sites. PostToolUse flushes mid-turn so the dashboard shows LLM
// activity in real time instead of waiting for the turn to end at Stop.
// ---------------------------------------------------------------------

async function flushPostCallTurns({
  cfg,
  sessionId,
  basePayload,
  turns,
  capturePrompts,
}) {
  for (const turn of turns) {
    if (!markEmittedTurn(turn.messageId)) continue;
    const tokens = tokensFromUsage(turn.usage);
    const latencyMs = computeLatencyMs(turn.userTurn, turn.lastTimestamp);
    const hasContent = capturePrompts;
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
  // PostToolUseFailure is intentionally absent from EVENT_MAP — it is
  // observable for MCP tools only (Phase 5 D1) and is dropped for
  // generic Claude Code tool failures. Let it through so the MCP
  // dispatch branch below can route it to mcp_tool_call; non-MCP
  // PostToolUseFailure falls through and is dropped after that branch.
  //
  // D126 — SubagentStart and SubagentStop are also intentionally
  // absent from EVENT_MAP because they emit CHILD session_start /
  // session_end events (different session_id from the outer hook),
  // not parent events. Routed to a dedicated dispatch below.
  const isSubagentHook =
    hookName === "SubagentStart" || hookName === "SubagentStop";
  if (!eventType && hookName !== "PostToolUseFailure" && !isSubagentHook) {
    return;
  }

  // ``outerSessionId`` is what Claude Code passes on hookEvent —
  // ALWAYS the parent invocation's id, regardless of whether the
  // hook fires inside subagent context. ``sessionId`` is what we
  // EMIT under, which equals ``outerSessionId`` for parent events
  // and equals the deterministic child id for interior subagent
  // events (computed below). Keep both names — the parent linkage
  // on subagent children needs the outer, the dispatch downstream
  // needs the resolved.
  const outerSessionId = getSessionId(hookEvent);
  let sessionId = outerSessionId;
  // ``transcriptPath`` defaults to the parent's transcript path
  // from hookEvent. When the hook fires inside subagent context,
  // we swap to the subagent's per-execution transcript so the
  // assistant-turn token usage is captured correctly. See
  // _subagentTranscriptPath comment for the path derivation.
  let transcriptPath = hookEvent.transcript_path;

  // Base identity fields used by every event for this session.
  //
  // ``context`` is attached here so *every* event type (pre_call,
  // post_call, tool_call, session_end) carries it -- not only
  // session_start. The worker's D106 lazy-create path and the
  // UpgradeSessionContext upgrade depend on seeing context on the first
  // event that actually reaches the server. Without this, a session
  // whose session_start POST failed (stack down at start, dead-TLS
  // window, ...) would land with "unknown" flavor and NULL context
  // forever because the session_start dedup marker on disk prevents
  // a retry. ``safeCollectContext`` returns null on throw or empty
  // result, in which case the field is omitted -- the worker's
  // COALESCE upgrade treats "missing" and "empty dict" identically.
  const baseContext = safeCollectContext();

  // D115 agent identity. Plugin emits hardcoded agent_type="coding"
  // and client_type="claude_code"; agent_name defaults to
  // "{user}@{hostname}" and can be overridden via
  // FLIGHTDECK_AGENT_NAME env var. The user/hostname come from the
  // context collector (which itself honors FLIGHTDECK_HOSTNAME), so
  // an operator overriding hostname for k8s pod grouping gets
  // consistent agent_id / agent_name derivation and context.hostname.
  const identityUser = baseContext?.user || "unknown";
  const identityHostname =
    process.env.FLIGHTDECK_HOSTNAME ||
    baseContext?.hostname ||
    osHostname();
  const baseAgentName =
    process.env.FLIGHTDECK_AGENT_NAME || `${identityUser}@${identityHostname}`;
  const baseAgentId = deriveAgentId({
    agent_type: "coding",
    user: identityUser,
    hostname: identityHostname,
    client_type: "claude_code",
    agent_name: baseAgentName,
  });

  // D126 interior-event routing. When this hook fired inside a
  // subagent's execution, swap (sessionId, agentId, agentName) to
  // the CHILD identity so every downstream emission lands under
  // the right session — and stamp parent_session_id / agent_role
  // on basePayload so the worker writes the relationship through.
  // Returns null for parent-context hooks; resolved fields apply
  // unchanged for those.
  const interiorCtx = _subagentInteriorContext({
    hookEvent,
    hookName,
    parentSessionId: outerSessionId,
    parentAgentName: baseAgentName,
    identityUser,
    identityHostname,
  });
  let agentId = baseAgentId;
  let agentName = baseAgentName;
  if (interiorCtx) {
    sessionId = interiorCtx.sessionId;
    agentId = interiorCtx.agentId;
    agentName = interiorCtx.agentName;
    if (interiorCtx.subagentTranscriptPath) {
      transcriptPath = interiorCtx.subagentTranscriptPath;
    }
  }

  const basePayload = {
    session_id: sessionId,
    flavor: "claude-code",
    agent_type: "coding",
    // D115 identity on every event.
    agent_id: agentId,
    agent_name: agentName,
    client_type: "claude_code",
    user: identityUser,
    hostname: identityHostname,
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
    ...(interiorCtx
      ? {
          parent_session_id: interiorCtx.parentSessionId,
          agent_role: interiorCtx.agentRole,
        }
      : {}),
    ...(baseContext ? { context: baseContext } : {}),
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

  // SubagentStart / SubagentStop (D126). Emit a child session_start /
  // session_end whose session_id is distinct from the outer
  // (parent) session, with parent_session_id pointing back at the
  // outer one and agent_role labeling the subagent's type. SubagentStop
  // is the canonical end-of-life signal; PostToolUseFailure on a
  // Task tool keeps emitting the parent's tool_call event with the
  // structured error block and does NOT duplicate-emit a child
  // session_end (D126 § 6 disambiguation). Crashes that never reach
  // a clean SubagentStop fall through the worker's existing state-
  // revival path (active → stale → lost).
  if (isSubagentHook) {
    // emitSubagentEvent derives the child's agent_id and display
    // name from the PARENT's agent_name (D126 § 1 — agent_role is
    // the conditional 6th input on top of the parent's 5-tuple).
    // Pass ``baseAgentName`` explicitly so the right value flows
    // even if a future change makes ``agentName`` carry the child's
    // composed form for some other reason.
    await emitSubagentEvent({
      cfg,
      hookName,
      hookEvent,
      outerSessionId,
      basePayload,
      agentName: baseAgentName,
      identityUser,
      identityHostname,
    });
    return;
  }

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
  // flush any LLM turns not yet emitted by Stop or PostToolUse -- in
  // `claude -p` mode Claude Code fires Stop once before the final
  // tool-loop turn is flushed to the transcript, so a post_call for
  // the final turn can still be missing when SessionEnd arrives.
  // Dedup via the per-messageId marker keeps this idempotent with
  // Stop and PostToolUse.
  if (hookName === "SessionEnd") {
    await flushPostCallTurns({
      cfg,
      sessionId,
      basePayload,
      turns: getTurns(),
      capturePrompts: cfg.capturePrompts,
    });
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
  // file. PostToolUse flushes most of these mid-turn; Stop acts as the
  // final backstop for the last assistant turn (no tool follow-up).
  // cacheSessionModel inside the helper keeps pre_call labelling right
  // for subsequent UserPromptSubmit hooks on older Claude Code versions
  // that do not carry model on SessionStart.
  if (hookName === "Stop") {
    await flushPostCallTurns({
      cfg,
      sessionId,
      basePayload,
      turns: getTurns(),
      capturePrompts: cfg.capturePrompts,
    });
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

  // PostToolUse: flush any un-emitted LLM turns from the transcript
  // before emitting the tool_call. The assistant record that triggered
  // this tool invocation is already in the transcript by the time
  // PostToolUse fires, so its post_call becomes visible in the
  // dashboard in real time rather than batching at Stop. Ordering:
  // post_call (LLM decision) precedes tool_call (tool execution),
  // matching transcript order. markEmittedTurn dedup keeps Stop and
  // SessionEnd idempotent. Wrapped in try/catch so a transcript read
  // failure cannot block the tool_call emission -- readTurns already
  // returns [] on read errors, but belt-and-suspenders.
  if (hookName === "PostToolUse") {
    try {
      await flushPostCallTurns({
        cfg,
        sessionId,
        basePayload,
        turns: getTurns(),
        capturePrompts: cfg.capturePrompts,
      });
    } catch (err) {
      process.stderr.write(
        `flightdeck: post_call flush on PostToolUse failed: ${err?.message || err}\n`,
      );
    }
  }

  // PreToolUse / PostToolUse: tool-lifecycle events. Keep the same
  // sanitised-whitelist capture semantics the plugin has shipped since
  // Phase 4.
  const toolName =
    hookEvent.tool_name ||
    hookEvent.tool_use?.name ||
    hookEvent.tool ||
    null;

  // Phase 5 — MCP tool calls are namespaced as ``mcp__<server>__<tool>``
  // by Claude Code. Detect via prefix and route to the dedicated MCP
  // emit branch BEFORE the standard tool sanitiser runs. Per Phase 5
  // D4, the whitelist sanitiser is BYPASSED for MCP tools — its keep-
  // list (file_path / command / query / pattern / prompt) drops every
  // MCP-specific argument shape and would render the plugin-sourced
  // MCP_TOOL_CALL payload empty. The MCP path captures the raw
  // arguments verbatim under the existing ``captureToolInputs`` knob.
  const mcpParse = parseMcpToolName(toolName);
  if (mcpParse) {
    if (!mcpParse.parsed) {
      process.stderr.write(
        `flightdeck: ambiguous MCP tool name "${toolName}"; ` +
          `server attribution falling back to null. See plugin README.\n`,
      );
    }
    await emitMCPToolCallEvent({
      cfg,
      sessionId,
      basePayload,
      hookEvent,
      hookName,
      mcpParse,
      startTime,
    });
    return;
  }

  // Non-MCP PostToolUseFailure is dropped — there is no generic
  // tool_failure event_type today (Phase 5 D1: failure granularity is
  // MCP-only). Avoids POSTing a payload with event_type=undefined.
  if (!eventType) return;

  const sanitizedInput =
    cfg.captureToolInputs && hookEvent.tool_input
      ? sanitizeToolInput(hookEvent.tool_input)
      : null;
  const toolInputJson = sanitizedInput ? JSON.stringify(sanitizedInput) : null;

  const isSubagentCall = toolName === "Task";

  // Build event_content payload so the drawer's Prompts tab can show
  // real tool input + output (previously tool_call events always had
  // has_content=false, so the drawer rendered shallow metadata only).
  // Privacy tiers: input is gated on captureToolInputs (default ON);
  // output is gated on capturePrompts (default ON for the plugin,
  // OFF for the Python sensor -- see resolveConfig rationale and
  // DECISIONS.md D103).
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
        content: out.length > 2000 ? out.slice(0, 2000) + "\u2026" : out,
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

  // D126 — preserve basePayload's parent_session_id when interior
  // subagent context set it (the modern Agent tool path). Fall back
  // to the legacy ``isSubagentCall ? sessionId : null`` shape for
  // the deprecated Task-tool informational hint (D100, retained as
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
    latency_ms: hookName === "PostToolUse" ? Date.now() - startTime : null,
    timestamp: new Date().toISOString(),
    has_content: hasContent,
    content,
  };
  await postEvent(cfg.server, cfg.token, sessionId, payload);
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === process.argv[1]
) {
  main();
}
