// Local state shared by every hook adapter. Each hook is a fresh Node
// child process, so whatever must survive across invocations -- the
// session id marker, the session-start dedup marker, the per-turn
// post_call dedup markers, the cached model and endpoint -- lives on
// disk in one owner-only directory under the system temp root. Every
// path into that directory is built from stateDir(), so moving it is a
// change in one place. The MCP policy cache (mcp_policy.mjs) and the
// SessionEnd worker log live there too.
//
// Uses only Node.js built-in modules.

import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Name of the plugin's directory under the system temp root.
export const STATE_DIR_NAME = "flightdeck-plugin";

/**
 * The directory that holds the plugin's on-disk state,
 * ``$TMPDIR/flightdeck-plugin``. Resolved on every call, not once at
 * load, so it follows the environment the way the inline
 * ``join(tmpdir(), ...)`` it replaces did.
 */
export function stateDir() {
  return join(tmpdir(), STATE_DIR_NAME);
}

/**
 * Create the plugin's temp directory owner-only. mkdir's mode applies
 * only when the directory is created, so a directory left by an earlier
 * version (0755 under the usual umask) is tightened with a best-effort
 * chmod; when that fails the mode stays as it was.
 */
export function mkdirOwnerOnly(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* not ours to change, or a platform without POSIX modes */
  }
}

// ---------------------------------------------------------------------
// Session id marker. A binding picks the marker key (normally derived
// from the client's own per-invocation session id) and the marker file
// holds the Flightdeck session id every hook of that invocation shares.
// ---------------------------------------------------------------------

/** Marker key for a client-supplied native session id: sha256(id)[:16]. */
export function markerKeyFor(nativeSessionId) {
  return createHash("sha256").update(nativeSessionId).digest("hex").slice(0, 16);
}

/** Fallback marker key when no native session id is known: sha256(cwd)[:16]. */
export function cwdMarkerKey(cwd) {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 16);
}

/**
 * Ephemeral session id, sha256(time, pid, cwd)[:32], for when the state
 * directory is unusable.
 */
export function ephemeralSessionId(cwd) {
  return createHash("sha256")
    .update(`${Date.now()}-${process.pid}-${cwd}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * Return the session id stored under ``markerKey``, minting a uuid4 and
 * storing it when there is none yet. Throws when the directory or file
 * cannot be used; the caller then falls back to ephemeralSessionId.
 */
export function readOrCreateSessionMarker(markerKey) {
  const dir = stateDir();
  const file = join(dir, `session-${markerKey}.txt`);
  // Owner-only: the directory holds session markers, the cached
  // model name, the MCP policy cache and the SessionEnd worker log,
  // none of which another user of a shared temp root should read.
  // The mode applies when the directory is created.
  mkdirOwnerOnly(dir);
  try {
    const existing = readFileSync(file, "utf8").trim();
    if (existing) return existing;
  } catch {
    /* fall through to create */
  }
  const candidate = randomUUID();
  try {
    const fd = openSync(file, "wx");
    try {
      writeFileSync(fd, candidate);
    } finally {
      closeSync(fd);
    }
    return candidate;
  } catch (err) {
    if (err && err.code === "EEXIST") {
      // Concurrent first-hook race: another process beat us to the
      // file. Read whatever they wrote so every hook in the same
      // Claude Code run still agrees on one session id.
      const winner = readFileSync(file, "utf8").trim();
      if (winner) return winner;
    }
    throw err;
  }
}

/**
 * Delete the session marker under ``markerKey`` and, when
 * ``sessionId`` is given, that session's started and endpoint markers.
 * Best-effort: ENOENT is fine, other errors log and continue.
 */
export function clearSessionMarkers(markerKey, sessionId = "") {
  const dir = stateDir();
  const targets = [`session-${markerKey}.txt`];
  if (sessionId) targets.push(`started-${sessionId}.txt`, `endpoint-${sessionId}.json`);
  for (const name of targets) {
    try {
      unlinkSync(join(dir, name));
    } catch (err) {
      if (!err || err.code !== "ENOENT") {
        process.stderr.write(
          `[flightdeck] WARN: clearSessionCacheFiles unlink ${name}: ${err.message}\n`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------
// Session-start de-duplication -- once per session id per machine.
// ---------------------------------------------------------------------

/** True once a session_start for ``sessionId`` has been accepted. */
export function isSessionStarted(sessionId) {
  try {
    readFileSync(join(stateDir(), `started-${sessionId}.txt`), "utf8");
    return true;
  } catch {
    return false;
  }
}

/** Record that the server accepted the session_start. Silent on failure. */
export function markSessionStarted(sessionId) {
  const dir = stateDir();
  try {
    mkdirOwnerOnly(dir);
    writeFileSync(join(dir, `started-${sessionId}.txt`), new Date().toISOString());
  } catch {
    /* silent */
  }
}

// ---------------------------------------------------------------------
// Per-session model cache -- SessionStart's `model` field survives on
// disk so UserPromptSubmit can populate pre_call.model without waiting
// for the assistant response to land in the transcript. Without this,
// LLM pre_calls all carry model=null and the dashboard renders them
// as "unknown".
// ---------------------------------------------------------------------

function modelCachePath(sessionId) {
  return join(stateDir(), `model-${sessionId}.txt`);
}

export function cacheSessionModel(sessionId, model) {
  if (!model) return;
  try {
    mkdirOwnerOnly(stateDir());
    writeFileSync(modelCachePath(sessionId), String(model));
  } catch {
    /* silent */
  }
}

export function readCachedModel(sessionId) {
  try {
    return readFileSync(modelCachePath(sessionId), "utf8").trim() || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------
// Per-session endpoint cache -- the billing mode, platform and Vertex AI
// scope a binding decides at session start survive on disk so every
// later hook stamps them without probing again.
// ---------------------------------------------------------------------

function endpointCachePath(sessionId) {
  return join(stateDir(), `endpoint-${sessionId}.json`);
}

/** The cached endpoint record for a session, or null when absent or unreadable. */
export function readEndpointCache(sessionId) {
  try {
    return JSON.parse(readFileSync(endpointCachePath(sessionId), "utf8"));
  } catch {
    return null;
  }
}

// Written to a temporary file and renamed into place, so a hook reading
// the cache concurrently never sees half a document.
export function writeEndpointCache(sessionId, record) {
  try {
    mkdirOwnerOnly(stateDir());
    const path = endpointCachePath(sessionId);
    const partial = `${path}.${process.pid}.tmp`;
    try {
      writeFileSync(partial, JSON.stringify(record));
      renameSync(partial, path);
    } catch {
      try {
        unlinkSync(partial);
      } catch {
        /* already gone */
      }
    }
  } catch {
    /* silent */
  }
}

// ---------------------------------------------------------------------
// post_call de-duplication -- per assistant message.id.
// Stop fires after every assistant turn. Without dedup, a replay or
// double-hook would duplicate the turn in the dashboard.
// ---------------------------------------------------------------------

export function isTurnEmitted(messageId) {
  return existsSync(join(stateDir(), `emitted-${messageId}.txt`));
}

export function markEmittedTurn(messageId) {
  const dir = stateDir();
  const file = join(dir, `emitted-${messageId}.txt`);
  try {
    mkdirOwnerOnly(dir);
    const fd = openSync(file, "wx");
    try {
      writeFileSync(fd, new Date().toISOString());
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (err) {
    if (err && err.code === "EEXIST") return false;
    return true; // fail open -- better to re-emit than silently drop
  }
}
