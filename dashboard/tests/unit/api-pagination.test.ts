import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchOlderEvents, fetchSession } from "@/lib/api";

// D113 pagination helpers. These exercise URL shape only; every other
// /v1/events and /v1/sessions/{id} code path is already covered by the
// handler integration tests on the Go side and the SessionDrawer
// component tests.

const originalFetch = globalThis.fetch;

function installFetchSpy() {
  const spy = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({ events: [], total: 0, limit: 0, offset: 0, has_more: false }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
  globalThis.fetch = spy as unknown as typeof fetch;
  return spy;
}

describe("fetchSession events_limit (D113)", () => {
  let spy: ReturnType<typeof installFetchSpy>;
  beforeEach(() => {
    spy = installFetchSpy();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("omits events_limit when the arg is not passed", async () => {
    await fetchSession("s1");
    const url = String(spy.mock.calls[0][0]);
    expect(url).toContain("/v1/sessions/s1");
    expect(url).not.toContain("events_limit");
  });

  it("appends ?events_limit=N when the arg is set", async () => {
    await fetchSession("s1", 100);
    const url = String(spy.mock.calls[0][0]);
    expect(url).toContain("/v1/sessions/s1?events_limit=100");
  });
});

describe("fetchOlderEvents (D113)", () => {
  let spy: ReturnType<typeof installFetchSpy>;
  beforeEach(() => {
    spy = installFetchSpy();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("builds the expected URL with session_id, before, order=desc, and limit", async () => {
    const before = "2026-04-21T12:00:00Z";
    await fetchOlderEvents("s1", before, 50);
    const url = String(spy.mock.calls[0][0]);
    // URLSearchParams encodes the colons in ``before``; decode before
    // comparing so the assertion stays readable.
    const decoded = decodeURIComponent(url);
    expect(decoded).toContain("/v1/events?");
    expect(decoded).toContain("session_id=s1");
    expect(decoded).toContain(`before=${before}`);
    expect(decoded).toContain("order=desc");
    expect(decoded).toContain("limit=50");
    // The endpoint requires ``from``; the helper passes the Unix epoch
    // so the time-window filter is a no-op and ``before`` is the only
    // effective cursor bound.
    expect(decoded).toContain("from=1970-01-01T00:00:00Z");
  });
});
