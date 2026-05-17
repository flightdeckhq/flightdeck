import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { eventsCache, useSessionEvents } from "@/hooks/useSessionEvents";
import type { AgentEvent } from "@/lib/types";

// Per-session events the mocked fetchSession resolves with.
// `vi.hoisted` so the factory below can close over it safely.
const h = vi.hoisted(() => ({ byId: new Map<string, AgentEvent[]>() }));

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchSession: vi.fn(async (sid: string) => ({
      session: { session_id: sid },
      events: h.byId.get(sid) ?? [],
      attachments: [],
    })),
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
