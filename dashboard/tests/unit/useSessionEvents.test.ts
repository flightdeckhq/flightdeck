import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  eventsCache,
  mergeFeedEvents,
  mergeIntoEventsCache,
  mergeRunEvents,
  mergeSessionEvents,
  useSessionEvents,
} from "@/hooks/useSessionEvents";
import type { AgentEvent, FeedEvent } from "@/lib/types";

// Per-session events the mocked fetchSession resolves with, and a gate
// that, when set, holds every fetch until it resolves.
// `vi.hoisted` so the factory below can close over it safely.
const h = vi.hoisted(() => ({
  byId: new Map<string, AgentEvent[]>(),
  gate: null as Promise<void> | null,
}));

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchSession: vi.fn(async (sid: string) => {
      if (h.gate) await h.gate;
      return {
        session: { session_id: sid },
        events: h.byId.get(sid) ?? [],
        attachments: [],
      };
    }),
  };
});

let seq = 0;
// A fresh session id per test — the hook's module-level
// `fetchedSessions` Set is not exported, so unique ids keep one
// test's fetch-once bookkeeping from leaking into the next.
function freshSid(): string {
  seq += 1;
  return `sess-${seq}`;
}

function mkEvent(sid: string): AgentEvent {
  return {
    id: `evt-${sid}`,
    session_id: sid,
    flavor: "f",
    event_type: "heartbeat",
    model: null,
    tokens_input: null,
    tokens_output: null,
    tokens_total: null,
    latency_ms: null,
    tool_name: null,
    has_content: false,
    occurred_at: "2026-05-15T12:00:00Z",
  };
}

describe("useSessionEvents", () => {
  beforeEach(() => {
    eventsCache.clear();
    h.byId.clear();
  });

  it("surfaces fetched events once the initial fetch resolves", async () => {
    // Regression guard: a `useMemo` keyed on `[sessionId, version]`
    // here would freeze the first render's empty array — the fetch
    // resolves and ticks local state, but the memo deps never
    // change, so the stale [] would survive. The hook reads the
    // cache directly for exactly this reason.
    const sid = freshSid();
    const evt = mkEvent(sid);
    h.byId.set(sid, [evt]);

    const { result } = renderHook(() => useSessionEvents(sid, false, 0));
    expect(result.current.events).toEqual([]);
    expect(result.current.loading).toBe(true);

    await act(async () => {});

    expect(result.current.events).toEqual([evt]);
    expect(result.current.loading).toBe(false);
  });

  it("surfaces WebSocket-injected events on a version bump", async () => {
    const sid = freshSid();
    h.byId.set(sid, []); // initial fetch returns nothing

    const { result, rerender } = renderHook(
      ({ v }) => useSessionEvents(sid, false, v),
      { initialProps: { v: 0 } },
    );
    await act(async () => {});
    expect(result.current.events).toEqual([]);

    // Fleet.tsx injects a live event straight into the module
    // cache, then bumps the `_version` prop to re-render.
    const evt = mkEvent(sid);
    eventsCache.set(sid, [evt]);
    rerender({ v: 1 });

    expect(result.current.events).toEqual([evt]);
  });

  it("reads pre-populated cache without issuing a fetch", () => {
    const sid = freshSid();
    const evt = mkEvent(sid);
    eventsCache.set(sid, [evt]);

    const { result } = renderHook(() => useSessionEvents(sid, false, 0));
    expect(result.current.events).toEqual([evt]);
    expect(result.current.loading).toBe(false);
  });
});

/** An event of run ``sid`` at ``at`` (an API timestamp). */
function ev(id: string, sid: string, at: string): AgentEvent {
  return { ...mkEvent(sid), id, occurred_at: at };
}

const ids = (events: readonly AgentEvent[] | null | undefined) => (events ?? []).map((e) => e.id);

