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
import { isAbsolute, join } from "node:path";

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
  // Claude Code always passes an absolute path. A relative one would
  // resolve against each hook's working directory and split the state.
  if (data && isAbsolute(data)) return join(data, PLUGIN_DATA_STATE_SUBDIR);
  return join(tmpdir(), STATE_DIR_NAME);
}

/**
 * Refresh a state file's mtime when a hook uses it, so pruneStateDir only
 * removes files no hook has touched for STATE_FILE_MAX_AGE_MS. Best-effort.
 */
export function touchStateFile(path, now = Date.now()) {
  try {
    utimesSync(path, now / 1000, now / 1000);
  } catch {
    /* gone or not ours */
  }
}

// A state file no hook has used for this long is deleted by
// pruneStateDir. Every hook refreshes its session's files
// (touchSessionFiles), so only sessions idle this long lose them. Seven
// days covers resuming a conversation within the working week, while
// keeping the directory bounded: the per-turn markers grow by about one
// file per model call, and a busy machine makes thousands of calls a
// day. A pruned per-turn marker only costs a redundant POST (the workers
// drop a re-sent call by its event id); a session idle for longer starts
// a new Flightdeck session and fetches its MCP policy again when it is
// resumed.
export const STATE_FILE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Refresh every state file of a live session: its marker, start and
 * git markers, cached model and endpoint, and MCP policy cache, so a
 * session that stays open keeps them all however long it runs.
 */
export function touchSessionFiles(markerKey, sessionId, now = Date.now()) {
  const dir = stateDir();
  const names = [`session-${markerKey}.txt`, `git-${markerKey}.json`];
  if (sessionId) {
    names.push(
      `started-${sessionId}.txt`,
      `model-${sessionId}.txt`,
      `model-switch-${sessionId}.json`,
      `endpoint-${sessionId}.json`,
      `${MCP_POLICY_CACHE_PREFIX}${sessionId}.json`,
    );
  }
  for (const name of names) touchStateFile(join(dir, name), now);
}

// File name prefix of the per-session MCP policy cache (mcp_policy.mjs).
export const MCP_POLICY_CACHE_PREFIX = "mcp-policy-";

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
 * ``sessionId`` is given, that session's started, endpoint and
 * working-directory markers.
 * Best-effort: ENOENT is fine, other errors log and continue.
 */
