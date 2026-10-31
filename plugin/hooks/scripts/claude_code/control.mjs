// Enforcement for Claude Code sessions (ARCHITECTURE.md, Plugin >
// Enforcement). With the user's enforcement option on, a directive that
// a response carries is recorded in the session's control state; the
// PreToolUse and UserPromptSubmit gates then deny tool calls and block
// prompts of a stopped session and show the user budget notices, and the
// next regular hook sends the events the directive owes.

import { boundedToken } from "../core/config.mjs";
import { postEvent, postHeartbeat } from "../core/poster.mjs";
import { clearControlState, readControlState, updateControlState } from "../core/state.mjs";

/** argv flag of the hook entries that only gate. */
export const GATE_FLAG = "--gate";

// The gate asks the server for a pending directive when it last asked
// more than this long ago. Any event POST also returns one, so in a busy
// session the poll rarely runs; in a quiet one, a stop reaches the next
// tool call or prompt within this window.
export const GATE_POLL_IDLE_MS = 5_000;

// Directive ids remembered per session so a directive seen twice is
// applied once; the server delivers each once, so this only guards a
// replayed response.
const MAX_APPLIED_IDS = 50;

// A directive's reason and target model reach the user's terminal and the
// event stream; anything longer than this, or with control characters
// removed, is not a reason or a model id.
const MAX_DIRECTIVE_TEXT_BYTES = 128;

function directiveText(value) {
  if (typeof value !== "string") return null;
  return boundedToken(value.replace(/[\x00-\x1f\x7f]+/g, " "), MAX_DIRECTIVE_TEXT_BYTES);
}

const STOP_ACTIONS = new Set(["shutdown", "shutdown_flavor"]);
const BUDGET_EXCEEDED = "token_budget_exceeded";

/** The text a stopped session's gates show. */
export function stopMessage(reason) {
  const why = reason === BUDGET_EXCEEDED ? "this session reached its token budget" : "an operator stopped this session";
  return `Stopped by Flightdeck: ${why}.`;
}

function noticeFor(directive) {
  if (directive.action === "warn") {
    return "Flightdeck: this session crossed its token budget's warning threshold.";
  }
  const to = typeof directive.degrade_to === "string" && directive.degrade_to ? ` (${directive.degrade_to})` : "";
  return (
    "Flightdeck: this session crossed its token budget's degrade threshold. " +
    `A hook cannot change Claude Code's model; switch to a smaller one with /model${to} to make the budget last.`
  );
}

/**
 * Record ``directive``, delivered for ``sessionId``, in the session's
 * control state. A stop takes effect at once; the events it owes wait in
 * ``pending`` for a hook that can send them. Ignored with enforcement
 * off.
 */
export function recordDirective(enforcement, sessionId, directive) {
  if (!enforcement || !sessionId || typeof directive?.action !== "string") return;
  const id = directiveText(directive.id) ?? "";
  updateControlState(sessionId, (state) => {
    const applied = Array.isArray(state.applied) ? state.applied : [];
    if (id && applied.includes(id)) return state;
    const next = { ...state, applied: id ? [...applied, id].slice(-MAX_APPLIED_IDS) : applied };
    next.pending = [
      ...(Array.isArray(state.pending) ? state.pending : []),
      {
        id,
        action: directive.action,
        reason: directiveText(directive.reason) ?? "",
        degrade_to: directiveText(directive.degrade_to),
      },
    ];
    if (STOP_ACTIONS.has(directive.action) && !state.stopped) {
      next.stopped = { reason: next.pending.at(-1).reason, at: new Date().toISOString() };
    }
    if (directive.action === "warn" || directive.action === "degrade") {
      next.notices = [...(Array.isArray(state.notices) ? state.notices : []), noticeFor(next.pending.at(-1))];
    }
    return next;
  });
}

function policyDecision(decision, reason) {
  return { policy_id: "server", scope: "server", decision, reason };
}

function event(basePayload, fields) {
  return {
    ...basePayload,
    tool_name: null,
    tool_input: null,
    is_subagent_call: false,
    latency_ms: null,
    has_content: false,
    content: null,
    timestamp: new Date().toISOString(),
    ...fields,
  };
}

