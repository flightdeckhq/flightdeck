import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAgentEvents } from "@/hooks/useAgentEvents";
import { fetchBulkEvents, type BulkEventsResponse } from "@/lib/api";
import type { AgentEvent } from "@/lib/types";

// The mock fetch returns whatever `h.response` holds when called.
const h = vi.hoisted(() => ({
  response: {
    events: [],
    total: 0,
    limit: 50,
    offset: 0,
    has_more: false,
  } as BulkEventsResponse,
}));

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchBulkEvents: vi.fn(async () => h.response),
  };
});

function mkEvent(id: string): AgentEvent {
  return {
    id,
    session_id: `sess-${id}`,
    flavor: "agent-1",
    event_type: "post_call",
    model: "claude-sonnet-4-6",
    tokens_input: null,
    tokens_output: null,
    tokens_total: null,
    latency_ms: null,
    tool_name: null,
    has_content: false,
    occurred_at: "2026-05-15T12:00:00Z",
  };
}

function mkResponse(events: AgentEvent[], total: number): BulkEventsResponse {
  return { events, total, limit: 50, offset: 0, has_more: total > events.length };
}

describe("useAgentEvents", () => {
  beforeEach(() => {
    vi.mocked(fetchBulkEvents).mockClear();
    h.response = mkResponse([], 0);
  });

  it("stays idle and issues no fetch while agentId is null", () => {
    const { result } = renderHook(() => useAgentEvents(null, 0, 50));
    expect(result.current.events).toEqual([]);
    expect(result.current.total).toBe(0);
    expect(result.current.loading).toBe(false);
    expect(fetchBulkEvents).not.toHaveBeenCalled();
  });

  it("fetches the agent's events newest-first once an agentId is set", async () => {
    h.response = mkResponse([mkEvent("e1"), mkEvent("e2")], 2);
    const { result } = renderHook(() => useAgentEvents("agent-1", 0, 50));
    expect(result.current.loading).toBe(true);

    await act(async () => {});

    expect(result.current.events).toHaveLength(2);
    expect(result.current.total).toBe(2);
    expect(result.current.loading).toBe(false);
    expect(fetchBulkEvents).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetchBulkEvents).mock.calls[0]![0]).toMatchObject({
      agent_id: "agent-1",
      order: "desc",
      limit: 50,
      offset: 0,
    });
  });

  it("re-fetches with the paged offset when the page advances", async () => {
    h.response = mkResponse([mkEvent("e1")], 120);
    const { rerender } = renderHook(
      ({ page }) => useAgentEvents("agent-1", page, 50),
      { initialProps: { page: 0 } },
    );
    await act(async () => {});

    rerender({ page: 2 });
    await act(async () => {});

    const lastCall = vi.mocked(fetchBulkEvents).mock.calls.at(-1)!;
    expect(lastCall[0]).toMatchObject({ agent_id: "agent-1", offset: 100 });
  });

  it("sets error=true when the fetch rejects", async () => {
    vi.mocked(fetchBulkEvents).mockRejectedValueOnce(new Error("network"));
    const { result } = renderHook(() => useAgentEvents("agent-1", 0, 50));
    await act(async () => {});
    expect(result.current.error).toBe(true);
    expect(result.current.loading).toBe(false);
    expect(result.current.events).toEqual([]);
  });
});
