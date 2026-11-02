// post_call emission from the transcript: the session's billing
// endpoint, per-turn token and cost fields, the pre_call model, and
// the deduplicated flush of every transcript turn not yet sent.

import { NAMESPACE_FLIGHTDECK } from "../agent_id.mjs";
import {
  BILLING_MODES,
  detectEndpoint,
  fitsDetailString,
  readAuthStatus,
  usageDetailFields,
} from "../billing.mjs";
import { sendEvent } from "../core/poster.mjs";
import {
  cacheSessionModel,
  isTurnEmitted,
  markEmittedTurn,
  markTurnRefused,
  markTurnSent,
  readCachedModel,
  readModelSwitch,
  reclaimOrphanedTurn,
  readEndpointCache,
  releaseTurnClaim,
  writeEndpointCache,
} from "../core/state.mjs";
import { uuid5 } from "../uuid5.mjs";
import { computeLatencyMs, isRealModel, readLatestTurn, tokensFromUsage } from "./transcript.mjs";

// ---------------------------------------------------------------------
// Session endpoint -- the billing mode, platform and Vertex AI scope
// SessionStart decides (see billing.mjs), cached in core/state.mjs so
// every later hook stamps them without running `claude auth status`
// again.
// ---------------------------------------------------------------------

// How many hooks of one session may run `claude auth status` while it
// keeps failing. A failure is usually transient (the CLI busy updating,
// a slow start), so one later hook retries; past that the environment
// fallback stands, and later hooks never wait on the CLI again.
export const MAX_AUTH_PROBES = 2;

/**
 * The session's endpoint. SessionStart (``refresh``) decides it afresh,
 * so a resumed session or a new login is picked up; later hooks read the
 * cache. A decision the CLI or an explicit FLIGHTDECK_BILLING_MODE
 * settled is final; one that fell back to the environment because the
 * CLI failed is retried by the next hook, up to MAX_AUTH_PROBES runs.
 * ``probe`` is injectable for tests. Never throws.
 */
export function resolveSessionEndpoint(
  sessionId,
  { env = process.env, probe = readAuthStatus, refresh = false } = {},
) {
  let cached = readEndpointCache(sessionId);
  const valid =
    cached && typeof cached.billingMode === "string" && typeof cached.platform === "string";
  if (!valid) cached = null;
  if (!refresh && cached && (cached.final || (cached.probes || 0) >= MAX_AUTH_PROBES)) {
    return endpointOf(cached);
  }
  // An explicit FLIGHTDECK_BILLING_MODE settles the billing mode, and the
  // cloud provider is read from the same CLAUDE_CODE_USE_* variables
  // Claude Code itself uses, so the CLI is not run.
  const override = BILLING_MODES.has((env.FLIGHTDECK_BILLING_MODE || "").trim().toLowerCase());
  const status = override ? null : probe(undefined, env);
  // A refresh whose probe fails keeps a decision an earlier probe made,
  // rather than replace it with the environment fallback.
  if (refresh && !override && status === null && cached?.final) {
    return endpointOf(cached);
  }
  const endpoint = detectEndpoint(env, status);
  writeEndpointCache(sessionId, {
    ...endpoint,
    final: override || status !== null,
    probes: (refresh ? 0 : cached?.probes || 0) + (override ? 0 : 1),
  });
  return endpoint;
}

function endpointOf(record) {
  return {
    billingMode: record.billingMode,
    platform: record.platform,
    inferenceScope: record.inferenceScope ?? null,
  };
}

/**
 * The token, model and cost fields of one transcript turn's post_call
 * (ARCHITECTURE.md, POST /v1/events): the vendor, the session's billing
 * mode and platform, the model id (Claude Code exposes no separate
 * served id, so requested and served are the same), the API request id
 * and reasoning effort, and what the turn's usage and stop reason
 * report.
 */
export function turnTokenCostFields(turn, model, endpoint) {
  const providerMetadata = { platform: endpoint.platform };
  if (fitsDetailString(turn.requestId)) providerMetadata.request_id = turn.requestId;
  const fields = {
    provider: "anthropic",
    billing_mode: endpoint.billingMode,
    provider_metadata: providerMetadata,
    ...usageDetailFields(turn.usage || {}),
  };
  if (fitsDetailString(model)) {
    fields.model_requested = model;
    fields.model_served = model;
  }
  if (endpoint.inferenceScope) fields.inference_scope = endpoint.inferenceScope;
  if (fitsDetailString(turn.stopReason)) fields.stop_reason = turn.stopReason;
  if (fitsDetailString(turn.effort)) fields.effort = turn.effort;
  return fields;
}

/**
 * Resolve the model for the upcoming LLM turn. Prefers the most recent
 * assistant record in the transcript (captures mid-session model
 * switches), falls back to the SessionStart-cached model, and finally
 * to the hook payload itself.
 *
 * ``isRealModel`` filters each candidate so Claude Code's synthetic-
 * turn sentinel (``<synthetic>``) never propagates into a pre_call.
 * ``readTurns`` already skips synthetic records when assigning a
 * group's model, so ``latest?.model`` is non-synthetic by
 * construction — the guard here is belt-and-suspenders for cached
 * and hook-payload fallbacks, both of which read external data this
 * function does not control.
 */
