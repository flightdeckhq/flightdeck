// Claude Code's SessionEnd hand-off: the hook does local work inside
// Claude Code's 1.5 s budget and re-invokes the entry script as a
// detached worker that does the network work.

import { spawn } from "node:child_process";
import { closeSync, constants as fsConstants, openSync, statSync } from "node:fs";
import { join } from "node:path";

import { mkdirOwnerOnly, stateDir } from "../core/state.mjs";

// Claude Code gives a SessionEnd hook 1.5 s before it stops waiting and
// exits, against the 600 s it allows an ordinary hook. One slow POST
// already eats that budget (TIMEOUT_MS in core/poster.mjs is 2 s), and
// SessionEnd needs up to one POST per unflushed assistant turn plus the
// session_end itself. The SessionEnd hook therefore does only local
// work inline and hands the network work to a detached worker process
// (spawnDetachedSessionEnd) that outlives the hook. The constant
// records the budget the inline part must respect; the test suite
// checks the hook returns before the server has answered anything.
export const SESSION_END_HOOK_BUDGET_MS = 1500;

// argv marker for the detached SessionEnd worker. The worker is this
// same script, re-invoked by the SessionEnd hook with the hook event on
// stdin and the resolved Flightdeck session id in CLAUDE_SESSION_ID.
export const SESSION_END_WORKER_FLAG = "--session-end-worker";

// How long the SessionEnd hook waits for its detached worker before
// letting go of it. With a local or fast control plane the worker's
// flush plus session_end finish within this window, so the events are
// delivered before Claude Code exits (and before an ephemeral runner
// tears the machine down). It leaves the rest of the 1.5 s budget for
// Node start-up and the marker clearing, with margin for a loaded
// machine; a slower server simply leaves the worker running detached
// past it.
export const SESSION_END_WORKER_GRACE_MS = 800;

// Ceiling on the FLIGHTDECK_SESSION_END_GRACE_MS override. The test
// suite's long-wait path uses 10 s so a fast server's worker finishes
// inside it even on a loaded machine; a larger value can only be a
// misconfiguration, and an exiting Claude Code must not hang on it.
export const SESSION_END_WORKER_GRACE_MAX_MS = 10000;

/**
 * The grace actually used. FLIGHTDECK_SESSION_END_GRACE_MS overrides it
 * so the test suite can force either path deterministically -- a wait
 * long enough that a fast server's worker always finishes inside it, or
 * the default where a parked worker is let go. An unset, empty or
 * invalid value falls back to the constant; a larger one is clamped to
 * SESSION_END_WORKER_GRACE_MAX_MS.
 */
export function sessionEndWorkerGraceMs(env = process.env) {
  const text = env.FLIGHTDECK_SESSION_END_GRACE_MS;
  if (typeof text !== "string" || text.trim() === "") return SESSION_END_WORKER_GRACE_MS;
  const raw = Number(text);
  if (!Number.isFinite(raw) || raw < 0) return SESSION_END_WORKER_GRACE_MS;
  return Math.min(raw, SESSION_END_WORKER_GRACE_MAX_MS);
}

// Overall deadline for the detached SessionEnd worker's transcript
// flush. A backlog is normally one or two turns, but against a dead
// server every POST aborts only after TIMEOUT_MS, so an orphaned worker
// would otherwise run for 2 s per unflushed turn. 20 s bounds that at
// about ten aborted POSTs while still clearing a long backlog on a
// healthy stack, where a POST takes milliseconds; the session_end POST
// itself is sent regardless.
export const SESSION_END_WORKER_DEADLINE_MS = 20000;

// The detached worker's stderr log holds one line per failed POST. It
// is truncated once it passes this size rather than growing without
// bound on a machine whose control plane is down for weeks; 256 KiB is
// thousands of lines, far more than a diagnosis needs.
export const SESSION_END_WORKER_LOG_MAX_BYTES = 256 * 1024;

/**
 * Hand the SessionEnd network work to a detached copy of the entry
 * script (``entryScript``, observe_cli.mjs) so the hook itself returns
 * within Claude Code's end-of-session budget. The child gets the raw hook event on stdin and the already
 * resolved Flightdeck session id through CLAUDE_SESSION_ID (the hook
 * process has cleared the marker file by now, so the child cannot
 * re-derive it). The hook waits up to SESSION_END_WORKER_GRACE_MS for
 * the child to exit, so a fast server gets the events before Claude
 * Code exits; after that detached + unref lets the hook exit while the
 * child runs. stdout is dropped and stderr appends to a log under the
 * plugin state directory so a failed POST stays diagnosable. FLIGHTDECK_QUIET
 * stops the child from repeating the default-token warning the hook
 * already printed.
 */
export async function spawnDetachedSessionEnd(rawInput, sessionId, entryScript) {
  let stderrTarget = "ignore";
  try {
    stderrTarget = openSessionEndWorkerLog(stateDir());
  } catch {
    stderrTarget = "ignore";
  }
  try {
    const child = spawn(
      process.execPath,
      [entryScript, SESSION_END_WORKER_FLAG],
      {
        detached: true,
        stdio: ["pipe", "ignore", stderrTarget],
        windowsHide: true,
        env: { ...process.env, CLAUDE_SESSION_ID: sessionId, FLIGHTDECK_QUIET: "1" },
      },
    );
    child.on("error", (err) => {
      process.stderr.write(
        `[flightdeck] WARN: SessionEnd worker failed to start: ${err.message}\n`,
      );
    });
    child.stdin.on("error", () => {
      /* the worker exited before reading; nothing left to hand over */
    });
    child.stdin.end(rawInput);
    await new Promise((settle) => {
      const timer = setTimeout(() => {
        child.unref();
        settle();
      }, sessionEndWorkerGraceMs());
      child.once("exit", () => {
        clearTimeout(timer);
        settle();
      });
    });
  } catch (err) {
    process.stderr.write(
      `[flightdeck] WARN: SessionEnd worker spawn failed: ${err?.message || err}\n`,
    );
  } finally {
    if (typeof stderrTarget === "number") {
      try {
        closeSync(stderrTarget);
      } catch {
        /* already closed */
      }
    }
  }
}

/**
 * Open the detached worker's stderr log for appending, owner-only
 * (failed-POST lines quote the server URL), truncating it first once
 * it has grown past SESSION_END_WORKER_LOG_MAX_BYTES. The mode applies
 * when the file is created. Returns the file descriptor; throws when
 * the directory or file cannot be opened, and the caller then discards
 * the worker's stderr.
 */
export function openSessionEndWorkerLog(dir) {
  mkdirOwnerOnly(dir);
  const file = join(dir, "session-end-worker.log");
  let truncate = false;
  try {
    truncate = statSync(file).size > SESSION_END_WORKER_LOG_MAX_BYTES;
  } catch {
    /* no log yet */
  }
  const { O_WRONLY, O_CREAT, O_APPEND, O_TRUNC, O_NOFOLLOW } = fsConstants;
  // O_NOFOLLOW refuses to open a symlink planted at the log path by
  // another user of a shared temp directory. Windows has no such flag
  // (it is undefined there), so it is simply left out.
  const noFollow = O_NOFOLLOW || 0;
  if (truncate) {
    // Truncate in a separate open, then reopen for appending: an
    // O_TRUNC descriptor without O_APPEND would write from offset 0 and
    // overwrite lines a concurrent worker is still appending.
    closeSync(openSync(file, O_WRONLY | O_TRUNC | noFollow, 0o600));
  }
  return openSync(file, O_WRONLY | O_CREAT | O_APPEND | noFollow, 0o600);
}
