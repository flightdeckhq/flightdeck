// Claude Code subagents: the child session SubagentStart /
// SubagentStop open and close, interior-hook routing onto that child,
// and the size-routed capture of the messages between parent and child.

import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { deriveAgentId, NAMESPACE_FLIGHTDECK } from "../agent_id.mjs";
import { PLUGIN_VERSION } from "../core/config.mjs";
import { postEvent } from "../core/poster.mjs";
import { claimSessionStart, isSessionStarted, markSessionStarted, releaseSessionStart } from "../core/state.mjs";
import { uuid5 } from "../uuid5.mjs";
import { finishControl } from "./control.mjs";
import { flushPostCallTurns } from "./post_call.mjs";
import { readTurns } from "./transcript.mjs";

// ---------------------------------------------------------------------
// SubagentStart / SubagentStop emission.
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
//   * ``agent_id`` (``tool_use_id`` on older versions) — a stable
//     correlator for THIS specific Task invocation; SubagentStop
//     carries the same value
//   * on older versions only, ``tool_input.prompt`` (the parent's
//     input to the subagent) and, on SubagentStop, ``tool_response``
//     (its response back); current versions send neither, so
//     subagentIncomingMessage / subagentOutgoingMessage read them from
//     the subagent's transcript and meta file
//
// We emit a CHILD session_start (or session_end) whose ``session_id``
// is a deterministic uuid5 derived from
// ``(outer_session_id, tool_use_id)`` so SubagentStart and the
// matching SubagentStop produce the same child id without any
// disk-marker plumbing. ``parent_session_id`` carries the outer
// session's id so the worker writes the relationship column.
// ``agent_role`` joins the agent_id derivation as the conditional
// 6th input — same uuid the Python sensor produces for
// a parent / role pair on the same identity 5-tuple.
//
// SubagentStop is the canonical child end-of-life signal.
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

// Derive the subagent's per-execution transcript path from
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

// Interior-event routing for Claude Code subagents.
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
// Using the parent's session_id for these interior events would
// leave the child session row empty in the dashboard while the
// parent collected the subagent's tool calls and LLM turns. The
// playground/14 synthetic harness cannot catch that regression
// because it never simulates the SubagentStart →
// interior-PostToolUse → SubagentStop sequence (it fires the
// boundary events alone); only a real Claude Code run exercises it.
//
// Returns null when the hook is NOT in subagent context (parent's
// own event); returns a context object with the remapped child
// identity when it IS. The caller (dispatchHookEvent) overlays the returned
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

// Sub-agent message routing thresholds. Mirror the
// constants in sensor/flightdeck_sensor/core/session.py so the
// plugin and Python sensor produce identical wire shapes for
// equivalent body sizes — same inline / overflow / hard-reject
// boundaries.
//
// Bodies up to SUBAGENT_INLINE_THRESHOLD_BYTES ride inline on the
// payload's ``incoming_message`` / ``outgoing_message`` field;
// bodies above the threshold but at or below SUBAGENT_HARD_CAP_BYTES
// route through the existing event_content path
// (has_content=true on the event, full body on payload.content
// in the PromptContent envelope shape the worker's
// InsertEventContent expects); bodies above the hard cap are
// dropped with a stderr WARN.
const SUBAGENT_INLINE_THRESHOLD_BYTES = 8 * 1024;
const SUBAGENT_HARD_CAP_BYTES = 2 * 1024 * 1024;
const SUBAGENT_OVERFLOW_PROVIDER = "flightdeck-subagent";

