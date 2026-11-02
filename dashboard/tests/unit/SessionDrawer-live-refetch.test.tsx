import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";

// An open run drawer reads its run through its own fetch (useSession),
// so the live stream has to tell it when to refetch: when the run's
// state or ended_at changes (the worker marks it stale or lost, the
// reaper or a client closes it, a child revives it), whether or not
// the page holds the run, and after the stream reconnects. The real
// fleet store drives these tests; useSession records the
// revalidationKey it is called with.

let shownState = "active";
let shownEndedAt: string | null = null;
const revalidationKeys: number[] = [];

vi.mock("@/hooks/useSession", () => ({
  useSession: (id: string | null, _limit?: number, revalidationKey?: number) => {
    revalidationKeys.push(revalidationKey ?? 0);
    if (!id) return { data: null, loading: false, error: null };
    return {
      data: {
        session: {
          session_id: id,
          flavor: "test-agent",
          agent_type: "production",
          host: "worker-1",
          framework: null,
          model: null,
          state: shownState,
          started_at: "2026-11-02T10:00:00Z",
          last_seen_at: "2026-11-02T10:05:00Z",
          ended_at: shownEndedAt,
          tokens_used: 0,
          token_limit: null,
          has_pending_directive: false,
          warn_at_pct: null,
          degrade_at_pct: null,
          degrade_to: null,
          block_at_pct: null,
        },
        events: [],
        attachments: [],
      },
      loading: false,
      error: null,
    };
  },
  invalidateSessionCache: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  createDirective: vi.fn(() => Promise.resolve({ id: "dir-1" })),
  fetchEventContent: vi.fn(() => Promise.resolve(null)),
  triggerCustomDirective: vi.fn(() => Promise.resolve()),
  fetchOlderEvents: vi.fn(() =>
    Promise.resolve({ events: [], total: 0, limit: 50, offset: 0, has_more: false }),
  ),
  fetchSessions: vi.fn(() =>
    Promise.resolve({ sessions: [], total: 0, limit: 1, offset: 0, has_more: false }),
  ),
  fetchSession: vi.fn(() => Promise.resolve({ session: null, events: [] })),
  fetchBulkEvents: vi.fn(() =>
    Promise.resolve({ events: [], total: 0, limit: 1, offset: 0, has_more: false }),
  ),
  resolveMCPPolicy: vi.fn(() => Promise.resolve(null)),
  fetchFleet: vi.fn(async () => ({
    agents: [],
    total: 0,
    page: 1,
    per_page: 200,
    context_facets: {},
  })),
  fetchCustomDirectives: vi.fn(async () => []),
}));

import { SessionDrawer } from "@/components/session/SessionDrawer";
import { useFleetStore } from "@/store/fleet";
import type { Session } from "@/lib/types";

const RUN = "s1-abcdef-1234";

function liveSession(over: Partial<Session>): Session {
  return {
    session_id: RUN,
    flavor: "test-agent",
    agent_type: "production",
    agent_id: "agent-1",
    agent_name: "agent-1",
    client_type: "flightdeck_sensor",
    host: "worker-1",
    framework: null,
    model: null,
    state: "active",
    started_at: "2026-11-02T10:00:00Z",
    last_seen_at: "2026-11-02T10:05:00Z",
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

const latestKey = () => revalidationKeys[revalidationKeys.length - 1];

beforeEach(() => {
  shownState = "active";
  shownEndedAt = null;
  revalidationKeys.length = 0;
  useFleetStore.setState({ lastSessionChange: null, resyncSeq: 0, lastEvent: null });
});

afterEach(() => {
  useFleetStore.setState({ lastSessionChange: null, resyncSeq: 0, lastEvent: null });
});

describe("SessionDrawer follows its run's state from the live stream", () => {
  it("refetches when the run goes stale, once, and not again for the same state", () => {
    render(<SessionDrawer sessionId={RUN} onClose={() => {}} />);
    expect(latestKey()).toBe(0);

    act(() => useFleetStore.getState().noteSessionChange(liveSession({ state: "stale" })));
    expect(latestKey()).toBe(1);

    // The refetch shows stale now; the same state again changes nothing.
    shownState = "stale";
    act(() => useFleetStore.getState().noteSessionChange(liveSession({ state: "stale" })));
    expect(latestKey()).toBe(1);
  });

  it("refetches again for a quick revival that arrives before the stale refetch lands", () => {
    render(<SessionDrawer sessionId={RUN} onClose={() => {}} />);
    // C1: the run goes stale; a refetch starts.
    act(() => useFleetStore.getState().noteSessionChange(liveSession({ state: "stale" })));
    expect(latestKey()).toBe(1);

    // C2: it revives before that refetch lands, so the drawer still
    // shows "active". The refetch for C1 may have read the stale row,
    // so C2 must refetch too.
    act(() => useFleetStore.getState().noteSessionChange(liveSession({ state: "active" })));
    expect(latestKey()).toBe(2);

    // The run's next event repeats C2: nothing new to fetch.
    act(() => useFleetStore.getState().noteSessionChange(liveSession({ state: "active" })));
    expect(latestKey()).toBe(2);
  });

  it("refetches when the run is closed, so its ended_at shows", () => {
    render(<SessionDrawer sessionId={RUN} onClose={() => {}} />);
    act(() =>
      useFleetStore
        .getState()
        .noteSessionChange(liveSession({ state: "closed", ended_at: "2026-11-02T11:00:00Z" })),
    );
    expect(latestKey()).toBe(1);
  });

  it("ignores changes it already shows and changes of other runs", () => {
    render(<SessionDrawer sessionId={RUN} onClose={() => {}} />);
    // Every event of an active run reports it active: nothing to refetch.
    act(() => useFleetStore.getState().noteSessionChange(liveSession({ state: "active" })));
    act(() =>
      useFleetStore.getState().noteSessionChange(liveSession({ session_id: "another-run", state: "stale" })),
    );
    expect(latestKey()).toBe(0);
  });

  it("after switching to another run, refetches for that run's first change too", () => {
    const { rerender } = render(<SessionDrawer sessionId={RUN} onClose={() => {}} />);
    act(() => useFleetStore.getState().noteSessionChange(liveSession({ state: "stale" })));
    expect(latestKey()).toBe(1);

    // The drawer now shows another run, still active, which then goes
    // stale too: the same state as the change refetched for before.
    shownState = "active";
    rerender(<SessionDrawer sessionId="s2-other-run" onClose={() => {}} />);
    act(() =>
      useFleetStore
        .getState()
        .noteSessionChange(liveSession({ session_id: "s2-other-run", state: "stale" })),
    );
    expect(latestKey()).toBe(2);
  });

  it("refetches after the stream reconnected", () => {
    render(<SessionDrawer sessionId={RUN} onClose={() => {}} />);
    act(() => useFleetStore.getState().resync());
    expect(latestKey()).toBe(1);
  });
});
