// MCP in Claude Code: tool-name parsing, server identity, the
// .mcp.json / ~/.claude.json fingerprints, and the mcp_tool_call event.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { boundedIdentity, boundedToken, MAX_MCP_IDENTITY_BYTES } from "../core/config.mjs";
import { postEvent } from "../core/poster.mjs";
import { buildToolErrorBlock, captureErrorText, hookDurationMs } from "./tools.mjs";

// ---------------------------------------------------------------------
// MCP tool-name parsing + server fingerprint discovery.
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

// Claude Code keys a plugin-provided MCP server as
// ``plugin:<plugin>:<server>`` and flattens that key into the tool
// name as ``plugin_<plugin>_<server>`` (every character outside
// [A-Za-z0-9_-] becomes an underscore). The prefix identifies the
// flattened form so the colon form can be rebuilt.
const MCP_PLUGIN_SERVER_PREFIX = "plugin_";

/**
 * Rebuild Claude Code's server key from its flattened tool-name form.
 * ``plugin_claude-mem_mcp-search`` becomes
 * ``plugin:claude-mem:mcp-search``, the same string Claude Code puts in
 * ``hookEvent.mcp_server.name`` on versions that send it. The plugin
 * name is taken up to the first underscore -- marketplace plugin names
 * are kebab-case, so the split is exact unless a plugin name itself
 * contains an underscore, in which case the hook's ``mcp_server``
 * field (preferred by resolveMcpToolIdentity) is the authority.
 * Non-plugin server keys are returned unchanged.
 */
export function canonicalMcpServerName(rawServer) {
  if (typeof rawServer !== "string") return rawServer;
  if (!rawServer.startsWith(MCP_PLUGIN_SERVER_PREFIX)) return rawServer;
  const rest = rawServer.slice(MCP_PLUGIN_SERVER_PREFIX.length);
  const idx = rest.indexOf("_");
  if (idx <= 0 || idx >= rest.length - 1) return rawServer;
  return `plugin:${rest.slice(0, idx)}:${rest.slice(idx + 1)}`;
}

/**
 * The flattened form Claude Code uses for a server key inside a tool
 * name: every character outside [A-Za-z0-9_-] becomes an underscore.
 */
export function flattenMcpServerName(serverName) {
  return String(serverName).replace(/[^A-Za-z0-9_-]/g, "_");
}

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
    return { server_name: null, server_key: null, tool_name: rest, parsed: false, source: null };
  }
  const serverKey = rest.slice(0, split);
  return {
    server_name: canonicalMcpServerName(serverKey),
    server_key: serverKey,
    tool_name: rest.slice(split + 2),
    parsed: true,
    source: serverKey.startsWith(MCP_PLUGIN_SERVER_PREFIX) ? "plugin" : null,
  };
}

/**
 * Resolve which MCP server and tool a hook event refers to. Current
 * Claude Code sends ``mcp_server: {name, source}`` on PreToolUse /
 * PostToolUse / PostToolUseFailure for MCP tools -- ``name`` is the
 * server key exactly as Claude Code holds it (``filesystem``,
 * ``plugin:claude-mem:mcp-search``) and ``source`` says where the
 * server was declared (``plugin``, project / user config). That field
 * is the authority when present: it also makes the tool-name split
 * exact for a server whose key contains ``__``, because the flattened
 * key can be stripped from the front of the tool name. Older versions
 * only give the tool name, so the parser's best-effort split applies.
 *
 * Returns null for a non-MCP tool name; otherwise
 * ``{server_name, server_key, tool_name, parsed, source}``.
 */
export function resolveMcpToolIdentity(hookEvent, toolName) {
  const parsed = parseMcpToolName(toolName);
  if (!parsed) return null;
  // A hint is honoured only when it is an object whose name is a
  // bounded, control-character-free string; anything else falls back
  // to the parsed name so a hostile hint cannot rename the server.
  const hint = hookEvent && hookEvent.mcp_server;
  const hintName =
    hint && typeof hint === "object" && !Array.isArray(hint)
      ? boundedToken(hint.name, MAX_MCP_IDENTITY_BYTES)
      : null;
  if (!hintName) return parsed;
  const hintSource =
    typeof hint.source === "string" && hint.source ? hint.source : parsed.source;
  const flat = flattenMcpServerName(hintName);
  const rest = toolName.slice(MCP_TOOL_PREFIX.length);
  const prefix = `${flat}__`;
  const toolFromHint =
    rest.startsWith(prefix) && rest.length > prefix.length
      ? rest.slice(prefix.length)
      : parsed.tool_name;
  return {
    server_name: hintName,
    server_key: flat,
    tool_name: toolFromHint,
    parsed: true,
    source: hintSource,
  };
}

