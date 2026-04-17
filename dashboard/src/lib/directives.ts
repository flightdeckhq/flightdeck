// Helpers for deciding whether a session can accept directives.
//
// The Python sensor intercepts every LLM call and polls for directives
// on each call -- shutdown, warn, degrade, custom handlers all flow
// back through the response envelope. Hook-based plugins (Claude Code,
// Codex, Cursor, Windsurf, any future one) observe tool lifecycle
// events and never sit in the agent's execution path, so they cannot
// be interrupted by a directive. The plugin payload marks this by
// setting ``context.supports_directives = false`` on session_start;
// unset is treated as true so every pre-existing sensor session keeps
// its kill switch.

import type { Session } from "@/lib/types";

/**
 * True when the session can receive and act on a directive. Hook-based
 * plugins set ``context.supports_directives: false``; the Python sensor
 * does not set the field at all, so we default to true.
 */
export function sessionSupportsDirectives(session: {
  context?: Record<string, unknown>;
}): boolean {
  const ctx = session.context;
  if (!ctx) return true;
  return ctx.supports_directives !== false;
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
