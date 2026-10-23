import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

const api = vi.hoisted(() => ({
  fetchSession: vi.fn(),
  fetchSearch: vi.fn(),
  fetchAnalytics: vi.fn(),
  fetchBulkEvents: vi.fn(),
}));

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return { ...actual, ...api };
});

import { useSession, invalidateSessionCache } from "@/hooks/useSession";
import { useSearch } from "@/hooks/useSearch";
import { useAnalytics } from "@/hooks/useAnalytics";
import { useHistoricalEvents } from "@/hooks/useHistoricalEvents";

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

const detail = (id: string) => ({ session: { session_id: id }, events: [], attachments: [] });

describe("useSession", () => {
  it("fetches once, then serves the cache without another request", async () => {
    invalidateSessionCache("s-cache");
    api.fetchSession.mockResolvedValue(detail("s-cache"));
    const first = renderHook(() => useSession("s-cache"));
    await waitFor(() => expect(first.result.current.data).not.toBeNull());
    first.unmount();

    const second = renderHook(() => useSession("s-cache"));
    expect(second.result.current.data).not.toBeNull();
    expect(second.result.current.loading).toBe(false);
    expect(api.fetchSession).toHaveBeenCalledTimes(1);
  });

  it("refetches when revalidationKey moves past the cached entry", async () => {
    invalidateSessionCache("s-reval");
    api.fetchSession.mockResolvedValue(detail("s-reval"));
    const { result, rerender } = renderHook(({ rk }) => useSession("s-reval", undefined, rk), {
      initialProps: { rk: 0 },
    });
    await waitFor(() => expect(result.current.data).not.toBeNull());
    rerender({ rk: 1 });
    await waitFor(() => expect(api.fetchSession).toHaveBeenCalledTimes(2));
    // The same revision again is served from the refreshed cache.
    rerender({ rk: 1 });
    expect(api.fetchSession).toHaveBeenCalledTimes(2);
  });

  it("is idle for a null session id", () => {
    const { result } = renderHook(() => useSession(null));
    expect(result.current).toEqual({ data: null, loading: false, error: null });
    expect(api.fetchSession).not.toHaveBeenCalled();
  });

  it("reports a fetch failure as a message", async () => {
    invalidateSessionCache("s-err");
    api.fetchSession.mockRejectedValue(new Error("nope"));
    const { result } = renderHook(() => useSession("s-err"));
    await waitFor(() => expect(result.current.error).toBe("nope"));
    expect(result.current.loading).toBe(false);
  });
});

describe("useSession review regressions", () => {
  it("shows this session's own data while it revalidates, never another session's", async () => {
    for (const id of ["s-A", "s-B"]) invalidateSessionCache(id);
    api.fetchSession.mockImplementation(async (id: string) => detail(id));
    const { result, rerender } = renderHook(({ id, rk }) => useSession(id, undefined, rk), {
      initialProps: { id: "s-A", rk: 0 },
    });
    await waitFor(() => expect(result.current.data?.session.session_id).toBe("s-A"));
    rerender({ id: "s-B", rk: 0 });
    await waitFor(() => expect(result.current.data?.session.session_id).toBe("s-B"));
    rerender({ id: "s-A", rk: 0 });
    expect(result.current.data?.session.session_id).toBe("s-A");

    // Revalidate A; hold the response so the in-flight state is visible.
    let release: (v: unknown) => void = () => {};
    api.fetchSession.mockImplementationOnce(() => new Promise((r) => (release = r)));
    rerender({ id: "s-A", rk: 1 });
    expect(result.current.loading).toBe(true);
    expect(result.current.data?.session.session_id).toBe("s-A");
    await act(async () => release(detail("s-A")));
    expect(result.current.data?.session.session_id).toBe("s-A");
  });

  it("a superseded fetch that settles late does not overwrite the cache", async () => {
    invalidateSessionCache("s-limit");
    let releaseOld: (v: unknown) => void = () => {};
    const oldDetail = { ...detail("s-limit"), events: new Array(100).fill({ id: "x" }) };
    const newDetail = { ...detail("s-limit"), events: new Array(50).fill({ id: "y" }) };
    api.fetchSession
      .mockImplementationOnce(() => new Promise((r) => (releaseOld = r)))
      .mockResolvedValueOnce(newDetail);
    const { result, rerender, unmount } = renderHook(({ limit }) => useSession("s-limit", limit), {
      initialProps: { limit: 100 },
    });
    rerender({ limit: 50 });
    await waitFor(() => expect(result.current.data?.events).toHaveLength(50));
    await act(async () => releaseOld(oldDetail));
    expect(result.current.data?.events).toHaveLength(50);
    unmount();
    // A fresh mount reads the cache: it must hold the 50-event answer.
    const again = renderHook(() => useSession("s-limit", 50));
    expect(again.result.current.data?.events).toHaveLength(50);
  });
});

