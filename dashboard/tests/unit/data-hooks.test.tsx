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
import { eventsCache, fullHistoryLoaded } from "@/hooks/useSessionEvents";
import {
  HISTORY_DRAIN_MAX_EVENTS,
  HISTORY_PAGE_SIZE,
  TIMELINE_RANGE_MS,
  type TimeRange,
} from "@/lib/constants";

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

describe("useSession and the events cache", () => {
  it("merges a newest-N fetch into a longer cached list instead of skipping it", async () => {
    invalidateSessionCache("s-merge");
    const at = (s: number) => `2026-05-15T12:00:${String(s).padStart(2, "0")}Z`;
    const e = (id: string, s: number) => ({ id, session_id: "s-merge", occurred_at: at(s) }) as never;
    // The cache holds three older events (a window load), the drawer's
    // newest-2 fetch brings one it lacks.
    eventsCache.set("s-merge", [e("a", 1), e("b", 2), e("c", 3)]);
    api.fetchSession.mockResolvedValue({ ...detail("s-merge"), events: [e("c", 3), e("d", 4)] });
    const { result } = renderHook(() => useSession("s-merge", 2));
    await waitFor(() => expect(result.current.data).not.toBeNull());
    expect((eventsCache.get("s-merge") ?? []).map((x) => x.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("invalidateSessionCache keeps the run's cached events", () => {
    eventsCache.set("s-keep", [{ id: "k", session_id: "s-keep", occurred_at: "2026-05-15T12:00:00Z" } as never]);
    invalidateSessionCache("s-keep");
    expect(eventsCache.get("s-keep")).toHaveLength(1);
  });

  it("marks a run's history whole only when the fetch was uncapped or came back short of its cap", async () => {
    const e = (id: string, sid: string) =>
      ({ id, session_id: sid, occurred_at: `2026-05-15T12:00:0${id.length}Z` }) as never;
    for (const id of ["s-full", "s-short", "s-capped"]) invalidateSessionCache(id);
    api.fetchSession.mockImplementation(async (id: string, limit?: number) => ({
      ...detail(id),
      events: id === "s-capped" ? [e("a", id), e("bb", id)].slice(0, limit) : [e("a", id)],
    }));
    for (const [id, limit] of [["s-full", undefined], ["s-short", 2], ["s-capped", 2]] as const) {
      const { result } = renderHook(() => useSession(id, limit));
      await waitFor(() => expect(result.current.data).not.toBeNull());
    }
    expect(fullHistoryLoaded.has("s-full")).toBe(true);
    expect(fullHistoryLoaded.has("s-short")).toBe(true);
    expect(fullHistoryLoaded.has("s-capped")).toBe(false);
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
  /** An event at second ``s`` of the window, newest first in a page. */
  const ev = (id: string, s = 0) =>
    ({ id, session_id: "r", occurred_at: `2026-05-15T12:00:${String(s).padStart(2, "0")}Z` }) as never;
  const idsOf = (events: readonly unknown[]) => events.map((e) => (e as { id: string }).id);

  it("asks for the window newest first, with from and to fixed", async () => {
    api.fetchBulkEvents.mockResolvedValueOnce({ events: [ev("b", 2), ev("a", 1)], total: 2, has_more: false });
    const { result } = renderHook(() => useHistoricalEvents("1h"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const [args] = api.fetchBulkEvents.mock.calls[0];
    expect(args.order).toBe("desc");
    expect(args.limit).toBe(HISTORY_PAGE_SIZE);
    expect(Date.parse(args.to) - Date.parse(args.from)).toBe(TIMELINE_RANGE_MS["1h"]);
    expect(args.before).toBeUndefined();
  });

  it("drains pages until has_more is false, each continuing before the last page's oldest event", async () => {
    api.fetchBulkEvents
      .mockResolvedValueOnce({ events: [ev("d", 4), ev("c", 3)], total: 4, has_more: true })
      .mockResolvedValueOnce({ events: [ev("b", 2), ev("a", 1)], total: 2, has_more: false });
    const { result } = renderHook(() => useHistoricalEvents("1h"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(api.fetchBulkEvents).toHaveBeenCalledTimes(2);
    const [first, second] = api.fetchBulkEvents.mock.calls.map((c) => c[0]);
    expect(second.before).toBe("2026-05-15T12:00:03Z");
    expect(second.before_id).toBe("c");
    expect(second.from).toBe(first.from);
    expect(second.to).toBe(first.to);
  });

  it("returns the events oldest first", async () => {
    api.fetchBulkEvents
      .mockResolvedValueOnce({ events: [ev("d", 4), ev("c", 3)], total: 4, has_more: true })
      .mockResolvedValueOnce({ events: [ev("b", 2), ev("a", 1)], total: 2, has_more: false });
    const { result } = renderHook(() => useHistoricalEvents("1h"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(idsOf(result.current.events)).toEqual(["a", "b", "c", "d"]);
  });

  it("stops at HISTORY_DRAIN_MAX_EVENTS, keeping the newest", async () => {
    // Every page is full and claims more, so only the cap ends the drain.
    const pages = Math.ceil(HISTORY_DRAIN_MAX_EVENTS / HISTORY_PAGE_SIZE);
    let served = 0;
    api.fetchBulkEvents.mockImplementation(async (params: { limit: number }) => {
      const page = Array.from({ length: params.limit }, (_, i) => ev(`e${served + i}`));
      served += params.limit;
      return { events: page, total: 1_000_000, has_more: true };
    });
    const { result } = renderHook(() => useHistoricalEvents("1h"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(api.fetchBulkEvents).toHaveBeenCalledTimes(pages);
    expect(result.current.events).toHaveLength(HISTORY_DRAIN_MAX_EVENTS);
    // The first page (the window's newest) is all there.
    expect(idsOf(result.current.events)).toContain("e0");
  });

  it("a failed page stops the drain and keeps the pages already loaded", async () => {
    api.fetchBulkEvents
      .mockResolvedValueOnce({ events: [ev("b", 2)], total: 3, has_more: true })
      .mockRejectedValueOnce(new Error("page failed"));
    const { result } = renderHook(() => useHistoricalEvents("1h"));
    await waitFor(() => expect(result.current.error).toBe("page failed"));
    expect(result.current.loading).toBe(false);
    expect(idsOf(result.current.events)).toEqual(["b"]);
    expect(api.fetchBulkEvents).toHaveBeenCalledTimes(2);
  });

  it("a range change aborts the drain in flight and keeps the previous range's events until the new first page", async () => {
    let releaseOldSecond: (v: unknown) => void = () => {};
    let releaseNew: (v: unknown) => void = () => {};
    const signals: AbortSignal[] = [];
    api.fetchBulkEvents
      .mockImplementationOnce(async (_p: unknown, signal: AbortSignal) => {
        signals.push(signal);
        return { events: [ev("old", 1)], total: 2, has_more: true };
      })
      .mockImplementationOnce((_p: unknown, signal: AbortSignal) => {
        signals.push(signal);
        return new Promise((r) => (releaseOldSecond = r));
      })
      .mockImplementationOnce(() => new Promise((r) => (releaseNew = r)));
    const { result, rerender } = renderHook(({ r }) => useHistoricalEvents(r), {
      initialProps: { r: "1h" as TimeRange },
    });
    await waitFor(() => expect(idsOf(result.current.events)).toEqual(["old"]));
    await waitFor(() => expect(api.fetchBulkEvents).toHaveBeenCalledTimes(2));

    rerender({ r: "5m" });
    expect(signals[1]?.aborted).toBe(true);
    expect(result.current.loading).toBe(true);
    expect(idsOf(result.current.events)).toEqual(["old"]);
    // The aborted page settling late changes nothing.
    await act(async () => releaseOldSecond({ events: [ev("stale", 0)], total: 1, has_more: false }));
    expect(idsOf(result.current.events)).toEqual(["old"]);
    await act(async () => releaseNew({ events: [ev("new", 5)], total: 1, has_more: false }));
    expect(idsOf(result.current.events)).toEqual(["new"]);
    expect(result.current.loading).toBe(false);
  });

  it("a new reloadKey (the live stream reconnected) loads the window again, ending now", async () => {
    api.fetchBulkEvents
      .mockResolvedValueOnce({ events: [ev("before", 1)], total: 1, has_more: false })
      .mockResolvedValueOnce({ events: [ev("during-outage", 5), ev("before", 1)], total: 2, has_more: false });
    const { result, rerender } = renderHook(({ k }) => useHistoricalEvents("5m", k), {
      initialProps: { k: 0 },
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    rerender({ k: 1 });
    await waitFor(() => expect(idsOf(result.current.events)).toEqual(["before", "during-outage"]));
    const [first, second] = api.fetchBulkEvents.mock.calls.map((c) => c[0]);
    expect(Date.parse(second.to)).toBeGreaterThanOrEqual(Date.parse(first.to));
    expect(second.before).toBeUndefined();
  });

  it("picking a range again loads it again", async () => {
    api.fetchBulkEvents.mockResolvedValue({ events: [ev("a", 1)], total: 1, has_more: false });
    const { result, rerender } = renderHook(({ r }) => useHistoricalEvents(r), {
      initialProps: { r: "1m" as TimeRange },
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    rerender({ r: "1h" });
    await waitFor(() => expect(result.current.loading).toBe(false));
    rerender({ r: "1m" });
    await waitFor(() => expect(api.fetchBulkEvents).toHaveBeenCalledTimes(3));
  });
});
