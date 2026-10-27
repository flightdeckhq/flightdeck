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
 * True when at least one "live" (active or idle) session in the flavor
 * supports directives. Used by the Fleet sidebar to decide whether to
 * render the Stop All button. A mixed flavor -- some sensor sessions,
 * some Claude Code sessions -- keeps the button because the directive
 * will still affect the sensor sessions; the Claude Code sessions
 * silently ignore it.
 */
export function flavorHasDirectiveCapableSession(sessions: Session[]): boolean {
  const live = sessions.filter(
    (s) => s.state === "active" || s.state === "idle",
  );
  return live.some(sessionSupportsDirectives);
}
