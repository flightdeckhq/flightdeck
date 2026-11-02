// Delivery of Claude Code tool events (tool_call, mcp_tool_call): the
// owed record a hook keeps from before its POST until the server has
// answered, and the rebuild of an event whose POST failed from that
// record and the transcript (ARCHITECTURE.md, Plugin > Tool calls and
// failures).
//
// The record holds only what the hook alone knows and no content: the
// tool's input, its result and a failure's error text are read back from
// the transcript's tool_use / tool_result records, under the same
// capture rules as the hook's own event. Only an event a hook tried to
// send is rebuilt: a tool use no hook reported (a denied permission, a
// hook Claude Code cancelled before it ran) has no record.

import { postEvent, sendEvent } from "../core/poster.mjs";
import {
  dropOwedToolCall,
  oweToolCall,
  readOwedToolCalls,
  releaseOwedToolCall,
  takeOwedToolCall,
} from "../core/state.mjs";
import { buildMcpToolCallPayload, resolveMcpToolIdentity } from "./mcp.mjs";
import { refusedForGood } from "./post_call.mjs";
import { buildToolCallPayload } from "./tools.mjs";
import { readToolUses } from "./transcript.mjs";

const TOOL_EVENT_TYPES = new Set(["tool_call", "mcp_tool_call"]);
const TOOL_HOOKS = new Set(["PostToolUse", "PostToolUseFailure"]);

/**
 * The owed record of a tool event a hook built: the fields only the hook
 * knows, and the transcript its content is read back from.
 */
export function owedToolCallEntry({ payload, hookName, hookEvent, toolName, transcriptPath }) {
  return {
    eventType: payload.event_type,
    toolName,
    hook: hookName,
    durationMs: typeof payload.duration_ms === "number" ? payload.duration_ms : null,
    interrupted: typeof hookEvent.is_interrupt === "boolean" ? hookEvent.is_interrupt : null,
    mcpServer: payload.mcp_server ?? null,
    transport: payload.event_type === "mcp_tool_call" ? (payload.transport ?? null) : null,
    at: payload.timestamp,
    transcript: typeof transcriptPath === "string" && transcriptPath ? transcriptPath : null,
  };
}

/**
 * POST a tool event a hook built. An event that carries a tool_use_id is
 * owed from before its POST until the server has answered, so a failed
 * POST (or a hook killed mid-way) leaves it for a later flush to rebuild;
 * one without is sent once, as before. Returns whether the server
 * accepted it.
 */
export async function sendToolEvent({ cfg, sessionId, payload, entry }) {
  const toolUseId = payload.tool_use_id;
  if (!toolUseId || !entry) return postEvent(cfg.server, cfg.token, sessionId, payload);
  oweToolCall(sessionId, toolUseId, entry);
  const sent = await sendEvent(cfg.server, cfg.token, sessionId, payload);
  if (sent.accepted || refusedForGood(sent, payload.timestamp)) dropOwedToolCall(sessionId, toolUseId);
  else releaseOwedToolCall(sessionId, toolUseId);
  return sent.accepted;
}

/** The text of a tool_result's content: a string as it is, the text blocks joined. */
function resultText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function validEntry(entry) {
  return (
    TOOL_EVENT_TYPES.has(entry.eventType) &&
    TOOL_HOOKS.has(entry.hook) &&
    typeof entry.toolName === "string" &&
    entry.toolName !== "" &&
    typeof entry.at === "string" &&
    Number.isFinite(Date.parse(entry.at)) &&
    (entry.transcript === null || typeof entry.transcript === "string")
  );
}

/**
 * The hook fields of an owed tool event, read back from its record and,
 * when the transcript records the tool use, from its tool_use and
 * tool_result: what the rebuild hands the hook's own payload builder.
 */
function hookFieldsFor(toolUseId, entry, use) {
  const failed = entry.hook === "PostToolUseFailure";
  const fields = { tool_name: entry.toolName, tool_use_id: toolUseId };
  if (use?.input != null) fields.tool_input = use.input;
  if (use?.result) {
    if (failed) {
      fields.error = resultText(use.result.content);
    } else if (entry.eventType === "mcp_tool_call" && Array.isArray(use.result.content)) {
      // The CallToolResult shape the hook's tool_response has for MCP.
      fields.tool_response = { content: use.result.content };
    } else {
      fields.tool_response = resultText(use.result.content);
    }
  }
  if (typeof entry.interrupted === "boolean") fields.is_interrupt = entry.interrupted;
  if (typeof entry.durationMs === "number") fields.duration_ms = entry.durationMs;
  if (entry.mcpServer && typeof entry.mcpServer === "object") fields.mcp_server = entry.mcpServer;
  return fields;
}

/**
 * Rebuild and send the tool events ``sessionId`` owes whose POST failed
 * (or whose hook died), each from its owed record and the transcript,
 * with the id and the time the hook gave it. An event a live hook is
 * still sending is left to it. When capture needs the transcript's
 * records and they are not there yet, a regular flush leaves the event
 * for a later one; ``lastChance`` (SubagentStop, the SessionEnd worker)
 * sends it without its content. Returns ``{complete, failed}`` as
 * flushPostCallTurns does: ``failed`` once a POST failed, which stops
 * the pass.
 */
export async function sendOwedToolCalls({ cfg, sessionId, basePayload, lastChance = false, deadline = null }) {
  const toolUseIds = Object.keys(readOwedToolCalls(sessionId));
  if (toolUseIds.length === 0) return { complete: true, failed: false };
  const transcripts = new Map();
  const usesIn = (path) => {
    if (!transcripts.has(path)) transcripts.set(path, readToolUses(path));
    return transcripts.get(path);
  };
  const needsTranscript = cfg.captureToolInputs || cfg.capturePrompts;
  let complete = true;
  for (const toolUseId of toolUseIds) {
    if (deadline !== null && Date.now() > deadline) return { complete: false, failed: false };
    const entry = takeOwedToolCall(sessionId, toolUseId);
    if (!entry) {
      complete = false; // a live hook is still sending it
      continue;
    }
    if (!validEntry(entry)) {
      dropOwedToolCall(sessionId, toolUseId); // not a record this plugin wrote
      continue;
    }
    const use = entry.transcript ? usesIn(entry.transcript).get(toolUseId) : undefined;
    if (needsTranscript && !use?.result && !lastChance) {
      releaseOwedToolCall(sessionId, toolUseId);
      complete = false;
      continue;
    }
    const hookEvent = hookFieldsFor(toolUseId, entry, use);
    let payload;
    if (entry.eventType === "mcp_tool_call") {
      const mcpIdentity = resolveMcpToolIdentity(hookEvent, entry.toolName);
      if (!mcpIdentity) {
        dropOwedToolCall(sessionId, toolUseId);
        continue;
      }
      payload = buildMcpToolCallPayload({
        cfg,
        sessionId,
        basePayload,
        hookEvent,
        hookName: entry.hook,
        mcpIdentity,
        transport: typeof entry.transport === "string" ? entry.transport : null,
        timestamp: entry.at,
      });
    } else {
      payload = buildToolCallPayload({
        cfg,
        hookName: entry.hook,
        hookEvent,
        toolName: entry.toolName,
        basePayload,
        sessionId,
        timestamp: entry.at,
      });
    }
    const sent = await sendEvent(cfg.server, cfg.token, sessionId, payload);
    if (sent.accepted || refusedForGood(sent, payload.timestamp)) {
      dropOwedToolCall(sessionId, toolUseId);
      continue;
    }
    releaseOwedToolCall(sessionId, toolUseId);
    return { complete: false, failed: true };
  }
  return { complete, failed: false };
}
