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
  it("fetches /v1/sessions with agent_id and no from/to bound", async () => {
    // Bug 1 (E) regression guard: the per-agent on-demand fetch must
    // deliberately NOT pass a from bound -- the expanded SESSIONS
    // list needs sessions older than the 24-hour Fleet rollup window
    // so closed sessions from days ago are visible when the user
    // expands the row.
    fetchSessionsMock.mockResolvedValue({
      sessions: [],
      total: 0,
      limit: 100,
      offset: 0,
      has_more: false,
    });
    await useFleetStore.getState().loadExpandedSessions("agent-xyz");
    expect(fetchSessionsMock).toHaveBeenCalledTimes(1);
    const args = fetchSessionsMock.mock.calls[0][0];
    expect(args.agent_id).toBe("agent-xyz");
    expect(args.limit).toBe(100);
    expect(args.offset).toBe(0);
    // No from/to bounds -- server default 7d applies.
    expect(args.from).toBeUndefined();
    expect(args.to).toBeUndefined();
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