/**
 * Resolve a sub-agent message into ``{stubOrInline, contentEnvelope}``
 * by body size. Mirrors :py:meth:`Session._route_subagent_message`
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
        `bytes); dropped.\n`,
    );
    return { stubOrInline: null, contentEnvelope: null };
  }
  if (size <= SUBAGENT_INLINE_THRESHOLD_BYTES) {
    return {
      stubOrInline: { body, captured_at: capturedAt },
      contentEnvelope: null,
    };
  }
  // Overflow → event_content via the existing prompt-capture path. The
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

// How long SubagentStart waits for Claude Code to write the subagent's
// transcript and meta file. Claude Code writes both before the
// asynchronous hook runs, so the wait covers a slow disk only; it stays
// short because the child's session_start waits behind it.
export const SUBAGENT_FILES_WAIT_MS = 1000;
const SUBAGENT_FILES_POLL_MS = 50;

// How much of the parent transcript's end SubagentStart searches for the
// Agent call that launched the subagent. The call is the parent's latest
// turn when the hook runs, so the tail holds it; reading only the tail
// keeps a long session's multi-megabyte transcript off this path.
export const PARENT_TAIL_BYTES = 4 * 1024 * 1024;

/** The lines of a JSONL file, or of its last ``maxBytes`` when given. */
function readLines(path, maxBytes = Infinity) {
  if (!path) return [];
  let raw;
  try {
    if (maxBytes === Infinity) {
      raw = readFileSync(path, "utf8");
    } else {
      const fd = openSync(path, "r");
      try {
        const size = fstatSync(fd).size;
        const length = Math.min(size, maxBytes);
        const buffer = Buffer.alloc(length);
        readSync(fd, buffer, 0, length, size - length);
        raw = buffer.toString("utf8");
      } finally {
        closeSync(fd);
      }
    }
  } catch {
    return [];
  }
  return raw.split("\n").filter((line) => line.length > 0);
}

/** A JSONL line parsed, or null for a partly written or cut line. */
function parseLine(line) {
  try {
    const record = JSON.parse(line);
    return record && typeof record === "object" ? record : null;
  } catch {
    return null;
  }
}

function readRecords(path) {
  return readLines(path).map(parseLine).filter((record) => record !== null);
}

/** The meta file Claude Code writes beside a subagent's transcript. */
export function _subagentMetaPath(subagentTranscript) {
  return subagentTranscript.replace(/\.jsonl$/i, ".meta.json");
}

function readSubagentMeta(subagentTranscript) {
  if (!subagentTranscript) return null;
  try {
    const meta = JSON.parse(readFileSync(_subagentMetaPath(subagentTranscript), "utf8"));
    return meta && typeof meta === "object" && !Array.isArray(meta) ? meta : null;
  } catch {
    return null;
  }
}

function contentBlocks(record) {
  const content = record?.message?.content;
  return Array.isArray(content) ? content : [];
}

function hasToolUse(record, toolUseId) {
  return contentBlocks(record).some((block) => block?.type === "tool_use" && block.id === toolUseId);
}

/** The ``prompt`` input of the tool call ``toolUseId`` in ``record``. */
function toolUsePrompt(record, toolUseId) {
  for (const block of contentBlocks(record)) {
    if (block?.type === "tool_use" && block.id === toolUseId && typeof block.input?.prompt === "string") {
      return block.input.prompt;
    }
  }
  return null;
}

/** Whether a subagent is a fork, which starts from the parent's history. */
export function isForkSubagent(role, subagentTranscript) {
  return role === "fork" || readSubagentMeta(subagentTranscript)?.isFork === true;
}

/** The message ids of the parent transcript's assistant turns. */
export function parentMessageIds(parentTranscript) {
  const ids = new Set();
  for (const line of readLines(parentTranscript)) {
    if (!line.includes('"assistant"')) continue;
    const record = parseLine(line);
    if (record?.type === "assistant" && typeof record.message?.id === "string") ids.add(record.message.id);
  }
  return ids;
}

/**
 * The message ids of a fork's copied history: every assistant record up
 * to and including the parent's Agent call that launched it (the meta
 * file's ``toolUseId``), which ends the copy. Without a meta file, the
 * ids its transcript shares with the parent's.
 */
function copiedMessageIds(subagentRecords, subagentTranscript, parentTranscript) {
  const toolUseId = readSubagentMeta(subagentTranscript)?.toolUseId;
  const end = typeof toolUseId === "string" ? subagentRecords.findLastIndex((r) => hasToolUse(r, toolUseId)) : -1;
  if (end >= 0) {
    const ids = new Set();
    for (const record of subagentRecords.slice(0, end + 1)) {
      if (record.type === "assistant" && typeof record.message?.id === "string") ids.add(record.message.id);
    }
    return ids;
  }
  return parentMessageIds(parentTranscript);
}

