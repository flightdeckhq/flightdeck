import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

// useFleet's live stream handling: every update's session state is
// recorded before the store applies it (a run drawer may show a run the
// page does not hold), the event of an update the page ignores goes to
// neither the store nor the live feed, and after the stream reconnects
// the fleet is refetched once, a short delay after the last reopen.

vi.mock("@/lib/api", () => ({
  fetchFleet: vi.fn(async () => ({
    agents: [],
    total: 0,
    page: 1,
    per_page: 200,
    context_facets: {},
  })),
  fetchSessions: vi.fn(async () => ({ sessions: [], total: 0 })),
  fetchCustomDirectives: vi.fn(async () => []),
  wsAccessTokenQuery: () => "token=test",
}));

import { fetchFleet } from "@/lib/api";
import { RESYNC_DELAY_MS, useFleet } from "@/hooks/useFleet";
import { INITIAL_BACKOFF_MS } from "@/hooks/useWebSocket";
import { useFleetStore } from "@/store/fleet";
import type { AgentEvent, FleetUpdate, Session } from "@/lib/types";

class FakeSocket {
  static instances: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
  deliver(update: FleetUpdate) {
    this.onmessage?.({ data: JSON.stringify(update) } as MessageEvent);
  }
}

const fetchFleetMock = fetchFleet as unknown as ReturnType<typeof vi.fn>;
const NOW_ISO = new Date().toISOString();

function mkSession(over: Partial<Session> = {}): Session {
  return {
    session_id: "run-held",
    flavor: "flavor-one",
    agent_type: "production",
    agent_id: "agent-one",
    agent_name: "agent-one",
    client_type: "flightdeck_sensor",
    host: null,
    framework: null,
    model: null,
    state: "active",
    started_at: NOW_ISO,
    last_seen_at: NOW_ISO,
    ended_at: null,
    tokens_used: 0,
    token_limit: null,
    parent_session_id: null,
    agent_role: null,
    context: {},
    capture_enabled: false,
    ...over,
  };
}

function mkEvent(over: Partial<AgentEvent> = {}): AgentEvent {
  return {
    id: "event-1",
    session_id: "run-held",
    flavor: "flavor-one",
    event_type: "post_call",
    model: null,
    tokens_input: null,
    tokens_output: null,
    tokens_total: null,
    latency_ms: null,
    tool_name: null,
    has_content: false,
    framework: null,
    client_type: "flightdeck_sensor",
    agent_type: "production",
    occurred_at: NOW_ISO,
    ...over,
  };
}

/** Let the mount's load() and any refetch settle. */
async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

function seedHeldRun(): void {
  useFleetStore.setState({
    flavors: [
      {
        flavor: "agent-one",
        agent_type: "production",
        session_count: 1,
        active_count: 1,
        tokens_used_total: 0,
        sessions: [mkSession()],
        agent_id: "agent-one",
        agent_name: "agent-one",
        last_seen_at: NOW_ISO,
      },
    ],
    agents: [],
    lastEvent: null,
    lastSessionChange: null,
  });
}

beforeEach(() => {
  FakeSocket.instances = [];
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeSocket);
  fetchFleetMock.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  useFleetStore.setState({
    flavors: [],
    agents: [],
    lastEvent: null,
    lastSessionChange: null,
    resyncSeq: 0,
  });
});

describe("useFleet live stream", () => {
  it("records each session's state first and drops the event of a run the page does not show", async () => {
    const onEvent = vi.fn();
    renderHook(() => useFleet(onEvent));
    await flush();
    seedHeldRun();
    const socket = FakeSocket.instances[0]!;

    // The reaper closes a run this page never loaded.
    const reaped = mkEvent({
      id: "reaper-end",
      session_id: "run-unloaded",
      event_type: "session_end",
      payload: { close_reason: "orphan_timeout" },
    });
    act(() =>
      socket.deliver({
        type: "session_end",
        session: mkSession({ session_id: "run-unloaded", state: "closed", ended_at: NOW_ISO }),
        last_event: reaped,
        agent_state: "active",
      }),
    );
    expect(onEvent).not.toHaveBeenCalled();
    expect(useFleetStore.getState().lastEvent).toBeNull();
    // A drawer open on that run still learns it closed.
    expect(useFleetStore.getState().lastSessionChange).toEqual({
      session_id: "run-unloaded",
      state: "closed",
      ended_at: NOW_ISO,
    });

    // An event of the run the page holds reaches the live feed.
    const call = mkEvent({ id: "held-call" });
    act(() => socket.deliver({ type: "session_update", session: mkSession(), last_event: call }));
    expect(onEvent).toHaveBeenCalledWith(call);
    expect(useFleetStore.getState().lastEvent).toEqual(call);

    // A state change of the held run carries no event; its state is recorded.
    act(() =>
      socket.deliver({ type: "session_update", session: mkSession({ state: "stale" }), agent_state: "stale" }),
    );
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(useFleetStore.getState().lastSessionChange?.state).toBe("stale");
  });

  it("refetches the fleet once after the stream reconnects, a short delay after the last reopen", async () => {
    renderHook(() => useFleet());
    await flush();
    expect(fetchFleetMock).toHaveBeenCalledTimes(1); // the first load
    act(() => FakeSocket.instances[0]!.onopen?.());

    // The stream drops and comes back...
    act(() => FakeSocket.instances[0]!.close());
    act(() => {
      vi.advanceTimersByTime(INITIAL_BACKOFF_MS);
    });
    act(() => FakeSocket.instances[1]!.onopen?.());

    // ...drops again at once and reopens one backoff step later (an
    // API still restarting): the wait restarts, nothing is fetched yet.
    act(() => FakeSocket.instances[1]!.close());
    act(() => {
      vi.advanceTimersByTime(INITIAL_BACKOFF_MS);
    });
    act(() => FakeSocket.instances[2]!.onopen?.());
    act(() => {
      vi.advanceTimersByTime(RESYNC_DELAY_MS - 1);
    });
    await flush();
    expect(fetchFleetMock).toHaveBeenCalledTimes(1);

    // The stream stays up: the burst costs one refetch.
    act(() => {
      vi.advanceTimersByTime(1);
    });
    await flush();
    expect(fetchFleetMock).toHaveBeenCalledTimes(2);
    expect(useFleetStore.getState().resyncSeq).toBe(1);
  });

  it("does not refetch on the first open", async () => {
    renderHook(() => useFleet());
    await flush();
    act(() => FakeSocket.instances[0]!.onopen?.());
    act(() => {
      vi.advanceTimersByTime(RESYNC_DELAY_MS * 5);
    });
    await flush();
    expect(fetchFleetMock).toHaveBeenCalledTimes(1);
    expect(useFleetStore.getState().resyncSeq).toBe(0);
  });
});
