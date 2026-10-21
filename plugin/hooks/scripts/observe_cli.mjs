#!/usr/bin/env node
// Flightdeck Claude Code hook. Reads hook event from stdin, reads the
// Claude Code JSONL transcript for token/content details, and POSTs
// metadata + optional content to the Flightdeck ingestion API.
//
// Design notes:
//   * Claude Code hooks have no visibility into the raw LLM request.
//     Every hook invocation receives `transcript_path` pointing at the
//     JSONL conversation log. That log carries the full Anthropic API
//     response envelope for every assistant turn, including model name,
//     usage object (input/output/cache tokens), and the message body.
//     The plugin reads that file to emit real post_call events rather
//     than the old "tokens_total = 0" placeholder.
//   * Every hook is a fresh Node child process. State that must survive
//     across invocations (session id, session-start de-dup, Stop dedup
//     per message.id, connection-refused one-shot log) lives on disk
//     under tmpdir()/flightdeck-plugin/.
//   * Defaults let a developer run `claude --plugin-dir <path>` against
//     a local `make dev` stack with zero env config. Production teams
//     override via shell rc or wrapper script.
//   * Hook failures never block Claude Code. Connection refused logs
//     once per session and then silently no-ops; anything else logs and
//     returns.
//
// Uses only Node.js built-in modules.

import { execSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  arch,
  hostname as osHostname,
  platform,
  tmpdir,
  userInfo,
} from "node:os";
import nodePath from "node:path";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { deriveAgentId, NAMESPACE_FLIGHTDECK } from "./agent_id.mjs";
import { canonicalizeUrl as _mcpCanonicalizeUrl } from "./mcp_identity.mjs";
import {
  buildPolicyDecisionBlock,
  classifyServer,
  clearSessionPolicyCache,
  fetchPolicies,
  readSessionPolicyCache,
  writeSessionPolicyCache,
} from "./mcp_policy.mjs";
import {
  lookupRemembered,
  writeRememberedDecision,
} from "./remembered_decisions.mjs";
import { uuid5 } from "./uuid5.mjs";

// Abort the fire-and-forget event POST after 2s. The hook runs inline in the
// Claude Code tool lifecycle, so a hung or unreachable control plane must
// never block the user's session; 2s is generous for a local stack and a hard
// ceiling for a slow one.
const TIMEOUT_MS = 2000;

// Claude Code gives a SessionEnd hook 1.5 s before it stops waiting and
// exits, against the 600 s it allows an ordinary hook. One slow POST
// already eats that budget (TIMEOUT_MS above is 2 s), and SessionEnd
// needs up to one POST per unflushed assistant turn plus the
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

// Bounds on the free-text values the plugin copies from the hook payload
// and the environment, measured in UTF-8 bytes because that is how
// ingestion measures them (a value that fits in code units but not in
// bytes would be rejected with 400 and the whole event lost). Claude
// Code's own values are short identifiers (startup, sdk-cli,
// prompt_input_exit); 64 bytes admits every known one and bounds a
// hostile environment without truncating a real value. Identity strings
// (MCP server key and source, tool name, tool use id) get the same
// 256-byte cap ingestion applies to agent_role, the comparable identity
// field.
export const MAX_SIGNAL_BYTES = 64;
export const MAX_MCP_IDENTITY_BYTES = 256;
// A Claude Code version is a semver string ("2.1.306", possibly with a
// pre-release or build suffix); 64 characters is far above any real one.
export const MAX_VERSION_CHARS = 64;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Control characters are the point of this pattern.
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f]/;

/**
 * A free-text value from the hook payload or the environment, or null
 * when it is not a non-empty string, exceeds ``max`` characters or
 * contains control characters. The values stay open pass-throughs;
 * they are only bounded.
 */
export function boundedToken(value, max) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "" || Buffer.byteLength(trimmed, "utf8") > max || CONTROL_CHARS_RE.test(trimmed)) {
    return null;
  }
  return trimmed;
}

/** A Claude Code version string, or null unless it is a bounded semver. */
export function boundedVersion(value) {
  const token = boundedToken(value, MAX_VERSION_CHARS);
  return token && SEMVER_RE.test(token) ? token : null;
}

/**
 * An identity string cut to MAX_MCP_IDENTITY_BYTES of UTF-8 on a code
 * point boundary; non-strings pass through.
 */
export function boundedIdentity(value) {
  if (typeof value !== "string") return value;
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= MAX_MCP_IDENTITY_BYTES) return value;
  // Back the cut off any UTF-8 continuation byte (10xxxxxx) so it lands
  // on the first byte of a code point and never splits one.
  let end = MAX_MCP_IDENTITY_BYTES;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

/**
 * The control-plane URL without its userinfo, for log lines: a server
 * configured as ``https://user:token@host`` must not leak the token into
 * stderr or the worker log.
 */
export function redactServerUrl(server) {
  return String(server).replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, "$1");
}

// The detached worker's stderr log holds one line per failed POST. It
// is truncated once it passes this size rather than growing without
// bound on a machine whose control plane is down for weeks; 256 KiB is
// thousands of lines, far more than a diagnosis needs.
export const SESSION_END_WORKER_LOG_MAX_BYTES = 256 * 1024;

// Placeholder for a failed tool's error text when capture is off. The
// text is content (a command's stderr, an Edit failure quoting the
// old_string it could not find, a token a failed command printed), so
// it follows the capture knobs; the block's class and abort flag stay.
export const REDACTED_ERROR_MESSAGE = "<redacted>";

// Tool error messages stay inline on the event payload, next to the
// metadata, so a failed tool is readable in the dashboard without a
// content fetch. 1000 characters holds a multi-line shell error or the
// head of a stack trace while keeping the row far below the ingestion
// request-body cap.
const TOOL_ERROR_MESSAGE_MAX_CHARS = 1000;

// Plugin version stamped on every session_start (parity with the
// Python sensor's wire contract). Read from the package metadata at
// module load; falls back to a sentinel string when the file is
// unreachable (rare — the plugin is always installed alongside its
// package.json). Used as the ``sensor_version`` field value on
// session_start events; ingestion's validator requires the field's
// presence as a string but does not constrain its content.
const PLUGIN_VERSION = (() => {
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(__dirname, "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    return `flightdeck-plugin/${pkg.version || "0.0.0"}`;
  } catch {
    return "flightdeck-plugin/unknown";
  }
})();

// ---------------------------------------------------------------------
// Env var resolution + defaults (zero-config flow).
// ---------------------------------------------------------------------

/**
 * Parse a string as a boolean, with an explicit fallback for the
 * "nothing here to interpret" cases: undefined, null, empty string,
 * and any value that doesn't clearly mean true or false. We fall back
 * to the default rather than guessing so a typo (e.g.
 * FLIGHTDECK_CAPTURE_PROMPTS=ture) preserves the documented default
 * behaviour instead of silently flipping.
 */
export function parseBool(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const v = String(value).trim().toLowerCase();
  if (v === "") return fallback;
  if (v === "true" || v === "1" || v === "yes" || v === "on") return true;
  if (v === "false" || v === "0" || v === "no" || v === "off") return false;
  return fallback;
}

/**
 * Resolve the plugin's four configuration knobs. Defaults target a
 * local ``make dev`` stack so ``claude --plugin-dir <path>`` works
 * with zero configuration for a developer who has just brought up the
 * stack. Production teams override via shell rc or a wrapper script.
 *
 * Rationale for each default:
 *   * ``server`` points at the dev nginx (localhost:4000). Any
 *     whitespace-only env var is treated as unset so a user who sets
 *     ``FLIGHTDECK_SERVER=""`` in a script does not silently break.
 *   * ``token`` defaults to ``tok_dev``, the seed token the dev
 *     compose stack accepts when ``ENVIRONMENT=dev``. Production
 *     deployments do not set ``ENVIRONMENT=dev`` so the seed token
 *     becomes inert there.
 *   * ``captureToolInputs`` defaults ON because the plugin only
 *     captures a sanitised whitelist (file paths, short command and
 *     query strings, <=200 chars). Without it tool events carry only
 *     the tool name which is far less useful for a developer
 *     inspecting their own work. Teams that want it off flip the env
 *     var.
 *   * ``capturePrompts`` defaults ON for the Claude Code plugin --
 *     developers running ``claude`` locally are observing their own
 *     session, and the Prompts tab is empty without captured LLM
 *     call content. The Python sensor keeps ``capture_prompts=False``
 *     as its default because it runs in production where prompts
 *     may carry PII and proprietary context. Users can
 *     opt out on the plugin with ``FLIGHTDECK_CAPTURE_PROMPTS=false``.
 */
export function resolveConfig(env = process.env) {
  const rawServer = (env.FLIGHTDECK_SERVER ?? "").trim() || "http://localhost:4000";
  // fetch() refuses a URL that carries credentials, so a
  // "https://user:token@host" server could never work and would only
  // leak the token into every failed-POST log line. Strip the userinfo
  // and say so; the bearer token is the one credential the plugin uses.
  const server = redactServerUrl(rawServer);
  if (server !== rawServer && env.FLIGHTDECK_QUIET !== "1") {
    process.stderr.write(
      "[flightdeck] WARN: FLIGHTDECK_SERVER carries credentials in the URL; " +
        "they are ignored. Authenticate with FLIGHTDECK_TOKEN.\n",
    );
  }
  const explicitToken = (env.FLIGHTDECK_TOKEN ?? "").trim();
  const token = explicitToken || "tok_dev";
  // Warn loudly on stderr when the seed dev token is in use. Loud is
  // the point: a production deployment that ships hooks without
  // FLIGHTDECK_TOKEN configured would otherwise silently authenticate
  // every POST as the development seed identity. The dev compose stack
  // accepts tok_dev when ENVIRONMENT=dev, so the warning is harmless
  // there; a production server that hasn't seeded tok_dev will refuse
  // the request with 401 (which the existing unreachable-line handler
  // surfaces). FLIGHTDECK_QUIET=1 suppresses the line so suites that
  // intentionally exercise the default-token path (zero-config)
  // don't pollute their captured stderr assertions.
  if (!explicitToken && env.FLIGHTDECK_QUIET !== "1") {
    process.stderr.write(
      "[flightdeck] WARN: using default token 'tok_dev'. " +
        "Set FLIGHTDECK_TOKEN=<your-token> for production. " +
        "Suppress this warning with FLIGHTDECK_QUIET=1.\n",
    );
  }
  return {
    server,
    token,
    captureToolInputs: parseBool(env.FLIGHTDECK_CAPTURE_TOOL_INPUTS, true),
    capturePrompts: parseBool(env.FLIGHTDECK_CAPTURE_PROMPTS, true),
  };
}

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
  const dir = join(tmpdir(), "flightdeck-plugin");

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
    markerKey = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
    process.stderr.write(
      "[flightdeck] WARN: hook event missing session_id; " +
        "falling back to cwd-keyed marker. Sessions may split on cd.\n",
    );
  }
  const file = join(dir, `session-${markerKey}.txt`);

  const fallback = () =>
    createHash("sha256")
      .update(`${Date.now()}-${process.pid}-${cwd}`)
      .digest("hex")
      .slice(0, 32);

  try {
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
  } catch {
    return fallback();
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
  const dir = join(tmpdir(), "flightdeck-plugin");
  let markerKey;
  const nativeId = claudeCodeSessionId(hookEvent);
  if (nativeId) {
    markerKey = markerKeyFor(nativeId);
  } else {
    markerKey = createHash("sha256").update(process.cwd()).digest("hex").slice(0, 16);
  }
  const targets = [`session-${markerKey}.txt`];
  if (sessionId) targets.push(`started-${sessionId}.txt`);
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
// Claude Code native session id + run-mode signals.
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
/**
 * Create the plugin's temp directory owner-only. mkdir's mode applies
 * only when the directory is created, so a directory left by an earlier
 * version (0755 under the usual umask) is tightened with a best-effort
 * chmod; when that fails the mode stays as it was.
 */
function mkdirOwnerOnly(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* not ours to change, or a platform without POSIX modes */
  }
}

export function claudeCodeSessionId(hookEvent = {}, env = process.env) {
  if (hookEvent && typeof hookEvent.session_id === "string" && hookEvent.session_id) {
    return hookEvent.session_id;
  }
  const fromEnv = (env.CLAUDE_CODE_SESSION_ID || "").trim();
  return fromEnv || null;
}

function markerKeyFor(nativeSessionId) {
  return createHash("sha256").update(nativeSessionId).digest("hex").slice(0, 16);
}

// Well-known CI environment markers, checked in order. The generic
// ``CI=true`` convention is the fallback when no provider-specific
// variable identifies the system.
export const CI_PROVIDER_ENV = [
  ["GITHUB_ACTIONS", "github"],
  ["GITLAB_CI", "gitlab"],
  ["CIRCLECI", "circleci"],
  ["BUILDKITE", "buildkite"],
  ["TRAVIS", "travis"],
  ["JENKINS_URL", "jenkins"],
  ["TF_BUILD", "azure"],
  ["BITBUCKET_BUILD_NUMBER", "bitbucket"],
  ["TEAMCITY_VERSION", "teamcity"],
];

export function detectCiProvider(env = process.env) {
  for (const [key, provider] of CI_PROVIDER_ENV) {
    if (env[key] !== undefined && env[key] !== "") return provider;
  }
  return parseBool(env.CI, false) ? "unknown" : null;
}

