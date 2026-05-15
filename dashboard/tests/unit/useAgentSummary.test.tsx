import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import type {
  AgentEvent,
  AgentSummaryResponse,
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
  useFleetStore.setState({ lastEvent: null });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useAgentSummary", () => {
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

  it("patches totals when a post_call event lands for the agent", async () => {
    const { result } = renderHook(() =>
      useAgentSummary("agent-3", { period: "7d", bucket: "day" }),
    );
    await waitFor(() => {
      expect(result.current.summary).not.toBeNull();
    });
    const before = result.current.summary!.totals.tokens;

    const event: AgentEvent = {
      id: "e1",
      session_id: "s1",
      flavor: "agent-3",
      event_type: "post_call",
      occurred_at: new Date().toISOString(),
      has_content: false,
      tokens_cache_read: 0,
      tokens_cache_creation: 0,
      tokens_total: 50,
    };
    act(() => {
      useFleetStore.setState({ lastEvent: event });
    });
    await waitFor(() => {
      expect(result.current.summary!.totals.tokens).toBe(before + 50);
    });
  });

  it("patches errors on llm_error events", async () => {
    const { result } = renderHook(() =>
      useAgentSummary("agent-4", { period: "7d", bucket: "day" }),
    );
    await waitFor(() => {
      expect(result.current.summary).not.toBeNull();
    });
    const beforeErrors = result.current.summary!.totals.errors;

    const event: AgentEvent = {
      id: "e2",
      session_id: "s1",
      flavor: "agent-4",
      event_type: "llm_error",
      occurred_at: new Date().toISOString(),
      has_content: false,
      tokens_cache_read: 0,
      tokens_cache_creation: 0,
    };
    act(() => {
      useFleetStore.setState({ lastEvent: event });
    });
    await waitFor(() => {
      expect(result.current.summary!.totals.errors).toBe(beforeErrors + 1);
    });
  });

  it("ignores events for OTHER agents", async () => {
    const { result } = renderHook(() =>
      useAgentSummary("agent-5", { period: "7d", bucket: "day" }),
    );
    await waitFor(() => {
      expect(result.current.summary).not.toBeNull();
    });
    const before = result.current.summary!.totals.tokens;

    const event: AgentEvent = {
      id: "e3",
      session_id: "s1",
      flavor: "different-agent",
      event_type: "post_call",
      occurred_at: new Date().toISOString(),
      has_content: false,
      tokens_cache_read: 0,
      tokens_cache_creation: 0,
      tokens_total: 999,
    };
    await act(async () => {
      useFleetStore.setState({ lastEvent: event });
    });
    // Flush queued effects via act so the WS subscription has its
    // chance to fire (and exit early because the event's flavor
    // doesn't match this hook's agent_id). qa.md forbids raw
    // setTimeout for synchronization; act() drains the microtask
    // queue deterministically.
    await act(async () => {});
    expect(result.current.summary!.totals.tokens).toBe(before);
  });
});
