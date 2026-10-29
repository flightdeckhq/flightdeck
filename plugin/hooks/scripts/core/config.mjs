// Client-agnostic configuration for a Flightdeck hook adapter: the
// FLIGHTDECK_* knobs every binding resolves the same way, the bounds
// applied to free-text values copied from a hook payload or the
// environment, and the plugin version stamped on session_start.
//
// Uses only Node.js built-in modules.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

// Plugin version stamped on every session_start (parity with the
// Python sensor's wire contract). Read from the package metadata at
// module load; falls back to a sentinel string when the file is
// unreachable (rare — the plugin is always installed alongside its
// package.json). Used as the ``sensor_version`` field value on
// session_start events; ingestion's validator requires the field's
// presence as a string but does not constrain its content.
export const PLUGIN_VERSION = (() => {
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(__dirname, "..", "..", "..", "package.json");
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
