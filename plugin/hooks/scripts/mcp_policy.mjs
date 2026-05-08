// MCP Protection Policy plugin helper — D127 / D135 / D139.
//
// Imported by observe_cli.mjs from three hook branches:
//
//   * SessionStart — fetchPolicies + writeSessionPolicyCache, then
//     classifyServer per declared MCP server to emit
//     policy_mcp_warn / policy_mcp_block events for non-allow
//     decisions at session boot.
//   * PreToolUse — readSessionPolicyCache + classifyServer to
//     decide allow / deny / ask for each mcp__<server>__<tool>
//     invocation.
//   * Stop — clearSessionPolicyCache to clean up the per-session
//     marker file.
//
// Imports the step-2 mcp_identity primitive so the canonical-URL
// + fingerprint contract stays cross-language identical with the
// sensor and the API.
//
// Pure Node built-ins (node:crypto via mcp_identity.mjs, node:fs,
// node:path, node:os, fetch, AbortController). No npm
// dependencies — preserves the plugin's zero-dep posture
// (D113 / D115 / D127 precedent).

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalizeUrl, fingerprintShort } from "./mcp_identity.mjs";

// Per-session marker file location. Mirrors the existing
// model-cache pattern in observe_cli.mjs (`flightdeck-plugin`
// scratch directory under tmpdir).
const PLUGIN_TMP_DIRNAME = "flightdeck-plugin";
const POLICY_CACHE_PREFIX = "mcp-policy-";

// HTTP timeout for the SessionStart fetch (ms). The plugin runs
// as a short-lived child process per hook invocation; budget for
// two parallel HTTP calls plus startup overhead must fit comfortably
// under Claude Code's hook timeout. 1500ms matches the sensor's
// 1-second per-call timeout × 1.5 buffer for tail latency.
const FETCH_TIMEOUT_MS = 1500;

function pluginTmpDir() {
  const dir = join(tmpdir(), PLUGIN_TMP_DIRNAME);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* dir exists or unwritable — caller handles via fail-open */
  }
  return dir;
}

function sessionPolicyCachePath(sessionId) {
  return join(pluginTmpDir(), `${POLICY_CACHE_PREFIX}${sessionId}.json`);
}

/**
 * Fetch the global + flavor policies from the control plane in
 * parallel. Returns `{global, flavor}` shape (each value is the
 * API's policy doc or null on miss / error). Fail-open per Rule 28
 * — any HTTP error or network failure produces null for that
 * scope; the caller's classifyServer falls through to local-
 * failsafe (the plugin doesn't carry the sensor's
 * mcp_block_on_uncertainty kwarg, so cache-miss = allow).
 *
 * @param {string} apiUrl - control-plane base URL (e.g. http://localhost:4000/api)
 * @param {string} token - bearer token
 * @param {string|null} flavor - flavor name; when null, only global is fetched
 * @returns {Promise<{global: object|null, flavor: object|null}>}
 */
export async function fetchPolicies(apiUrl, token, flavor) {
  const requests = [fetchOne(apiUrl, token, "global")];
  if (flavor) {
    requests.push(fetchOne(apiUrl, token, encodeURIComponent(flavor)));
  } else {
    requests.push(Promise.resolve(null));
  }
  const [global, flavorDoc] = await Promise.all(requests);
  return { global, flavor: flavorDoc };
}