describe("mergeRunEvents / mergeIntoEventsCache", () => {
  beforeEach(() => {
    eventsCache.clear();
  });

  it("takes the union by id, in the server's order", () => {
    const held = [ev("a", "s", "2026-05-15T12:00:01Z"), ev("c", "s", "2026-05-15T12:00:03Z")];
    const page = [ev("b", "s", "2026-05-15T12:00:02Z"), ev("c", "s", "2026-05-15T12:00:03Z")];
    expect(ids(mergeRunEvents(held, page))).toEqual(["a", "b", "c"]);
  });

  it("keeps a newer cached event when an older page lands", () => {
    // A range switch loads a page that ends before the run's newest
    // cached event; that event must stay.
    eventsCache.set("s", [ev("new", "s", "2026-05-15T12:05:00Z")]);
    const changed = mergeIntoEventsCache([
      ev("old1", "s", "2026-05-15T12:00:00Z"),
      ev("old2", "s", "2026-05-15T12:01:00Z"),
    ]);
    expect(changed).toEqual(new Set(["s"]));
    expect(ids(eventsCache.get("s"))).toEqual(["old1", "old2", "new"]);
  });

  it("orders equal timestamps by id, to the microsecond", () => {
    const merged = mergeRunEvents(
      [ev("b", "s", "2026-05-15T12:00:00.000002Z")],
      [ev("c", "s", "2026-05-15T12:00:00.000001Z"), ev("a", "s", "2026-05-15T12:00:00.000002Z")],
    );
    expect(ids(merged)).toEqual(["c", "a", "b"]);
  });

  it("changes nothing and keeps the same array when nothing is new", () => {
    const list = [ev("a", "s", "2026-05-15T12:00:01Z")];
    eventsCache.set("s", list);
    expect(mergeRunEvents(list, [ev("a", "s", "2026-05-15T12:00:01Z")])).toBeNull();
    expect(mergeIntoEventsCache([ev("a", "s", "2026-05-15T12:00:01Z")]).size).toBe(0);
    expect(eventsCache.get("s")).toBe(list);
  });

  it("appends a newer event after the held list", () => {
    const held = [ev("a", "s", "2026-05-15T12:00:01Z"), ev("b", "s", "2026-05-15T12:00:02Z")];
    const merged = mergeRunEvents(held, [ev("c", "s", "2026-05-15T12:00:03Z")]);
    expect(ids(merged)).toEqual(["a", "b", "c"]);
    expect(merged?.[0]).toBe(held[0]);
  });

  it("groups by run and reports only the runs whose list changed", () => {
    eventsCache.set("x", [ev("x1", "x", "2026-05-15T12:00:00Z")]);
    const changed = mergeIntoEventsCache([
      ev("x1", "x", "2026-05-15T12:00:00Z"),
      ev("y1", "y", "2026-05-15T12:00:00Z"),
    ]);
    expect(changed).toEqual(new Set(["y"]));
    expect(ids(eventsCache.get("y"))).toEqual(["y1"]);
  });

  it("a run's own fetch keeps a live event injected while it was in flight", async () => {
    const sid = freshSid();
    let release: () => void = () => {};
    h.byId.set(sid, [ev("fetched", sid, "2026-05-15T12:00:00Z")]);
    h.gate = new Promise<void>((r) => (release = r));
    try {
      renderHook(() => useSessionEvents(sid, false, 0));
      // A live event lands while the history fetch is in flight.
      mergeSessionEvents(sid, [ev("live", sid, "2026-05-15T12:00:05Z")]);
      await act(async () => release());
      expect(ids(eventsCache.get(sid))).toEqual(["fetched", "live"]);
    } finally {
      h.gate = null;
    }
  });
});

describe("mergeFeedEvents", () => {
  const fe = (id: string, arrivedAt: number): FeedEvent => ({
    arrivedAt,
    event: ev(id, "s", "2026-05-15T12:00:00Z"),
  });

  it("keeps the newest cap by arrival, so older history never displaces live events", () => {
    const live = [fe("live1", 1000), fe("live2", 1001)];
    const history = [fe("h1", 10), fe("h2", 20), fe("h3", 30)];
    const merged = mergeFeedEvents(live, history, 3);
    expect(merged.map((f) => f.event.id)).toEqual(["h3", "live1", "live2"]);
  });

  it("adds an event once, and returns the same feed when nothing is new", () => {
    const prev = [fe("a", 1)];
    expect(mergeFeedEvents(prev, [fe("a", 99)], 10)).toBe(prev);
  });
});
