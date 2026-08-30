// Tests for the runtime-config-driven access-token bootstrap.
// The token is MEMORY-ONLY (security hardening): it is never written
// to or read from localStorage/sessionStorage. Covers:
//   (a) fetch succeeds → token held in memory and returned; a second
//       ensureAccessToken() call reuses it without re-fetching.
//   (b) fetch fails → actionable Error, in-memory token stays null.
// Also covers the in-flight promise cache so concurrent callers
// share one fetch.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetBootstrapForTest,
  ensureAccessToken,
  getAccessTokenSync,
} from "@/lib/runtime-config";

const originalFetch = global.fetch;

beforeEach(() => {
  window.localStorage.clear();
  _resetBootstrapForTest();
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

function mockFetchOk(body: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => body,
  })) as unknown as typeof fetch;
  global.fetch = fetchMock;
  return fetchMock as unknown as ReturnType<typeof vi.fn>;
}

function mockFetchHttpError(status: number): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => ({
    ok: false,
    status,
    json: async () => ({}),
  })) as unknown as typeof fetch;
  global.fetch = fetchMock;
  return fetchMock as unknown as ReturnType<typeof vi.fn>;
}

function mockFetchNetworkError(message: string): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => {
    throw new Error(message);
  }) as unknown as typeof fetch;
  global.fetch = fetchMock;
  return fetchMock as unknown as ReturnType<typeof vi.fn>;
}

describe("runtime-config bootstrap", () => {
  it("holds the fetched token in memory and reuses it without re-fetching on a second call", async () => {
    const fetchMock = mockFetchOk({ access_token: "ftd_runtime_abc" });

    const first = await ensureAccessToken();
    expect(first).toBe("ftd_runtime_abc");
    expect(getAccessTokenSync()).toBe("ftd_runtime_abc");

    // Second call short-circuits to the cached in-flight promise; the
    // fetch is never repeated.
    const second = await ensureAccessToken();
    expect(second).toBe("ftd_runtime_abc");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never persists the token to localStorage/sessionStorage", async () => {
    mockFetchOk({ access_token: "ftd_runtime_abc" });

    await ensureAccessToken();

    // Security invariant: the bearer must not be recoverable from web
    // storage across reloads or by an XSS payload scraping it.
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("fetches /runtime-config.json with cache: no-store and returns the token on first run", async () => {
    const fetchMock = mockFetchOk({ access_token: "ftd_runtime_abc" });

    const token = await ensureAccessToken();

    expect(token).toBe("ftd_runtime_abc");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/runtime-config.json");
    expect(init.cache).toBe("no-store");
    expect(getAccessTokenSync()).toBe("ftd_runtime_abc");
  });

  it("throws an actionable error when the runtime-config fetch fails over the network", async () => {
    mockFetchNetworkError("connection refused");

    await expect(ensureAccessToken()).rejects.toThrow(
      /No access token configured.*connection refused.*runtime-config\.json/,
    );
    expect(getAccessTokenSync()).toBeNull();
  });

  it("throws an actionable error when /runtime-config.json returns a non-2xx status", async () => {
    mockFetchHttpError(404);

    await expect(ensureAccessToken()).rejects.toThrow(
      /No access token configured.*HTTP 404.*runtime-config\.json/,
    );
    expect(getAccessTokenSync()).toBeNull();
  });

  it("throws when /runtime-config.json is missing the access_token field", async () => {
    mockFetchOk({ unrelated: "shape" });

    await expect(ensureAccessToken()).rejects.toThrow(
      /Malformed.*missing required string field "access_token"/,
    );
  });

  it("throws when /runtime-config.json carries an empty access_token string", async () => {
    mockFetchOk({ access_token: "" });

    await expect(ensureAccessToken()).rejects.toThrow(
      /Malformed.*missing required string field "access_token"/,
    );
  });

  it("shares the in-flight promise across concurrent ensureAccessToken() callers", async () => {
    const fetchMock = mockFetchOk({ access_token: "single-fetch" });

    const [a, b, c] = await Promise.all([
      ensureAccessToken(),
      ensureAccessToken(),
      ensureAccessToken(),
    ]);

    expect(a).toBe("single-fetch");
    expect(b).toBe("single-fetch");
    expect(c).toBe("single-fetch");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("getAccessTokenSync", () => {
  it("returns null before the bootstrap has resolved a token", () => {
    expect(getAccessTokenSync()).toBeNull();
  });

  it("returns the in-memory token after ensureAccessToken resolves", async () => {
    mockFetchOk({ access_token: "ftd_dev_xyz" });
    await ensureAccessToken();
    expect(getAccessTokenSync()).toBe("ftd_dev_xyz");
  });

  it("stays null after a failed bootstrap (no token is persisted)", async () => {
    mockFetchHttpError(500);
    await expect(ensureAccessToken()).rejects.toThrow();
    expect(getAccessTokenSync()).toBeNull();
  });
});