/**
 * Run-mode signals Claude Code exposes to hooks through the environment
 * rather than the hook payload:
 *
 *   * ``CLAUDE_CODE_ENTRYPOINT`` -- ``cli`` for an interactive terminal
 *     session, ``sdk-cli`` for ``claude -p`` / headless runs, and the
 *     SDK's own values for programmatic use.
 *   * ``CLAUDE_CODE_SESSION_ATTENDED`` -- ``1`` when a human is at the
 *     terminal, ``0`` for unattended runs.
 *   * ``CLAUDE_CODE_CHILD_SESSION`` -- ``1`` when Claude Code was
 *     launched from inside another Claude Code session.
 *   * ``CLAUDE_CODE_REMOTE`` -- ``true`` when Claude Code runs as a
 *     cloud session (unset in the local CLI); the cloud session's id
 *     arrives as ``CLAUDE_CODE_REMOTE_SESSION_ID``.
 *   * ``CI`` plus the provider-specific markers in CI_PROVIDER_ENV.
 *
 * The ingestion vocabulary for ``agent_type`` is locked to
 * ``coding`` / ``production``, so the plugin keeps stamping
 * ``agent_type=coding`` and puts the signals that distinguish an
 * interactive session from a headless, SDK, CI or remote run in
 * ``context``, where the dashboard can read them and a future vocabulary
 * can be derived from them server-side without a plugin change.
 *
 * ``extras.claudeCodeSessionId`` (the hook payload's session_id) and
 * ``extras.sessionSource`` (SessionStart's ``source``: startup, resume,
 * clear, compact or fork) land here too so every signal about the run
 * lives under one object.
 */
export function collectClaudeCodeSignals(env = process.env, extras = {}) {
  const signals = {};
  // The native id is reported only in its canonical UUID form; anything
  // else still keys the marker file (it is only hashed there) but does
  // not go on the wire.
  const nativeSessionId =
    boundedToken(extras.claudeCodeSessionId, MAX_SIGNAL_BYTES) ||
    boundedToken(env.CLAUDE_CODE_SESSION_ID, MAX_SIGNAL_BYTES);
  if (nativeSessionId && UUID_RE.test(nativeSessionId)) {
    signals.claude_code_session_id = nativeSessionId;
  }
  const sessionSource = boundedToken(extras.sessionSource, MAX_SIGNAL_BYTES);
  if (sessionSource) signals.session_source = sessionSource;
  const entrypoint = boundedToken(env.CLAUDE_CODE_ENTRYPOINT, MAX_SIGNAL_BYTES);
  if (entrypoint) signals.entrypoint = entrypoint;
  const attended = parseBool(env.CLAUDE_CODE_SESSION_ATTENDED, null);
  if (attended !== null) signals.attended = attended;
  if (parseBool(env.CLAUDE_CODE_CHILD_SESSION, false)) signals.child_session = true;
  if (parseBool(env.CLAUDE_CODE_REMOTE, false)) {
    signals.remote = true;
    const remoteSessionId = boundedToken(env.CLAUDE_CODE_REMOTE_SESSION_ID, MAX_SIGNAL_BYTES);
    if (remoteSessionId) signals.remote_session_id = remoteSessionId;
  }
  const ciProvider = detectCiProvider(env);
  if (ciProvider) {
    signals.ci = true;
    signals.ci_provider = ciProvider;
  }
  return signals;
}

// ---------------------------------------------------------------------
// Runtime context collection (parallels sensor/core/context.py).
// ---------------------------------------------------------------------

export function collectContext(extras = {}) {
  const ctx = { pid: process.pid, process_name: "claude-code" };

  const frameworks = [];

  try {
    const p = platform();
    ctx.os = p === "win32" ? "Windows" : p === "darwin" ? "Darwin" : "Linux";
  } catch {
    /* silent */
  }
  try {
    ctx.arch = arch();
  } catch {
    /* silent */
  }
  try {
    ctx.hostname = osHostname();
  } catch {
    /* silent */
  }
  try {
    ctx.user = userInfo().username;
  } catch {
    /* silent */
  }

  ctx.node_version = process.version;
  try {
    ctx.working_dir = process.cwd();
  } catch {
    /* silent */
  }

  const gitOpts = { timeout: 500, stdio: ["ignore", "pipe", "ignore"] };
  try {
    ctx.git_commit = execSync("git rev-parse --short HEAD", gitOpts)
      .toString()
      .trim();
  } catch {
    /* silent */
  }
  try {
    ctx.git_branch = execSync("git branch --show-current", gitOpts)
      .toString()
      .trim();
  } catch {
    /* silent */
  }
  try {
    const remote = execSync("git remote get-url origin", gitOpts)
      .toString()
      .trim();
    const clean = remote.replace(/https?:\/\/[^@]+@/, "https://");
    // Split on either separator: a Windows file-path remote
    // (C:\\repos\\foo.git) has no forward slash at all.
    const repo = clean.split(/[\\/]/).pop()?.replace(/\.git$/, "");
    if (repo) ctx.git_repo = repo;
  } catch {
    /* silent */
  }

  if (process.env.KUBERNETES_SERVICE_HOST) {
    ctx.orchestration = "kubernetes";
    const pod =
      process.env.MY_POD_NAME || process.env.POD_NAME || ctx.hostname;
    if (pod) ctx.k8s_pod = pod;
    const ns = process.env.MY_POD_NAMESPACE || process.env.POD_NAMESPACE;
    if (ns) ctx.k8s_namespace = ns;
    const node = process.env.MY_NODE_NAME || process.env.NODE_NAME;
    if (node) ctx.k8s_node = node;
  } else if (
    process.env.COMPOSE_PROJECT_NAME ||
    process.env.COMPOSE_SERVICE
  ) {
    ctx.orchestration = "docker-compose";
    if (process.env.COMPOSE_PROJECT_NAME)
      ctx.compose_project = process.env.COMPOSE_PROJECT_NAME;
    if (process.env.COMPOSE_SERVICE)
      ctx.compose_service = process.env.COMPOSE_SERVICE;
  }

  // Identify Claude Code itself in context.frameworks so the FRAMEWORK
  // facet in Investigate picks it up alongside sensor-reported frameworks.
  // Version comes from the transcript when available.
  // Only the transcript's version is trusted. CLAUDE_CODE_EXECPATH is
  // not used: when one Claude Code session is started from another's
  // shell it names the outermost binary, not the one hosting this
  // session, and a wrong version is worse than none.
  const version = boundedVersion(extras.claudeCodeVersion);
  frameworks.push(version ? `claude-code/${version}` : "claude-code");
  ctx.frameworks = frameworks;
  if (version) ctx.claude_code_version = version;

  // Native session id, how the session started, and the run-mode
  // signals (entrypoint, attended, child session, remote, CI). See
  // collectClaudeCodeSignals for why these live in context and not on
  // agent_type.
  Object.assign(ctx, collectClaudeCodeSignals(process.env, extras));

  // MCP server fingerprint capture from .mcp.json + ~/.claude.json.
  // The Claude Code plugin emits MCP_TOOL_CALL events
  // and the session-level mcp_servers context but cannot observe MCP
  // resource reads / prompt fetches / list operations (those bypass
  // the hook surface entirely). The mcp_servers fingerprint list
  // surfaces in the SessionDrawer's MCP SERVERS panel and feeds the
  // Investigate MCP SERVER facet aggregation. Version + capabilities
  // are best-effort because the plugin can't inspect the actual MCP
  // handshake — see plugin/README.md for the documented gap.
  try {
    const mcpServers = loadMcpServerFingerprints(extras.cwd || process.cwd());
    if (mcpServers && mcpServers.length > 0) {
      ctx.mcp_servers = mcpServers;
    }
  } catch {
    /* silent — never crash a hook on broken user config */
  }

  // Mark hook-based sessions as observer-only so the dashboard hides
  // the kill-switch UI. Claude Code hooks fire after the event has
  // already happened and the plugin never sits in the agent's hot
  // path, so a "Stop Agent" click would be a silent no-op. Python
  // sensor sessions omit this field entirely and the dashboard
  // treats "unset" as directive-capable. See dashboard/src/lib/
  // directives.ts.
  ctx.supports_directives = false;

  return ctx;
}

/**
 * Wrap ``collectContext`` so a throw or an empty result returns ``null``
 * instead of propagating. Callers use ``null`` to signal "omit the
 * context field from the outbound payload" rather than sending
 * ``context: {}``.
 *
 * A non-session_start event that arrives without context would leave the
 * worker's COALESCE upgrade as a no-op, so there is no correctness cost
 * to omitting; the benefit is that the worker-side logs don't report a
 * pointless upgrade attempt and the DB doesn't see an extra UPDATE. The
 * "or throws" branch is defensive -- ``collectContext`` already wraps
 * each syscall in try/catch, so in practice the check on
 * ``Object.keys(ctx).length === 0`` guards the "everything I tried to
 * read failed" edge case.
 */
