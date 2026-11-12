// MCP Protection Policy enforcement through Claude Code's hooks:
// SessionStart fetches and caches the policy, PreToolUse answers with a
// permission decision, PostToolUse records a de-facto approval.

import { MAX_SIGNAL_BYTES, boundedToken } from "../core/config.mjs";
import { postEvent } from "../core/poster.mjs";
import { canonicalizeUrl as _mcpCanonicalizeUrl } from "../mcp_identity.mjs";
import {
  buildPolicyDecisionBlock,
  classifyServer,
  fetchPolicies,
  readSessionPolicyCache,
  writeSessionPolicyCache,
} from "../mcp_policy.mjs";
import { lookupRemembered, writeRememberedDecision } from "../remembered_decisions.mjs";
import { loadMcpServerFingerprints, resolveMcpToolIdentity } from "./mcp.mjs";
import { getSessionId } from "./session.mjs";

// ---------------------------------------------------------------------
// MCP Protection Policy hook dispatchers.
//
// Three entry points exposed for the dispatch loop (dispatch.mjs):
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
    // to say. Returning false lets the dispatcher fall through and exit
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
    // The mode the session was in when the approved call ran; audit
    // context only, since Claude Code honours the gate's "ask" in every
    // mode. Omitted when the hook carries none.
    permission_mode: boundedToken(hookEvent.permission_mode, MAX_SIGNAL_BYTES) ?? undefined,
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
