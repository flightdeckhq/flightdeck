// Claude Code's JSONL transcript: the per-call turns (model, usage,
// content, timing) the hooks themselves do not carry.

import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------
// Transcript reader. Pulls the final LLM turn out of Claude Code's
// JSONL transcript so post_call events carry real tokens + model.
// ---------------------------------------------------------------------

// Claude Code stamps ``model: "<synthetic>"`` on assistant records it
// synthesises into the transcript itself — tool-result coordination
// turns, internal Agent SDK orchestration messages, etc. — that did
// not originate from a real LLM call. Forwarding that literal as the
// pre_call / post_call model name pollutes the events table (the
// model facet ends up with a ``<synthetic>`` bucket) and breaks
// downstream provider detection. The constant is exported so the
// test suite can verify the skip without re-spelling the literal.
export const SYNTHETIC_MODEL = "<synthetic>";

/**
 * Returns ``true`` when ``model`` is a usable LLM identifier — i.e.,
 * non-empty AND not Claude Code's synthetic-turn sentinel. Callers
 * use this when picking the most recent ``message.model`` out of a
 * transcript: synthetic-turn records are skipped in favour of the
 * preceding real assistant turn (or the cached SessionStart model).
 */
export function isRealModel(model) {
  return Boolean(model) && model !== SYNTHETIC_MODEL;
}

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
      // Synthetic-turn records (model="<synthetic>", no real LLM
      // call) must never set the group's model. Real turns can land
      // in any order relative to the synthetic ones in the same
      // message-id group; ``isRealModel`` is the gate so a synthetic
      // record arriving first does not poison the bucket. A later
      // real record can still upgrade ``model`` once the gate
      // passes.
      const recModel = rec.message?.model;
      let group = groups.get(messageId);
      if (!group) {
        group = {
          messageId,
          model: isRealModel(recModel) ? recModel : null,
          firstTimestamp: rec.timestamp,
          lastTimestamp: rec.timestamp,
          usage: rec.message?.usage || null,
          contentBlocks: [],
          userAtStart: lastUser,
        };
        groups.set(messageId, group);
        groupOrder.push(messageId);
      } else if (!isRealModel(group.model) && isRealModel(recModel)) {
        group.model = recModel;
      }
      group.lastTimestamp = rec.timestamp || group.lastTimestamp;
      if (rec.message?.usage) group.usage = rec.message.usage;
      if (typeof rec.message?.stop_reason === "string" && rec.message.stop_reason) {
        group.stopReason = rec.message.stop_reason;
      }
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
      stopReason: group.stopReason || null,
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
 * Python sensor's AnthropicProvider semantics:
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
