import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SessionListItem } from "@/lib/types";

// Mock the API layer so the test exercises the store logic without
// hitting the network. ``fetchFleet`` is needed because the store
// types the selector against its shape but this test does not load()
// before calling ``loadExpandedSessions`` -- the store starts empty.
const fetchSessionsMock = vi.fn();
vi.mock("@/lib/api", () => ({
  fetchSessions: (...args: unknown[]) => fetchSessionsMock(...args),
  fetchFleet: vi.fn(),
  fetchCustomDirectives: vi.fn(() => Promise.resolve([])),
}));

// Import AFTER the mock so zustand's initial state + store factory
// capture the mocked api references.
// eslint-disable-next-line import/first
import { useFleetStore } from "@/store/fleet";

function mkListItem(
  partial: Partial<SessionListItem>,
): SessionListItem {
  return {
    session_id: partial.session_id ?? "s1",
    flavor: partial.flavor ?? "claude-code",
    agent_type: partial.agent_type ?? "coding",
    agent_id: partial.agent_id,
    agent_name: partial.agent_name,
    client_type: partial.client_type,
    host: partial.host ?? null,
    model: partial.model ?? null,
    state: partial.state ?? "closed",
    started_at: partial.started_at ?? "2026-04-22T10:00:00Z",
    ended_at: partial.ended_at ?? "2026-04-22T10:30:00Z",
    duration_s: partial.duration_s ?? 1800,
    tokens_used: partial.tokens_used ?? 100,
    token_limit: partial.token_limit ?? null,
    context: partial.context ?? {},
    capture_enabled: partial.capture_enabled ?? false,
    token_id: partial.token_id ?? null,
    token_name: partial.token_name ?? null,
  };
}

beforeEach(() => {
  fetchSessionsMock.mockReset();
  useFleetStore.setState({ expandedSessions: new Map() });
});

describe("useFleetStore.loadExpandedSessions", () => {
  it("fetches /v1/sessions with agent_id, EXPANDED_DRAWER_PAGE_SIZE limit, and ``from`` set to the Unix epoch", async () => {
    // V-DRAWER fix: the per-agent on-demand fetch must pass an
    // explicit far-past ``from`` so the server's 7-day default
    // doesn't kick in. Pre-fix the absence of ``from`` made the
    // expanded drawer a dead-end whenever the agent's last session
    // was > 7 days old (an invisible API default leaking into
    // UX). ``new Date(0)`` is the well-known "no lower bound"
    // sentinel; the page size is ``EXPANDED_DRAWER_PAGE_SIZE``,
    // not the server's per-page hard cap (the drawer paginates
    // via ``loadMoreExpandedSessions`` for agents with more
    // history than fits in one page).
    fetchSessionsMock.mockResolvedValue({
      sessions: [],
      total: 0,
      limit: 25,
      offset: 0,
      has_more: false,
    });
    await useFleetStore.getState().loadExpandedSessions("agent-xyz");
    expect(fetchSessionsMock).toHaveBeenCalledTimes(1);
    const args = fetchSessionsMock.mock.calls[0][0];
    expect(args.agent_id).toBe("agent-xyz");
    expect(args.limit).toBe(25);
    expect(args.offset).toBe(0);
    expect(args.from).toBe(new Date(0).toISOString());
    expect(args.to).toBeUndefined();
  });

  it("records ``has_more`` from the fetch into expandedSessionsHasMore", async () => {
    // V-DRAWER pagination: the load-more affordance gates on this
    // flag. The store must persist whatever the server reported so
    // a subsequent ``loadMoreExpandedSessions`` call doesn't fire
    // a no-op fetch (and the SwimLane footer doesn't show a button
    // that would noop on click).
    fetchSessionsMock.mockResolvedValue({
      sessions: [mkListItem({ session_id: "s1" })],
      total: 50,
      limit: 25,
      offset: 0,
      has_more: true,
    });
    await useFleetStore.getState().loadExpandedSessions("agent-xyz");
    expect(
      useFleetStore.getState().expandedSessionsHasMore.get("agent-xyz"),
    ).toBe(true);
  });

  it("populates expandedSessions with the fetched rows", async () => {
    // The expanded drawer reads from this map; if the fetch succeeds
    // but the store does not stash the result, the drawer falls back
    // to the 24h-windowed subset and the bug re-surfaces silently.
    fetchSessionsMock.mockResolvedValue({
      sessions: [
        mkListItem({
          session_id: "old-1",
          agent_id: "agent-xyz",
          state: "closed",
          ended_at: "2026-04-20T09:00:00Z",
        }),
        mkListItem({
          session_id: "old-2",
          agent_id: "agent-xyz",
          state: "lost",
        }),
      ],
      total: 2,
      limit: 100,
      offset: 0,
      has_more: false,
    });
    await useFleetStore.getState().loadExpandedSessions("agent-xyz");
    const map = useFleetStore.getState().expandedSessions;
    const list = map.get("agent-xyz");
    expect(list).toBeDefined();
    expect(list!).toHaveLength(2);
    expect(list!.map((s) => s.session_id)).toEqual(["old-1", "old-2"]);
    expect(list!.map((s) => s.state)).toEqual(["closed", "lost"]);
  });

  it("leaves expandedSessions untouched on fetch failure (best-effort)", async () => {
    // Transient 5xx on the sessions endpoint should not crash the
    // expand handler -- the drawer gracefully falls back to the 24h
    // subset already in flavors[].sessions.
    fetchSessionsMock.mockRejectedValue(new Error("HTTP 503"));
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await useFleetStore.getState().loadExpandedSessions("agent-broken");
    expect(useFleetStore.getState().expandedSessions.has("agent-broken")).toBe(
      false,
    );
    expect(logSpy).toHaveBeenCalledTimes(1);
    logSpy.mockRestore();
  });

  it("overwrites a prior entry on re-expand (no stale cache)", async () => {
    // Supervisor direction: fresh fetch on every expand, no caching.
    // Collapsing and re-expanding the same agent should hit the API
    // again and replace whatever was there.
    fetchSessionsMock
      .mockResolvedValueOnce({
        sessions: [mkListItem({ session_id: "first" })],
        total: 1,
        limit: 100,
        offset: 0,
        has_more: false,
      })
      .mockResolvedValueOnce({
        sessions: [
          mkListItem({ session_id: "second-a" }),
          mkListItem({ session_id: "second-b" }),
        ],
        total: 2,
        limit: 100,
        offset: 0,
        has_more: false,
      });
    await useFleetStore.getState().loadExpandedSessions("agent-xyz");
    await useFleetStore.getState().loadExpandedSessions("agent-xyz");
    const list = useFleetStore.getState().expandedSessions.get("agent-xyz");
    expect(list!.map((s) => s.session_id)).toEqual(["second-a", "second-b"]);
  });
});

