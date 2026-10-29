// How a Claude Code session is billed, and which endpoint serves it
// (ARCHITECTURE.md, Cost estimation > Billing modes, and Plugin > Per-turn
// flush). Decided once per session at SessionStart and kept in the
// plugin's marker directory, so later hooks never run `claude auth
// status` again.
//
// Precedence:
//   1. FLIGHTDECK_BILLING_MODE (metered / subscription / local) -- the
//      operator knows best, e.g. a subscription running on extra usage,
//      which Claude Code does not signal per request.
//   2. A cloud provider (CLAUDE_CODE_USE_BEDROCK / _VERTEX / _FOUNDRY, or
//      the provider `claude auth status` reports) -- metered.
//   3. The login method `claude auth status` reports: an API key
//      (api_key, api_key_helper) or a third-party credential is metered;
//      a claude.ai or OAuth-token login is a subscription.
//   4. When that command is unavailable: a set ANTHROPIC_API_KEY or
//      ANTHROPIC_AUTH_TOKEN is metered, anything else a subscription.

import { execFileSync } from "node:child_process";

export const BILLING_MODES = new Set(["metered", "subscription", "local"]);

// `claude auth status` login methods that pay per token.
const METERED_AUTH_METHODS = new Set(["api_key", "api_key_helper", "third_party"]);
// Login methods that run on a flat-rate plan.
const SUBSCRIPTION_AUTH_METHODS = new Set(["claude.ai", "oauth_token"]);

// Cloud providers Claude Code can run on, by the environment variable
// that selects each and by the name `claude auth status` reports.
const CLOUD_ENV_VARS = [
  ["CLAUDE_CODE_USE_BEDROCK", "bedrock"],
  ["CLAUDE_CODE_USE_VERTEX", "vertex"],
  ["CLAUDE_CODE_USE_FOUNDRY", "foundry"],
];
const CLOUD_API_PROVIDERS = new Map([
  ["bedrock", "bedrock"],
  ["vertex", "vertex"],
  ["foundry", "foundry"],
]);

// A platform label is a fixed name or a hostname; the ingestion API caps
// it at 253 characters (the DNS limit). Anything else reports as
// invalid-host so a malformed ANTHROPIC_BASE_URL cannot put arbitrary
// bytes on every event.
const HOSTNAME = /^[a-z0-9.-]{1,253}$/;
const ANTHROPIC_HOST_SUFFIX = ".anthropic.com";

// `claude auth status` is a local command that prints a small JSON
// document in well under a second; five seconds bounds a hook that
// would otherwise wait on a wedged CLI, and the plugin falls back to the
// environment when it is exceeded.
export const AUTH_STATUS_TIMEOUT_MS = 5000;

function truthy(value) {
  return typeof value === "string" && ["1", "true", "yes"].includes(value.trim().toLowerCase());
}

/**
 * Run `claude auth status` and return `{ authMethod, apiProvider }`, or
 * null when the command is missing, fails, times out or prints something
 * that is not the expected JSON. Never throws.
 */
export function readAuthStatus(run = execFileSync) {
  try {
    const out = run("claude", ["auth", "status"], {
      encoding: "utf8",
      timeout: AUTH_STATUS_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
      // On Windows the CLI is a claude.cmd shim, which only a shell
      // resolves; the arguments are fixed, so the shell sees no input.
      shell: process.platform === "win32",
    });
    const parsed = JSON.parse(out);
    if (!parsed || typeof parsed.authMethod !== "string") return null;
    return {
      authMethod: parsed.authMethod,
      apiProvider: typeof parsed.apiProvider === "string" ? parsed.apiProvider : null,
    };
  } catch {
    return null;
  }
}

// Loopback spellings of ANTHROPIC_BASE_URL (a local proxy), reported as
// the single platform "localhost" like the Python sensor does.
const LOOPBACK_HOSTS = new Set(["localhost", "::1"]);
const IPV4_LOOPBACK = /^127(\.\d{1,3}){3}$/;

