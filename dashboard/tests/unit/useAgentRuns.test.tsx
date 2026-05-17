import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAgentRuns } from "@/hooks/useAgentRuns";
import { fetchSessions } from "@/lib/api";
import type { SessionListItem, SessionsResponse } from "@/lib/types";

const h = vi.hoisted(() => ({
  response: {
    sessions: [],
    total: 0,
    limit: 50,
    offset: 0,
    has_more: false,
  } as SessionsResponse,
}));

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchSessions: vi.fn(async () => h.response),
  };
});

function mkRun(id: string): SessionListItem {
  return {
    session_id: id,
    flavor: "agent-1",
    agent_type: "coding",
    host: null,
    model: null,
    state: "closed",
    started_at: "2026-05-15T12:00:00Z",
    ended_at: null,
    last_seen_at: "2026-05-15T12:05:00Z",
    duration_s: 300,
    tokens_used: 100,
    token_limit: null,
    context: {},
  };
}

function mkResponse(
  sessions: SessionListItem[],
  total: number,
): SessionsResponse {
  return {
    sessions,
    total,
    limit: 50,
    offset: 0,
    has_more: total > sessions.length,
  };
}

const SORT = { column: "started_at", direction: "desc" } as const;

describe("useAgentRuns", () => {
  beforeEach(() => {
    vi.mocked(fetchSessions).mockClear();
    h.response = mkResponse([], 0);
  });

  it("stays idle and issues no fetch while agentId is null", () => {
    const { result } = renderHook(() => useAgentRuns(null, 0, 50, SORT));
    expect(result.current.runs).toEqual([]);
    expect(result.current.total).toBe(0);
    expect(result.current.loading).toBe(false);
    expect(fetchSessions).not.toHaveBeenCalled();
  });

  it("fetches the agent's runs once an agentId is set", async () => {
    h.response = mkResponse([mkRun("r1"), mkRun("r2")], 2);
    const { result } = renderHook(() =>
      useAgentRuns("agent-1", 0, 50, SORT),
    );
    expect(result.current.loading).toBe(true);

    await act(async () => {});

    expect(result.current.runs).toHaveLength(2);
    expect(result.current.total).toBe(2);
    expect(result.current.loading).toBe(false);
    expect(vi.mocked(fetchSessions).mock.calls[0]![0]).toMatchObject({
      agent_id: "agent-1",
      sort: "started_at",
      order: "desc",
      limit: 50,
      offset: 0,
    });
  });

  it("re-fetches when the sort column changes", async () => {
    h.response = mkResponse([mkRun("r1")], 1);
    const { rerender } = renderHook(
      ({ sort }) => useAgentRuns("agent-1", 0, 50, sort),
      { initialProps: { sort: SORT as Parameters<typeof useAgentRuns>[3] } },
    );
    await act(async () => {});

    rerender({ sort: { column: "tokens_used", direction: "asc" } });
    await act(async () => {});

    const lastCall = vi.mocked(fetchSessions).mock.calls.at(-1)!;
    expect(lastCall[0]).toMatchObject({
      sort: "tokens_used",
      order: "asc",
    });
  });

  it("sets error=true when the fetch rejects", async () => {
    vi.mocked(fetchSessions).mockRejectedValueOnce(new Error("network"));
    const { result } = renderHook(() => useAgentRuns("agent-1", 0, 50, SORT));
    await act(async () => {});
    expect(result.current.error).toBe(true);
    expect(result.current.loading).toBe(false);
    expect(result.current.runs).toEqual([]);
  });
});