describe("useFleetStore.loadMoreExpandedSessions", () => {
  it("appends the next page via offset pagination and updates has_more", async () => {
    // Initial page fills the drawer with 2 rows (real seed would be
    // 25; trimmed for test brevity). has_more=true → footer shows
    // load-more button. Click → loadMoreExpandedSessions fires
    // ``offset = current.length`` so the second page picks up
    // exactly where the first left off.
    fetchSessionsMock
      .mockResolvedValueOnce({
        sessions: [
          mkListItem({ session_id: "s1" }),
          mkListItem({ session_id: "s2" }),
        ],
        total: 4,
        limit: 25,
        offset: 0,
        has_more: true,
      })
      .mockResolvedValueOnce({
        sessions: [
          mkListItem({ session_id: "s3" }),
          mkListItem({ session_id: "s4" }),
        ],
        total: 4,
        limit: 25,
        offset: 2,
        has_more: false,
      });
    await useFleetStore.getState().loadExpandedSessions("agent-xyz");
    expect(
      useFleetStore.getState().expandedSessionsHasMore.get("agent-xyz"),
    ).toBe(true);
    await useFleetStore.getState().loadMoreExpandedSessions("agent-xyz");
    const list = useFleetStore.getState().expandedSessions.get("agent-xyz");
    expect(list!.map((s) => s.session_id)).toEqual(["s1", "s2", "s3", "s4"]);
    expect(
      useFleetStore.getState().expandedSessionsHasMore.get("agent-xyz"),
    ).toBe(false);
    // Second fetch's offset must equal first page length (keyset
    // via offset, not 0). Mock receives this as its second call.
    const secondArgs = fetchSessionsMock.mock.calls[1][0];
    expect(secondArgs.offset).toBe(2);
  });

  it("dedupes by session_id when a live WS update raced the load-more click", async () => {
    // Edge case: between the user expanding the row and clicking
    // load-more, a session_start landed on the WebSocket and was
    // appended to expandedSessions. The next page's offset would
    // re-fetch that session. Without a dedupe guard the row would
    // double-render.
    fetchSessionsMock.mockResolvedValueOnce({
      sessions: [mkListItem({ session_id: "s1" })],
      total: 3,
      limit: 25,
      offset: 0,
      has_more: true,
    });
    await useFleetStore.getState().loadExpandedSessions("agent-xyz");
    // Simulate a WS update appending s2 between the expand and the
    // load-more click.
    useFleetStore.setState({
      expandedSessions: new Map(
        useFleetStore.getState().expandedSessions,
      ).set("agent-xyz", [
        ...useFleetStore.getState().expandedSessions.get("agent-xyz")!,
        { ...mkListItem({ session_id: "s2" }) } as never,
      ]),
    });
    fetchSessionsMock.mockResolvedValueOnce({
      // Server's offset=2 fetch returns s2 (the WS-added one) and s3.
      // s2 is the duplicate the dedupe must drop.
      sessions: [
        mkListItem({ session_id: "s2" }),
        mkListItem({ session_id: "s3" }),
      ],
      total: 3,
      limit: 25,
      offset: 2,
      has_more: false,
    });
    await useFleetStore.getState().loadMoreExpandedSessions("agent-xyz");
    const list = useFleetStore.getState().expandedSessions.get("agent-xyz")!;
    expect(list.map((s) => s.session_id)).toEqual(["s1", "s2", "s3"]);
  });

  it("no-ops when has_more is false (avoids superfluous request at end of history)", async () => {
    fetchSessionsMock.mockResolvedValue({
      sessions: [mkListItem({ session_id: "only" })],
      total: 1,
      limit: 25,
      offset: 0,
      has_more: false,
    });
    await useFleetStore.getState().loadExpandedSessions("agent-end");
    fetchSessionsMock.mockReset();
    await useFleetStore.getState().loadMoreExpandedSessions("agent-end");
    expect(fetchSessionsMock).not.toHaveBeenCalled();
  });
});