/** The events a recorded directive owes, in the order the sensor sends them. */
export function eventsForDirective(directive, basePayload) {
  const ack = (result) =>
    event(basePayload, {
      event_type: "directive_result",
      directive_name: directive.action,
      directive_action: directive.action,
      directive_status: "acknowledged",
      result,
    });
  switch (directive.action) {
    case "shutdown":
    case "shutdown_flavor": {
      const out = [ack({ message: "Claude Code session stopped", reason: directive.reason || "directive received" })];
      if (directive.reason === BUDGET_EXCEEDED) {
        out.push(
          event(basePayload, {
            event_type: "policy_block",
            source: "server",
            reason: directive.reason,
            policy_decision: policyDecision(
              "block",
              "Token budget exceeded (server policy); Flightdeck's gate denies the session's further tool calls and prompts",
            ),
          }),
        );
      }
      out.push(event(basePayload, { event_type: "session_end", close_reason: "directive_shutdown" }));
      return out;
    }
    case "warn":
      return [
        event(basePayload, {
          event_type: "policy_warn",
          source: "server",
          reason: directive.reason,
          policy_decision: policyDecision("warn", "Token usage crossed the warn threshold (server policy); the user was told"),
        }),
      ];
    case "degrade":
      return [
        event(basePayload, {
          event_type: "policy_degrade",
          source: "server",
          from_model: basePayload.model ?? null,
          to_model: directive.degrade_to,
          policy_decision: policyDecision(
            "degrade",
            "Token usage crossed the degrade threshold (server policy); advisory, since a hook cannot change Claude Code's model: the user was asked to switch",
          ),
        }),
        ack({ message: "advisory: Claude Code's model cannot be changed from a hook", advisory: true, to_model: directive.degrade_to }),
      ];
    case "custom":
      return [
        event(basePayload, {
          event_type: "directive_result",
          directive_name: "custom",
          directive_action: "custom",
          directive_status: "error",
          error: "custom directives are not supported by the Claude Code plugin",
        }),
      ];
    default:
      return [];
  }
}

/**
 * Send, once, the events the session's recorded directives owe. A
 * directive whose event the server did not accept goes back to
 * ``pending``, remembering the events already sent, so a later hook sends
 * the rest in order and none twice.
 */
export async function sendPendingControlEvents({ cfg, sessionId, basePayload }) {
  if (!cfg.enforcement) return;
  if (!(readControlState(sessionId).pending?.length > 0)) return;
  let taken = [];
  updateControlState(sessionId, (state) => {
    taken = Array.isArray(state.pending) ? state.pending : [];
    return { ...state, pending: [] };
  });
  const unsent = [];
  for (const directive of taken) {
    const sent = new Set(Array.isArray(directive.sent) ? directive.sent : []);
    for (const payload of eventsForDirective(directive, basePayload)) {
      if (sent.has(payload.event_type)) continue;
      if (!(await postEvent(cfg.server, cfg.token, sessionId, payload))) {
        unsent.push({ ...directive, sent: [...sent] });
        break;
      }
      sent.add(payload.event_type);
    }
  }
  if (unsent.length > 0) {
    updateControlState(sessionId, (state) => ({ ...state, pending: [...unsent, ...(state.pending ?? [])] }));
  }
}

/**
 * The gate's decision for a hook, over the control state of each of
 * ``sessionIds`` (the session, and for a subagent's hook its child
 * session): a Claude Code hook output, or null to let the call through.
 * Polls the server for a pending directive when the session has been
 * quiet. ``stopOnly`` leaves budget notices for a gate that shows them.
 */
export async function gateDecision({ cfg, hookName, sessionIds, stopOnly = false, now = Date.now() }) {
  if (!cfg.enforcement) return null;
  const ids = sessionIds.filter(Boolean);
  const stopped = () => ids.map((id) => readControlState(id).stopped).find(Boolean);
  if (!stopped()) {
    for (const id of ids) {
      const last = Date.parse(readControlState(id).lastPollAt ?? "") || 0;
      if (now - last < GATE_POLL_IDLE_MS) continue;
      updateControlState(id, (state) => ({ ...state, lastPollAt: new Date(now).toISOString() }));
      await postHeartbeat(cfg.server, cfg.token, id);
    }
  }
  const stop = stopped();
  if (stop) {
    const message = stopMessage(stop.reason);
    if (hookName === "UserPromptSubmit") return { decision: "block", reason: message };
    return {
      continue: false,
      stopReason: message,
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: message },
    };
  }
  if (stopOnly) return null;
  const notices = [];
  for (const id of ids) {
    if (!(readControlState(id).notices?.length > 0)) continue;
    updateControlState(id, (state) => {
      notices.push(...(Array.isArray(state.notices) ? state.notices : []));
      return { ...state, notices: [] };
    });
  }
  return notices.length > 0 ? { systemMessage: notices.join("\n") } : null;
}

/**
 * At the session's end (the SessionEnd worker): send what its directives
 * still owe and drop its control state. Returns true when a directive
 * stopped the session, whose session_end (close_reason
 * directive_shutdown) the stop's own events carry, so the caller sends
 * no other.
 */
export async function finishControl({ cfg, sessionId, basePayload }) {
  if (!cfg.enforcement) return false;
  await sendPendingControlEvents({ cfg, sessionId, basePayload });
  const stopped = Boolean(readControlState(sessionId).stopped);
  clearControlState(sessionId);
  return stopped;
}