describe("useSearch", () => {
  it("does not search short queries", () => {
    const { result } = renderHook(() => useSearch("a"));
    expect(result.current).toEqual({ results: null, loading: false, error: null });
    expect(api.fetchSearch).not.toHaveBeenCalled();
  });

  it("debounces: only the last of quick successive queries is sent", async () => {
    vi.useFakeTimers();
    api.fetchSearch.mockResolvedValue({ sessions: [] });
    const { result, rerender } = renderHook(({ q }) => useSearch(q), {
      initialProps: { q: "ab" },
    });
    rerender({ q: "abc" });
    rerender({ q: "abcd" });
    expect(result.current.loading).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(api.fetchSearch).toHaveBeenCalledTimes(1);
    expect(api.fetchSearch.mock.calls[0]![0]).toBe("abcd");
    expect(result.current.results).toEqual({ sessions: [] });
    expect(result.current.loading).toBe(false);
  });
});

describe("useAnalytics", () => {
  it("loads, and refetch re-runs the same query", async () => {
    api.fetchAnalytics.mockResolvedValue({ series: [] });
    const params = { metric: "tokens", group_by: "model" } as never;
    const { result } = renderHook(() => useAnalytics(params));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.data).toEqual({ series: [] }));
    act(() => result.current.refetch());
    await waitFor(() => expect(api.fetchAnalytics).toHaveBeenCalledTimes(2));
  });

  it("reports a failure as a message", async () => {
    api.fetchAnalytics.mockRejectedValue(new Error("down"));
    const { result } = renderHook(() => useAnalytics({ metric: "tokens" } as never));
    await waitFor(() => expect(result.current.error).toBe("down"));
  });
});

describe("useHistoricalEvents", () => {
  const ev = (id: string) => ({ id }) as never;

  it("loads the first page and appends the next on loadMore", async () => {
    api.fetchBulkEvents
      .mockResolvedValueOnce({ events: [ev("a"), ev("b")], total: 3, has_more: true })
      .mockResolvedValueOnce({ events: [ev("c")], total: 3, has_more: false });
    const { result } = renderHook(() => useHistoricalEvents("1h"));
    await waitFor(() => expect(result.current.events).toHaveLength(2));
    expect(result.current.hasMore).toBe(true);

    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.events).toHaveLength(3));
    expect(result.current.hasMore).toBe(false);
    // The second request continues from the first page's offset and window.
    const [firstArgs, secondArgs] = api.fetchBulkEvents.mock.calls.map((c) => c[0]);
    expect(secondArgs.offset).toBe(2);
    expect(secondArgs.from).toBe(firstArgs.from);
  });

  it("a second loadMore before the first settles does not append the same page twice", async () => {
    let releaseFirst: (v: unknown) => void = () => {};
    api.fetchBulkEvents
      .mockResolvedValueOnce({ events: [ev("a")], total: 3, has_more: true })
      .mockImplementationOnce(() => new Promise((r) => (releaseFirst = r)))
      .mockResolvedValueOnce({ events: [ev("b")], total: 3, has_more: true });
    const { result } = renderHook(() => useHistoricalEvents("1h"));
    await waitFor(() => expect(result.current.events).toHaveLength(1));
    act(() => result.current.loadMore());
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.events).toHaveLength(2));
    // The superseded first request settling late changes nothing.
    await act(async () => releaseFirst({ events: [ev("b")], total: 3, has_more: true }));
    expect(result.current.events.map((e) => (e as { id: string }).id)).toEqual(["a", "b"]);
  });

  it("reports a failed first loadMore", async () => {
    api.fetchBulkEvents
      .mockResolvedValueOnce({ events: [ev("a")], total: 2, has_more: true })
      .mockRejectedValueOnce(new Error("page failed"));
    const { result } = renderHook(() => useHistoricalEvents("1h"));
    await waitFor(() => expect(result.current.events).toHaveLength(1));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.error).toBe("page failed"));
  });

  it("keeps the previous range's events until the new range loads, then drops appended pages", async () => {
    let releaseSecond: (v: unknown) => void = () => {};
    api.fetchBulkEvents
      .mockResolvedValueOnce({ events: [ev("a")], total: 2, has_more: true })
      .mockResolvedValueOnce({ events: [ev("b")], total: 2, has_more: false })
      .mockImplementationOnce(() => new Promise((r) => (releaseSecond = r)));
    const { result, rerender } = renderHook(({ r }) => useHistoricalEvents(r), {
      initialProps: { r: "1h" as const },
    });
    await waitFor(() => expect(result.current.events).toHaveLength(1));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.events).toHaveLength(2));

    rerender({ r: "5m" as never });
    expect(result.current.loading).toBe(true);
    expect(result.current.events.map((e) => (e as { id: string }).id)).toEqual(["a", "b"]);
    await act(async () => releaseSecond({ events: [ev("z")], total: 1, has_more: false }));
    expect(result.current.events.map((e) => (e as { id: string }).id)).toEqual(["z"]);
  });
});