/**
 * The turns of a subagent's transcript that are its own. A fork's
 * transcript starts with a copy of the parent's history, which repeats
 * the parent's turns under their message ids; those are the parent's
 * to report.
 */
export function ownSubagentTurns(turns, { role, subagentTranscript, parentTranscript }) {
  if (!isForkSubagent(role, subagentTranscript)) return turns;
  const copied = copiedMessageIds(readRecords(subagentTranscript), subagentTranscript, parentTranscript);
  return turns.filter((turn) => !copied.has(turn.messageId));
}

/** Wait, up to SUBAGENT_FILES_WAIT_MS, for the subagent's transcript and meta file. */
export async function waitForSubagentFiles(subagentTranscript) {
  const deadline = Date.now() + SUBAGENT_FILES_WAIT_MS;
  while (!(existsSync(subagentTranscript) && existsSync(_subagentMetaPath(subagentTranscript)))) {
    if (Date.now() >= deadline) return;
    await new Promise((resolve) => setTimeout(resolve, SUBAGENT_FILES_POLL_MS));
  }
}

/** The ``prompt`` of the Agent call ``toolUseId`` in the parent transcript's tail. */
function parentToolUsePrompt(parentTranscript, toolUseId) {
  const lines = readLines(parentTranscript, PARENT_TAIL_BYTES);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes(toolUseId)) continue;
    const prompt = toolUsePrompt(parseLine(lines[i]), toolUseId);
    if (prompt !== null) return prompt;
  }
  return null;
}

/**
 * The prompt the parent gave a subagent: the hook's own
 * ``tool_input.prompt`` (older Claude Code), else the ``prompt`` of the
 * Agent tool call the meta file names, else (not for a fork, whose
 * transcript opens with the parent's history) the subagent transcript's
 * first user message given as a string.
 */
export function subagentIncomingMessage({ hookEvent, subagentTranscript, parentTranscript, role }) {
  const legacy = hookEvent?.tool_input?.prompt;
  if (typeof legacy === "string") return legacy;
  if (!subagentTranscript) return null;
  const records = readRecords(subagentTranscript);
  const toolUseId = readSubagentMeta(subagentTranscript)?.toolUseId;
  if (typeof toolUseId === "string") {
    for (const record of records) {
      const prompt = toolUsePrompt(record, toolUseId);
      if (prompt !== null) return prompt;
    }
    const prompt = parentToolUsePrompt(parentTranscript, toolUseId);
    if (prompt !== null) return prompt;
  }
  if (isForkSubagent(role, subagentTranscript)) return null;
  for (const record of records) {
    if (record.type === "user" && typeof record.message?.content === "string") return record.message.content;
  }
  return null;
}

/** The text of the last assistant message in ``records``, its blocks joined. */
function lastAssistantText(records) {
  for (let i = records.length - 1; i >= 0; i--) {
    const id = records[i].message?.id;
    const group = id ? records.filter((r) => r.message?.id === id) : [records[i]];
    const text = group
      .flatMap(contentBlocks)
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n");
    if (text.trim() !== "") return text;
  }
  return null;
}

/**
 * A subagent's report back to its parent: the hook's own
 * ``tool_response`` (older Claude Code), else the ``message`` of its
 * last SubagentHandback call, else the hook's
 * ``last_assistant_message``, else its last assistant message's text.
 * A fork's copied history is not the subagent's.
 */
