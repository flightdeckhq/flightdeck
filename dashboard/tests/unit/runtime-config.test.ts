// Tests for the runtime-config-driven access-token bootstrap.
// Covers the three bootstrap paths the operator can hit:
//   (a) localStorage already has a token → fetch is skipped.
//   (b) localStorage empty + fetch succeeds → token written to
//       localStorage and returned.
//   (c) localStorage empty + fetch fails → actionable Error.
// Also covers the in-flight promise cache so concurrent callers
// share one fetch.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ACCESS_TOKEN_STORAGE_KEY,
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
  it("returns the localStorage token without fetching when one is already set", async () => {
    window.localStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, "operator-pasted-token");
    const fetchMock = mockFetchOk({ access_token: "should-not-be-used" });

    const token = await ensureAccessToken();

    expect(token).toBe("operator-pasted-token");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getAccessTokenSync()).toBe("operator-pasted-token");
  });

  it("fetches /runtime-config.json, writes the token to localStorage, and returns it on first run", async () => {
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
      /No access token configured.*connection refused.*flightdeck-access-token/,
    );
    expect(getAccessTokenSync()).toBeNull();
  });

  it("throws an actionable error when /runtime-config.json returns a non-2xx status", async () => {
    mockFetchHttpError(404);

    await expect(ensureAccessToken()).rejects.toThrow(
      /No access token configured.*HTTP 404.*flightdeck-access-token/,
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
  it("returns null when localStorage is empty", () => {
    expect(getAccessTokenSync()).toBeNull();
  });

  it("returns the stored token when present", () => {
    window.localStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, "ftd_dev_xyz");
    expect(getAccessTokenSync()).toBe("ftd_dev_xyz");
  });

  it("returns null for an empty-string entry (treats it as unset)", () => {
    window.localStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, "");
    expect(getAccessTokenSync()).toBeNull();
  });
});