async function fetchOne(apiUrl, token, scopeSegment) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(`${apiUrl}/v1/mcp-policies/${scopeSegment}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!resp.ok) {
      // 404 = scope absent (legitimate empty result for flavor
      // policies); other statuses = transient or auth issue.
      // Both bucket as null per Rule 28 fail-open.
      return null;
    }
    return await resp.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Per-D135 evaluation against the cached policies. Returns a
 * decision record matching the sensor's MCPPolicyDecision shape so
 * downstream event-payload construction stays uniform.
 *
 * @param {{global: object|null, flavor: object|null}} policies
 * @param {string} serverUrl - raw URL or stdio command
 * @param {string} serverName - display name from .mcp.json or
 *   serverInfo.name
 * @returns {{
 *   decision: "allow"|"warn"|"block",
 *   decisionPath: "flavor_entry"|"global_entry"|"mode_default",
 *   policyId: string,
 *   scope: string,
 *   fingerprint: string
 * }}
 */
export function evaluateServer(policies, serverUrl, serverName) {
  const canonical = canonicalizeUrl(serverUrl);
  const fp = fingerprintShort(canonical, serverName);

  // Step 1: flavor entry?
  const flavorEntry = findEntry(policies.flavor, fp);
  if (flavorEntry) {
    return decisionFromEntry(
      flavorEntry, "flavor_entry", policies.flavor, fp,
    );
  }

  // Step 2: global entry?
  const globalEntry = findEntry(policies.global, fp);
  if (globalEntry) {
    return decisionFromEntry(
      globalEntry, "global_entry", policies.global, fp,
    );
  }

  // Step 3: mode default. Allowlist → block; blocklist → allow.
  // Plugin doesn't carry the sensor's mcp_block_on_uncertainty
  // failsafe — when policies object is null (preflight fetch
  // failed), default to allow to preserve agent availability.
  const globalMode = policies.global?.mode;
  if (globalMode === "allowlist") {
    return {
      decision: "block",
      decisionPath: "mode_default",
      policyId: policies.global?.id || "",
      scope: "global",
      fingerprint: fp,
    };
  }
  return {
    decision: "allow",
    decisionPath: "mode_default",
    policyId: policies.global?.id || "",
    scope: policies.global ? "global" : "fail_open",
    fingerprint: fp,
  };
}

/**
 * Coarse-grained classifier used by PreToolUse to decide which
 * Claude Code hook decision to emit. Maps the D135 decision plus
 * cache state to one of:
 *
 *   * "allow" — allow / warn / remembered allow → no hook decision
 *     needed beyond proceeding.
 *   * "block" — return {decision: "deny", reason}.
 *   * "ask" — unknown-allowlist (no entry, mode=allowlist), no
 *     remembered approval; return {decision: "ask"} so Claude Code's
 *     built-in prompt fires.
 *
 * @param {{global: object|null, flavor: object|null}} policies
 * @param {string} serverUrl
 * @param {string} serverName
 * @returns {{
 *   classification: "allow"|"warn"|"block"|"ask",
 *   decision: object
 * }}
 */
export function classifyServer(policies, serverUrl, serverName) {
  const decision = evaluateServer(policies, serverUrl, serverName);
  // Step 1: if the decision came from the mode_default branch
  // AND the global mode is allowlist, treat it as "ask" — the
  // user gets prompted yes/no instead of an automatic block.
  // This is the unknown-allowlist case the D139 reactive flow
  // is built around. Explicit deny entries (decisionPath =
  // flavor_entry / global_entry with decision=block) still
  // classify as block.
  if (
    decision.decisionPath === "mode_default"
    && policies.global?.mode === "allowlist"
  ) {
    return { classification: "ask", decision };
  }
  if (decision.decision === "block") {
    return { classification: "block", decision };
  }
  if (decision.decision === "warn") {
    return { classification: "warn", decision };
  }
  return { classification: "allow", decision };
}

function findEntry(policy, fingerprint) {
  if (!policy || !Array.isArray(policy.entries)) {
    return null;
  }
  for (const entry of policy.entries) {
    if (entry?.fingerprint === fingerprint) {
      return entry;
    }
  }
  return null;
}

function decisionFromEntry(entry, decisionPath, policyDoc, fingerprint) {
  let decisionValue;
  if (entry.entry_kind === "allow") {
    decisionValue = "allow";
  } else if (entry.enforcement === "warn" || entry.enforcement === "block") {
    decisionValue = entry.enforcement;
  } else {
    decisionValue = "block";
  }
  let scope = "global";
  if (policyDoc?.scope === "flavor") {
    scope = `flavor:${policyDoc.scope_value || ""}`;
  }
  return {
    decision: decisionValue,
    decisionPath,
    policyId: policyDoc?.id || "",
    scope,
    fingerprint,
    // Phase 7 Step 2 (D148): matched_entry surface for the shared
    // policy_decision block. Plugin-side parity with the sensor's
    // MCPPolicyDecision shape so emissions across both surfaces
    // produce byte-identical wire payloads.
    matchedEntryId: entry.id || "",
    matchedEntryLabel: entry.server_name || "",
  };
}

/**
 * Build the shared policy_decision block (D148) for plugin-side
 * policy_mcp_warn / policy_mcp_block emissions. Mirrors the sensor's
 * PolicyDecisionSummary.as_payload_dict shape byte-for-byte.
 *
 * @param {object} decision - evaluateServer() return value
 * @returns {object} the policy_decision block
 */
export function buildPolicyDecisionBlock(decision) {
  const out = {
    policy_id: decision.policyId || "",
    scope: decision.scope || "",
    decision: decision.decision,
    reason: buildPolicyReason(decision),
  };
  if (decision.decisionPath) {
    out.decision_path = decision.decisionPath;
  }
  if (decision.matchedEntryId) {
    out.matched_entry_id = decision.matchedEntryId;
  }
  if (decision.matchedEntryLabel) {
    out.matched_entry_label = decision.matchedEntryLabel;
  }
  return out;
}

/**
 * Operator-readable single-line reason per the locked Step 2
 * pattern: "<what happened> + <by what mechanism> + <relevant
 * context>". Plugin parity with the sensor's
 * _build_mcp_policy_reason. No newlines, no jargon.
 */
export function buildPolicyReason(decision) {
  const label = decision.matchedEntryLabel || "<server>";
  const verb = decision.decision === "block" ? "blocked" : "warned";
  if (decision.decisionPath === "flavor_entry") {
    return `Server ${label} ${verb} by flavor entry, enforcement=${decision.decision}`;
  }
  if (decision.decisionPath === "global_entry") {
    return `Server ${label} ${verb} by global entry, enforcement=${decision.decision}`;
  }
  // mode_default
  if (decision.decision === "block") {
    return `Server ${label} ${verb} by allow-list mode default; no matching allow entry`;
  }
  return `Server ${label} ${verb} by mode default (${decision.scope})`;
}

// ----- Per-session policy cache I/O -------------------------------

/**
 * Persist the SessionStart-fetched policy snapshot for later
 * PreToolUse reads. Atomic write via temp + rename so a concurrent
 * read can't observe a half-written file.
 *
 * @param {string} sessionId
 * @param {{global: object|null, flavor: object|null}} policies
 */
export function writeSessionPolicyCache(sessionId, policies) {
  const target = sessionPolicyCachePath(sessionId);
  const tmp = `${target}.tmp.${process.pid}`;
  try {
    writeFileSync(tmp, JSON.stringify({ version: 1, ...policies }));
    renameSync(tmp, target);
  } catch {
    // Cache write failure isn't fatal — the next PreToolUse
    // sees a missing cache and falls through to fail-open allow.
    try { unlinkSync(tmp); } catch { /* ignore */ }
  }
}

/**
 * Read the per-session policy cache. Returns the policies shape on
 * hit, null on miss / corruption / error. Tolerates everything;
 * the hook must never crash.
 *
 * @param {string} sessionId
 * @returns {{global: object|null, flavor: object|null}|null}
 */
export function readSessionPolicyCache(sessionId) {
  const target = sessionPolicyCachePath(sessionId);
  try {
    const raw = readFileSync(target, "utf8");
    const parsed = JSON.parse(raw);
    return {
      global: parsed.global ?? null,
      flavor: parsed.flavor ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Best-effort cleanup of the per-session policy cache. Called by
 * the Stop hook so $TMPDIR/flightdeck-plugin/mcp-policy-*.json
 * doesn't accumulate.
 *
 * @param {string} sessionId
 */
export function clearSessionPolicyCache(sessionId) {
  const target = sessionPolicyCachePath(sessionId);
  try {
    unlinkSync(target);
  } catch {
    // Missing file = nothing to clean. Other errors (permissions,
    // race with concurrent stop) are non-fatal.
  }
}

// Note: ``parseMcpToolName`` lives in observe_cli.mjs as the
// canonical Claude Code mcp__<server>__<tool> parser (returning
// {server_name, tool_name, parsed}). This module deliberately
// does not duplicate it — observe_cli.mjs imports both modules
// and uses its local parser at the dispatch site.
