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
  rmdirSync,
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
      `start-notice-${sessionId}.txt`,
      `minted-${sessionId}.txt`,
      `model-${sessionId}.txt`,
      `model-switch-${sessionId}.json`,
      `endpoint-${sessionId}.json`,
      `subagent-ends-${sessionId}.json`,
      `tool-calls-${sessionId}.json`,
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
 * storing it when there is none yet. With ``recordMint`` (the hook is a
 * SessionStart) a minted session also records when it was minted (see
 * readSessionMintTime). Throws when the directory or file cannot be used;
 * the caller then falls back to ephemeralSessionId.
 */
export function readOrCreateSessionMarker(markerKey, { recordMint = false } = {}) {
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
  // The mint time is written before the marker, so a hook that reads the
  // marker always finds it.
  const minted = recordMint && writeSessionMintTime(candidate);
  try {
    const fd = openSync(file, "wx");
    try {
      writeFileSync(fd, candidate);
    } finally {
      closeSync(fd);
    }
    return candidate;
  } catch (err) {
    if (minted) removeStateFile(`minted-${candidate}.txt`);
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
 * The session id the marker under ``markerKey`` names now, or null when
 * there is none. Reads only: it neither creates the marker nor refreshes
 * it, so a process that is not the session's (the SessionEnd worker) can
 * see whether a later session has taken the marker over.
 */
export function readSessionMarker(markerKey) {
  try {
    return readFileSync(join(stateDir(), `session-${markerKey}.txt`), "utf8").trim() || null;
  } catch {
    return null;
  }
}

/** Delete one file of the state directory. Best-effort. */
function removeStateFile(name) {
  try {
    unlinkSync(join(stateDir(), name));
  } catch {
    /* already gone */
  }
}

// ---------------------------------------------------------------------
// Session mint time. A session SessionStart mints records when, so its
// flushes can tell the transcript turns that ran in it from the turns of
// a resumed conversation's earlier sessions: a turn is reported only
// under the session that was current when it ran. Kept under the
// Flightdeck session id rather than the marker key, so the SessionEnd
// worker and a hook that runs after SessionEnd, which no longer have the
// marker, still find it; SessionEnd leaves it to the prune.
// ---------------------------------------------------------------------

function writeSessionMintTime(sessionId) {
  try {
    writeFileSync(join(stateDir(), `minted-${sessionId}.txt`), new Date().toISOString());
    return true;
  } catch {
    return false; // the session's flushes then send every unsent turn
  }
}

/**
 * When ``sessionId`` was minted, in epoch milliseconds, or null when it
 * recorded no time: a session minted by a hook other than SessionStart,
 * a marker an earlier plugin release wrote, or an id given through
 * CLAUDE_SESSION_ID by something other than the SessionEnd hand-off.
 */
export function readSessionMintTime(sessionId) {
  if (!sessionId) return null;
  try {
    const at = Date.parse(readFileSync(join(stateDir(), `minted-${sessionId}.txt`), "utf8").trim());
    return Number.isFinite(at) ? at : null;
  } catch {
    return null;
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
  if (sessionId) {
    targets.push(
      `started-${sessionId}.txt`,
      `starting-${sessionId}.txt`,
      `start-notice-${sessionId}.txt`,
      `endpoint-${sessionId}.json`,
      `cwd-${sessionId}.txt`,
    );
  }
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

// A session_start claim older than this belongs to a hook that died
// mid-send; a live one holds it for one POST (2 s at most).
const SESSION_START_CLAIM_STALE_MS = 30_000;

/**
 * Claim the sending of ``sessionId``'s session_start, so concurrent
 * hooks (a subagent's SubagentStart and its first interior hooks, or
 * parallel tool calls) send one between them. False when another hook
 * holds the claim or the state directory is unusable.
 */
export function claimSessionStart(sessionId) {
  const dir = stateDir();
  const path = join(dir, `starting-${sessionId}.txt`);
  try {
    mkdirOwnerOnly(dir);
  } catch {
    return false;
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, String(process.pid), { flag: "wx" });
      return true;
    } catch (err) {
      if (err?.code !== "EEXIST") return false;
      try {
        if (Date.now() - statSync(path).mtimeMs < SESSION_START_CLAIM_STALE_MS) return false;
        unlinkSync(path);
      } catch {
        return false;
      }
    }
  }
  return false;
}

/** Whether a live hook holds ``sessionId``'s session_start claim. */
export function isSessionStartClaimed(sessionId) {
  try {
    const age = Date.now() - statSync(join(stateDir(), `starting-${sessionId}.txt`)).mtimeMs;
    return age < SESSION_START_CLAIM_STALE_MS;
  } catch {
    return false;
  }
}

/** Release a claim taken by claimSessionStart. Silent on failure. */
export function releaseSessionStart(sessionId) {
  try {
    unlinkSync(join(stateDir(), `starting-${sessionId}.txt`));
  } catch {
    /* already released */
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

/** Forget that ``sessionId``'s session_start was accepted, so the next one is sent. */
export function clearSessionStarted(sessionId) {
  removeStateFile(`started-${sessionId}.txt`);
}

/**
 * Claim the one "this session is not being recorded" notice of
 * ``sessionId``: true the first time, false once it has been shown, so
 * a SessionStart that fires again in the session (a compaction) does
 * not repeat it. The marker lives as the session's other markers do:
 * every hook refreshes it (touchSessionFiles) and SessionEnd removes it
 * (clearSessionMarkers), so a session resumed after its end is told
 * again, as a new one is. With an unusable state directory the answer
 * is true: a repeated notice is better than none.
 */
export function claimStartFailureNotice(sessionId) {
  const dir = stateDir();
  try {
    mkdirOwnerOnly(dir);
    writeFileSync(join(dir, `start-notice-${sessionId}.txt`), new Date().toISOString(), { flag: "wx" });
    return true;
  } catch (err) {
    return err?.code !== "EEXIST";
  }
}

// ---------------------------------------------------------------------
// Ended subagent marker. SubagentStop leaves it for the child session;
// a later SubagentStart of the same child (a SendMessage resume, or a
// finished background task waking the subagent) removes it and sends
// the child's session_start again, re-attaching the closed row. While it
// is in place no hook of the child sends a session_start, so an async
// hook of an execution that has ended cannot reopen the child.
// ---------------------------------------------------------------------

/**
 * Record that the child session ``childSessionId`` ended. Best-effort:
 * returns false when the marker could not be written, in which case a
 * late hook may reopen the child and a resume is not re-attached.
 */
export function markSubagentEnded(childSessionId, at = new Date().toISOString()) {
  const dir = stateDir();
  try {
    mkdirOwnerOnly(dir);
    writeFileSync(join(dir, `subagent-ended-${childSessionId}.txt`), at);
    return true;
  } catch {
    return false;
  }
}

/** Whether ``childSessionId`` ended and was not resumed since. */
export function isSubagentEnded(childSessionId) {
  return existsSync(join(stateDir(), `subagent-ended-${childSessionId}.txt`));
}

/** Forget that ``childSessionId`` ended (it is resumed). */
export function clearSubagentEnded(childSessionId) {
  removeStateFile(`subagent-ended-${childSessionId}.txt`);
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

// Async hooks run concurrently (parallel tool calls), so a read-modify-
// write of a shared state file happens under a lock directory: mkdir
// either creates it or fails, for exactly one of two racing hooks. A lock
// older than this is left by a hook that died holding it; a holder does
// two small file operations, so a live one never comes close.
const LOCK_DIR_STALE_MS = 5_000;

function takeLockDir(lockPath) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(lockPath);
      return true;
    } catch (err) {
      if (err?.code !== "EEXIST") return false;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs < LOCK_DIR_STALE_MS) return false;
        rmdirSync(lockPath);
      } catch {
        return false;
      }
    }
  }
  return false;
}