export function safeCollectContext(extras = {}) {
  try {
    const ctx = collectContext(extras);
    if (!ctx || typeof ctx !== "object") return null;
    if (Object.keys(ctx).length === 0) return null;
    return ctx;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------
// Tool input sanitisation -- safe whitelist only.
// ---------------------------------------------------------------------

export function sanitizeToolInput(input) {
  if (!input || typeof input !== "object") return null;
  const safe = {};
  if (input.file_path) safe.file_path = input.file_path;
  if (input.command) safe.command = String(input.command).slice(0, 200);
  if (input.query) safe.query = String(input.query).slice(0, 200);
  if (input.pattern) safe.pattern = String(input.pattern).slice(0, 200);
  if (input.prompt) safe.prompt = String(input.prompt).slice(0, 100);
  return Object.keys(safe).length > 0 ? safe : null;
}

// ---------------------------------------------------------------------
// MCP tool-name parsing + server fingerprint discovery.
//
// Claude Code namespaces MCP tools as ``mcp__<server>__<tool>``. The
// hook payload's ``tool_name`` is the prefixed string; this helper
// splits it back into (server_name, tool_name) for per-event
// attribution. Server names containing ``__`` cannot be unambiguously
// disambiguated from a plain tool name with double underscores — the
// parser falls back to a "best-effort split on the first inner ``__``"
// strategy with a documented limitation. ``claude mcp list`` could
// validate at SessionStart but spawning a subprocess on every hook is
// not free; we accept the ambiguity and document.
//
// A null return signals "this is NOT an MCP tool name." Callers use
// that to route the event through the standard tool_call path
// instead.
// ---------------------------------------------------------------------

const MCP_TOOL_PREFIX = "mcp__";

// Claude Code keys a plugin-provided MCP server as
// ``plugin:<plugin>:<server>`` and flattens that key into the tool
// name as ``plugin_<plugin>_<server>`` (every character outside
// [A-Za-z0-9_-] becomes an underscore). The prefix identifies the
// flattened form so the colon form can be rebuilt.
const MCP_PLUGIN_SERVER_PREFIX = "plugin_";

/**
 * Rebuild Claude Code's server key from its flattened tool-name form.
 * ``plugin_claude-mem_mcp-search`` becomes
 * ``plugin:claude-mem:mcp-search``, the same string Claude Code puts in
 * ``hookEvent.mcp_server.name`` on versions that send it. The plugin
 * name is taken up to the first underscore -- marketplace plugin names
 * are kebab-case, so the split is exact unless a plugin name itself
 * contains an underscore, in which case the hook's ``mcp_server``
 * field (preferred by resolveMcpToolIdentity) is the authority.
 * Non-plugin server keys are returned unchanged.
 */
export function canonicalMcpServerName(rawServer) {
  if (typeof rawServer !== "string") return rawServer;
  if (!rawServer.startsWith(MCP_PLUGIN_SERVER_PREFIX)) return rawServer;
  const rest = rawServer.slice(MCP_PLUGIN_SERVER_PREFIX.length);
  const idx = rest.indexOf("_");
  if (idx <= 0 || idx >= rest.length - 1) return rawServer;
  return `plugin:${rest.slice(0, idx)}:${rest.slice(idx + 1)}`;
}

/**
 * The flattened form Claude Code uses for a server key inside a tool
 * name: every character outside [A-Za-z0-9_-] becomes an underscore.
 */
export function flattenMcpServerName(serverName) {
  return String(serverName).replace(/[^A-Za-z0-9_-]/g, "_");
}

export function parseMcpToolName(name) {
  if (typeof name !== "string" || !name.startsWith(MCP_TOOL_PREFIX)) {
    return null;
  }
  const rest = name.slice(MCP_TOOL_PREFIX.length);
  if (rest.length === 0) {
    return null;
  }
  const split = rest.indexOf("__");
  if (split <= 0 || split >= rest.length - 2) {
    // No inner ``__``, or it lands at the very start / end — the name
    // is malformed. Best-effort fallback: treat the whole rest as the
    // tool name with a null server attribution. Callers log a warn.
    return { server_name: null, server_key: null, tool_name: rest, parsed: false, source: null };
  }
  const serverKey = rest.slice(0, split);
  return {
    server_name: canonicalMcpServerName(serverKey),
    server_key: serverKey,
    tool_name: rest.slice(split + 2),
    parsed: true,
    source: serverKey.startsWith(MCP_PLUGIN_SERVER_PREFIX) ? "plugin" : null,
  };
}

/**
 * Resolve which MCP server and tool a hook event refers to. Current
 * Claude Code sends ``mcp_server: {name, source}`` on PreToolUse /
 * PostToolUse / PostToolUseFailure for MCP tools -- ``name`` is the
 * server key exactly as Claude Code holds it (``filesystem``,
 * ``plugin:claude-mem:mcp-search``) and ``source`` says where the
 * server was declared (``plugin``, project / user config). That field
 * is the authority when present: it also makes the tool-name split
 * exact for a server whose key contains ``__``, because the flattened
 * key can be stripped from the front of the tool name. Older versions
 * only give the tool name, so the parser's best-effort split applies.
 *
 * Returns null for a non-MCP tool name; otherwise
 * ``{server_name, server_key, tool_name, parsed, source}``.
 */
export function resolveMcpToolIdentity(hookEvent, toolName) {
  const parsed = parseMcpToolName(toolName);
  if (!parsed) return null;
  // A hint is honoured only when it is an object whose name is a
  // bounded, control-character-free string; anything else falls back
  // to the parsed name so a hostile hint cannot rename the server.
  const hint = hookEvent && hookEvent.mcp_server;
  const hintName =
    hint && typeof hint === "object" && !Array.isArray(hint)
      ? boundedToken(hint.name, MAX_MCP_IDENTITY_BYTES)
      : null;
  if (!hintName) return parsed;
  const hintSource =
    typeof hint.source === "string" && hint.source ? hint.source : parsed.source;
  const flat = flattenMcpServerName(hintName);
  const rest = toolName.slice(MCP_TOOL_PREFIX.length);
  const prefix = `${flat}__`;
  const toolFromHint =
    rest.startsWith(prefix) && rest.length > prefix.length
      ? rest.slice(prefix.length)
      : parsed.tool_name;
  return {
    server_name: hintName,
    server_key: flat,
    tool_name: toolFromHint,
    parsed: true,
    source: hintSource,
  };
}

/**
 * The tool's real wall time as measured by Claude Code
 * (``hookEvent.duration_ms`` on PostToolUse / PostToolUseFailure).
 * Null when the hook does not carry it (older Claude Code): the plugin
 * never substitutes its own process runtime, which says nothing about
 * the tool.
 */
export function hookDurationMs(hookEvent) {
  const value = hookEvent && hookEvent.duration_ms;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value);
}

/**
 * Whether a failed tool's error text may leave the machine. Claude
 * Code's ``error`` string is whatever the tool produced -- a command's
 * stderr, an Edit failure quoting the ``old_string`` it could not find,
 * a token a failed command printed -- so it is content and can carry
 * either tool input or tool output. Both knobs must be on.
 */
export function captureErrorText(cfg) {
  return Boolean(cfg && cfg.capturePrompts && cfg.captureToolInputs);
}

/**
 * Structured error block for a failed tool call, in the shape the
 * sensor's error taxonomy uses (``error_type`` / ``error_class`` /
 * ``message``). Claude Code reports the failure as a free-form
 * ``error`` string plus ``is_interrupt`` (true when the failure reached
 * Claude Code as an abort rather than as an error the tool reported),
 * so the taxonomy stays coarse: ``error_type=other``,
 * ``error_class=PluginToolError``, with ``interrupted`` carrying the
 * abort flag when the hook provides it. The message is content and is
 * sent only when ``captureText`` is true (see captureErrorText);
 * otherwise it is the fixed REDACTED_ERROR_MESSAGE, so the block still
 * says that the tool failed and how. A failure hook that carries no
 * error text still gets a block, otherwise the event would be
 * indistinguishable from a success.
 */
export function buildToolErrorBlock(hookEvent, captureText) {
  const raw = hookEvent ? hookEvent.error : null;
  let message;
  if (!captureText) {
    message = REDACTED_ERROR_MESSAGE;
  } else if (raw == null) {
    message = "tool failed (Claude Code reported no error detail)";
  } else if (typeof raw === "string") {
    message = raw;
  } else {
    message = JSON.stringify(raw);
  }
  const block = {
    error_type: "other",
    error_class: "PluginToolError",
    message:
      message.length > TOOL_ERROR_MESSAGE_MAX_CHARS
        ? `${message.slice(0, TOOL_ERROR_MESSAGE_MAX_CHARS)}…`
        : message,
  };
  if (hookEvent && typeof hookEvent.is_interrupt === "boolean") {
    block.interrupted = hookEvent.is_interrupt;
  }
  return block;
}

// ``.mcp.json`` (project-scoped) + ``~/.claude.json`` (user-scoped)
// declare the MCP servers Claude Code is configured with for the
// current working directory. Both files are JSON; missing or
// malformed files yield an empty list (we never crash a hook on
// corrupt user config). Fields per server entry mirror the
// MCPServerFingerprint shape the Python sensor emits, with one
// asymmetry: the plugin cannot inspect the actual
// MCP handshake (handshakes are invisible to hooks), so capability
// discovery + server version are best-effort or absent. Operators
// reading the dashboard see name + transport + command/URL — the
// fingerprint shape the asymmetric-coverage README documents.

export function loadMcpServerFingerprints(cwd) {
  const fingerprints = [];
  const seen = new Set();

  // Project-scoped .mcp.json sits at the repository root. Walk up
  // from cwd until we find one or hit filesystem root — the same
  // walk Claude Code itself does to resolve project-scoped servers.
  let dir = cwd;
  for (let i = 0; i < 32; i++) {
    const candidate = join(dir, ".mcp.json");
    try {
      const raw = readFileSync(candidate, "utf8");
      const parsed = JSON.parse(raw);
      const servers = parsed && typeof parsed === "object" ? parsed.mcpServers : null;
      if (servers && typeof servers === "object") {
        for (const [name, spec] of Object.entries(servers)) {
          if (seen.has(name)) continue;
          seen.add(name);
          fingerprints.push(buildFingerprintFromSpec(name, spec));
        }
      }
      break;
    } catch {
      /* continue walking up */
    }
    const parent = dirname(dir);
    if (!parent || parent === dir) break;
    dir = parent;
  }

  // User-scoped ~/.claude.json carries a ``projects.<cwd>.mcpServers``
  // block per project plus a top-level ``mcpServers`` block for
  // user-global servers. We parse both. The walk-up cwd matching is
  // approximate — Claude Code normalizes paths internally; we accept
  // an exact-match-or-no-match here because the alternative
  // (re-implementing Claude's path normalization) is fragile.
  try {
    const home = process.env.HOME || process.env.USERPROFILE;
    if (home) {
      const userFile = join(home, ".claude.json");
      const raw = readFileSync(userFile, "utf8");
      const parsed = JSON.parse(raw);
      // Top-level user-global servers.
      if (parsed && typeof parsed === "object" && parsed.mcpServers) {
        for (const [name, spec] of Object.entries(parsed.mcpServers)) {
          if (seen.has(name)) continue;
          seen.add(name);
          fingerprints.push(buildFingerprintFromSpec(name, spec));
        }
      }
      // Per-project servers — find the entry matching cwd.
      const projects = parsed?.projects;
      if (projects && typeof projects === "object" && projects[cwd]?.mcpServers) {
        for (const [name, spec] of Object.entries(projects[cwd].mcpServers)) {
          if (seen.has(name)) continue;
          seen.add(name);
          fingerprints.push(buildFingerprintFromSpec(name, spec));
        }
      }
    }
  } catch {
    /* silent */
  }

  return fingerprints;
}

function buildFingerprintFromSpec(name, spec) {
  // The mcpServers entry shape varies by transport:
  //   stdio: {"command": "npx", "args": [...], "env": {...}}
  //   http:  {"url": "https://...", "headers": {...}}
  //   sse:   {"type": "sse", "url": "..."}
  // We surface the human-readable fingerprint fields the dashboard's
  // MCPServersPanel renders. Capabilities are absent (the plugin
  // can't observe a handshake) — emitted as an empty object so the
  // wire shape matches what the sensor produces.
  let transport = null;
  let endpoint = null;
  if (spec && typeof spec === "object") {
    if (spec.url) {
      endpoint = String(spec.url);
      transport =
        typeof spec.type === "string"
          ? String(spec.type)
          : spec.url.startsWith("https://") || spec.url.startsWith("http://")
            ? "http"
            : "sse";
    } else if (spec.command) {
      transport = "stdio";
      const args = Array.isArray(spec.args) ? spec.args.join(" ") : "";
      endpoint = args ? `${spec.command} ${args}` : String(spec.command);
    }
  }
  return {
    name: String(name),
    transport,
    protocol_version: "",
    version: null,
    capabilities: {},
    instructions: null,
    // ``endpoint`` is plugin-only metadata — the Python sensor cannot
    // observe it because the SDK hides transport details below the
    // ClientSession surface. Documented in the dashboard contract as
    // "may be null on Python-sensor sessions, populated on plugin-
    // sourced sessions."
    endpoint,
  };
}

// ---------------------------------------------------------------------
// Transcript reader. Pulls the final LLM turn out of Claude Code's
// JSONL transcript so post_call events carry real tokens + model.
// ---------------------------------------------------------------------

// Claude Code stamps ``model: "<synthetic>"`` on assistant records it
// synthesises into the transcript itself — tool-result coordination
// turns, internal Agent SDK orchestration messages, etc. — that did
// not originate from a real LLM call. Forwarding that literal as the
// pre_call / post_call model name pollutes the events table (the
// model facet ends up with a ``<synthetic>`` bucket) and breaks
// downstream provider detection. The constant is exported so the
// test suite can verify the skip without re-spelling the literal.
export const SYNTHETIC_MODEL = "<synthetic>";

/**
 * Returns ``true`` when ``model`` is a usable LLM identifier — i.e.,
 * non-empty AND not Claude Code's synthetic-turn sentinel. Callers
 * use this when picking the most recent ``message.model`` out of a
 * transcript: synthetic-turn records are skipped in favour of the
 * preceding real assistant turn (or the cached SessionStart model).
 */
export function isRealModel(model) {
  return Boolean(model) && model !== SYNTHETIC_MODEL;
}

/**
 * Read a JSONL transcript and return every LLM turn, in order.
 *
 * One LLM call can span multiple assistant JSONL records (one per
 * streamed content block -- thinking, text, tool_use). All records
 * that belong to the same call share the same `message.id`. The final
 * record's `usage` object is the authoritative accumulated usage. We
 * group by `message.id` in order and pair each group with the most
 * recent user-role turn that preceded it (for latency calculation).
 *
 * Multi-LLM-turn conversations (assistant makes a tool call, gets a
 * tool_result user-role reply, makes another LLM call) produce one
 * entry in the returned array per LLM call, not per user prompt. That
 * matches the Python sensor's one-post_call-per-LLM-call semantics.
 *
 * Returns [] when the transcript is missing or has no assistant records.
 */
export function readTurns(transcriptPath) {
  if (!transcriptPath) return [];
  let raw;
  try {
    raw = readFileSync(transcriptPath, "utf8");
  } catch {
    return [];
  }
  const lines = raw.split("\n").filter((l) => l.length > 0);
  // "Last user-role record we saw" -- both real prompts and tool_result
  // injections. We track it per-record rather than per-prompt because
  // every new assistant turn (including follow-up turns after a
  // tool_result) wants its latency measured against the immediately
  // preceding user-role record, which is the tool_result reply when
  // the assistant is continuing a tool-use loop.
  let lastUser = null;
  let lastClaudeVersion = null;
  const groups = new Map();
  const groupOrder = [];
  for (const line of lines) {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof rec !== "object" || rec === null) continue;
    if (rec.version && typeof rec.version === "string") {
      lastClaudeVersion = rec.version;
    }
    if (rec.type === "user") {
      const content = rec.message?.content;
      // Normalise to a string for downstream content capture -- either
      // the raw prompt or a short description of the tool_result reply.
      const userContent =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content
            : null;
      if (userContent !== null) {
        lastUser = {
          content: userContent,
          timestamp: rec.timestamp,
          promptId: rec.promptId,
        };
      }
    } else if (rec.type === "assistant") {
      const messageId = rec.message?.id;
      if (!messageId) continue;
      // Synthetic-turn records (model="<synthetic>", no real LLM
      // call) must never set the group's model. Real turns can land
      // in any order relative to the synthetic ones in the same
      // message-id group; ``isRealModel`` is the gate so a synthetic
      // record arriving first does not poison the bucket. A later
      // real record can still upgrade ``model`` once the gate
      // passes.
      const recModel = rec.message?.model;
      let group = groups.get(messageId);
      if (!group) {
        group = {
          messageId,
          model: isRealModel(recModel) ? recModel : null,
          firstTimestamp: rec.timestamp,
          lastTimestamp: rec.timestamp,
          usage: rec.message?.usage || null,
          contentBlocks: [],
          userAtStart: lastUser,
        };
        groups.set(messageId, group);
        groupOrder.push(messageId);
      } else if (!isRealModel(group.model) && isRealModel(recModel)) {
        group.model = recModel;
      }
      group.lastTimestamp = rec.timestamp || group.lastTimestamp;
      if (rec.message?.usage) group.usage = rec.message.usage;
      const blocks = rec.message?.content;
      if (Array.isArray(blocks)) {
        for (const b of blocks) group.contentBlocks.push(b);
      }
    }
  }
  const out = [];
  for (const id of groupOrder) {
    const group = groups.get(id);
    out.push({
      messageId: group.messageId,
      model: group.model,
      firstTimestamp: group.firstTimestamp,
      lastTimestamp: group.lastTimestamp,
      usage: group.usage || {},
      contentBlocks: group.contentBlocks,
      userTurn: group.userAtStart,
      claudeCodeVersion: lastClaudeVersion,
    });
  }
  return out;
}

/**
 * Convenience wrapper: return the most recent turn, or null. Kept for
 * callers that only want the final turn (e.g. version-probe on
 * SessionStart).
 */
export function readLatestTurn(transcriptPath) {
  const turns = readTurns(transcriptPath);
  return turns.length > 0 ? turns.at(-1) : null;
}

/**
 * Compute token fields from a transcript usage object, matching the
 * Python sensor's AnthropicProvider semantics:
 *   tokens_input = uncached + cache_read + cache_creation
 *   tokens_cache_read / tokens_cache_creation surfaced separately
 *   tokens_output = output_tokens
 * Missing fields default to 0.
 */
