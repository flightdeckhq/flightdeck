// Claude Code run-mode signals and the runtime context stamped on
// every event (parallels sensor/core/context.py).

import { execSync } from "node:child_process";
import { arch, hostname as osHostname, platform, userInfo } from "node:os";

import { boundedToken, boundedVersion, MAX_SIGNAL_BYTES, parseBool } from "../core/config.mjs";
import { markerKeyFor, readGitCache, writeGitCache } from "../core/state.mjs";
import { loadMcpServerFingerprints } from "./mcp.mjs";

// Canonical UUID form, the only form the native session id is reported in.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/**
 * The working directory's git commit, branch and repo name, from three
 * git subprocesses. Each field is omitted when its probe fails.
 */
export function probeGit() {
  const git = {};
  const gitOpts = { timeout: 500, stdio: ["ignore", "pipe", "ignore"] };
  try {
    git.git_commit = execSync("git rev-parse --short HEAD", gitOpts)
      .toString()
      .trim();
  } catch {
    /* silent */
  }
  try {
    git.git_branch = execSync("git branch --show-current", gitOpts)
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
    if (repo) git.git_repo = repo;
  } catch {
    /* silent */
  }
  return git;
}

/**
 * The git fields for this hook: probed once per Claude Code session and
 * working directory and then read from the state directory, so later
 * hooks skip the three subprocesses. Without a native session id (or a
 * working directory) the probe runs every time, as before.
 */
export function sessionGitFields(nativeSessionId, cwd, probe = probeGit) {
  if (!nativeSessionId || !cwd) return probe();
  const key = markerKeyFor(nativeSessionId);
  const cached = readGitCache(key, cwd);
  if (cached) return cached;
  const git = probe();
  writeGitCache(key, cwd, git);
  return git;
}

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

  Object.assign(ctx, sessionGitFields(extras.claudeCodeSessionId, ctx.working_dir));

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
