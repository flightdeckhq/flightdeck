// The event poster every hook adapter shares: one POST to the
// ingestion API per event, bounded by TIMEOUT_MS, logging one stderr
// line per failure and never throwing.
//
// Uses only Node.js built-in modules (global fetch, AbortController).

import { redactServerUrl, truncateUtf8 } from "./config.mjs";

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

// Ingestion reads at most 1 MiB of an event body, and NATS carries the
// event on with the same 1 MiB max_payload; a larger body is rejected
// whole (413 from a proxy with nginx's default 1 MiB limit, 400 from
// ingestion when the cut body fails to parse), its token counts with
// it. The poster keeps every body under 768 KiB as measured by
// encodedBytes; the remaining quarter covers the token id and name
// ingestion adds to a session_start.
export const MAX_EVENT_BODY_BYTES = 768 * 1024;

const GO_ESCAPED_ASCII_RE = /[<>&]/g;
const GO_ESCAPED_SEPARATORS_RE = /[\u2028\u2029]/g;

/**
 * The size of a JSON body once ingestion has re-encoded it. Ingestion
 * re-marshals a session_start with Go's encoding/json, which writes
 * ``<``, ``>`` and ``&`` as six-byte ``\u003c`` escapes (one byte in
 * the plugin's JSON) and U+2028 / U+2029 as six-byte escapes (three
 * bytes in UTF-8), so content heavy in markup or code grows on the way
 * to NATS. Every event is measured this way; for the others it only
 * over-counts.
 */
export function encodedBytes(body) {
  const ascii = body.match(GO_ESCAPED_ASCII_RE)?.length ?? 0;
  const separators = body.match(GO_ESCAPED_SEPARATORS_RE)?.length ?? 0;
  return Buffer.byteLength(body, "utf8") + 5 * ascii + 3 * separators;
}

/** The text that replaces the cut end of a string in oversized content. */
export function truncationMarker(keptBytes, totalBytes) {
  return `… [flightdeck: kept ${keptBytes} of ${totalBytes} bytes to fit the event size limit]`;
}

/**
 * Every string in ``value`` longer than ``capBytes`` of UTF-8, cut to
 * ``capBytes`` and marked. Structure, keys and the other values stay.
 */
export function capStrings(value, capBytes) {
  if (typeof value === "string") {
    const total = Buffer.byteLength(value, "utf8");
    if (total <= capBytes) return value;
    const kept = truncateUtf8(value, capBytes);
    const marked = kept + truncationMarker(Buffer.byteLength(kept, "utf8"), total);
    // A string barely over the cap would grow by the marker; keep it.
    return Buffer.byteLength(marked, "utf8") < total ? marked : value;
  }
  if (Array.isArray(value)) return value.map((item) => capStrings(item, capBytes));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = capStrings(item, capBytes);
    return out;
  }
  return value;
}

function longestStringBytes(value) {
  if (typeof value === "string") return Buffer.byteLength(value, "utf8");
  let longest = 0;
  const items = Array.isArray(value) ? value : value && typeof value === "object" ? Object.values(value) : [];
  for (const item of items) longest = Math.max(longest, longestStringBytes(item));
  return longest;
}

function serializeCut(payload, capBytes) {
  return JSON.stringify({ ...payload, content: capStrings(payload.content, capBytes) });
}

// Payload fields holding a sub-agent message stub that points at the
// event's content ({has_content: true, content_bytes, captured_at}).
const MESSAGE_STUB_FIELDS = ["incoming_message", "outgoing_message"];

/** ``payload`` sent without its content: no stub still claims it. */
function withoutContent(payload) {
  const out = { ...payload, has_content: false, content: null };
  for (const field of MESSAGE_STUB_FIELDS) {
    const stub = out[field];
    if (stub && typeof stub === "object" && stub.has_content) out[field] = { ...stub, has_content: false };
  }
  return out;
}

/**
 * The JSON body for one event, kept within MAX_EVENT_BODY_BYTES. An
 * event over it has the strings of its captured ``content`` cut, each
 * to the same largest length that fits, with a marker in place of the
 * cut text, so the call and its tokens are stored with as much of the
 * content as fits. When no cut fits, the event is sent without its
 * content. An event without content, or one that is over the limit
 * even without it, is sent as it is.
 */