export function resolvePreCallModel(sessionId, hookEvent, transcriptPath) {
  const latest = readLatestTurn(transcriptPath);
  // A model switch newer than the latest turn wins: that turn still
  // names the model the session switched away from.
  const switched = readModelSwitch(sessionId);
  const switchIsNewer =
    switched !== null &&
    (!latest?.lastTimestamp || Date.parse(switched.at) > Date.parse(latest.lastTimestamp));
  const candidates = [
    switchIsNewer ? switched.model : null,
    latest?.model,
    readCachedModel(sessionId),
    hookEvent.model,
  ];
  for (const candidate of candidates) {
    if (isRealModel(candidate)) return candidate;
  }
  return null;
}

// ---------------------------------------------------------------------
// Build content payload for prompt capture. Mirrors the Python
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
// Called from Stop, StopFailure, PostToolUse, PostToolUseFailure,
// SubagentStop and the SessionEnd worker. markEmittedTurn dedup (per
// assistant message.id) keeps emission idempotent across them.
// PostToolUse flushes mid-turn so the dashboard shows LLM activity in
// real time instead of waiting for the turn to end at Stop.
//
// Delivery rules (ARCHITECTURE.md, Plugin > Subagent hooks):
//   * a turn whose POST fails is released and the flush stops there, so
//     the next flush sends it, and the turns after it, in order;
//   * a turn ingestion refuses as invalid is never retried, so it cannot
//     hold back the turns after it (refusedForGood);
//   * a turn is sent only under the session that was current when it
//     ran: with ``notBefore`` (the mint time of the session the flush
//     reports under) an earlier turn is not sent, and with ``notAfter``
//     (the mint time of a later session that has taken the conversation
//     over) neither is a turn at or after it.
// ---------------------------------------------------------------------

/**
 * True when ``turn`` ran before ``notBefore`` (epoch milliseconds). A
 * turn whose time the transcript does not give is taken as current.
 */
export function ranBefore(turn, notBefore) {
  if (notBefore == null) return false;
  const at = Date.parse(turn.lastTimestamp);
  return Number.isFinite(at) && at < notBefore;
}

/** True when ``turn`` ran at or after ``notAfter``; an unknown time is taken as before it. */
export function ranAtOrAfter(turn, notAfter) {
  if (notAfter == null) return false;
  const at = Date.parse(turn.lastTimestamp);
  return Number.isFinite(at) && at >= notAfter;
}

/**
 * Read a transcript's turns (``read()``) between two looks at the
 * conversation's marker (``laterMint()``, see laterSessionMint), and
 * return them with ``notAfter``, the earliest mint of a later session
 * either look found. A session's marker is written before any of its
 * turns, so a later session minted while the transcript was read is seen
 * by the second look before any of its turns can be in what was read.
 */
export function readTurnsBounded(read, laterMint = null) {
  const before = laterMint ? laterMint() : null;
  const turns = read();
  const after = laterMint ? laterMint() : null;
  const found = [before, after].filter((t) => t != null);
  return { turns, notAfter: found.length > 0 ? Math.min(...found) : null };
}

// How far in the past ingestion accepts an event's timestamp (its
// maxClockSkewPast). Ingestion answers an event outside its clock-skew
// window with one error, too old or too far in the future alike: an event
// younger than this was refused because the clocks disagree, and is
// accepted once they agree, so it is retried; an older one never will be.
export const INGESTION_MAX_PAST_MS = 48 * 60 * 60 * 1000;

/**
 * Whether the server refused an event (``sent``, from sendEvent) dated
 * ``timestamp`` for good: ingestion refused it as invalid, and not for a
 * clock-skew window the event is still inside of on this clock.
 */
export function refusedForGood(sent, timestamp, now = Date.now()) {
  if (sent.accepted || sent.retryable) return false;
  if (!sent.clockSkew) return true;
  const at = Date.parse(timestamp);
  return Number.isFinite(at) && now - at > INGESTION_MAX_PAST_MS;
}

/**
 * The event id of the ``post_call`` for one model call, derived from the
 * provider's message id. Every copy of the same call carries the same id
 * (a hook that re-reads the transcript after a reboot cleared the sent
 * markers sends it again), and the worker stores an event id once, so a
 * call is counted once.
 */
export function postCallEventId(messageId) {
  return uuid5(NAMESPACE_FLIGHTDECK, `flightdeck://claude-code/post_call/${messageId}`);
}

// A hook starts no new transcript-turn POST after this long and leaves
// the rest to a later hook, which reads the same transcript. Claude Code
// does not enforce a timeout on an async hook, so this is what bounds a
// backlog flush against a dead server (2 s per turn otherwise). It
// gates when each POST starts, so a hook can run a few seconds past it.
export const HOOK_FLUSH_DEADLINE_MS = 25000;

/** The deadline a hook's flush uses when its caller sets none. */
export function defaultFlushDeadline(now = Date.now()) {
  return now + HOOK_FLUSH_DEADLINE_MS;
}

