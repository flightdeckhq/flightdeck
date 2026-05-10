// Plugin-side remembered decisions cache (D139).
//
// Per-token JSON file at
// ~/.claude/flightdeck/remembered_mcp_decisions-<tokenPrefix>.json
// captures user "yes" approvals for unknown-allowlist MCP servers.
// PreToolUse reads this file fresh on every invocation so concurrent
// Claude Code sessions on the same machine see each other's
// approvals in real time without restart. PostToolUse writes the
// file when an `mcp__<server>__<tool>` call succeeded AND the server
// was unknown-allowlist on this session AND no remembered decision
// exists yet — the reactive yes-and-remember path locked in D139.
//
// Atomic writes via temp-file + rename so a concurrent read can't
// observe a half-written file. Reads tolerate missing or corrupted
// files by returning an empty list (the hook must never crash).
//
// Pure Node built-ins: node:crypto, node:fs, node:os, node:path.
// No npm dependencies — preserves the plugin's zero-dep posture.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// File-name token prefix length. Matches the
// access_tokens.prefix indexing convention on the API side
// (16 hex chars of SHA-256). See D139.
const TOKEN_PREFIX_HEX_CHARS = 16;

const FLIGHTDECK_HOME_DIRNAME = "flightdeck";

/**
 * Compute the on-disk path for a token's remembered-decisions
 * file. The token's first 16 hex chars of SHA-256 keyed at the
 * filename so two operators on one machine don't share files
 * (D139 per-token isolation).
 *
 * @param {string} token
 * @returns {string} absolute path
 */
export function rememberedFilePath(token) {
  const prefix = createHash("sha256")
    .update(String(token), "utf8")
    .digest("hex")
    .slice(0, TOKEN_PREFIX_HEX_CHARS);
  return join(
    homedir(),
    ".claude",
    FLIGHTDECK_HOME_DIRNAME,
    `remembered_mcp_decisions-${prefix}.json`,
  );
}

function ensureParentDir(path) {
  const parent = path.slice(0, path.lastIndexOf("/"));
  if (parent && !existsSync(parent)) {
    try {
      mkdirSync(parent, { recursive: true });
    } catch {
      // Directory creation failure handled at the caller (write
      // path catches and logs at most; read path returns empty).
    }
  }
}

/**
 * Read the remembered-decisions file for this token. Returns
 * `{version, decisions}` shape on hit; returns
 * `{version: 1, decisions: []}` on missing-file / corrupt-JSON /
 * permission error. Tolerates everything — the hook must never
 * crash.
 *
 * @param {string} token
 * @returns {{version: number, decisions: Array<object>}}
 */
export function readRememberedDecisions(token) {
  const path = rememberedFilePath(token);
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    if (
      parsed
      && typeof parsed === "object"
      && Array.isArray(parsed.decisions)
    ) {
      return {
        version: typeof parsed.version === "number" ? parsed.version : 1,
        decisions: parsed.decisions,
      };
    }
    return { version: 1, decisions: [] };
  } catch {
    return { version: 1, decisions: [] };
  }
}

/**
 * Append a remembered decision for this token. Atomic via
 * write-temp + rename. Idempotent: if a decision for the same
 * fingerprint already exists, leaves the file unchanged (the
 * earliest decided_at wins so the operator-visible event stream
 * doesn't get a flood of duplicates from the reactive
 * PostToolUse path on every successful call).
 *
 * @param {string} token
 * @param {{
 *   fingerprint: string,
 *   serverUrlCanonical: string,
 *   serverName: string,
 *   decidedAt: string
 * }} decision
 */
export function writeRememberedDecision(token, decision) {
  const path = rememberedFilePath(token);
  ensureParentDir(path);
  const current = readRememberedDecisions(token);
  if (
    current.decisions.some(
      (d) => d?.fingerprint === decision.fingerprint,
    )
  ) {
    // Already remembered. PostToolUse calls this on every
    // successful unknown-allowlist call until the cache is
    // populated; the idempotent guard makes that safe.
    return;
  }
  const next = {
    version: 1,
    decisions: [
      ...current.decisions,
      {
        fingerprint: decision.fingerprint,
        server_url_canonical: decision.serverUrlCanonical,
        server_name: decision.serverName,
        decided_at: decision.decidedAt,
      },
    ],
  };
  const tmp = `${path}.tmp.${process.pid}`;
  try {
    writeFileSync(tmp, JSON.stringify(next, null, 2));
    renameSync(tmp, path);
  } catch {
    // Best-effort write. Failure here means the user re-approves
    // next session — annoying but not catastrophic.
    try {
      unlinkSync(tmp);
    } catch {
      // ignore
    }
  }
}

/**
 * Look up a fingerprint in the remembered-decisions file.
 * Returns the decision record on hit, null on miss.
 *
 * @param {string} token
 * @param {string} fingerprint
 * @returns {object|null}
 */
export function lookupRemembered(token, fingerprint) {
  const { decisions } = readRememberedDecisions(token);
  for (const d of decisions) {
    if (d?.fingerprint === fingerprint) {
      return d;
    }
  }
  return null;
}