export function serializeEvent(payload) {
  const body = JSON.stringify(payload);
  const size = encodedBytes(body);
  if (size <= MAX_EVENT_BODY_BYTES || payload.content == null) return body;
  const bare = JSON.stringify(withoutContent(payload));
  if (encodedBytes(bare) > MAX_EVENT_BODY_BYTES) {
    process.stderr.write(
      `[flightdeck] WARN: ${payload.event_type} event is ${size} bytes and over the event ` +
        "size limit without its content; it is sent as it is.\n",
    );
    return body;
  }
  // The body only grows with the cap, so when even an empty cap does
  // not fit, no cap does; that skips the search (each step serialises
  // the whole event).
  if (encodedBytes(serializeCut(payload, 0)) > MAX_EVENT_BODY_BYTES) {
    process.stderr.write(
      `[flightdeck] WARN: ${payload.event_type} event is ${size} bytes and its content cannot be cut ` +
        "to fit the event size limit; the event is sent without it.\n",
    );
    return bare;
  }
  let lo = 0;
  let hi = Math.min(longestStringBytes(payload.content), MAX_EVENT_BODY_BYTES);
  let best = null;
  let bestCap = 0;
  // Binary search for the largest per-string length that fits; about
  // twenty serialisations for content of a few MiB.
  while (lo <= hi) {
    const cap = Math.floor((lo + hi) / 2);
    const candidate = serializeCut(payload, cap);
    if (encodedBytes(candidate) <= MAX_EVENT_BODY_BYTES) {
      best = candidate;
      bestCap = cap;
      lo = cap + 1;
    } else {
      hi = cap - 1;
    }
  }
  if (best !== null) {
    process.stderr.write(
      `[flightdeck] WARN: ${payload.event_type} event is ${size} bytes; ` +
        `content strings over ${bestCap} bytes were cut to fit the event size limit.\n`,
    );
    return best;
  }
  process.stderr.write(
    `[flightdeck] WARN: ${payload.event_type} event is ${size} bytes and its content cannot be cut ` +
      "to fit the event size limit; the event is sent without it.\n",
  );
  return bare;
}

// Returns true when the server accepted the event (2xx), false on any
// network or HTTP failure. Callers that only fire and forget may ignore
// it; ensureSessionStarted uses it to retry an unaccepted session_start.
export async function postEvent(server, token, sessionId, payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let response = null;
    try {
      response = await fetch(`${server}/ingest/v1/events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: serializeEvent(payload),
        signal: controller.signal,
      });
    } catch (err) {
      // Network-level failure: connection refused, DNS miss, abort
      // timeout, fetch rejection. Log and return -- the next hook
      // invocation is a fresh process and will try again.
      logUnreachable(server, shortErrorFrom(err));
      return false;
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
    // The body is read under the same timeout, and only when a directive
    // sink is registered (enforcement on).
    await deliverDirective(sessionId, response);
    return true;
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------
// Directives. The ingestion API answers an event POST, or a heartbeat,
// with the session's pending directive, and marks it delivered: a
// directive the poster does not hand on is lost. The client binding
// registers the sink that applies it.
// ---------------------------------------------------------------------

let directiveSink = null;

/** Register ``sink(sessionId, directive)``, called for each directive a response carries. */
export function setDirectiveSink(sink) {
  directiveSink = sink;
}

// A response envelope is a few hundred bytes; a body larger than this is
// not one, and is not read.
const MAX_RESPONSE_BYTES = 64 * 1024;

async function deliverDirective(sessionId, response) {
  if (!directiveSink) return;
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) return;
  let directive = null;
  try {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) return;
    directive = JSON.parse(text)?.directive ?? null;
  } catch {
    // A body cut off by the timeout, or one that is not JSON.
    return;
  }
  if (!directive || typeof directive !== "object" || Array.isArray(directive)) return;
  try {
    await directiveSink(sessionId, directive);
  } catch (err) {
    process.stderr.write(`[flightdeck] WARN: applying a directive failed: ${shortErrorFrom(err)}\n`);
  }
}

/**
 * POST a heartbeat for ``sessionId``, which keeps the session live and
 * returns its pending directive to the sink. Returns whether the server
 * accepted it; never throws.
 */
export async function postHeartbeat(server, token, sessionId) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${server}/ingest/v1/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ session_id: sessionId }),
      signal: controller.signal,
    });
    if (!response.ok) return false;
    await deliverDirective(sessionId, response);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