export function tokensFromUsage(usage = {}) {
  const uncached = Number(usage.input_tokens || 0);
  const cacheRead = Number(usage.cache_read_input_tokens || 0);
  const cacheCreation = Number(usage.cache_creation_input_tokens || 0);
  const output = Number(usage.output_tokens || 0);
  const input = uncached + cacheRead + cacheCreation;
  return {
    tokens_input: input,
    tokens_output: output,
    tokens_total: input + output,
    tokens_cache_read: cacheRead,
    tokens_cache_creation: cacheCreation,
  };
}

/**
 * Compute latency_ms between a user turn and the assistant response.
 * Falls back to null when either timestamp is missing or malformed.
 */
export function computeLatencyMs(userTurn, assistantLastTimestamp) {
  if (!userTurn || !userTurn.timestamp || !assistantLastTimestamp) return null;
  const t0 = Date.parse(userTurn.timestamp);
  const t1 = Date.parse(assistantLastTimestamp);
  if (Number.isNaN(t0) || Number.isNaN(t1) || t1 < t0) return null;
  return t1 - t0;
}

// ---------------------------------------------------------------------
// Event-type mapping.
// ---------------------------------------------------------------------

// Maps Claude Code hook names to Flightdeck event_types. Notably
// PreToolUse is intentionally absent -- PostToolUse already emits a
// tool_call per invocation, matching the Python sensor's post-hoc
// tool_call extraction. A parallel pre-tool event would double-report
// every tool use and render as "unknown model" in the dashboard since
// pre-tool hooks do not know which LLM call triggered them.
// PostToolUseFailure fires for every tool (a non-zero Bash exit, a
// Read on a missing file, an MCP call that errored) and maps to the
// same tool_call event with a structured ``error`` block, so a failed
// tool and a successful one are the same row shape with one extra
// field.
export const EVENT_MAP = {
  SessionStart: "session_start",
  UserPromptSubmit: "pre_call",
  PostToolUse: "tool_call",
  PostToolUseFailure: "tool_call",
  Stop: "post_call",
  SessionEnd: "session_end",
  PreCompact: "tool_call",
};

// ---------------------------------------------------------------------
// MCP tool-call emission (Claude Code plugin path).
//
// The plugin emits MCP_TOOL_CALL only — resource
// reads, prompt fetches, and list operations are invisible to the
// hook surface. The wire shape matches what the Python sensor's
// MCP interceptor produces:
//
//   server_name, transport, tool_name, arguments, result, duration_ms
//
// Differences from the sensor path:
//
//   * ``transport`` is read from the session's mcp_servers fingerprint
//     list (loaded from .mcp.json + ~/.claude.json). The hook payload
//     itself does not carry transport metadata, so we look up by
//     server_name. If the server isn't in the fingerprint list (e.g.
//     a server added mid-session via ``claude mcp add``) we emit
//     transport=null and the dashboard renders "—".
//   * ``error`` is populated on PostToolUseFailure events with the
//     hookEvent.error string lifted into the structured taxonomy
//     shape (error_type=other, error_class=PluginToolError). The
//     plugin doesn't get JSON-RPC error codes — those live below the
//     hook surface — so the taxonomy stays coarse.
//   * ``arguments`` and ``result`` capture is gated on the existing
//     captureToolInputs / capturePrompts knobs. MCP
//     bypasses the sanitiser whitelist (the keep-list would drop
//     every MCP arg shape).
// ---------------------------------------------------------------------

async function emitMCPToolCallEvent({
  cfg,
  sessionId,
  basePayload,
  hookEvent,
  hookName,
  mcpIdentity,
}) {
  // Look up transport by server_name from the session's fingerprint
  // list. The cache is built once per process via collectContext for
  // SessionStart but the dispatch branch here runs in fresh hook
  // processes — re-load each time. Best-effort; on failure transport
  // is null and the dashboard renders that gracefully. Plugin-provided
  // servers are declared in the plugin's own .mcp.json, not the
  // project's, so they resolve to null here by design.
  let transport = null;
  try {
    const fingerprints = loadMcpServerFingerprints(process.cwd());
    if (mcpIdentity.server_name) {
      const match = fingerprints.find(
        (s) => s.name === mcpIdentity.server_name || s.name === mcpIdentity.server_key,
      );
      if (match) transport = match.transport;
    }
  } catch {
    /* silent */
  }

  // Capture-on arguments: bypass the whitelist sanitiser (its
  // keep-list would drop every MCP arg shape).
  const argumentsCapture =
    cfg.captureToolInputs && hookEvent.tool_input != null
      ? hookEvent.tool_input
      : null;

  // Capture-on result: same posture as the existing tool_call path,
  // gated on capturePrompts. The wire shape mirrors what the sensor
  // produces — a CallToolResult-like dict with the response content.
  let resultCapture = null;
  if (cfg.capturePrompts && hookEvent.tool_response != null) {
    resultCapture =
      typeof hookEvent.tool_response === "string"
        ? { content: [{ type: "text", text: hookEvent.tool_response }] }
        : hookEvent.tool_response;
  }

  // Failure path — PostToolUseFailure. Hook event carries an ``error``
  // (string or object). Lift into the structured MCP error shape so
  // the dashboard's MCPEventDetails error block renders consistently
  // with sensor-produced errors.
  const errorPayload =
    hookName === "PostToolUseFailure"
      ? buildToolErrorBlock(hookEvent, captureErrorText(cfg))
      : null;

  // Real tool duration as measured by Claude Code; null on versions
  // that do not send it (never the hook's own process runtime).
  const duration_ms = hookDurationMs(hookEvent);

  const payload = {
    ...basePayload,
    event_type: "mcp_tool_call",
    server_name: boundedIdentity(mcpIdentity.server_name),
    transport,
    tool_name: boundedIdentity(mcpIdentity.tool_name),
    duration_ms,
    timestamp: new Date().toISOString(),
  };
  // mcp_server is a pass-through of what Claude Code sent ({name,
  // source}, Claude Code 2.1.274+) and is absent when the hook carried
  // none; server_name above is the resolved identity on every version.
  // Only a well-formed object goes through: a string name within the
  // identity cap and a source that is a string within the cap, null,
  // or absent -- exactly what ingestion accepts.
  const hint = hookEvent.mcp_server;
  if (hint && typeof hint === "object" && !Array.isArray(hint)) {
    const name = boundedToken(hint.name, MAX_MCP_IDENTITY_BYTES);
    const sourceOk =
      hint.source === undefined ||
      hint.source === null ||
      boundedToken(hint.source, MAX_MCP_IDENTITY_BYTES) !== null;
    if (name && sourceOk) {
      payload.mcp_server =
        hint.source === undefined ? { name: hint.name } : { name: hint.name, source: hint.source };
    }
  }
  const toolUseId = boundedToken(hookEvent.tool_use_id, MAX_MCP_IDENTITY_BYTES);
  if (toolUseId) payload.tool_use_id = toolUseId;

  // Tool args + result live in event_content's dedicated tool_input /
  // tool_output columns, not inline on the payload. Plugin parity
  // with the sensor's _build_tool_capture_content envelope — wire
  // shape is byte-identical so the worker's InsertEventContent
  // consumes both surfaces uniformly. captureToolInputs gates
  // whether they are captured, not where they land.
  if (argumentsCapture != null || resultCapture != null) {
    payload.has_content = true;
    payload.content = buildToolCaptureContent({
      toolInput: argumentsCapture,
      toolOutput: resultCapture,
      serverName: mcpIdentity.server_name || "",
      sessionId,
    });
  }
  if (errorPayload != null) payload.error = errorPayload;

  await postEvent(cfg.server, cfg.token, sessionId, payload);
}

/**
 * Build the event_content envelope for tool capture using the
 * dedicated ``tool_input`` / ``tool_output`` columns (migration
 * 000021). Mirrors the sensor's ``_build_tool_capture_content``
 * wire shape byte-for-byte so the worker's ``InsertEventContent``
 * consumes both surfaces uniformly.
 *
 * ``response: {}`` ships explicitly because event_content.response
 * is a NOT NULL column that predates tool capture — see the sensor
 * helper for the same constraint workaround. The
 * operationally-meaningful tool capture lives in tool_input /
 * tool_output.
 */