export function subagentOutgoingMessage({ hookEvent, subagentTranscript, parentTranscript, role }) {
  if (hookEvent?.tool_response != null) return hookEvent.tool_response;
  const records = readRecords(subagentTranscript);
  const copied = isForkSubagent(role, subagentTranscript)
    ? copiedMessageIds(records, subagentTranscript, parentTranscript)
    : new Set();
  const own = records.filter((record) => record.type === "assistant" && !copied.has(record.message?.id));
  for (let i = own.length - 1; i >= 0; i--) {
    for (const block of contentBlocks(own[i])) {
      const message = block?.input?.message;
      if (block?.type === "tool_use" && block.name === "SubagentHandback" && typeof message === "string" && message.trim() !== "") {
        return message;
      }
    }
  }
  const last = hookEvent?.last_assistant_message;
  if (typeof last === "string" && last.trim() !== "") return last;
  return lastAssistantText(own);
}

export async function emitSubagentEvent({
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
  // Match the parent session_start contract: ingestion requires
  // sensor_version on every session_start. Sub-agent session_start
  // emits the same field so the wire contract holds; session_end
  // doesn't need it but having the field doesn't break anything.
  if (hookName === "SubagentStart") {
    payload.sensor_version = PLUGIN_VERSION;
    // Declare capture posture so the worker enforces it server-side
    // for the child session too (parity with the parent session_start).
    payload.capture_prompts = cfg.capturePrompts;
  }

  // Sub-agent message routing. Body size decides
  // whether the message lives inline on payload (≤ 8 KiB) or rides
  // through the existing event_content path (> 8 KiB and ≤ 2
  // MiB). _routeSubagentMessage handles capture-off + hard-cap
  // rejection inline; here we just stamp whatever it returns.
  if (hookName === "SubagentStart") {
    let promptBody = null;
    if (cfg.capturePrompts) {
      const subagentTranscript = _subagentTranscriptPath(hookEvent.transcript_path, correlator);
      if (typeof hookEvent.tool_input?.prompt !== "string" && subagentTranscript) {
        await waitForSubagentFiles(subagentTranscript);
      }
      promptBody = subagentIncomingMessage({
        hookEvent,
        subagentTranscript,
        parentTranscript: hookEvent.transcript_path,
        role,
      });
    }
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
    //      back to the parent (cross-agent message capture).
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
          turns: ownSubagentTurns(readTurns(subagentTranscript), {
            role,
            subagentTranscript,
            parentTranscript: hookEvent.transcript_path,
          }),
          capturePrompts: cfg.capturePrompts,
        });
      } catch (err) {
        // Transcript-read failures are not fatal — we still emit
        // the session_end so the child session closes cleanly. The
        // missing post_calls just means the subagent's final turn
        // won't show in the dashboard; the worker's lazy-create
        // path still tracks the session itself.
        process.stderr.write(
          `flightdeck: SubagentStop transcript flush failed for ` +
            `${childSessionId}: ${err?.message || err}\n`,
        );
      }
    }
    const report = cfg.capturePrompts
      ? subagentOutgoingMessage({
          hookEvent,
          subagentTranscript,
          parentTranscript: hookEvent.transcript_path,
          role,
        })
      : null;
    const { stubOrInline, contentEnvelope } = _routeSubagentMessage(report, cfg.capturePrompts, "outgoing");
    if (stubOrInline) payload.outgoing_message = stubOrInline;
    if (contentEnvelope) {
      payload.has_content = true;
      payload.content = contentEnvelope;
    }
  }

  if (hookName !== "SubagentStart") {
    // A subagent a directive stopped has ended with that stop's own
    // session_end; send what it still owes and drop its control state.
    const childBase = {
      ...basePayload,
      session_id: childSessionId,
      parent_session_id: outerSessionId,
      agent_role: role || null,
      agent_id: childAgentId,
      agent_name: childAgentName,
    };
    if (await finishControl({ cfg, sessionId: childSessionId, basePayload: childBase })) return;
    await postEvent(cfg.server, cfg.token, childSessionId, payload);
    return;
  }
  // The child's session_start goes through the same claim and marker as
  // any other, so the child's interior hooks do not send another one.
  if (isSessionStarted(childSessionId) || !claimSessionStart(childSessionId)) return;
  try {
    if (await postEvent(cfg.server, cfg.token, childSessionId, payload)) markSessionStarted(childSessionId);
  } finally {
    releaseSessionStart(childSessionId);
  }
}