export function clearSessionMarkers(markerKey, sessionId = "", { recordEnded = false } = {}) {
  const dir = stateDir();
  if (sessionId && recordEnded) writeEndedMarker(markerKey, sessionId);
  const targets = [`session-${markerKey}.txt`, `git-${markerKey}.json`];
  if (sessionId) targets.push(`started-${sessionId}.txt`, `endpoint-${sessionId}.json`, `cwd-${sessionId}.txt`);
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
// Ended-session marker. SessionEnd clears the session marker, but an
// async hook of the same run can still be starting up; without this it
// would mint a new session id (a stray session) or re-send the ending
// session's session_start (reopening it). SessionEnd leaves the ended
// id behind, a later hook of the same Claude Code session reports under
// it without the session_start backstop, and the next SessionStart
// (a resume) removes it.
// ---------------------------------------------------------------------

/** Record that ``sessionId`` ended for ``markerKey``. Best-effort. */
export function writeEndedMarker(markerKey, sessionId) {
  const dir = stateDir();
  try {
    mkdirOwnerOnly(dir);
    writeFileSync(join(dir, `ended-${markerKey}.txt`), sessionId);
  } catch {
    /* without it a late hook may start a stray session, as before */
  }
}

/** The session id that ended for ``markerKey``, or null. */
export function readEndedMarker(markerKey) {
  try {
    const id = readFileSync(join(stateDir(), `ended-${markerKey}.txt`), "utf8").trim();
    return id || null;
  } catch {
    return null;
  }
}

/** Forget that a session ended for ``markerKey`` (a new start or resume). */
export function clearEndedMarker(markerKey) {
  try {
    unlinkSync(join(stateDir(), `ended-${markerKey}.txt`));
  } catch {
    /* none */
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

// The working directory a session's hooks last ran in. Claude Code runs
// a plugin's CwdChanged hook only when the user's settings register one
// too, so each hook compares its cwd with this one to report a change.
function cwdPath(sessionId) {
  return join(stateDir(), `cwd-${sessionId}.txt`);
}

/**
 * Record ``cwd`` as the session's working directory and return the one
 * recorded before it, or null when there was none or it is unreadable.
 * A non-string ``cwd`` records nothing.
 */
export function swapSessionCwd(sessionId, cwd) {
  let previous = null;
  try {
    previous = readFileSync(cwdPath(sessionId), "utf8") || null;
  } catch {
    /* none recorded yet */
  }
  if (typeof cwd !== "string" || cwd === "" || cwd === previous) return previous;
  try {
    mkdirOwnerOnly(stateDir());
    writeFileSync(cwdPath(sessionId), cwd);
  } catch {
    /* silent */
  }
  return previous;
}

// The model a session switched to and when, so the next prompt is
// labelled with it although the transcript's latest turn still names
// the old model.
function modelSwitchPath(sessionId) {
  return join(stateDir(), `model-switch-${sessionId}.json`);
}

export function recordModelSwitch(sessionId, model, at = new Date().toISOString()) {
  if (!model) return;
  try {
    mkdirOwnerOnly(stateDir());
    writeFileSync(modelSwitchPath(sessionId), JSON.stringify({ model: String(model), at }));
  } catch {
    /* silent */
  }
}

/** ``{model, at}`` of the session's last model switch, or null. */
export function readModelSwitch(sessionId) {
  try {
    const record = JSON.parse(readFileSync(modelSwitchPath(sessionId), "utf8"));
    return typeof record?.model === "string" && typeof record?.at === "string" ? record : null;
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

const CLAIM_PREFIX = "claimed ";

/** True when ``pid`` names a running process (EPERM: running, not ours). */
export function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === "EPERM");
  }
}

/** Record that the server accepted ``messageId``'s post_call. Best-effort. */
export function markTurnSent(messageId) {
  try {
    writeFileSync(join(stateDir(), `emitted-${messageId}.txt`), "");
  } catch {
    /* the claim stays; at worst the SessionEnd worker sends it again */
  }
}

/**
 * Whether the SessionEnd worker should send ``messageId`` although it is
 * claimed: true when the claim was never confirmed sent and the process
 * that made it is gone, as when Claude Code killed a pending async hook
 * at the end of a print-mode run. A live claimant is still sending and
 * is left alone, so two live processes never send one turn.
 */
export function reclaimOrphanedTurn(messageId) {
  try {
    const claim = readFileSync(join(stateDir(), `emitted-${messageId}.txt`), "utf8");
    if (!claim.startsWith(CLAIM_PREFIX)) return false;
    const pid = Number.parseInt(claim.slice(CLAIM_PREFIX.length), 10);
    return Number.isInteger(pid) && pid > 0 && pid !== process.pid && !processAlive(pid);
  } catch {
    return false;
  }
}

export function markEmittedTurn(messageId) {
  const dir = stateDir();
  const file = join(dir, `emitted-${messageId}.txt`);
  try {
    mkdirOwnerOnly(dir);
    // The claim names the claiming process; markTurnSent empties the
    // file once the server accepted the turn, so a sent turn's marker
    // costs an inode but no data block. A claim whose process died
    // before that (a hook killed mid-flush) is re-sent by the
    // SessionEnd worker (reclaimOrphanedTurn).
    const fd = openSync(file, "wx");
    try {
      writeFileSync(fd, `${CLAIM_PREFIX}${process.pid}`);
    } finally {
      closeSync(fd);
    }
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

// The context fields the git probe sets.
export const GIT_FIELDS = ["git_commit", "git_branch", "git_repo"];

/** The cached git fields for ``markerKey`` in ``cwd``, or null. */
export function readGitCache(markerKey, cwd) {
  try {
    const record = JSON.parse(readFileSync(join(stateDir(), `git-${markerKey}.json`), "utf8"));
    if (record && record.cwd === cwd && record.git && typeof record.git === "object") {
      // Only the three git fields, and only strings: the cache must not be
      // able to set any other context field.
      const git = {};
      for (const field of GIT_FIELDS) {
        if (typeof record.git[field] === "string") git[field] = record.git[field];
      }
      return git;
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