export function buildToolCaptureContent({
  toolInput,
  toolOutput,
  serverName,
  sessionId,
}) {
  return {
    system: null,
    messages: [],
    tools: null,
    response: {},
    input: null,
    tool_input: toolInput == null ? null : toolInput,
    tool_output: toolOutput == null ? null : toolOutput,
    provider: "mcp",
    model: serverName || "",
    session_id: sessionId,
    event_id: "",
    captured_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------
// SubagentStart / SubagentStop emission.
//
// The plugin's standard dispatch emits events for the OUTER session
// — the one Claude Code invocation owns. When a Task subagent
// spawns, Claude Code fires SubagentStart with a hookEvent that
// carries:
//
//   * ``session_id`` — the outer session's id (the parent)
//   * the subagent's type / role (``subagent_type`` or
//     ``agent_type``, depending on Claude Code version; we read
//     either as the role string)
//   * ``tool_use_id`` — a stable correlator for THIS specific Task
//     invocation; SubagentStop carries the same value
//   * ``tool_input.prompt`` — the parent's input to the subagent
//   * (SubagentStop only) ``tool_response`` — the subagent's
//     response back to the parent
//
// We emit a CHILD session_start (or session_end) whose ``session_id``
// is a deterministic uuid5 derived from
// ``(outer_session_id, tool_use_id)`` so SubagentStart and the
// matching SubagentStop produce the same child id without any
// disk-marker plumbing. ``parent_session_id`` carries the outer
// session's id so the worker writes the relationship column.
// ``agent_role`` joins the agent_id derivation as the conditional
// 6th input — same uuid the Python sensor produces for
// a parent / role pair on the same identity 5-tuple.
//
// SubagentStop is the canonical child end-of-life signal.
// PostToolUseFailure on a Task tool stays in the existing tool_call
// dispatch path (parent's event with the error block); we do NOT
// emit a child session_end here, because a delayed real
// SubagentStop would then race a synthetic one.
// ---------------------------------------------------------------------

export function _subagentRole(hookEvent) {
  // Claude Code's exact field name for the subagent's type label
  // varies by version. Try the documented ones in order; fall back
  // to the empty string (which the agent_id derivation collapses
  // to the 5-tuple form).
  const raw =
    hookEvent.subagent_type ||
    hookEvent.agent_type ||
    hookEvent.subagent ||
    "";
  return typeof raw === "string" ? raw : String(raw || "");
}

export function _subagentCorrelator(hookEvent) {
  // Stable correlator linking SubagentStart, every interior hook
  // fired during the subagent's execution, and SubagentStop to the
  // same child session.
  //
  // Real Claude Code (Opus 4.7+) populates ``agent_id`` on every
  // hook fired in subagent context — SubagentStart, every interior
  // PostToolUse / PreToolUse / Stop, and SubagentStop — with the
  // SAME value. This is the authoritative correlator for the modern
  // Agent tool surface and the only field present on SubagentStart
  // (which Claude Code does NOT supply tool_use_id for).
  //
  // ``tool_use_id`` / ``subagent_id`` / ``id`` remain as fallbacks
  // for older Claude Code versions, the playground/14 synthetic
  // harness, and any future surface that uses a different field
  // name. The first non-empty value wins; agent_id is checked first
  // so the modern surface routes correctly without touching the
  // playground / unit-test fixtures.
  return (
    hookEvent.agent_id ||
    hookEvent.tool_use_id ||
    hookEvent.subagent_id ||
    hookEvent.id ||
    null
  );
}

export function _subagentChildSessionId(outerSessionId, correlator) {
  // Deterministic uuid5 in the same NAMESPACE_FLIGHTDECK as agent_id
  // so future reverse-derivation tools have one constant to anchor
  // against. The path scheme starts with ``flightdeck:subagent://``
  // so it can't collide with the agent_id derivation's
  // ``flightdeck://`` paths even if a clever adversary chose
  // colliding inputs.
  return uuid5(
    NAMESPACE_FLIGHTDECK,
    `flightdeck:subagent://${outerSessionId}/${correlator}`,
  );
}

// Derive the subagent's per-execution transcript path from
// the parent's transcript path and the subagent's agent_id.
//
// Claude Code stores each subagent's LLM turns in a SEPARATE JSONL
// file at:
//
//   <parent_transcript_dir>/<parent_session_id>/subagents/agent-<agent_id>.jsonl
//
// e.g. parent ``…/<dir>/47a0eaef-…-9130fcdca5df.jsonl`` →
//   subagent ``…/<dir>/47a0eaef-…-9130fcdca5df/subagents/agent-a3017….jsonl``
//
// The plugin's transcript reader (``readTurns``) operates on a
// single .jsonl file. Without this derivation, interior PostToolUse
// hooks fired during a subagent's execution see the PARENT'S
// transcript — which contains the subagent's tool calls but NOT
// the subagent's LLM assistant turns (those live in the per-
// subagent file). The result: post_call events for the subagent
// land with tokens_input/output/total = 0 because the assistant
// turn carrying ``message.usage`` was never read.
//
// SubagentStop hooks DO carry an explicit ``agent_transcript_path``
// field on the hook payload — when present we prefer that over
// the derivation. Interior PostToolUse hooks don't, so the
// derivation is the only path.
//
// Returns null when either input is missing — callers must fall
// back to the parent's transcript_path so the function never
// silently produces a malformed path.
export function _subagentTranscriptPath(parentTranscriptPath, subagentAgentId) {
  if (!parentTranscriptPath || typeof parentTranscriptPath !== "string") {
    return null;
  }
  if (!subagentAgentId || typeof subagentAgentId !== "string") {
    return null;
  }
  const parentDir = dirname(parentTranscriptPath);
  const parentBase = basename(parentTranscriptPath).replace(/\.jsonl$/i, "");
  if (!parentBase) return null;
  return join(parentDir, parentBase, "subagents", `agent-${subagentAgentId}.jsonl`);
}

// Interior-event routing for Claude Code subagents.
//
// When Claude Code runs an Agent-tool subagent, every interior hook
// (PostToolUse, PreToolUse, Stop, etc.) fires with the OUTER session's
// ``session_id`` but with two extra fields populated:
//
//   * ``agent_id``   — the subagent's stable correlator (same value
//                      Claude Code passed on SubagentStart and will
//                      pass on SubagentStop).
//   * ``agent_type`` — the subagent's role label (e.g. ``"Explore"``).
//
// Both fields are absent (null / undefined) on hooks fired outside
// subagent context — i.e. the parent's own tool-call lifecycle.
// Their presence is the discriminator: when we see ``agent_id`` set
// on a non-Subagent-named hook, we are inside the subagent's
// execution and the event must land under the CHILD session, not
// the parent.
//
// Using the parent's session_id for these interior events would
// leave the child session row empty in the dashboard while the
// parent collected the subagent's tool calls and LLM turns. The
// playground/14 synthetic harness cannot catch that regression
// because it never simulates the SubagentStart →
// interior-PostToolUse → SubagentStop sequence (it fires the
// boundary events alone); only a real Claude Code run exercises it.
//
// Returns null when the hook is NOT in subagent context (parent's
// own event); returns a context object with the remapped child
// identity when it IS. The caller (main()) overlays the returned
// fields onto basePayload before emission so every downstream event
// type — pre_call, post_call, tool_call, mcp_*, the synthetic
// session_start backstop — automatically lands under the child.
export function _subagentInteriorContext({
  hookEvent,
  hookName,
  parentSessionId,
  parentAgentName,
  identityUser,
  identityHostname,
}) {
  // SubagentStart / SubagentStop have their own dedicated dispatch
  // (emitSubagentEvent) and do NOT take this path. Recognising them
  // here would double-emit the child session_start / session_end.
  if (hookName === "SubagentStart" || hookName === "SubagentStop") {
    return null;
  }
  const agentIdField = hookEvent && hookEvent.agent_id;
  if (!agentIdField || typeof agentIdField !== "string") {
    return null;
  }
  const role =
    hookEvent.subagent_type ||
    hookEvent.agent_type ||
    hookEvent.subagent ||
    "";
  const childSessionId = _subagentChildSessionId(parentSessionId, agentIdField);
  const childAgentName = role ? `${parentAgentName}/${role}` : parentAgentName;
  const childAgentId = deriveAgentId({
    agent_type: "coding",
    user: identityUser,
    hostname: identityHostname,
    client_type: "claude_code",
    agent_name: parentAgentName,
    agent_role: role,
  });
  // Subagent's per-execution transcript path. Interior PostToolUse
  // hooks fired during the subagent's run carry the PARENT'S
  // transcript_path on hookEvent — the per-subagent JSONL lives at
  // a derived location (see _subagentTranscriptPath). flushPostCall
  // Turns reads this path so the subagent's assistant turns
  // (carrying ``message.usage``) emit post_call events with real
  // tokens_input/output/total instead of zeros.
  const subagentTranscriptPath = _subagentTranscriptPath(
    hookEvent && hookEvent.transcript_path,
    agentIdField,
  );
  return {
    sessionId: childSessionId,
    parentSessionId,
    agentRole: role || null,
    agentId: childAgentId,
    agentName: childAgentName,
    subagentTranscriptPath,
  };
}

function _captureMessage(body) {
  if (body == null) return null;
  return {
    body,
    captured_at: new Date().toISOString(),
  };
}

// Sub-agent message routing thresholds. Mirror the
// constants in sensor/flightdeck_sensor/core/session.py so the
// plugin and Python sensor produce identical wire shapes for
// equivalent body sizes — same inline / overflow / hard-reject
// boundaries.
//
// Bodies up to SUBAGENT_INLINE_THRESHOLD_BYTES ride inline on the
// payload's ``incoming_message`` / ``outgoing_message`` field;
// bodies above the threshold but at or below SUBAGENT_HARD_CAP_BYTES
// route through the existing event_content path
// (has_content=true on the event, full body on payload.content
// in the PromptContent envelope shape the worker's
// InsertEventContent expects); bodies above the hard cap are
// dropped with a stderr WARN.
const SUBAGENT_INLINE_THRESHOLD_BYTES = 8 * 1024;
const SUBAGENT_HARD_CAP_BYTES = 2 * 1024 * 1024;
const SUBAGENT_OVERFLOW_PROVIDER = "flightdeck-subagent";

/**
 * Resolve a sub-agent message into ``{stubOrInline, contentEnvelope}``
 * by body size. Mirrors :py:meth:`Session._route_subagent_message`
 * on the sensor side — same byte-size measurement (JSON-encoded
 * body), same threshold values, same wire shapes for inline / stub
 * / overflow envelopes.
 *
 * Returns ``{stubOrInline: null, contentEnvelope: null}`` when the
 * body is absent / capture is off / body exceeds the hard cap.
 */
function _routeSubagentMessage(body, capturePrompts, direction) {
  if (body == null || !capturePrompts) {
    return { stubOrInline: null, contentEnvelope: null };
  }
  // JSON-encode once to size — same encoding the worker sees, so
  // this byte count is the authoritative measure for the
  // inline-vs-overflow decision.
  const jsonBody = JSON.stringify(body);
  const size = Buffer.byteLength(jsonBody, "utf8");
  const capturedAt = new Date().toISOString();
  if (size > SUBAGENT_HARD_CAP_BYTES) {
    process.stderr.write(
      `flightdeck: sub-agent ${direction}_message body exceeds ` +
        `${SUBAGENT_HARD_CAP_BYTES}-byte hard cap (size=${size} ` +
        `bytes); dropped.\n`,
    );
    return { stubOrInline: null, contentEnvelope: null };
  }
  if (size <= SUBAGENT_INLINE_THRESHOLD_BYTES) {
    return {
      stubOrInline: { body, captured_at: capturedAt },
      contentEnvelope: null,
    };
  }
  // Overflow → event_content via the existing prompt-capture path. The
  // PromptContent envelope's NOT NULL columns
  // (``messages`` default ``[]``, ``response`` JSONB NOT NULL) are
  // satisfied by an empty messages list and a response object that
  // carries the body + direction discriminator. ``provider`` =
  // "flightdeck-subagent" lets the dashboard's content-fetch
  // consumer pick the sub-agent renderer over PromptViewer.
  return {
    stubOrInline: {
      has_content: true,
      content_bytes: size,
      captured_at: capturedAt,
    },
    contentEnvelope: {
      provider: SUBAGENT_OVERFLOW_PROVIDER,
      model: "",
      system: null,
      messages: [],
      tools: null,
      response: { direction, body, captured_at: capturedAt },
      input: null,
    },
  };
}

async function emitSubagentEvent({
  cfg,
  hookName,
  hookEvent,
  outerSessionId,
  basePayload,
  agentName,
  identityUser,
  identityHostname,
}) {
  const role = _subagentRole(hookEvent);
  const correlator = _subagentCorrelator(hookEvent);
  if (!correlator) {
    // Without a correlator we can't pair Start with Stop. Log and
    // bail rather than emitting half a relationship that the
    // worker would later struggle to close. The modern Claude Code
    // surface populates ``agent_id`` on Subagent hooks; older
    // surfaces fell back to ``tool_use_id``. Either should be
    // present; absence here means a Claude Code version skew the
    // plugin's correlator list doesn't yet cover.
    process.stderr.write(
      `flightdeck: ${hookName} payload missing agent_id and ` +
        `tool_use_id; child session emission skipped.\n`,
    );
    return;
  }

  const childSessionId = _subagentChildSessionId(outerSessionId, correlator);
  const childAgentName = role ? `${agentName}/${role}` : agentName;
  const childAgentId = deriveAgentId({
    agent_type: "coding",
    user: identityUser,
    hostname: identityHostname,
    client_type: "claude_code",
    agent_name: agentName,
    agent_role: role,
  });

  const payload = {
    ...basePayload,
    session_id: childSessionId,
    parent_session_id: outerSessionId,
    agent_role: role || null,
    agent_id: childAgentId,
    agent_name: childAgentName,
    event_type: hookName === "SubagentStart" ? "session_start" : "session_end",
    tool_name: null,
    tool_input: null,
    is_subagent_call: false,
    latency_ms: null,
    timestamp: new Date().toISOString(),
    has_content: false,
    content: null,
  };
  // Match the parent session_start contract: ingestion requires
  // sensor_version on every session_start. Sub-agent session_start
  // emits the same field so the wire contract holds; session_end
  // doesn't need it but having the field doesn't break anything.
  if (hookName === "SubagentStart") {
    payload.sensor_version = PLUGIN_VERSION;
    // Declare capture posture so the worker enforces it server-side
    // for the child session too (parity with the parent session_start).
    payload.capture_prompts = cfg.capturePrompts;
  }

  // Sub-agent message routing. Body size decides
  // whether the message lives inline on payload (≤ 8 KiB) or rides
  // through the existing event_content path (> 8 KiB and ≤ 2
  // MiB). _routeSubagentMessage handles capture-off + hard-cap
  // rejection inline; here we just stamp whatever it returns.
  if (hookName === "SubagentStart") {
    const promptBody =
      hookEvent.tool_input && typeof hookEvent.tool_input === "object"
        ? hookEvent.tool_input.prompt ?? null
        : null;
    const { stubOrInline, contentEnvelope } = _routeSubagentMessage(
      promptBody, cfg.capturePrompts, "incoming",
    );
    if (stubOrInline) payload.incoming_message = stubOrInline;
    if (contentEnvelope) {
      payload.has_content = true;
      payload.content = contentEnvelope;
    }
  } else {
    // SubagentStop. Two responsibilities here:
    //
    //   1. Flush any unemitted assistant turns from the subagent's
    //      per-execution transcript as post_call events, mirroring
    //      what SessionEnd does for parent sessions. Without this
    //      the subagent's FINAL LLM turn (the one not followed by
    //      a tool call, so no interior PostToolUse triggered the
    //      flush) lands as zero-token void in the dashboard.
    //      Prefer the explicit ``agent_transcript_path`` field on
    //      the SubagentStop payload (Claude Code provides it);
    //      fall back to the derived path so older Claude Code
    //      versions or subtle layout differences still work.
    //
    //   2. Stamp ``outgoing_message`` with the subagent's response
    //      back to the parent (cross-agent message capture).
    const subagentTranscript =
      (typeof hookEvent.agent_transcript_path === "string" &&
        hookEvent.agent_transcript_path) ||
      _subagentTranscriptPath(hookEvent.transcript_path, correlator);
    if (subagentTranscript) {
      try {
        const childBasePayload = {
          ...basePayload,
          session_id: childSessionId,
          parent_session_id: outerSessionId,
          agent_role: role || null,
          agent_id: childAgentId,
          agent_name: childAgentName,
        };
        await flushPostCallTurns({
          cfg,
          sessionId: childSessionId,
          basePayload: childBasePayload,
          turns: readTurns(subagentTranscript),
          capturePrompts: cfg.capturePrompts,
        });
      } catch (err) {
        // Transcript-read failures are not fatal — we still emit
        // the session_end so the child session closes cleanly. The
        // missing post_calls just means the subagent's final turn
        // won't show in the dashboard; the worker's lazy-create
        // path still tracks the session itself.
        process.stderr.write(
          `flightdeck: SubagentStop transcript flush failed for ` +
            `${childSessionId}: ${err?.message || err}\n`,
        );
      }
    }
    const { stubOrInline, contentEnvelope } = _routeSubagentMessage(
      hookEvent.tool_response ?? null,
      cfg.capturePrompts,
      "outgoing",
    );
    if (stubOrInline) payload.outgoing_message = stubOrInline;
    if (contentEnvelope) {
      payload.has_content = true;
      payload.content = contentEnvelope;
    }
  }

  await postEvent(cfg.server, cfg.token, childSessionId, payload);
}

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
function logUnreachable(server, shortError) {
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
function shortErrorFrom(err) {
  if (!err) return "unknown error";
  const code = err.cause?.code || err.code;
  if (code) return String(code);
  if (err.name === "AbortError") return "timeout";
  return (err.message || "unknown error").split("\n")[0];
}

async function postEvent(server, token, sessionId, payload) {
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
    return;
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
  return join(tmpdir(), "flightdeck-plugin", `model-${sessionId}.txt`);
}

function cacheSessionModel(sessionId, model) {
  if (!model) return;
  try {
    mkdirOwnerOnly(join(tmpdir(), "flightdeck-plugin"));
    writeFileSync(modelCachePath(sessionId), String(model));
  } catch {
    /* silent */
  }
}

function readCachedModel(sessionId) {
  try {
    return readFileSync(modelCachePath(sessionId), "utf8").trim() || null;
  } catch {
    return null;
  }
}

/**
 * Resolve the model for the upcoming LLM turn. Prefers the most recent
 * assistant record in the transcript (captures mid-session model
 * switches), falls back to the SessionStart-cached model, and finally
 * to the hook payload itself.
 *
 * ``isRealModel`` filters each candidate so Claude Code's synthetic-
 * turn sentinel (``<synthetic>``) never propagates into a pre_call.
 * ``readTurns`` already skips synthetic records when assigning a
 * group's model, so ``latest?.model`` is non-synthetic by
 * construction — the guard here is belt-and-suspenders for cached
 * and hook-payload fallbacks, both of which read external data this
 * function does not control.
 */
function resolvePreCallModel(sessionId, hookEvent, transcriptPath) {
  const latest = readLatestTurn(transcriptPath);
  const candidates = [
    latest?.model,
    readCachedModel(sessionId),
    hookEvent.model,
  ];
  for (const candidate of candidates) {
    if (isRealModel(candidate)) return candidate;
  }
  return null;
}

// ---------------------------------------------------------------------
// Session-start de-duplication -- once per session id per machine.
// ---------------------------------------------------------------------

async function ensureSessionStarted(server, token, sessionId, basePayload, extras = {}) {
  const dir = join(tmpdir(), "flightdeck-plugin");
  const startFile = join(dir, `started-${sessionId}.txt`);
  try {
    readFileSync(startFile, "utf8");
    return;
  } catch {
    /* fall through */
  }

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

  await postEvent(server, token, sessionId, startPayload);

  try {
    mkdirOwnerOnly(dir);
    writeFileSync(startFile, new Date().toISOString());
  } catch {
    /* silent */
  }
}

// ---------------------------------------------------------------------
// post_call de-duplication -- per assistant message.id.
// Stop fires after every assistant turn. Without dedup, a replay or
// double-hook would duplicate the turn in the dashboard.
// ---------------------------------------------------------------------

function isTurnEmitted(messageId) {
  return existsSync(join(tmpdir(), "flightdeck-plugin", `emitted-${messageId}.txt`));
}

function markEmittedTurn(messageId) {
  const dir = join(tmpdir(), "flightdeck-plugin");
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

// ---------------------------------------------------------------------
// Build content payload for prompt capture. Mirrors the Python
// sensor's AnthropicProvider.extract_content shape: provider, model,
// messages (user turn), tools (assistant tool_use blocks), response
// (assistant text + thinking blocks). system is null -- Claude Code's
// system prompt is not in the transcript.
// ---------------------------------------------------------------------

function buildContent(turn) {
  const toolUses = [];
  const responseBlocks = [];
  for (const block of turn.contentBlocks) {
    if (!block || !block.type) continue;
    if (block.type === "tool_use") {
      toolUses.push(block);
    } else {
      // text, thinking, redacted_thinking, etc.
      responseBlocks.push(block);
    }
  }
  const messages = turn.userTurn
    ? [{ role: "user", content: turn.userTurn.content }]
    : [];
  return {
    provider: "anthropic",
    model: turn.model || "",
    system: null,
    messages,
    tools: toolUses,
    response: responseBlocks,
  };
}

// ---------------------------------------------------------------------
// Emit one post_call per un-emitted transcript turn.
//
// Called from Stop, SessionEnd, and PostToolUse. markEmittedTurn dedup
// (per assistant message.id) keeps emission idempotent across the three
// call sites. PostToolUse flushes mid-turn so the dashboard shows LLM
// activity in real time instead of waiting for the turn to end at Stop.
// ---------------------------------------------------------------------

async function flushPostCallTurns({
  cfg,
  sessionId,
  basePayload,
  turns,
  capturePrompts,
  deadline = null,
}) {
  let seen = 0;
  for (const turn of turns) {
    seen += 1;
    // The detached SessionEnd worker passes an overall deadline so an
    // orphaned backlog against a dead server stops instead of paying
    // one aborted POST per turn; the other callers run unbounded.
    if (deadline !== null && Date.now() > deadline) {
      // Count only the turns no hook has emitted yet; turns Stop or
      // PostToolUse already flushed are not lost.
      const unflushed = turns.slice(seen - 1).filter((t) => !isTurnEmitted(t.messageId)).length;
      process.stderr.write(
        `flightdeck: SessionEnd worker deadline reached; ${unflushed} transcript turn(s) left unflushed.\n`,
      );
      break;
    }
    if (!markEmittedTurn(turn.messageId)) continue;
    const tokens = tokensFromUsage(turn.usage);
    const latencyMs = computeLatencyMs(turn.userTurn, turn.lastTimestamp);
    const hasContent = capturePrompts;
    const content = hasContent ? buildContent(turn) : null;
    // Both sources are already synthetic-filtered (``readTurns``
    // skips synthetic records when assigning a group's model;
    // ``basePayload.model`` is gated by ``isRealModel`` at
    // construction). Leave the fallback chain unguarded so a future
    // upstream change does not silently bypass the filter — the
    // upstream gates are the contract.
    const resolvedModel = turn.model || basePayload.model;
    cacheSessionModel(sessionId, resolvedModel);
    await postEvent(cfg.server, cfg.token, sessionId, {
      ...basePayload,
      event_type: "post_call",
      model: resolvedModel,
      tool_name: null,
      tool_input: null,
      is_subagent_call: false,
      latency_ms: latencyMs,
      timestamp: turn.lastTimestamp || new Date().toISOString(),
      ...tokens,
      has_content: hasContent,
      content,
    });
  }
}

// ---------------------------------------------------------------------
// MCP Protection Policy hook dispatchers.
//
// Three entry points exposed for the main() dispatch loop:
//
//   * dispatchMcpPolicySessionStart — fetches policies, caches per-
//     session, emits policy_mcp_warn / policy_mcp_block for each
//     declared MCP server's non-allow decision.
//   * dispatchMcpPolicyPreToolUse — reads the per-session cache +
//     remembered-decisions file fresh, writes a Claude Code hook
//     decision on stdout as ``hookSpecificOutput.permissionDecision``
//     (allow / deny / ask) with a ``permissionDecisionReason``. This
//     is the contract Claude Code validates; the older top-level
//     ``decision`` field is rejected by current versions (only the
//     deprecated ``approve|block`` pair is still accepted there), and
//     a rejected decision is treated as a non-blocking error, which
//     means the tool call proceeds. Returns true when a decision was
//     emitted.
//   * dispatchMcpPolicyPostToolUse — when an mcp__<server>__<tool>
//     succeeded AND the server was unknown-allowlist on this session
//     AND no remembered decision exists yet: writes the
//     remembered-decisions file AND emits the
//     mcp_policy_user_remembered event (reactive yes-and-remember).
//
// Server-name resolution: the plugin reads .mcp.json fingerprints
// at hook time. Each fingerprint carries {name, endpoint} where
// endpoint is the URL (http/sse) or command-and-args (stdio). The
// canonicalizeUrl helper from mcp_identity.mjs runs the same
// canonicalization the sensor + API use, so the fingerprint
// derived here matches the policy's stored fingerprint byte-for-
// byte.
// ---------------------------------------------------------------------

export async function dispatchMcpPolicySessionStart({
  cfg,
  hookEvent,
  sessionId,
  basePayload,
}) {
  const cwd = hookEvent.cwd || process.cwd();
  const fingerprints = loadMcpServerFingerprints(cwd);
  if (fingerprints.length === 0) {
    // No MCP servers declared in .mcp.json — nothing to enforce.
    // Don't fetch the policy; saves two HTTP calls per
    // session_start for the common case of non-MCP projects.
    return;
  }
  // Fetch the flavor policy for the flavor the plugin stamps on its
  // own events (``basePayload.flavor``), so the policy that applies is
  // the one the dashboard shows next to these sessions. AGENT_FLAVOR is
  // honoured only as a fallback when the payload carries no flavor.
  const flavor =
    (basePayload && basePayload.flavor) || process.env.AGENT_FLAVOR || "claude-code";
  // The plugin's ``cfg.server`` is the ingestion-side base
  // (default http://localhost:4000); the API endpoints live under
  // ``/api``. process.env.FLIGHTDECK_API_URL overrides for prod
  // deployments where the API is on a separate hostname.
  const apiUrl =
    process.env.FLIGHTDECK_API_URL
    || `${cfg.server.replace(/\/ingest$/, "")}/api`;
  const policies = await fetchPolicies(apiUrl, cfg.token, flavor);
  writeSessionPolicyCache(sessionId, policies);

  // Emit policy_mcp_warn / policy_mcp_block for non-allow
  // decisions per declared server. Allow decisions stay silent —
  // the dashboard event stream would drown in noise otherwise.
  for (const fp of fingerprints) {
    if (!fp.endpoint) continue;
    const { classification, decision } = classifyServer(
      policies, fp.endpoint, fp.name,
    );
    if (classification === "allow") continue;
    const eventType =
      classification === "block" ? "policy_mcp_block" : "policy_mcp_warn";
    const payload = {
      ...basePayload,
      event_type: eventType,
      tool_name: null,
      tool_input: null,
      is_subagent_call: false,
      latency_ms: null,
      timestamp: new Date().toISOString(),
      server_url: fp.endpoint,
      server_name: fp.name,
      fingerprint: decision.fingerprint,
      policy_id: decision.policyId,
      scope: decision.scope,
      decision_path: decision.decisionPath,
      // The ingestion API rejects every policy_mcp_* event that does
      // not carry the shared policy_decision block (HTTP 400), and
      // postEvent fails open, so without this block the event is
      // silently dropped and the dashboard never sees the block.
      policy_decision: buildPolicyDecisionBlock(decision),
    };
    if (eventType === "policy_mcp_block") {
      payload.block_on_uncertainty = false;
    }
    await postEvent(cfg.server, cfg.token, sessionId, payload);
  }
}

/**
 * Write a PreToolUse permission decision to stdout in the shape Claude
 * Code validates: ``{"hookSpecificOutput": {"hookEventName":
 * "PreToolUse", "permissionDecision": "allow"|"deny"|"ask",
 * "permissionDecisionReason": "..."}}``. The reason is shown to the
 * user for ``ask`` and ``deny`` and recorded in the transcript.
 *
 * @param {"allow"|"deny"|"ask"} permissionDecision
 * @param {string} permissionDecisionReason
 */
export function writeHookDecision(permissionDecision, permissionDecisionReason) {
  const out = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision,
      permissionDecisionReason,
    },
  };
  process.stdout.write(JSON.stringify(out) + "\n");
}

// A project server may itself be named with a plugin_ prefix
// (plugin_my_server in .mcp.json): its tool name then parses to the
// plugin:my:server key while the fingerprint keeps the literal name,
// so both forms are matched -- as emitMCPToolCallEvent does -- and the
// block / ask gate does not fail open for it.
function findFingerprint(fingerprints, identity) {
  return fingerprints.find(
    (f) => f.name === identity.server_name || f.name === identity.server_key,
  );
}

export function dispatchMcpPolicyPreToolUse(cfg, hookEvent) {
  const toolName =
    hookEvent.tool_name
    || hookEvent.tool_use?.name
    || hookEvent.tool
    || null;
  const parsed = resolveMcpToolIdentity(hookEvent, toolName);
  if (!parsed) {
    // Not an MCP tool call — the plugin's PreToolUse has nothing
    // to say. Returning false lets main() fall through and exit
    // normally (no decision written; Claude Code's default
    // approval flow applies).
    return false;
  }
  const sessionId = getSessionId(hookEvent);
  const policies = readSessionPolicyCache(sessionId);
  if (!policies) {
    // SessionStart didn't run successfully or the cache was
    // cleaned up. Fail-open: no decision, let Claude Code proceed
    // normally.
    return false;
  }

  // Look up the server's endpoint from .mcp.json so we can
  // canonicalize + fingerprint the same way the policy stored.
  const fingerprints = loadMcpServerFingerprints(
    hookEvent.cwd || process.cwd(),
  );
  const fp = findFingerprint(fingerprints, parsed);
  if (!fp || !fp.endpoint) {
    // Unknown server name — can't fingerprint, can't enforce.
    // Fail-open per Rule 28.
    return false;
  }

  // Fresh-read: consult the remembered-decisions file on
  // every PreToolUse so concurrent sessions see each other's
  // approvals in real time.
  const decision = classifyServer(policies, fp.endpoint, fp.name);
  if (decision.classification === "ask") {
    const remembered = lookupRemembered(
      cfg.token, decision.decision.fingerprint,
    );
    if (remembered) {
      // Previously approved — proceed silently.
      writeHookDecision(
        "allow",
        `MCP server ${fp.name} was previously approved on this machine (remembered decision)`,
      );
      return true;
    }
    // No remembered approval — defer to Claude Code's built-in
    // ask flow. The user gets a yes/no prompt; if they say yes,
    // PostToolUse below catches the de-facto approval.
    writeHookDecision(
      "ask",
      `MCP policy: ${fp.name} is not on the allowlist for this flavor; approve to proceed`,
    );
    return true;
  }
  if (decision.classification === "block") {
    const reason =
      `MCP policy blocked tool call to ${fp.name} `
      + `(${decision.decision.scope}, ${decision.decision.decisionPath})`;
    writeHookDecision("deny", reason);
    return true;
  }
  // allow / warn → no explicit decision; default flow applies.
  return false;
}

export async function dispatchMcpPolicyPostToolUse({
  cfg,
  hookEvent,
  sessionId,
  basePayload,
  toolName,
}) {
  const parsed = resolveMcpToolIdentity(hookEvent, toolName);
  if (!parsed || !parsed.parsed || !parsed.server_name) {
    return;
  }
  const policies = readSessionPolicyCache(sessionId);
  if (!policies) return;
  const fingerprints = loadMcpServerFingerprints(
    hookEvent.cwd || process.cwd(),
  );
  const fp = findFingerprint(fingerprints, parsed);
  if (!fp || !fp.endpoint) return;

  const decision = classifyServer(policies, fp.endpoint, fp.name);
  if (decision.classification !== "ask") {
    // Either explicitly allowed/denied/warned by policy. No
    // de-facto-approval write — the policy already has an
    // opinion on this server.
    return;
  }
  // Unknown-allowlist + tool call succeeded = de-facto approval.
  const fingerprint = decision.decision.fingerprint;
  if (lookupRemembered(cfg.token, fingerprint)) {
    // Already remembered — idempotent.
    return;
  }
  const decidedAt = new Date().toISOString();
  // canonicalizeUrl is consumed inside classifyServer to compute
  // the fingerprint; the canonical URL itself isn't on the
  // decision record so we recompute from fp.endpoint here. Both
  // the remembered-decisions row AND the event payload below use
  // the same value to stay in lockstep with the policy entry.
  const canonicalUrl = canonicalizeForRemembered(fp.endpoint);
  writeRememberedDecision(cfg.token, {
    fingerprint,
    serverUrlCanonical: canonicalUrl,
    serverName: fp.name,
    decidedAt,
  });
  // Emit the operator-visibility event.
  const payload = {
    ...basePayload,
    event_type: "mcp_policy_user_remembered",
    tool_name: null,
    tool_input: null,
    is_subagent_call: false,
    latency_ms: null,
    timestamp: decidedAt,
    server_url_canonical: canonicalUrl,
    server_name: fp.name,
    fingerprint,
    flavor: basePayload.flavor,
    decided_at: decidedAt,
  };
  await postEvent(cfg.server, cfg.token, sessionId, payload);
}

// Local alias: canonicalizeUrl from mcp_identity.mjs (imported at
// the top of this file). Used by the PostToolUse de-facto-approval
// path to compute the canonical URL form for both the remembered-
// decisions file row AND the mcp_policy_user_remembered event
// payload. Two call sites, one canonicalization — keeps them in
// lockstep.
function canonicalizeForRemembered(rawEndpoint) {
  return _mcpCanonicalizeUrl(rawEndpoint);
}

// ---------------------------------------------------------------------
// Main entry point.
// ---------------------------------------------------------------------

async function main() {
  const cfg = resolveConfig();
  // The detached SessionEnd worker is this script re-invoked with the
  // marker flag; it skips the hand-off below and does the network work.
  const sessionEndWorker = process.argv.includes(SESSION_END_WORKER_FLAG);

  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let hookEvent;
  try {
    hookEvent = JSON.parse(input);
  } catch {
    process.stderr.write("flightdeck: failed to parse hook event from stdin\n");
    return;
  }

  const hookName = hookEvent.hook_event_name || hookEvent.event || "";
  const eventType = EVENT_MAP[hookName];
  // SubagentStart and SubagentStop are intentionally absent from
  // EVENT_MAP because they emit CHILD session_start / session_end
  // events (different session_id from the outer hook), not parent
  // events. Routed to a dedicated dispatch below.
  const isSubagentHook =
    hookName === "SubagentStart" || hookName === "SubagentStop";
  // PreToolUse fires for the MCP Protection Policy gate.
  // It has no entry in EVENT_MAP because PreToolUse itself doesn't
  // emit a wire event — it returns a hook decision (allow / deny /
  // ask) on stdout. The branch lives in dispatchMcpPolicyPreToolUse
  // below; let the hook through the early-return guard so it
  // reaches the dispatch site.
  const isMcpPolicyHook = hookName === "PreToolUse";
  if (!eventType && !isSubagentHook && !isMcpPolicyHook) {
    return;
  }

  // PreToolUse MCP Protection Policy gate. Runs before the
  // rest of the dispatch because it returns a Claude Code hook
  // decision on stdout; the hook's job here is to gate the call,
  // NOT to emit a wire event. (warn/block events emit at
  // SessionStart for fleet visibility; user-remembered events emit
  // from PostToolUse below.) Reads the per-session policy cache +
  // the remembered-decisions file fresh on every invocation so
  // concurrent Claude Code sessions on the same machine see each
  // other's approvals in real time.
  if (hookName === "PreToolUse") {
    const decided = dispatchMcpPolicyPreToolUse(cfg, hookEvent);
    if (decided) {
      // Decision written to stdout; nothing else to do for this
      // hook invocation.
      return;
    }
    // Non-MCP tool call (or no policy in scope). Fall through to
    // the early-return below — PreToolUse has no entry in
    // EVENT_MAP so the standard branch is a no-op.
    return;
  }

  // ``outerSessionId`` is what Claude Code passes on hookEvent —
  // ALWAYS the parent invocation's id, regardless of whether the
  // hook fires inside subagent context. ``sessionId`` is what we
  // EMIT under, which equals ``outerSessionId`` for parent events
  // and equals the deterministic child id for interior subagent
  // events (computed below). Keep both names — the parent linkage
  // on subagent children needs the outer, the dispatch downstream
  // needs the resolved.
  const outerSessionId = getSessionId(hookEvent);

  // SessionEnd runs under Claude Code's 1.5 s end-of-session budget
  // (SESSION_END_HOOK_BUDGET_MS). The hook process does only local work
  // here -- invalidate the session markers so the next Claude Code
  // invocation mints a fresh session, drop the per-session policy
  // cache -- and hands the transcript flush plus the session_end POST
  // to a detached worker that keeps running after Claude Code has
  // moved on. Clearing the markers before the hand-off keeps the
  // ordering the synchronous path had: a SessionStart that follows
  // immediately (/clear, a new `claude -p`) never sees the ended
  // session's marker. Without the hand-off, context collection plus
  // one slow POST already exceeded the budget and the session_end was
  // lost. The worker's stderr goes to
  // $TMPDIR/flightdeck-plugin/session-end-worker.log.
  if (hookName === "SessionEnd" && !sessionEndWorker) {
    clearSessionCacheFiles(hookEvent, outerSessionId);
    clearSessionPolicyCache(outerSessionId);
    await spawnDetachedSessionEnd(input, outerSessionId);
    return;
  }

  let sessionId = outerSessionId;
  // ``transcriptPath`` defaults to the parent's transcript path
  // from hookEvent. When the hook fires inside subagent context,
  // we swap to the subagent's per-execution transcript so the
  // assistant-turn token usage is captured correctly. See
  // _subagentTranscriptPath comment for the path derivation.
  let transcriptPath = hookEvent.transcript_path;

  // Base identity fields used by every event for this session.
  //
  // ``context`` is attached here so *every* event type (pre_call,
  // post_call, tool_call, session_end) carries it -- not only
  // session_start. The worker's lazy-create path and the
  // UpgradeSessionContext upgrade depend on seeing context on the first
  // event that actually reaches the server. Without this, a session
  // whose session_start POST failed (stack down at start, dead-TLS
  // window, ...) would land with "unknown" flavor and NULL context
  // forever because the session_start dedup marker on disk prevents
  // a retry. ``safeCollectContext`` returns null on throw or empty
  // result, in which case the field is omitted -- the worker's
  // COALESCE upgrade treats "missing" and "empty dict" identically.
  const baseContext = safeCollectContext({
    claudeCodeSessionId: hookEvent.session_id,
  });

  // Agent identity. Plugin emits agent_type="coding" (the ingestion
  // vocabulary is locked to coding / production; the run-mode signals
  // that tell an interactive session from a headless, SDK, CI or
  // remote run ride in context -- see collectClaudeCodeSignals)
  // and client_type="claude_code"; agent_name defaults to
  // "{user}@{hostname}" and can be overridden via
  // FLIGHTDECK_AGENT_NAME env var. The user/hostname come from the
  // context collector (which itself honors FLIGHTDECK_HOSTNAME), so
  // an operator overriding hostname for k8s pod grouping gets
  // consistent agent_id / agent_name derivation and context.hostname.
  const identityUser = baseContext?.user || "unknown";
  const identityHostname =
    process.env.FLIGHTDECK_HOSTNAME ||
    baseContext?.hostname ||
    osHostname();
  const baseAgentName =
    process.env.FLIGHTDECK_AGENT_NAME || `${identityUser}@${identityHostname}`;
  const baseAgentId = deriveAgentId({
    agent_type: "coding",
    user: identityUser,
    hostname: identityHostname,
    client_type: "claude_code",
    agent_name: baseAgentName,
  });

  // Interior-event routing. When this hook fired inside a
  // subagent's execution, swap (sessionId, agentId, agentName) to
  // the CHILD identity so every downstream emission lands under
  // the right session — and stamp parent_session_id / agent_role
  // on basePayload so the worker writes the relationship through.
  // Returns null for parent-context hooks; resolved fields apply
  // unchanged for those.
  const interiorCtx = _subagentInteriorContext({
    hookEvent,
    hookName,
    parentSessionId: outerSessionId,
    parentAgentName: baseAgentName,
    identityUser,
    identityHostname,
  });
  let agentId = baseAgentId;
  let agentName = baseAgentName;
  if (interiorCtx) {
    sessionId = interiorCtx.sessionId;
    agentId = interiorCtx.agentId;
    agentName = interiorCtx.agentName;
    if (interiorCtx.subagentTranscriptPath) {
      transcriptPath = interiorCtx.subagentTranscriptPath;
    }
  }

  const basePayload = {
    session_id: sessionId,
    flavor: "claude-code",
    agent_type: "coding",
    // Agent identity on every event.
    agent_id: agentId,
    agent_name: agentName,
    client_type: "claude_code",
    user: identityUser,
    hostname: identityHostname,
    host: osHostname(),
    framework: "claude-code",
    // ``hookEvent.model`` may carry Claude Code's synthetic-turn
    // sentinel for orchestration hooks; gate via ``isRealModel`` so
    // it never leaks into the basePayload that downstream branches
    // (post_call resolvedModel fallback, MCP content stub, etc.)
    // read when their own primary model source is null.
    model: isRealModel(hookEvent.model) ? hookEvent.model : null,
    tokens_input: 0,
    tokens_output: 0,
    tokens_total: 0,
    tokens_cache_read: 0,
    tokens_cache_creation: 0,
    tokens_used_session: 0,
    token_limit_session: null,
    has_content: false,
    content: null,
    ...(interiorCtx
      ? {
          parent_session_id: interiorCtx.parentSessionId,
          agent_role: interiorCtx.agentRole,
        }
      : {}),
    ...(baseContext ? { context: baseContext } : {}),
  };

  // Read transcript lazily -- some hooks don't need it and the file
  // may not exist yet (first-hook SessionStart before the JSONL is
  // flushed).
  let cachedTurns = null;
  const getTurns = () => {
    if (cachedTurns !== null) return cachedTurns;
    cachedTurns = readTurns(transcriptPath);
    return cachedTurns;
  };
  const getLatestTurn = () => {
    const turns = getTurns();
    return turns.length > 0 ? turns.at(-1) : null;
  };

  // SubagentStart / SubagentStop. Emit a child session_start /
  // session_end whose session_id is distinct from the outer
  // (parent) session, with parent_session_id pointing back at the
  // outer one and agent_role labeling the subagent's type. SubagentStop
  // is the canonical end-of-life signal; PostToolUseFailure on a
  // Task tool keeps emitting the parent's tool_call event with the
  // structured error block and does NOT duplicate-emit a child
  // session_end (a delayed real SubagentStop would race a synthetic
  // one). Crashes that never reach a clean SubagentStop fall through
  // the worker's existing state-revival path (active → stale → lost).
  if (isSubagentHook) {
    // emitSubagentEvent derives the child's agent_id and display
    // name from the PARENT's agent_name (agent_role is the
    // conditional 6th input on top of the parent's 5-tuple).
    // Pass ``baseAgentName`` explicitly so the right value flows
    // even if a future change makes ``agentName`` carry the child's
    // composed form for some other reason.
    await emitSubagentEvent({
      cfg,
      hookName,
      hookEvent,
      outerSessionId,
      basePayload,
      agentName: baseAgentName,
      identityUser,
      identityHostname,
    });
    return;
  }

  // SessionStart: real first hook. Emit session_start with the model
  // and context, cache the model for subsequent UserPromptSubmit hooks,
  // and mark the dedup file so later hooks skip the backstop.
  if (hookName === "SessionStart") {
    const turn = getLatestTurn();
    const hookModel = isRealModel(hookEvent.model) ? hookEvent.model : null;
    const model = hookModel || (isRealModel(turn?.model) ? turn.model : null);
    cacheSessionModel(sessionId, model);
    await ensureSessionStarted(cfg.server, cfg.token, sessionId, basePayload, {
      model,
      claudeCodeVersion: turn?.claudeCodeVersion || hookEvent.version || null,
      capturePrompts: cfg.capturePrompts,
      claudeCodeSessionId: hookEvent.session_id,
      // startup / resume / clear / compact / fork -- how this Claude
      // Code session came to be. A resumed or forked session is
      // otherwise indistinguishable from a fresh one.
      sessionSource: typeof hookEvent.source === "string" ? hookEvent.source : null,
    });
    // Fetch + cache the MCP Protection Policy and emit
    // policy_mcp_warn / policy_mcp_block events for any non-allow
    // decisions per declared MCP server. Best-effort; failures
    // fail-open per Rule 28.
    await dispatchMcpPolicySessionStart({
      cfg,
      hookEvent,
      sessionId,
      basePayload,
    });
    return;
  }

  // SessionEnd: real session teardown, running in the detached worker
  // (the hook process handed off above after clearing the on-disk
  // markers). Before emitting session_end, flush any LLM turns not yet
  // emitted by Stop or PostToolUse -- in `claude -p` mode Claude Code
  // fires Stop once before the final tool-loop turn is flushed to the
  // transcript, so a post_call for the final turn can still be missing
  // when SessionEnd arrives. Dedup via the per-messageId marker keeps
  // this idempotent with Stop and PostToolUse. The worker must not
  // touch the session markers: a new Claude Code session may own them
  // by now.
  if (hookName === "SessionEnd") {
    await flushPostCallTurns({
      cfg,
      sessionId,
      basePayload,
      turns: getTurns(),
      capturePrompts: cfg.capturePrompts,
      deadline: Date.now() + SESSION_END_WORKER_DEADLINE_MS,
    });
    const payload = {
      ...basePayload,
      event_type: "session_end",
      tool_name: null,
      tool_input: null,
      is_subagent_call: false,
      latency_ms: null,
      timestamp: new Date().toISOString(),
      // Plugin-driven SessionEnd is always a normal exit from the
      // operator's perspective (the user typed /exit, /clear, or the
      // `claude -p` command completed cleanly). The worker reaper
      // fills "orphan_timeout" on lost sessions; "sigkill_detected"
      // is reserved for future signal-handling. Stamping explicitly
      // here keeps the dashboard's Close Reason facet populated for
      // every clean exit instead of falling through to the worker's
      // unknown-default path.
      close_reason: "normal_exit",
    };
    // Claude Code's own exit reason (clear, resume, logout,
    // prompt_input_exit, other) rides alongside the enum so the specific
    // trigger is not lost to the coarse close_reason bucket. Every one
    // of them is a clean exit from the operator's perspective, so
    // close_reason stays normal_exit.
    const endReason = boundedToken(hookEvent.reason, MAX_SIGNAL_BYTES);
    if (endReason) payload.end_reason = endReason;
    await postEvent(cfg.server, cfg.token, sessionId, payload);
    return;
  }

  // Every other event type goes through the common session_start
  // backstop so an initial hook that is NOT SessionStart still produces
  // a session row.
  await ensureSessionStarted(cfg.server, cfg.token, sessionId, basePayload, {
    model: isRealModel(hookEvent.model) ? hookEvent.model : null,
    claudeCodeVersion: hookEvent.version || null,
    capturePrompts: cfg.capturePrompts,
    claudeCodeSessionId: hookEvent.session_id,
  });

  // Stop: every un-emitted LLM turn in the transcript becomes a
  // post_call. Multi-turn tool-use conversations produce multiple
  // assistant message.ids and Stop only fires once at the end, so we
  // must iterate every group and dedup via the per-messageId marker
  // file. PostToolUse flushes most of these mid-turn; Stop acts as the
  // final backstop for the last assistant turn (no tool follow-up).
  // cacheSessionModel inside the helper keeps pre_call labelling right
  // for subsequent UserPromptSubmit hooks on older Claude Code versions
  // that do not carry model on SessionStart.
  if (hookName === "Stop") {
    await flushPostCallTurns({
      cfg,
      sessionId,
      basePayload,
      turns: getTurns(),
      capturePrompts: cfg.capturePrompts,
    });
    // The per-session MCP policy cache deliberately survives Stop:
    // Stop fires after every assistant turn, and PreToolUse reads the
    // cache on every MCP tool call for the life of the session. It is
    // removed on SessionEnd below.
    return;
  }

  // UserPromptSubmit: user hit enter on a prompt. Emit pre_call for
  // the upcoming LLM turn, but only when we can resolve a concrete
  // model. Resolution order: (1) most recent assistant in the
  // transcript, (2) cached model from a prior post_call this session,
  // (3) hook payload. If all three are empty the dashboard would
  // render the pre_call as "unknown", so we skip the emission entirely
  // and rely on the Stop-emitted post_call (which always has a model
  // because it reads usage directly from the transcript). First-turn
  // prompts in a brand-new session thus have no pre_call; second and
  // subsequent prompts are labelled correctly.
  if (hookName === "UserPromptSubmit") {
    const model = resolvePreCallModel(sessionId, hookEvent, transcriptPath);
    if (!model) return;
    const hasContent = cfg.capturePrompts && typeof hookEvent.prompt === "string";
    const content = hasContent
      ? {
          provider: "anthropic",
          model,
          system: null,
          messages: [{ role: "user", content: hookEvent.prompt }],
          tools: [],
          response: [],
        }
      : null;
    const payload = {
      ...basePayload,
      event_type: "pre_call",
      model,
      tool_name: null,
      tool_input: null,
      is_subagent_call: false,
      latency_ms: null,
      timestamp: new Date().toISOString(),
      has_content: hasContent,
      content,
    };
    await postEvent(cfg.server, cfg.token, sessionId, payload);
    return;
  }

  // PreCompact: context compaction is about to happen. Emit a synthetic
  // tool_call so the dashboard timeline shows the compaction event.
  if (hookName === "PreCompact") {
    const payload = {
      ...basePayload,
      event_type: "tool_call",
      tool_name: "compact_context",
      tool_input: hookEvent.trigger ? JSON.stringify({ trigger: hookEvent.trigger }) : null,
      is_subagent_call: false,
      latency_ms: null,
      timestamp: new Date().toISOString(),
    };
    await postEvent(cfg.server, cfg.token, sessionId, payload);
    return;
  }

  // PostToolUse and PostToolUseFailure: flush any un-emitted LLM turns
  // from the transcript before emitting the tool_call. The assistant
  // record that triggered this tool invocation is already in the
  // transcript by the time either hook fires, so its post_call becomes visible in the
  // dashboard in real time rather than batching at Stop. Ordering:
  // post_call (LLM decision) precedes tool_call (tool execution),
  // matching transcript order. markEmittedTurn dedup keeps Stop and
  // SessionEnd idempotent. Wrapped in try/catch so a transcript read
  // failure cannot block the tool_call emission -- readTurns already
  // returns [] on read errors, but belt-and-suspenders.
  if (hookName === "PostToolUse" || hookName === "PostToolUseFailure") {
    try {
      await flushPostCallTurns({
        cfg,
        sessionId,
        basePayload,
        turns: getTurns(),
        capturePrompts: cfg.capturePrompts,
      });
    } catch (err) {
      process.stderr.write(
        `flightdeck: post_call flush on ${hookName} failed: ${err?.message || err}\n`,
      );
    }
  }
  if (hookName === "PostToolUse") {
    // Reactive de-facto-approval write. When an
    // mcp__<server>__<tool> call succeeded AND the server was
    // unknown-allowlist on this session AND no remembered
    // decision exists yet for the active token: write the
    // remembered file AND emit mcp_policy_user_remembered.
    // Wrapped to never crash the standard PostToolUse path.
    try {
      const toolNameForPolicy =
        hookEvent.tool_name
        || hookEvent.tool_use?.name
        || hookEvent.tool
        || null;
      await dispatchMcpPolicyPostToolUse({
        cfg,
        hookEvent,
        sessionId: outerSessionId,
        basePayload,
        toolName: toolNameForPolicy,
      });
    } catch (err) {
      process.stderr.write(
        `flightdeck: mcp policy PostToolUse failed: ${err?.message || err}\n`,
      );
    }
  }

  // PreToolUse / PostToolUse: tool-lifecycle events. Same
  // sanitised-whitelist capture semantics as every other tool event.
  const toolName =
    hookEvent.tool_name ||
    hookEvent.tool_use?.name ||
    hookEvent.tool ||
    null;

  // MCP tool calls are namespaced as ``mcp__<server>__<tool>``
  // by Claude Code. Detect via prefix and route to the dedicated MCP
  // emit branch BEFORE the standard tool sanitiser runs. The
  // whitelist sanitiser is BYPASSED for MCP tools — its keep-
  // list (file_path / command / query / pattern / prompt) drops every
  // MCP-specific argument shape and would render the plugin-sourced
  // MCP_TOOL_CALL payload empty. The MCP path captures the raw
  // arguments verbatim under the existing ``captureToolInputs`` knob.
  const mcpIdentity = resolveMcpToolIdentity(hookEvent, toolName);
  if (mcpIdentity) {
    if (!mcpIdentity.parsed) {
      process.stderr.write(
        `flightdeck: ambiguous MCP tool name "${toolName}"; ` +
          `server attribution falling back to null. See plugin README.\n`,
      );
    }
    await emitMCPToolCallEvent({
      cfg,
      sessionId,
      basePayload,
      hookEvent,
      hookName,
      mcpIdentity,
    });
    return;
  }

  // Every remaining hook name maps to an event type (EVENT_MAP); the
  // guard keeps a future unmapped hook from POSTing event_type=undefined.
  if (!eventType) return;

  const sanitizedInput =
    cfg.captureToolInputs && hookEvent.tool_input
      ? sanitizeToolInput(hookEvent.tool_input)
      : null;
  const toolInputJson = sanitizedInput ? JSON.stringify(sanitizedInput) : null;

  const isSubagentCall = toolName === "Task";
  const toolDurationMs = hookDurationMs(hookEvent);

  // Build event_content payload so the drawer's Prompts tab can show
  // real tool input + output (previously tool_call events always had
  // has_content=false, so the drawer rendered shallow metadata only).
  // Privacy tiers: input is gated on captureToolInputs (default ON);
  // output is gated on capturePrompts (default ON for the plugin,
  // OFF for the Python sensor -- see resolveConfig rationale).
  let content = null;
  let hasContent = false;
  if (cfg.captureToolInputs && toolName && sanitizedInput) {
    const tools = [{ type: "tool_use", name: toolName, input: sanitizedInput }];
    const response = [];
    if (cfg.capturePrompts && hookEvent.tool_response != null) {
      const out =
        typeof hookEvent.tool_response === "string"
          ? hookEvent.tool_response
          : JSON.stringify(hookEvent.tool_response);
      response.push({
        type: "tool_result",
        content: out.length > 2000 ? out.slice(0, 2000) + "\u2026" : out,
      });
    }
    content = {
      provider: "anthropic",
      model: readCachedModel(sessionId) || basePayload.model || "",
      system: null,
      messages: [],
      tools,
      response,
    };
    hasContent = true;
  }

  // Preserve basePayload's parent_session_id when interior
  // subagent context set it (the modern Agent tool path). Fall back
  // to the legacy ``isSubagentCall ? sessionId : null`` shape for
  // the deprecated Task-tool informational hint (retained as
  // forward-compat on the parent's tool_call event for any consumer
  // still reading it). The two paths are mutually exclusive — when
  // interior context is active, basePayload.parent_session_id is
  // the OUTER session id; when it isn't, the legacy line applies.
  const payload = {
    ...basePayload,
    event_type: eventType,
    tool_name: toolName,
    tool_input: toolInputJson,
    tool_result: null,
    is_subagent_call: isSubagentCall,
    parent_session_id:
      basePayload.parent_session_id ??
      (isSubagentCall ? sessionId : null),
    // Real tool wall time from Claude Code on PostToolUse /
    // PostToolUseFailure, null when the hook does not carry it. The
    // same value lands as duration_ms so tool_call and mcp_tool_call
    // report the tool's duration under one name.
    latency_ms: toolDurationMs,
    duration_ms: toolDurationMs,
    timestamp: new Date().toISOString(),
    has_content: hasContent,
    content,
  };
  const toolUseId = boundedToken(hookEvent.tool_use_id, MAX_MCP_IDENTITY_BYTES);
  if (toolUseId) payload.tool_use_id = toolUseId;
  if (hookName === "PostToolUseFailure") {
    payload.error = buildToolErrorBlock(hookEvent, captureErrorText(cfg));
  }
  await postEvent(cfg.server, cfg.token, sessionId, payload);
}

/**
 * Hand the SessionEnd network work to a detached copy of this script
 * so the hook itself returns within Claude Code's end-of-session
 * budget. The child gets the raw hook event on stdin and the already
 * resolved Flightdeck session id through CLAUDE_SESSION_ID (the hook
 * process has cleared the marker file by now, so the child cannot
 * re-derive it). The hook waits up to SESSION_END_WORKER_GRACE_MS for
 * the child to exit, so a fast server gets the events before Claude
 * Code exits; after that detached + unref lets the hook exit while the
 * child runs. stdout is dropped and stderr appends to a log under the
 * plugin tmpdir so a failed POST stays diagnosable. FLIGHTDECK_QUIET
 * stops the child from repeating the default-token warning the hook
 * already printed.
 */
async function spawnDetachedSessionEnd(rawInput, sessionId) {
  let stderrTarget = "ignore";
  try {
    stderrTarget = openSessionEndWorkerLog(join(tmpdir(), "flightdeck-plugin"));
  } catch {
    stderrTarget = "ignore";
  }
  try {
    const child = spawn(
      process.execPath,
      [fileURLToPath(import.meta.url), SESSION_END_WORKER_FLAG],
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

/**
 * True when this file is the process entry point. A plain string
 * comparison fails on Windows whenever ``process.argv[1]`` arrives with
 * forward slashes or a differently cased drive letter (both happen when
 * Claude Code expands ``${CLAUDE_PLUGIN_ROOT}`` into the hook command)
 * and anywhere the plugin directory is reached through a symlink, so
 * main() never ran and the plugin was silently inert. Both sides are
 * resolved and taken through realpath, and compared case-insensitively
 * on win32. The platform, path module and own path are injectable so
 * the win32 rule is testable from any host.
 */
export function isMainModule(
  argv1 = process.argv[1],
  {
    platform: plat = platform(),
    pathModule = nodePath,
    selfPath = fileURLToPath(import.meta.url),
  } = {},
) {
  if (!argv1) return false;
  const self = canonicalPath(selfPath, pathModule);
  const invoked = canonicalPath(argv1, pathModule);
  if (plat === "win32") {
    return self.toLowerCase() === invoked.toLowerCase();
  }
  return self === invoked;
}

// resolve() normalises separators and relative segments; realpath then
// follows symlinks, falling back to the resolved path when the file
// cannot be looked up (a path from another platform in tests).
function canonicalPath(p, pathModule) {
  const resolved = pathModule.resolve(p);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

if (isMainModule()) {
  // A hook must exit 0 and stay quiet: an unexpected throw is logged as
  // one line instead of an unhandled rejection's stack trace and
  // non-zero exit.
  main().catch((err) => {
    process.stderr.write(`[flightdeck] WARN: hook failed: ${err?.message || err}\n`);
  });
}
