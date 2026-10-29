// Local state shared by every hook adapter. Each hook is a fresh Node
// child process, so whatever must survive across invocations -- the
// session id marker, the session-start dedup marker, the per-turn
// post_call dedup markers, the cached model, endpoint and git probes --
// lives on disk in one owner-only directory. Claude Code gives every
// plugin a persistent data directory (CLAUDE_PLUGIN_DATA) that survives
// reboots and plugin updates; the system temp root, which a reboot
// clears, is the fallback when it is not set. Every path into the
// directory is built from stateDir(). The MCP policy cache
// (mcp_policy.mjs) and the SessionEnd worker log live there too, and
// pruneStateDir() keeps it bounded.
//
// Uses only Node.js built-in modules.

import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Name of the plugin's directory under the system temp root, the
// fallback location.
export const STATE_DIR_NAME = "flightdeck-plugin";

// Subdirectory of CLAUDE_PLUGIN_DATA that holds the state, so the data
// directory has room for anything else the plugin keeps later.
export const PLUGIN_DATA_STATE_SUBDIR = "state";

/**
 * The directory that holds the plugin's on-disk state:
 * ``$CLAUDE_PLUGIN_DATA/state`` when Claude Code provides a data
 * directory, else ``$TMPDIR/flightdeck-plugin``. Resolved on every call,
 * not once at load, so it follows the environment of the process (the
 * detached SessionEnd worker inherits the hook's environment and so
 * resolves the same directory).
 */
export function stateDir(env = process.env) {
  const data = (env.CLAUDE_PLUGIN_DATA ?? "").trim();
  if (data) return join(data, PLUGIN_DATA_STATE_SUBDIR);
  return join(tmpdir(), STATE_DIR_NAME);
}

/**
 * Refresh a state file's mtime when a hook uses it, so pruneStateDir only
 * removes files no hook has touched for STATE_FILE_MAX_AGE_MS: a session
 * open for longer keeps its id and its MCP policy cache. Best-effort.
 */
export function touchStateFile(path, now = Date.now()) {
  try {
    utimesSync(path, now / 1000, now / 1000);
  } catch {
    /* gone or not ours */
  }
}

// A state file older than this is deleted by pruneStateDir. Seven days
// covers resuming a conversation within the working week without
// re-reading its markers, while keeping the directory bounded: the
// per-turn markers grow by about one file per model call, and a busy
// machine makes thousands of calls a day. Losing a marker is harmless
// for correctness, because the workers drop a re-sent call by its
// event id; it only costs the redundant POSTs.
export const STATE_FILE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// pruneStateDir runs at most this often per machine. A prune lists and
// stats every file in the directory, so it runs about once a day rather
// than on every SessionStart.
export const STATE_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

const PRUNE_STAMP_FILE = "last-prune.txt";

/**
 * Delete state files older than ``maxAgeMs``, at most once per
 * ``intervalMs``. Best-effort and silent: a file another hook is using
 * or that vanished meanwhile is skipped. Returns the number deleted, or
 * -1 when the interval has not elapsed.
 */
export function pruneStateDir({
  now = Date.now(),
  maxAgeMs = STATE_FILE_MAX_AGE_MS,
  intervalMs = STATE_PRUNE_INTERVAL_MS,
  dir = stateDir(),
} = {}) {
  const stamp = join(dir, PRUNE_STAMP_FILE);
  try {
    if (now - statSync(stamp).mtimeMs < intervalMs) return -1;
  } catch {
    /* no stamp yet: prune now */
  }
  let names;
  try {
    mkdirOwnerOnly(dir);
    writeFileSync(stamp, "");
    utimesSync(stamp, now / 1000, now / 1000);
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  let deleted = 0;
  for (const name of names) {
    if (name === PRUNE_STAMP_FILE) continue;
    const path = join(dir, name);
    try {
      const st = statSync(path);
      if (st.isFile() && now - st.mtimeMs > maxAgeMs) {
        unlinkSync(path);
        deleted += 1;
      }
    } catch {
      /* in use or already gone */
    }
  }
  return deleted;
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
    if (existing) {
      touchStateFile(file);
      return existing;
    }
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
  const targets = [`session-${markerKey}.txt`, `git-${markerKey}.json`];
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
    // Empty: only the file's existence matters, and an empty file costs
    // an inode but no data block. Its mtime is what pruneStateDir reads.
    closeSync(openSync(file, "wx"));
    return true;
  } catch (err) {
    if (err && err.code === "EEXIST") return false;
    return true; // fail open -- better to re-emit than silently drop
  }
}

// ---------------------------------------------------------------------
// Git probe cache -- the branch, commit and repo a hook reports are
// probed once per Claude Code session and working directory instead of
// with three git subprocesses on every hook. Keyed by the session marker
// key; holds the working directory it was probed in, so a session that
// changes directory probes again.
// ---------------------------------------------------------------------

/** The cached git fields for ``markerKey`` in ``cwd``, or null. */
export function readGitCache(markerKey, cwd) {
  try {
    const record = JSON.parse(readFileSync(join(stateDir(), `git-${markerKey}.json`), "utf8"));
    if (record && record.cwd === cwd && record.git && typeof record.git === "object") {
      return record.git;
    }
  } catch {
    /* missing or unreadable: probe again */
  }
  return null;
}

/** Drop the cached git fields for ``markerKey``. Best-effort. */
export function clearGitCache(markerKey) {
  try {
    unlinkSync(join(stateDir(), `git-${markerKey}.json`));
  } catch {
    /* not cached */
  }
}

/** Store the git fields probed for ``markerKey`` in ``cwd``. Best-effort. */
export function writeGitCache(markerKey, cwd, git) {
  const dir = stateDir();
  const file = join(dir, `git-${markerKey}.json`);
  const partial = `${file}.${process.pid}.tmp`;
  try {
    mkdirOwnerOnly(dir);
    writeFileSync(partial, JSON.stringify({ cwd, git }));
    renameSync(partial, file);
  } catch {
    try {
      unlinkSync(partial);
    } catch {
      /* nothing to clean up */
    }
  }
}
