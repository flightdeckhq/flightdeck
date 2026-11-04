import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import type {
  AgentEvent,
  AgentSummaryResponse,
  FlavorSummary,
} from "@/lib/types";

// Hoisted mock — vi.mock fires before any of the test file's
// imports resolve, so the hook's `import { fetchAgentSummary }
// from "@/lib/api"` binds to this stub at load time. The async
// factory's `orig()` invocation hands back the real module so
// every OTHER export remains intact for other tests / hooks
// that may pull from the same surface.
const fetchAgentSummaryMock = vi.hoisted(() =>
  vi.fn(
    async (agentId: string): Promise<AgentSummaryResponse> => ({
      agent_id: agentId,
      period: "7d",
      bucket: "day",
      totals: {
        tokens: 100,
        errors: 0,
        sessions: 1,
        cost_usd: 0,
        latency_p50_ms: 50,
        latency_p95_ms: 200,
      },
      series: [
        {
          ts: "2026-05-14T00:00:00Z",
          tokens: 100,
          errors: 0,
          sessions: 1,
          cost_usd: 0,
          latency_p95_ms: 200,
        },
      ],
    }),
  ),
);

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchAgentSummary: fetchAgentSummaryMock,
  };
});

import {
  useAgentSummary,
  __resetAgentSummaryCacheForTests,
} from "@/hooks/useAgentSummary";
import { useFleetStore } from "@/store/fleet";

