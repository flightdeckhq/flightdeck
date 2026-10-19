// MCP server identity primitive — Node twin of
// sensor/flightdeck_sensor/interceptor/mcp_identity.py.
//
// Both implementations MUST produce byte-identical output for
// identical inputs. The cross-language fixture vectors at
// tests/fixtures/mcp_identity_vectors.json lock both surfaces
// against drift; plugin/tests/mcp_identity.test.mjs and
// sensor/tests/unit/test_mcp_identity.py assert the same vectors.
//
// Identity is the pair (URL, name). The URL is the security key;
// the name is display + tamper-evidence. The full SHA-256
// of canonical_url + 0x00 + name is the storage key; the first
// 16 hex chars are the display fingerprint.
//
// Uses only Node built-ins (node:crypto, URL global, process.env)
// so the plugin preserves its zero-npm-dependency posture
// (mirrors plugin/hooks/scripts/agent_id.mjs / uuid5.mjs).
//
// See ARCHITECTURE.md "MCP Protection Policy" → "Identity model"
// for the contract this module implements.

import { createHash } from "node:crypto";

// Default ports stripped from HTTP canonical form. A declaration of
// `https://host:443/path` and `https://host/path` produce the same
// fingerprint — the explicit port is cosmetic when it matches the
// scheme default.
const DEFAULT_PORTS = { "http:": "80", "https:": "443" };

// Env-var regex matches `$VAR` and `${VAR}` shapes. POSIX-style
// only — no tilde expansion (resolution is limited to env vars).
// Unresolved variables (not present in process.env) remain LITERAL
// in the canonical form: `${MISSING_VAR}` stays `${MISSING_VAR}`.
// Keeping unresolved vars literal means a missing env var produces
// a stable fingerprint that doesn't accidentally match another
// agent's empty-string substitution.
const ENV_VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

// Whitespace collapse applies globally inside the stdio canonical
// form (Assumption Y locked in step 2). Every run of whitespace
// becomes a single space; leading and trailing whitespace are
// stripped. An arg containing multi-space whitespace collapses by
// design — callers should normalize args before declaring them.
// This is documented in README.md "MCP Protection Policy" →
// "Troubleshooting".
const WHITESPACE_RUN_RE = /\s+/g;

function resolveEnvVars(raw) {
  return raw.replace(ENV_VAR_RE, (match, braced, bare) => {
    const name = braced || bare;
    // process.env.<name> falls back to the original match when the
    // variable is unset, preserving the literal form so missing-env
    // vectors stay deterministic.
    const value = process.env[name];
    return value === undefined ? match : value;
  });
}

function canonicalizeHttp(raw) {
  // The URL global lowercases scheme + host automatically and
  // surfaces user-info, port, path, fragment, and query as named
  // properties — no manual parsing needed.
  const u = new URL(raw);
  const scheme = u.protocol; // includes trailing `:`, e.g. "https:"
  const host = u.hostname.toLowerCase();
  const port = u.port; // empty string when default

  let netloc = host;
  if (port !== "" && DEFAULT_PORTS[scheme] !== port) {
    netloc = `${host}:${port}`;
  }

  let path = u.pathname || "";
  // Strip trailing slash only at the root. `/api/` keeps its slash
  // because path semantics carry beyond root.
  if (path === "/") {
    path = "";
  }

  // Drop user-info (URL.username / URL.password not appended),
  // fragment (URL.hash), and query (URL.search) by reconstructing
  // manually. The trailing `:` in scheme is already part of the
  // protocol property, so no extra colon is needed.
  return `${scheme}//${netloc}${path}`;
}

function canonicalizeStdio(raw) {
  let body = raw;
  if (body.toLowerCase().startsWith("stdio://")) {
    body = body.slice("stdio://".length);
  }

  body = resolveEnvVars(body);
  // Whitespace runs collapsed to single space globally; leading
  // and trailing whitespace stripped.
  body = body.replace(WHITESPACE_RUN_RE, " ").trim();

  return `stdio://${body}`;
}

/**
 * Reduce `raw` to its canonical form.
 *
 * HTTP / HTTPS URLs route to the HTTP canonicalisation. Anything
 * else routes to the stdio canonicalisation, which prepends
 * `stdio://` if missing. The lenient default lets callers pass a
 * bare `"npx -y package"` command and still get a deterministic
 * fingerprint without learning the scheme convention.
 *
 * Throws TypeError on non-string input. An empty string returns
 * `"stdio://"`; a string consisting only of whitespace returns
 * `"stdio://"`. Callers that want to reject empty inputs should
 * validate before calling.
 *
 * @param {string} raw
 * @returns {string}
 */
export function canonicalizeUrl(raw) {
  if (typeof raw !== "string") {
    throw new TypeError(`raw must be string, got ${typeof raw}`);
  }
  const lower = raw.toLowerCase();
  if (lower.startsWith("http://") || lower.startsWith("https://")) {
    return canonicalizeHttp(raw);
  }
  return canonicalizeStdio(raw);
}

/**
 * Full 64-character hex SHA-256 of `canonical_url + 0x00 + name`.
 *
 * The 0x00 separator prevents collisions between
 * `("https://a.com", "bservice")` and `("https://a.combservice", "")` —
 * without a non-printable separator a plain concatenation hash
 * collides on those.
 *
 * @param {string} canonicalUrl
 * @param {string} name
 * @returns {string}
 */
export function fingerprint(canonicalUrl, name) {
  if (typeof canonicalUrl !== "string") {
    throw new TypeError("canonicalUrl must be string");
  }
  if (typeof name !== "string") {
    throw new TypeError("name must be string");
  }
  // 0x00 separator via \u0000 Unicode escape — matches the Python
  // primitive's `canonical_url + "\0" + name` byte-for-byte at
  // runtime while keeping the source file ASCII (a literal NUL
  // byte in source would make git treat the file as binary,
  // breaking PR diff rendering).
  const payload = `${canonicalUrl}\u0000${name}`;
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

/**
 * First 16 hex characters of {@link fingerprint} — the display
 * fingerprint surfaced in the dashboard and in policy entries.
 *
 * @param {string} canonicalUrl
 * @param {string} name
 * @returns {string}
 */
export function fingerprintShort(canonicalUrl, name) {
  return fingerprint(canonicalUrl, name).slice(0, 16);
}
