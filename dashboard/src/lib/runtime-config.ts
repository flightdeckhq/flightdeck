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
//   1. Fetch /runtime-config.json. Validate. Hold the token in memory.
//      Return it.
//   2. If the fetch fails, surface a clear error so the operator knows
//      what to do — silent fall-through to a broken state is the
//      failure mode we want to avoid.
//
// SECURITY: the bearer token is held IN MEMORY ONLY (the module-level
// ``accessToken`` variable below). It is never written to localStorage
// or sessionStorage, so it is not persisted across reloads and cannot
// be exfiltrated by an XSS payload reading web storage — a fresh page
// load always re-fetches it from /runtime-config.json (same-origin).
//
// The fetch promise is cached so concurrent ensureAccessToken() calls
// share one network round-trip. Once the bootstrap resolves, the
// in-memory token is populated and downstream callers use the
// synchronous getAccessTokenSync() helper.

import { DISABLE_KEEPALIVE_WS_STORAGE_KEY } from "./constants";

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

// SECURITY: the resolved access token lives here, in memory, for the
// lifetime of the page load only. It is intentionally NOT persisted to
// localStorage/sessionStorage — not written on bootstrap, not read on
// reload — so it cannot survive a reload or be exfiltrated by an XSS
// payload scraping web storage. Each fresh load re-fetches it from
// /runtime-config.json (same-origin).
let accessToken: string | null = null;

/**
 * Sync read of the active in-memory access token. Returns ``null`` if
 * no token has been resolved yet; callers that need a guarantee should
 * await {@link ensureAccessToken} once at app start, after which this
 * helper is guaranteed to return a non-null value for the lifetime of
 * the page.
 */
export function getAccessTokenSync(): string | null {
  return accessToken;
}

/**
 * Idempotent access-token bootstrap. First call fetches
 * ``/runtime-config.json``, stores the resolved token in the
 * module-level in-memory variable, and returns it. Concurrent calls
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
    const config = await fetchRuntimeConfig();
    // Memory-only: hold the token in the module-level variable so
    // getAccessTokenSync() can serve it synchronously. Never persisted.
    accessToken = config.access_token;
    return config.access_token;
  })();
  pending.catch(() => {
    if (bootstrapPromise === pending) bootstrapPromise = null;
  });
  bootstrapPromise = pending;
  return pending;
}

/** Reset the bootstrap cache and in-memory token. Tests only —
 *  production code never calls this. Allows a Vitest spec to
 *  re-exercise the fetch path across cases with different mocks. */
export function _resetBootstrapForTest(): void {
  bootstrapPromise = null;
  accessToken = null;
}

// Bootstrap fetch deadline. Tighter than the API REQUEST_TIMEOUT_MS
// (30 s) because /runtime-config.json is served from the same origin
// as the SPA — a stalled request here means nginx isn't ready and the
// operator needs to see the actionable error fast, not after half a
// minute of blank page.
const BOOTSTRAP_TIMEOUT_MS = 10_000;

async function fetchRuntimeConfig(): Promise<RuntimeConfig> {
  // Memory-only token: there is no localStorage override to suggest;
  // the only fix path is configuring the file the server serves.
  const helpHint = `Configure ${RUNTIME_CONFIG_URL} on the server.`;
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
