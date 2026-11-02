// Helpers for deciding whether a session can accept directives.
//
// The Python sensor intercepts every LLM call and polls for directives
// on each call -- shutdown, warn, degrade, custom handlers all flow
// back through the response envelope. Hook-based clients observe tool
// lifecycle events and never sit in the agent's execution path, so
// they cannot be interrupted by a directive. Each client type's
// registry entry says which kind it is (CLIENT_TYPE_META), and a
// session can override that with ``context.supports_directives``.

import type { Session } from "@/lib/types";
import { CLIENT_TYPE_META, isClientType } from "@/lib/agent-identity";
import { isClaudeCodeSession } from "@/lib/models";

/**
 * True when the session can receive and act on a directive:
 *
 *   1. its ``context.supports_directives``, when the session set it;
 *   2. otherwise its ``client_type``'s registry default;
 *   3. otherwise (no ``client_type``, as on a parent-stub row) false
 *      when the flavor or framework tag marks a Claude Code session,
 *      so an old plugin row never regains a Stop button, and true for
 *      anything else.
 */
export function sessionSupportsDirectives(session: {
  flavor?: string;
  client_type?: string | null;
  context?: Record<string, unknown>;
}): boolean {
  const flag = session.context?.supports_directives;
  if (typeof flag === "boolean") return flag;
  if (isClientType(session.client_type)) {
    return CLIENT_TYPE_META[session.client_type].supportsDirectives;
  }
  return !isClaudeCodeSession(session);
}

/**
 * True when the session runs custom directive handlers: it can act on
 * a directive at all (``sessionSupportsDirectives``) AND its client
 * type runs custom handlers (the registry's ``runsCustomDirectives``,
 * only the sensor today). A Claude Code plugin session with
 * enforcement on, or an Agent SDK run, takes stop and budget
 * directives but answers a custom one with an error, so offering it
 * one would be a dead end. A row with no ``client_type`` falls back as
 * ``sessionSupportsDirectives`` does: such rows predate the registry
 * and are sensor rows unless their flavor or framework marks Claude
 * Code.
 */
export function sessionRunsCustomDirectives(session: {
  flavor?: string;
  client_type?: string | null;
  context?: Record<string, unknown>;
}): boolean {
  if (!sessionSupportsDirectives(session)) return false;
  if (isClientType(session.client_type)) {
    return CLIENT_TYPE_META[session.client_type].runsCustomDirectives;
  }
  return !isClaudeCodeSession(session);
}

/** The "live" (active or idle) sessions a directive can still reach. */
function liveSessions(sessions: Session[]): Session[] {
  return sessions.filter((s) => s.state === "active" || s.state === "idle");
}

/**
 * True when at least one "live" (active or idle) session in the flavor
 * supports directives. Used by the Fleet sidebar to decide whether to
 * render the Stop All button. A mixed agent -- some sensor sessions,
 * some Claude Code sessions -- keeps the button because the stop still
 * reaches the sensor sessions.
 */
export function flavorHasDirectiveCapableSession(sessions: Session[]): boolean {
  return liveSessions(sessions).some(sessionSupportsDirectives);
}

/** The live sessions in ``sessions`` that can act on a stop. Stop All
 *  asks the API to stop every such run of the agent, and marks the ones
 *  the page holds as shutting down. */
export function stoppableSessions(sessions: Session[]): Session[] {
  return liveSessions(sessions).filter(sessionSupportsDirectives);
}

/**
 * True when at least one live (active or idle) session runs custom
 * directive handlers. The Fleet sidebar's directive trigger needs one:
 * a directive sent from the row reaches only the agent's live runs.
 */
export function hasLiveCustomDirectiveSession(sessions: Session[]): boolean {
  return liveSessions(sessions).some(sessionRunsCustomDirectives);
}

/** "1 run" / "3 runs": how many runs a directive reached. */
export function runCountLabel(count: number): string {
  return `${count} ${count === 1 ? "run" : "runs"}`;
}