beforeEach(() => {
  __resetAgentSummaryCacheForTests();
  useFleetStore.setState({ lastEvent: null, lastEventAgentId: null, flavors: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Deliver a live event as useFleet does: the broadcast carries the
 *  event and its session, whose agent_id goes with the event. */
function deliver(event: AgentEvent, agentId: string | null): void {
  useFleetStore.getState().setLastEvent(event, agentId);
}

/** A live event with a realistic flavor: a label, never an agent id. */
function liveEvent(fields: Partial<AgentEvent>): AgentEvent {
  return {
    id: `e-${Math.random().toString(36).slice(2)}`,
    session_id: "s1",
    flavor: "research-agent",
    event_type: "post_call",
    occurred_at: new Date().toISOString(),
    has_content: false,
    tokens_cache_read: 0,
    tokens_cache_creation: 0,
    ...fields,
  } as AgentEvent;
}

async function loaded(agentId: string) {
  const hook = renderHook(() =>
    useAgentSummary(agentId, { period: "7d", bucket: "day" }),
  );
  await waitFor(() => {
    expect(hook.result.current.summary).not.toBeNull();
  });
  return hook.result;
}

describe("useAgentSummary", () => {
  it("fetches nothing for an empty agent id and is not loading", async () => {
    fetchAgentSummaryMock.mockClear();
    const { result } = renderHook(() =>
      useAgentSummary("", { period: "7d", bucket: "day" }),
    );
    expect(result.current.summary).toBeNull();
    expect(result.current.loading).toBe(false);
    // Flush effects and any microtask a fetch would have scheduled.
    await act(async () => {});
    expect(fetchAgentSummaryMock).not.toHaveBeenCalled();
  });

  it("fetches on first mount and returns the summary", async () => {
    const { result } = renderHook(() =>
      useAgentSummary("agent-1", { period: "7d", bucket: "day" }),
    );
    expect(result.current.summary).toBeNull();
    expect(result.current.loading).toBe(true);
    await waitFor(() => {
      expect(result.current.summary).not.toBeNull();
    });
    expect(result.current.summary!.totals.tokens).toBe(100);
  });

  it("dedupes parallel mounts to one HTTP request", async () => {
    fetchAgentSummaryMock.mockClear();
    const { result: r1 } = renderHook(() =>
      useAgentSummary("agent-2", { period: "7d", bucket: "day" }),
    );
    const { result: r2 } = renderHook(() =>
      useAgentSummary("agent-2", { period: "7d", bucket: "day" }),
    );
    await waitFor(() => {
      expect(r1.current.summary).not.toBeNull();
      expect(r2.current.summary).not.toBeNull();
    });
    expect(fetchAgentSummaryMock).toHaveBeenCalledTimes(1);
  });

  it("patches the agent the broadcast's session names", async () => {
    const result = await loaded("agent-3");
    const before = result.current.summary!.totals.tokens;
    act(() => {
      deliver(liveEvent({ tokens_total: 50 }), "agent-3");
    });
    await waitFor(() => {
      expect(result.current.summary!.totals.tokens).toBe(before + 50);
    });
  });

  it("finds the agent from the fleet row that holds the run when the broadcast names none", async () => {
    const result = await loaded("agent-9");
    const before = result.current.summary!.totals.tokens;
    useFleetStore.setState({
      flavors: [
        { flavor: "agent-other", sessions: [{ session_id: "s-other" }] },
        { flavor: "agent-9", sessions: [{ session_id: "s-9" }] },
      ] as unknown as FlavorSummary[],
    });
    act(() => {
      deliver(liveEvent({ session_id: "s-9", tokens_total: 70 }), null);
    });
    await waitFor(() => {
      expect(result.current.summary!.totals.tokens).toBe(before + 70);
    });
  });

  it("skips an event no broadcast or fleet row ties to an agent, whatever its flavor", async () => {
    const result = await loaded("agent-6");
    const before = result.current.summary!.totals.tokens;
    // A flavor that happens to equal the agent id is still not a key.
    await act(async () => {
      deliver(liveEvent({ flavor: "agent-6", session_id: "s-unknown", tokens_total: 40 }), null);
    });
    await act(async () => {});
    expect(result.current.summary!.totals.tokens).toBe(before);
  });

  it("applies a live event once however many hooks show the agent", async () => {
    // The Agents table row and the per-agent modal can both be mounted
    // for the same agent; they share one cached summary, so the event
    // must be counted once, not once per mounted hook.
    const opts = { period: "7d" as const, bucket: "day" as const };
    const { result: row } = renderHook(() => useAgentSummary("agent-1", opts));
    const { result: modal } = renderHook(() => useAgentSummary("agent-1", opts));
    await waitFor(() => {
      expect(row.current.summary).not.toBeNull();
      expect(modal.current.summary).not.toBeNull();
    });
    act(() => {
      deliver(
        liveEvent({
          id: "e-once",
          model: "claude-sonnet-4-6",
          tokens_input: 30,
          tokens_output: 20,
          tokens_total: 50,
          latency_ms: 10,
        }),
        "agent-1",
      );
    });
    await waitFor(() => {
      expect(row.current.summary!.totals.tokens).toBe(150);
    });
    expect(modal.current.summary!.totals.tokens).toBe(150);
  });

  it("patches errors on llm_error events", async () => {
    const result = await loaded("agent-4");
    const beforeErrors = result.current.summary!.totals.errors;
    const beforeTokens = result.current.summary!.totals.tokens;
    act(() => {
      deliver(liveEvent({ event_type: "llm_error" }), "agent-4");
    });
    await waitFor(() => {
      expect(result.current.summary!.totals.errors).toBe(beforeErrors + 1);
    });
    // An llm_error with no billed tokens adds none.
    expect(result.current.summary!.totals.tokens).toBe(beforeTokens);
  });

  it("counts a failed stream's billed tokens from its llm_error", async () => {
    const result = await loaded("agent-7");
    const totals = result.current.summary!.totals;
    const series = result.current.summary!.series;
    const beforeTokens = totals.tokens;
    const beforeErrors = totals.errors;
    const beforeBucket = series[series.length - 1]!.tokens;

    // The worker stores the stream's partial tokens as the llm_error's
    // token columns, which is what the event row carries.
    act(() => {
      deliver(
        liveEvent({
          event_type: "llm_error",
          tokens_input: 1500,
          tokens_output: 240,
          tokens_total: 1740,
        }),
        "agent-7",
      );
    });
    await waitFor(() => {
      expect(result.current.summary!.totals.tokens).toBe(beforeTokens + 1740);
    });
    const after = result.current.summary!;
    expect(after.totals.errors).toBe(beforeErrors + 1);
    expect(after.series[after.series.length - 1]!.tokens).toBe(
      beforeBucket + 1740,
    );
  });

  it("counts an embeddings call's tokens like the backend", async () => {
    const result = await loaded("agent-8");
    const before = result.current.summary!.totals;
    const beforeTokens = before.tokens;
    const beforeErrors = before.errors;
    const beforeP95 = before.latency_p95_ms;
    act(() => {
      deliver(
        liveEvent({
          event_type: "embeddings",
          tokens_input: 300,
          tokens_output: 0,
          tokens_total: 300,
          // Above the cached p95: an embeddings call's latency is not
          // one of the summary's call latencies.
          latency_ms: 5000,
        }),
        "agent-8",
      );
    });
    await waitFor(() => {
      expect(result.current.summary!.totals.tokens).toBe(beforeTokens + 300);
    });
    expect(result.current.summary!.totals.errors).toBe(beforeErrors);
    expect(result.current.summary!.totals.latency_p95_ms).toBe(beforeP95);
  });

  it("ignores events for OTHER agents", async () => {
    const result = await loaded("agent-5");
    const before = result.current.summary!.totals.tokens;
    await act(async () => {
      deliver(liveEvent({ tokens_total: 999 }), "different-agent");
    });
    // Flush queued effects via act so the WS subscription has its
    // chance to fire (and exit early because the event belongs to
    // another agent). qa.md forbids raw setTimeout for
    // synchronization; act() drains the microtask queue
    // deterministically.
    await act(async () => {});
    expect(result.current.summary!.totals.tokens).toBe(before);
  });
});