// The session's enforcement state (claude_code/control.mjs): a stop or a
// budget notice a directive set, the events still owed for it, and when
// the gate last polled. Async hooks and the gate update it at once, so
// every change happens under a lock directory.
function controlPath(sessionId) {
  return join(stateDir(), `control-${sessionId}.json`);
}

/** Delete the session's control state, once its session has ended. */
export function clearControlState(sessionId) {
  try {
    unlinkSync(controlPath(sessionId));
  } catch {
    /* none */
  }
}

/** The session's control state, or an empty object. */
export function readControlState(sessionId) {
  return readJsonObject(controlPath(sessionId));
}

/** The JSON object stored at ``path``, or an empty object. */
function readJsonObject(path) {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

// A peer holds a state file's lock for one read and one write; waiting up
// to this long covers a slow disk. Past it the update goes ahead
// unlocked rather than losing a stop or an owed subagent end.
const STATE_LOCK_WAIT_MS = 1_000;
const STATE_LOCK_POLL_MS = 20;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Apply ``update(state)`` to the session's control state under its lock
 * and write the result atomically. Returns the state written, or the
 * state read when the directory cannot be written (an update that
 * removes notices then removes nothing, so a notice can show again).
 * When the lock is still held after STATE_LOCK_WAIT_MS the update runs
 * unlocked, and a concurrent update can be lost. Taking over a stale
 * lock is not exclusive either: two hooks that both find it stale can
 * both take it; it needs a holder dead for LOCK_DIR_STALE_MS first.
 */
export function updateControlState(sessionId, update) {
  return updateJsonObject(controlPath(sessionId), update);
}

/**
 * The read-modify-write updateControlState describes, on the JSON object
 * at ``path``. With ``removeWhenEmpty`` an update that leaves the object
 * empty deletes the file, so a reader on the common path finds none.
 */
function updateJsonObject(path, update, { removeWhenEmpty = false } = {}) {
  const lockPath = `${path}.lock`;
  try {
    mkdirOwnerOnly(stateDir());
  } catch {
    return update(readJsonObject(path));
  }
  const deadline = Date.now() + STATE_LOCK_WAIT_MS;
  let locked = takeLockDir(lockPath);
  while (!locked && Date.now() < deadline) {
    sleepSync(STATE_LOCK_POLL_MS);
    locked = takeLockDir(lockPath);
  }
  try {
    const next = update(readJsonObject(path));
    if (removeWhenEmpty && Object.keys(next).length === 0) {
      try {
        unlinkSync(path);
      } catch (err) {
        if (err?.code !== "ENOENT") throw err;
      }
      return next;
    }
    const partial = `${path}.${process.pid}.tmp`;
    try {
      writeFileSync(partial, JSON.stringify(next));
      renameSync(partial, path);
    } catch (err) {
      try {
        unlinkSync(partial);
      } catch {
        /* never written */
      }
      throw err;
    }
    return next;
  } catch {
    return readJsonObject(path);
  } finally {
    if (locked) {
      try {
        rmdirSync(lockPath);
      } catch {
        /* removed as stale by another hook */
      }
    }
  }
}

// ---------------------------------------------------------------------
// Owed work. A hook records what it is about to send before its first
// POST and drops the record once the server has answered; a record left
// behind (a failed POST, a hook killed mid-way) is sent by a later hook
// of the same session, or by the SessionEnd worker. Two kinds:
//   * subagent ends (``subagent-ends-<outer session>.json``, keyed by
//     child session id): SubagentStop's child session_end, owed until the
//     child's turns are sent and the end is accepted;
//   * tool events (``tool-calls-<session>.json``, keyed by tool_use_id):
//     a tool_call or mcp_tool_call until the server has answered, rebuilt
//     from the record and the transcript after a failed POST.
// One file per session and kind, absent when nothing is owed. Each record
// names the process working on it (``pid``, null once released) and is
// taken over like a turn's claim: only from a process that is gone.
// ---------------------------------------------------------------------

const OWED_SUBAGENT_ENDS = "subagent-ends";
const OWED_TOOL_CALLS = "tool-calls";

function owedPath(kind, sessionId) {
  return join(stateDir(), `${kind}-${sessionId}.json`);
}

function updateOwed(kind, sessionId, update) {
  return updateJsonObject(owedPath(kind, sessionId), update, { removeWhenEmpty: true });
}

function owe(kind, sessionId, key, entry) {
  updateOwed(kind, sessionId, (owed) => ({ ...owed, [key]: { ...entry, pid: process.pid } }));
}

function takeOwed(kind, sessionId, key) {
  let taken = null;
  updateOwed(kind, sessionId, (owed) => {
    const entry = owed[key];
    if (!entry || typeof entry !== "object") return owed;
    const holder = Number(entry.pid);
    if (Number.isInteger(holder) && holder > 0 && holder !== process.pid && processAlive(holder)) return owed;
    taken = { ...entry, pid: process.pid };
    return { ...owed, [key]: taken };
  });
  return taken;
}

function releaseOwed(kind, sessionId, key) {
  updateOwed(kind, sessionId, (owed) => {
    const entry = owed[key];
    if (!entry || entry.pid !== process.pid) return owed;
    return { ...owed, [key]: { ...entry, pid: null } };
  });
}

function dropOwed(kind, sessionId, key) {
  updateOwed(kind, sessionId, (owed) => {
    if (!(key in owed)) return owed;
    const rest = { ...owed };
    delete rest[key];
    return rest;
  });
}

/** The owed subagent ends of ``outerSessionId``, keyed by child session id. */
export function readOwedSubagentEnds(outerSessionId) {
  return readJsonObject(owedPath(OWED_SUBAGENT_ENDS, outerSessionId));
}

/** Record that ``childSessionId`` owes ``entry``'s end, held by this process. */
export function oweSubagentEnd(outerSessionId, childSessionId, entry) {
  owe(OWED_SUBAGENT_ENDS, outerSessionId, childSessionId, entry);
}

/**
 * Take the owed end of ``childSessionId`` for this process. Returns the
 * entry, or null when there is none or a live process holds it.
 */
export function takeOwedSubagentEnd(outerSessionId, childSessionId) {
  return takeOwed(OWED_SUBAGENT_ENDS, outerSessionId, childSessionId);
}

/** Let go of this process's hold on an owed end, after a failed POST. */
export function releaseOwedSubagentEnd(outerSessionId, childSessionId) {
  releaseOwed(OWED_SUBAGENT_ENDS, outerSessionId, childSessionId);
}

/** Forget an owed end: sent, or dropped because its subagent was resumed. */
export function dropOwedSubagentEnd(outerSessionId, childSessionId) {
  dropOwed(OWED_SUBAGENT_ENDS, outerSessionId, childSessionId);
}

/** The owed tool events of ``sessionId``, keyed by tool_use_id. */
export function readOwedToolCalls(sessionId) {
  return readJsonObject(owedPath(OWED_TOOL_CALLS, sessionId));
}

/**
 * Whether another live process is still sending one of the tool events
 * ``sessionId`` owes: an entry it holds that this process could not take
 * over. Reads only; takes nothing.
 */
export function owedToolCallHeld(sessionId) {
  return Object.values(readOwedToolCalls(sessionId)).some((entry) => {
    const holder = Number(entry?.pid);
    return Number.isInteger(holder) && holder > 0 && holder !== process.pid && processAlive(holder);
  });
}

/** Record that ``sessionId`` owes the tool event of ``toolUseId``, held by this process. */
export function oweToolCall(sessionId, toolUseId, entry) {
  owe(OWED_TOOL_CALLS, sessionId, toolUseId, entry);
}

/** Take an owed tool event for this process; null when none is owed or a live process holds it. */
export function takeOwedToolCall(sessionId, toolUseId) {
  return takeOwed(OWED_TOOL_CALLS, sessionId, toolUseId);
}

/** Let go of this process's hold on an owed tool event, after a failed POST. */
export function releaseOwedToolCall(sessionId, toolUseId) {
  releaseOwed(OWED_TOOL_CALLS, sessionId, toolUseId);
}

/** Forget an owed tool event: the server accepted it, or refused it for good. */
export function dropOwedToolCall(sessionId, toolUseId) {
  dropOwed(OWED_TOOL_CALLS, sessionId, toolUseId);
}

/**
 * Record ``cwd`` as the session's working directory. Returns
 * ``{changed, previous}``: ``changed`` is true for exactly one hook per
 * change, the one that recorded it, and ``previous`` is the directory
 * recorded before (null when there was none). A missing ``cwd``, a
 * failed lock (another hook is recording) or an unwritable state
 * directory records nothing and reports no change.
 */
export function swapSessionCwd(sessionId, cwd) {
  const none = { changed: false, previous: null };
  if (typeof cwd !== "string" || cwd === "") return none;
  const path = cwdPath(sessionId);
  const lockPath = `${path}.lock`;
  try {
    mkdirOwnerOnly(stateDir());
  } catch {
    return none;
  }
  if (!takeLockDir(lockPath)) return none;
  try {
    let previous = null;
    try {
      previous = readFileSync(path, "utf8") || null;
    } catch {
      /* none recorded yet */
    }
    if (cwd === previous) return { changed: false, previous };
    writeFileSync(path, cwd);
    return { changed: true, previous };
  } catch {
    return none;
  } finally {
    try {
      rmdirSync(lockPath);
    } catch {
      /* removed as stale by another hook */
    }
  }
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

const REFUSED_PREFIX = "refused ";

/**
 * Record that the server refused ``messageId``'s post_call as invalid
 * (``status``), so no hook sends it again: the same event would be
 * refused again, and a turn that is retried forever would hold back
 * every turn after it.
 */
export function markTurnRefused(messageId, status) {
  try {
    writeFileSync(join(stateDir(), `emitted-${messageId}.txt`), `${REFUSED_PREFIX}${status ?? ""}`.trim());
  } catch {
    /* the claim stays; a takeover sends it again and it is refused again */
  }
}

/**
 * Give up this process's claim on ``messageId`` after its POST failed,
 * so the next hook that reads the transcript sends the turn. A claim
 * this process no longer holds is left alone.
 */
export function releaseTurnClaim(messageId) {
  const file = join(stateDir(), `emitted-${messageId}.txt`);
  try {
    if (readFileSync(file, "utf8") === `${CLAIM_PREFIX}${process.pid}`) unlinkSync(file);
  } catch {
    /* already gone */
  }
}

/**
 * Take over ``messageId``'s claim when it was never confirmed sent and
 * the process that made it is gone, as when Claude Code killed a pending
 * async hook at the end of a print-mode run. The claim is rewritten to
 * name this process under a lock, so of two processes taking over the
 * same turn only one sends it. A live claimant is still sending and is
 * left alone, so two live processes never send one turn. True when this
 * process now holds the claim.
 */
export function reclaimOrphanedTurn(messageId) {
  const file = join(stateDir(), `emitted-${messageId}.txt`);
  const lockPath = `${file}.lock`;
  if (!takeLockDir(lockPath)) return false;
  try {
    const claim = readFileSync(file, "utf8");
    if (!claim.startsWith(CLAIM_PREFIX)) return false;
    const pid = Number.parseInt(claim.slice(CLAIM_PREFIX.length), 10);
    if (!(Number.isInteger(pid) && pid > 0 && pid !== process.pid && !processAlive(pid))) return false;
    writeFileSync(file, `${CLAIM_PREFIX}${process.pid}`);
    return true;
  } catch {
    return false;
  } finally {
    try {
      rmdirSync(lockPath);
    } catch {
      /* removed as stale by another hook */
    }
  }
}

export function markEmittedTurn(messageId) {
  const dir = stateDir();
  const file = join(dir, `emitted-${messageId}.txt`);
  try {
    mkdirOwnerOnly(dir);
    // The claim names the claiming process; markTurnSent empties the
    // file once the server accepted the turn, so a sent turn's marker
    // costs an inode but no data block, and releaseTurnClaim removes
    // it when the POST failed. A claim whose process died before either
    // (a hook killed mid-flush) is taken over by SubagentStop or the
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
