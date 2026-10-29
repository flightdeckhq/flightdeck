// Claude Code session identity: the native session id Claude Code
// stamps on every hook, the Flightdeck session id resolved from it
// through the core/state.mjs marker, clearing those markers on
// SessionEnd, and the session_start backstop.

import { PLUGIN_VERSION } from "../core/config.mjs";
import { postEvent } from "../core/poster.mjs";
import {
  clearSessionMarkers,
  cwdMarkerKey,
  ephemeralSessionId,
  isSessionStarted,
  markerKeyFor,
  markSessionStarted,
  readOrCreateSessionMarker,
} from "../core/state.mjs";
import { safeCollectContext } from "./context.mjs";

// ---------------------------------------------------------------------
// Session id: uuid4 random, cached once per Claude Code invocation
// in a marker file keyed on the Claude-Code-supplied invocation id so
// every hook in the same run shares one session_id -- regardless of
// ``cd`` or whatever cwd the hook process happens to inherit.
//
// Stability lives in ``agent_id`` (a deterministic function of the
// identity tuple), which is what frees ``session_id`` to be a
// per-invocation random uuid4. Keying the marker on
// ``sha256(cwd)[:16]`` instead breaks the "one session per
// invocation" invariant whenever a user runs ``cd`` between hooks --
// three sessions landed for one Claude Code invocation that way.
// ``hookEvent.session_id`` is the key because Claude Code guarantees
// a stable per-invocation id on every hook event.
// ---------------------------------------------------------------------

/**
 * Resolve a session id for the current hook invocation. Precedence
 * (top wins):
 *   1. process.env.CLAUDE_SESSION_ID
 *   2. process.env.ANTHROPIC_CLAUDE_SESSION_ID
 *   3. Marker file cache keyed on Claude Code's native session id --
 *      ``hookEvent.session_id``, else ``$CLAUDE_CODE_SESSION_ID``
 *      from the hook environment (populated by the fresh-uuid fallback
 *      on the first hook of this invocation; read verbatim by every
 *      subsequent hook in the same run)
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

  // Primary: Claude Code's per-invocation session id. Hook events
  // carry this reliably; when present it is the authoritative
  // invocation scope and the marker key.
  let markerKey;
  const nativeId = claudeCodeSessionId(hookEvent);
  if (nativeId) {
    markerKey = markerKeyFor(nativeId);
  } else {
    // Fallback: cwd-sha marker + a single stderr warning so operators
    // know the plugin lost per-invocation scope. Kept as a safety net
    // for non-Claude-Code callers (playground scripts, integration
    // harnesses) that may invoke the entrypoint without a hook event.
    markerKey = cwdMarkerKey(cwd);
    process.stderr.write(
      "[flightdeck] WARN: hook event missing session_id; " +
        "falling back to cwd-keyed marker. Sessions may split on cd.\n",
    );
  }

  try {
    return readOrCreateSessionMarker(markerKey);
  } catch {
    return ephemeralSessionId(cwd);
  }
}

// On SessionEnd we invalidate both on-disk cache files so the next
// hook fire mints a fresh sessionId AND re-emits its own
// session_start. Without this, subsequent /clear / re-`claude -p`
// invocations reuse the closed session_id and the worker drops their
// events under state=closed (per the worker's closed-skip path). The
// session-${markerKey}.txt cache is keyed by sha256(hookEvent.
// session_id); the started-${sessionId}.txt dedup marker is keyed by
// the resolved sessionId (see getSessionId + ensureSessionStarted).
// Best-effort by design — ENOENT is fine, other errors log and
// continue so the SessionEnd emission isn't blocked.
export function clearSessionCacheFiles(hookEvent = {}, sessionId = "") {
  let markerKey;
  const nativeId = claudeCodeSessionId(hookEvent);
  if (nativeId) {
    markerKey = markerKeyFor(nativeId);
  } else {
    markerKey = cwdMarkerKey(process.cwd());
  }
  clearSessionMarkers(markerKey, sessionId);
}

// ---------------------------------------------------------------------
// Claude Code native session id.
// ---------------------------------------------------------------------

/**
 * Claude Code's own session id for this invocation. Every hook payload
 * carries it as ``session_id``; the hook environment repeats it as
 * ``CLAUDE_CODE_SESSION_ID``, which is the only source when a caller
 * invokes the script without a hook payload. Returns null when neither
 * is set. This is NOT the Flightdeck session id (see getSessionId) --
 * it keys the per-invocation marker file and rides on the wire as
 * ``context.claude_code_session_id`` so a dashboard session can be
 * traced back to the Claude Code transcript it came from.
 */
export function claudeCodeSessionId(hookEvent = {}, env = process.env) {
  if (hookEvent && typeof hookEvent.session_id === "string" && hookEvent.session_id) {
    return hookEvent.session_id;
  }
  const fromEnv = (env.CLAUDE_CODE_SESSION_ID || "").trim();
  return fromEnv || null;
}

// ---------------------------------------------------------------------
// Session-start de-duplication -- once per session id per machine.
// ---------------------------------------------------------------------

export async function ensureSessionStarted(server, token, sessionId, basePayload, extras = {}) {
  if (isSessionStarted(sessionId)) return;

  const startPayload = {
    ...basePayload,
    event_type: "session_start",
    tool_name: null,
    tool_input: null,
    is_subagent_call: false,
    latency_ms: null,
    timestamp: new Date().toISOString(),
    // Ingestion requires a non-empty sensor_version on every
    // session_start (plugin parity with the Python sensor's wire
    // contract). Plugin reports its own version since the Python
    // sensor version is not available here; the field's purpose is
    // "what build emitted this session" and the plugin's own version
    // satisfies that.
    sensor_version: PLUGIN_VERSION,
    // Declare capture posture on session_start so the worker can
    // enforce it server-side (parity with the Python sensor). Without
    // this the server treats the session as capture-off and drops the
    // plugin's captured content even though capturePrompts is on.
    capture_prompts: Boolean(extras.capturePrompts),
  };
  const startContext = safeCollectContext({
    claudeCodeVersion: extras.claudeCodeVersion,
    claudeCodeSessionId: extras.claudeCodeSessionId,
    sessionSource: extras.sessionSource,
  });
  if (startContext) startPayload.context = startContext;
  if (extras.model) startPayload.model = extras.model;

  // Mark the session started only once the server has accepted the
  // session_start. If ingestion is down or rejects it, the next hook
  // sends it again: session_start carries the capture posture, and a
  // session whose row was created from a later event (posture unknown,
  // so content is dropped) only learns it from a session_start.
  if (!(await postEvent(server, token, sessionId, startPayload))) return;

  markSessionStarted(sessionId);
}