// ``.mcp.json`` (project-scoped) + ``~/.claude.json`` (user-scoped)
// declare the MCP servers Claude Code is configured with for the
// current working directory. Both files are JSON; missing or
// malformed files yield an empty list (we never crash a hook on
// corrupt user config). Fields per server entry mirror the
// MCPServerFingerprint shape the Python sensor emits, with one
// asymmetry: the plugin cannot inspect the actual
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
// MCP tool-call emission (Claude Code plugin path).
//
// The plugin emits MCP_TOOL_CALL only — resource
// reads, prompt fetches, and list operations are invisible to the
// hook surface. The wire shape matches what the Python sensor's
// MCP interceptor produces:
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
//     captureToolInputs / capturePrompts knobs. MCP
//     bypasses the sanitiser whitelist (the keep-list would drop
//     every MCP arg shape).
// ---------------------------------------------------------------------

export async function emitMCPToolCallEvent({
  cfg,
  sessionId,
  basePayload,
  hookEvent,
  hookName,
  mcpIdentity,
}) {
  // Look up transport by server_name from the session's fingerprint
  // list. The cache is built once per process via collectContext for
  // SessionStart but the dispatch branch here runs in fresh hook
  // processes — re-load each time. Best-effort; on failure transport
  // is null and the dashboard renders that gracefully. Plugin-provided
  // servers are declared in the plugin's own .mcp.json, not the
  // project's, so they resolve to null here by design.
  let transport = null;
  try {
    const fingerprints = loadMcpServerFingerprints(process.cwd());
    if (mcpIdentity.server_name) {
      const match = fingerprints.find(
        (s) => s.name === mcpIdentity.server_name || s.name === mcpIdentity.server_key,
      );
      if (match) transport = match.transport;
    }
  } catch {
    /* silent */
  }

  // Capture-on arguments: bypass the whitelist sanitiser (its
  // keep-list would drop every MCP arg shape).
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
  const errorPayload =
    hookName === "PostToolUseFailure"
      ? buildToolErrorBlock(hookEvent, captureErrorText(cfg))
      : null;

  // Real tool duration as measured by Claude Code; null on versions
  // that do not send it (never the hook's own process runtime).
  const duration_ms = hookDurationMs(hookEvent);

  const payload = {
    ...basePayload,
    event_type: "mcp_tool_call",
    server_name: boundedIdentity(mcpIdentity.server_name),
    transport,
    tool_name: boundedIdentity(mcpIdentity.tool_name),
    duration_ms,
    timestamp: new Date().toISOString(),
  };
  // mcp_server is a pass-through of what Claude Code sent ({name,
  // source}, Claude Code 2.1.274+) and is absent when the hook carried
  // none; server_name above is the resolved identity on every version.
  // Only a well-formed object goes through: a string name within the
  // identity cap and a source that is a string within the cap, null,
  // or absent -- exactly what ingestion accepts.
  const hint = hookEvent.mcp_server;
  if (hint && typeof hint === "object" && !Array.isArray(hint)) {
    const name = boundedToken(hint.name, MAX_MCP_IDENTITY_BYTES);
    const sourceOk =
      hint.source === undefined ||
      hint.source === null ||
      boundedToken(hint.source, MAX_MCP_IDENTITY_BYTES) !== null;
    if (name && sourceOk) {
      payload.mcp_server =
        hint.source === undefined ? { name: hint.name } : { name: hint.name, source: hint.source };
    }
  }
  const toolUseId = boundedToken(hookEvent.tool_use_id, MAX_MCP_IDENTITY_BYTES);
  if (toolUseId) payload.tool_use_id = toolUseId;

  // Tool args + result live in event_content's dedicated tool_input /
  // tool_output columns, not inline on the payload. Plugin parity
  // with the sensor's _build_tool_capture_content envelope — wire
  // shape is byte-identical so the worker's InsertEventContent
  // consumes both surfaces uniformly. captureToolInputs gates
  // whether they are captured, not where they land.
  if (argumentsCapture != null || resultCapture != null) {
    payload.has_content = true;
    payload.content = buildToolCaptureContent({
      toolInput: argumentsCapture,
      toolOutput: resultCapture,
      serverName: mcpIdentity.server_name || "",
      sessionId,
    });
  }
  if (errorPayload != null) payload.error = errorPayload;

  await postEvent(cfg.server, cfg.token, sessionId, payload);
}

/**
 * Build the event_content envelope for tool capture using the
 * dedicated ``tool_input`` / ``tool_output`` columns (migration
 * 000021). Mirrors the sensor's ``_build_tool_capture_content``
 * wire shape byte-for-byte so the worker's ``InsertEventContent``
 * consumes both surfaces uniformly.
 *
 * ``response: {}`` ships explicitly because event_content.response
 * is a NOT NULL column that predates tool capture — see the sensor
 * helper for the same constraint workaround. The
 * operationally-meaningful tool capture lives in tool_input /
 * tool_output.
 */
export function buildToolCaptureContent({
  toolInput,
  toolOutput,
  serverName,
  sessionId,
}) {
  return {
    system: null,
    messages: [],
    tools: null,
    response: {},
    input: null,
    tool_input: toolInput == null ? null : toolInput,
    tool_output: toolOutput == null ? null : toolOutput,
    provider: "mcp",
    model: serverName || "",
    session_id: sessionId,
    event_id: "",
    captured_at: new Date().toISOString(),
  };
}