/** The platform label of ANTHROPIC_BASE_URL, or "anthropic" when unset. */
function platformOfBaseUrl(baseUrl) {
  if (!baseUrl) return "anthropic";
  let host;
  try {
    // An IPv6 literal keeps its brackets in URL.hostname; a fully
    // qualified name may end in a dot.
    host = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  } catch {
    return "invalid-host";
  }
  if (LOOPBACK_HOSTS.has(host) || host.endsWith(".localhost") || IPV4_LOOPBACK.test(host)) {
    return "localhost";
  }
  if (host === "anthropic.com" || host.endsWith(ANTHROPIC_HOST_SUFFIX)) return "anthropic";
  return HOSTNAME.test(host) ? host : "invalid-host";
}

/**
 * Decide the session's billing mode, platform and (on Vertex AI)
 * inference scope from the environment and the `claude auth status`
 * result (`null` when unavailable). Pure: the caller supplies both.
 */
export function detectEndpoint(env, authStatus) {
  let platform = platformOfBaseUrl(env.ANTHROPIC_BASE_URL);
  let cloud = null;
  for (const [name, label] of CLOUD_ENV_VARS) {
    if (truthy(env[name])) {
      cloud = label;
      break;
    }
  }
  if (!cloud && authStatus?.apiProvider) cloud = CLOUD_API_PROVIDERS.get(authStatus.apiProvider) ?? null;
  if (cloud) platform = cloud;

  let billingMode;
  if (cloud) {
    billingMode = "metered";
  } else if (authStatus && METERED_AUTH_METHODS.has(authStatus.authMethod)) {
    billingMode = "metered";
  } else if (authStatus && SUBSCRIPTION_AUTH_METHODS.has(authStatus.authMethod)) {
    billingMode = "subscription";
  } else {
    billingMode = env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN ? "metered" : "subscription";
  }
  const override = (env.FLIGHTDECK_BILLING_MODE || "").trim().toLowerCase();
  if (BILLING_MODES.has(override)) billingMode = override;

  let inferenceScope = null;
  if (platform === "vertex") {
    const region = (env.CLOUD_ML_REGION || "").trim();
    if (region) inferenceScope = region === "global" ? "global" : "regional";
  }
  return { billingMode, platform, inferenceScope };
}

function count(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

// The ingestion API caps each free-form token-and-cost string at 256
// UTF-8 bytes and rejects the whole event above it; a longer value is
// left out instead.
const MAX_DETAIL_BYTES = 256;

/** Whether a value is a non-empty string the ingestion API accepts. */
export function fitsDetailString(value) {
  return (
    typeof value === "string" && value !== "" && Buffer.byteLength(value, "utf8") <= MAX_DETAIL_BYTES
  );
}

function text(value) {
  return fitsDetailString(value) ? value : null;
}

/**
 * The token and call-detail fields a transcript `usage` object carries
 * beyond the basic counts, as wire fields: the thinking share of the
 * output, the one-hour share of the cache writes, service tier, speed,
 * data residency and the non-zero server-tool counters. A share larger
 * than its total is left out, since ingestion would reject the event.
 * Fields the usage object does not carry are omitted.
 */
export function usageDetailFields(usage = {}) {
  const out = {};
  const output = Number(usage.output_tokens || 0);
  const cacheCreation = Number(usage.cache_creation_input_tokens || 0);
  const thinking = count(usage.output_tokens_details?.thinking_tokens);
  if (thinking !== null && thinking <= output) out.tokens_reasoning = thinking;
  const oneHour = count(usage.cache_creation?.ephemeral_1h_input_tokens);
  if (oneHour !== null && oneHour <= cacheCreation) out.tokens_cache_creation_1h = oneHour;
  for (const key of ["service_tier", "speed", "inference_geo"]) {
    const value = text(usage[key]);
    if (value) out[key] = value;
  }
  const tools = {};
  for (const key of ["web_search_requests", "web_fetch_requests"]) {
    const n = count(usage.server_tool_use?.[key]);
    if (n) tools[key] = n;
  }
  if (Object.keys(tools).length > 0) out.server_tool_use = tools;
  return out;
}