/**
 * Send a post_call for every turn of ``turns`` no hook has sent. Returns
 * ``{complete, failed}``: ``complete`` when every turn in scope was sent,
 * refused or left to a live claimant; ``failed`` when a POST failed and
 * the flush stopped there (the deadline stops it without ``failed``).
 * ``notBefore`` is the mint time of the session the flush reports under,
 * null when it recorded none, and ``notAfter`` the mint time of a later
 * session that has taken the conversation over (readTurnsBounded), null
 * when there is none; ``reclaimOrphaned`` takes over the claims of hooks
 * that died before confirming their turn.
 */
export async function flushPostCallTurns({
  cfg,
  sessionId,
  basePayload,
  turns,
  capturePrompts,
  deadline = defaultFlushDeadline(),
  reclaimOrphaned = false,
  notBefore = null,
  notAfter = null,
}) {
  let seen = 0;
  // The conversation's running token total through each turn: the
  // client-side tokens_used_session, as the sensor sends its own.
  let usedSoFar = 0;
  // Turns from before the session that no marker shows as sent.
  let skippedOlder = 0;
  const finish = (result) => {
    if (skippedOlder > 0) {
      process.stderr.write(
        `flightdeck: ${skippedOlder} transcript turn(s) older than this session were not sent; ` +
          "a turn is reported only under the session it ran in.\n",
      );
    }
    return result;
  };
  for (const turn of turns) {
    seen += 1;
    if (!turn.synthetic) usedSoFar += tokensFromUsage(turn.usage).tokens_total;
    // Past the deadline an orphaned backlog against a dead server stops
    // instead of paying one aborted POST per turn. The detached
    // SessionEnd worker passes its own, shorter deadline.
    if (deadline !== null && Date.now() > deadline) {
      // Count only the turns no hook has emitted yet; turns Stop or
      // PostToolUse already flushed are not lost.
      const unflushed = turns
        .slice(seen - 1)
        .filter(
          (t) =>
            !t.synthetic && !ranBefore(t, notBefore) && !ranAtOrAfter(t, notAfter) && !isTurnEmitted(t.messageId),
        ).length;
      process.stderr.write(
        `flightdeck: transcript flush deadline reached; ${unflushed} transcript turn(s) left unflushed.\n`,
      );
      return finish({ complete: false, failed: false });
    }
    // Claude Code writes a failed or interrupted turn as a synthetic
    // assistant record with no usage; it is not a model call. A failed
    // one is reported by StopFailure as an llm_error.
    if (turn.synthetic) continue;
    if (ranBefore(turn, notBefore)) {
      if (!isTurnEmitted(turn.messageId)) skippedOlder += 1;
      continue;
    }
    // A turn of the later session that has taken the conversation over:
    // that session's own hooks send it.
    if (ranAtOrAfter(turn, notAfter)) continue;
    if (!markEmittedTurn(turn.messageId)) {
      // Claimed by another hook. Only SubagentStop and the SessionEnd
      // worker take over a claim, and only one whose process is gone.
      if (!(reclaimOrphaned && reclaimOrphanedTurn(turn.messageId))) continue;
    }
    const tokens = tokensFromUsage(turn.usage);
    const latencyMs = computeLatencyMs(turn.userTurn, turn.lastTimestamp);
    const hasContent = capturePrompts;
    const content = hasContent ? buildContent(turn) : null;
    // Both sources are already synthetic-filtered (``readTurns``
    // skips synthetic records when assigning a group's model;
    // ``basePayload.model`` is gated by ``isRealModel`` at
    // construction). Leave the fallback chain unguarded so a future
    // upstream change does not silently bypass the filter — the
    // upstream gates are the contract.
    const resolvedModel = turn.model || basePayload.model;
    cacheSessionModel(sessionId, resolvedModel);
    const sent = await sendEvent(cfg.server, cfg.token, sessionId, {
      ...basePayload,
      id: postCallEventId(turn.messageId),
      event_type: "post_call",
      model: resolvedModel,
      tool_name: null,
      tool_input: null,
      is_subagent_call: false,
      latency_ms: latencyMs,
      timestamp: turn.lastTimestamp || new Date().toISOString(),
      ...tokens,
      tokens_used_session: usedSoFar,
      // A subagent runs in its parent's Claude Code process on the same
      // login, so its calls are billed as the parent session's are.
      ...turnTokenCostFields(turn, resolvedModel, resolveSessionEndpoint(basePayload.parent_session_id || sessionId)),
      has_content: hasContent,
      content,
    });
    if (sent.accepted) {
      markTurnSent(turn.messageId);
    } else if (refusedForGood(sent, turn.lastTimestamp)) {
      markTurnRefused(turn.messageId, sent.status);
    } else {
      // The next flush sends this turn and the ones after it, in order;
      // one failed POST per hook is all an outage costs.
      releaseTurnClaim(turn.messageId);
      return finish({ complete: false, failed: true });
    }
  }
  return finish({ complete: true, failed: false });
}
