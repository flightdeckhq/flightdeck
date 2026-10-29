// The event poster every hook adapter shares: one POST to the
// ingestion API per event, bounded by TIMEOUT_MS, logging one stderr
// line per failure and never throwing.
//
// Uses only Node.js built-in modules (global fetch, AbortController).

import { redactServerUrl } from "./config.mjs";

// Abort the fire-and-forget event POST after 2s. The hook runs inline in the
// Claude Code tool lifecycle, so a hung or unreachable control plane must
// never block the user's session; 2s is generous for a local stack and a hard
// ceiling for a slow one.
export const TIMEOUT_MS = 2000;

// ---------------------------------------------------------------------
// HTTP POST helper + unreachable-session logging.
//
// The plugin must never block Claude Code on a broken or missing
// Flightdeck stack. Every failure path -- connection refused, DNS
// failure, HTTP non-2xx, abort timeout -- writes a single stderr line
// and returns; the hook still exits 0 so Claude Code sees it healthy.
//
// Each hook invocation is a fresh Node process, so "each POST logs at
// most once" naturally yields bounded stderr output: one line per
// failed POST, at most two lines per hook (ensureSessionStarted's
// POST + the real event's POST). No disk-persisted unreachable flag
// -- that design broke reconnect: once the flag was written, every
// subsequent hook short-circuited even after the server recovered,
// so transient outages turned into permanent session mute. Retrying
// each hook's POST costs at most two stderr lines on a dead stack
// and unlocks the "server recovers mid-session, events resume
// landing" path that the worker's lazy-create handles server-side.
// ---------------------------------------------------------------------

/**
 * Log a single "cannot reach" stderr line for this failed POST. The
 * message format is stable -- it is documented in the plugin README
 * troubleshooting section and in tests. Called once per failed POST;
 * the caller process exits shortly after so the volume of log lines
 * is bounded by the number of POST attempts per hook (at most two).
 */
export function logUnreachable(server, shortError) {
  process.stderr.write(
    `[flightdeck] cannot reach ${redactServerUrl(server)}: ${redactUserinfo(shortError)}. events dropped for this session.\n`,
  );
}

/** Strip the userinfo of every URL inside free text (error messages quote URLs). */
export function redactUserinfo(text) {
  return String(text).replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^@\s/]*@/gi, "$1");
}

// ``fetch failed`` is the generic umbrella Node uses to wrap underlying
// network errors whose ``cause.code`` we also check explicitly. Keeping
// both the string substring test and the code check covers libuv
// errors that surface through either path.
export function shortErrorFrom(err) {
  if (!err) return "unknown error";
  const code = err.cause?.code || err.code;
  if (code) return String(code);
  if (err.name === "AbortError") return "timeout";
  return (err.message || "unknown error").split("\n")[0];
}

// Returns true when the server accepted the event (2xx), false on any
// network or HTTP failure. Callers that only fire and forget may ignore
// it; ensureSessionStarted uses it to retry an unaccepted session_start.
export async function postEvent(server, token, sessionId, payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response = null;
  try {
    response = await fetch(`${server}/ingest/v1/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    // Network-level failure: connection refused, DNS miss, abort
    // timeout, fetch rejection. Log and return -- the next hook
    // invocation is a fresh process and will try again.
    logUnreachable(server, shortErrorFrom(err));
    return false;
  } finally {
    clearTimeout(timeout);
  }

  // HTTP-level failure: auth, payload validation, server error.
  // fetch() returns normally for these so the catch above does not
  // fire. We do NOT retry within this hook -- one attempt per POST
  // is the whole contract. A subsequent hook will try again when
  // Claude Code invokes a fresh plugin process.
  if (!response.ok) {
    logUnreachable(server, `HTTP ${response.status}`);
    return false;
  }
  return true;
}
