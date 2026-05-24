// Runtime-config-driven access-token bootstrap.
//
// Production dashboards ship as a static SPA bundle behind nginx; the
// access token comes from /runtime-config.json (a single JSON file
// the deployer mounts over /usr/share/nginx/html/runtime-config.json
// at deploy time). Operators rotate tokens by editing the file and
// reloading nginx — no rebuild, no fresh image. Same trust boundary
// as before: anyone on the dashboard origin can fetch the file.
//
// Bootstrap order at app start:
//   1. Read localStorage. If a token is set, use it (operator-pasted
//      override always wins; honoured for token rotation testing).
//   2. Fetch /runtime-config.json. Validate. Write the token to
//      localStorage. Return it.
//   3. If both fail, surface a clear error so the operator knows what
//      to do — silent fall-through to a broken state is the failure
//      mode we want to avoid.
//
// The fetch promise is cached so concurrent ensureAccessToken() calls
// share one network round-trip. Once the bootstrap resolves,
// localStorage holds the token and downstream callers use the
// synchronous getAccessTokenSync() helper.

import { DISABLE_KEEPALIVE_WS_STORAGE_KEY } from "./constants";

export const ACCESS_TOKEN_STORAGE_KEY = "flightdeck-access-token";

// Re-export so existing callers that import the key from this
// module continue to work. The canonical definition now lives in
// ``constants.ts`` so playwright.config.ts (Node-side, can't
// import browser-globals freely) can share the same source of
// truth without a string duplicate.
export { DISABLE_KEEPALIVE_WS_STORAGE_KEY };

const RUNTIME_CONFIG_URL = "/runtime-config.json";

interface RuntimeConfig {
  access_token: string;
  api_base_url?: string;
}

/**
 * Sync read of the keep-alive WS disable flag from localStorage.
 * Returns ``true`` when the flag is set to ``"1"`` or ``"true"``
 * (case-insensitive). Used by ``useFleet`` to conditionally skip
 * its WebSocket subscription under E2E. Production callers never
 * see this flag set; the value is only written by Playwright's
 * per-project storageState bootstrap.
 */
export function isKeepaliveWsDisabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const v = window.localStorage.getItem(DISABLE_KEEPALIVE_WS_STORAGE_KEY);
    if (v == null) return false;
    const norm = v.trim().toLowerCase();
    return norm === "1" || norm === "true";
  } catch {
    return false;
  }
}

let bootstrapPromise: Promise<string> | null = null;

/**
 * Sync read of the active access token from localStorage. Returns
 * ``null`` if no token is set; callers that need a guarantee should
 * await {@link ensureAccessToken} once at app start, after which
 * this helper is guaranteed to return a non-null value.
 */
export function getAccessTokenSync(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = window.localStorage.getItem(ACCESS_TOKEN_STORAGE_KEY);
    return stored && stored.length > 0 ? stored : null;
  } catch {
    // localStorage may be unavailable (SSR, strict iframe); the
    // caller's downstream behaviour decides what to do with null.
    return null;
  }
}

/**
 * Idempotent access-token bootstrap. First call fetches
 * ``/runtime-config.json`` if localStorage is empty, writes the
 * resolved token into localStorage, and returns it. Concurrent calls
 * share the same in-flight promise, so multiple components racing the
 * bootstrap pay one fetch.
 *
 * Throws on configuration failure (fetch error, non-OK status,
 * malformed JSON, missing access_token field). Caller is expected to
 * surface the message to the operator — silent failure leaves every
 * subsequent API call to fail with a less actionable 401.
 *
 * On rejection the in-flight promise is cleared so a follow-up call
 * (e.g. user retry, transient network blip recovery) can re-attempt
 * the fetch instead of replaying the cached failure for the lifetime
 * of the tab.
 */
export function ensureAccessToken(): Promise<string> {
  if (bootstrapPromise) return bootstrapPromise;
  const pending = (async () => {
    const stored = getAccessTokenSync();
    if (stored) return stored;
    const config = await fetchRuntimeConfig();
    try {
      window.localStorage.setItem(
        ACCESS_TOKEN_STORAGE_KEY,
        config.access_token,
      );
    } catch {
      // localStorage unavailable; the access token is still returned
      // so the in-memory promise cache satisfies subsequent reads
      // for the lifetime of the page load.
    }
    return config.access_token;
  })();
  pending.catch(() => {
    if (bootstrapPromise === pending) bootstrapPromise = null;
  });
  bootstrapPromise = pending;
  return pending;
}

/** Reset the bootstrap cache. Tests only — production code never
 *  calls this. Allows a Vitest spec to re-exercise the fetch path
 *  across cases with different mocks. */
export function _resetBootstrapForTest(): void {
  bootstrapPromise = null;
}

// Bootstrap fetch deadline. Tighter than the API REQUEST_TIMEOUT_MS
// (30 s) because /runtime-config.json is served from the same origin
// as the SPA — a stalled request here means nginx isn't ready and the
// operator needs to see the actionable error fast, not after half a
// minute of blank page.
const BOOTSTRAP_TIMEOUT_MS = 10_000;

async function fetchRuntimeConfig(): Promise<RuntimeConfig> {
  const helpHint =
    `Set localStorage.${ACCESS_TOKEN_STORAGE_KEY} manually, or ` +
    `configure ${RUNTIME_CONFIG_URL} on the server.`;
  let resp: Response;
  try {
    resp = await fetch(RUNTIME_CONFIG_URL, {
      cache: "no-store",
      signal: AbortSignal.timeout(BOOTSTRAP_TIMEOUT_MS),
    });
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(
      `No access token configured. Failed to fetch ${RUNTIME_CONFIG_URL}: ${cause}. ${helpHint}`,
    );
  }
  if (!resp.ok) {
    throw new Error(
      `No access token configured. ${RUNTIME_CONFIG_URL} returned HTTP ${resp.status}. ${helpHint}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = await resp.json();
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Malformed ${RUNTIME_CONFIG_URL}: not valid JSON (${cause}). ${helpHint}`,
    );
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as Record<string, unknown>).access_token !== "string" ||
    (parsed as Record<string, unknown>).access_token === ""
  ) {
    throw new Error(
      `Malformed ${RUNTIME_CONFIG_URL}: missing required string field "access_token". ${helpHint}`,
    );
  }
  return parsed as RuntimeConfig;
}
