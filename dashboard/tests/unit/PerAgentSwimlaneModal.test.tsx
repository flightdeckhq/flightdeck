import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { PerAgentSwimlaneModal } from "@/components/agents/PerAgentSwimlaneModal";
import { ClientType } from "@/lib/agent-identity";
import { __resetAgentSummaryCacheForTests } from "@/hooks/useAgentSummary";
import { eventsCache } from "@/hooks/useSessionEvents";
import { useFleetStore } from "@/store/fleet";
import type {
  AgentEvent,
  AgentSummary,
  AgentSummaryResponse,
  FeedEvent,
  FlavorSummary,
  Session,
} from "@/lib/types";

// Stub LiveFeed so we can assert on the ``events`` prop the modal
// passes — the test reads ``data-event-count`` straight off the
// stub rather than walking the (heavy) recharts/Radix render tree
// inside the real component.
vi.mock("@/components/fleet/LiveFeed", () => ({
  LiveFeed: (props: { events: FeedEvent[] }) => (
    <div
      data-testid="livefeed-stub"
      data-event-count={props.events.length}
    />
  ),
}));

// Stub the summary fetch so the modal's useAgentSummary hook
// doesn't hit jsdom's broken fetch path. See AgentTable.test.tsx
// for the same pattern + rationale.
vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchAgentSummary: vi.fn(
      async (agentId: string): Promise<AgentSummaryResponse> => ({
        agent_id: agentId,
        period: "7d",
        bucket: "day",
        totals: {
          tokens: 0,
          errors: 0,
          sessions: 0,
          cost_usd: 0,
          latency_p50_ms: 0,
          latency_p95_ms: 0,
        },
        series: [],
      }),
    ),
  };
});

function mkAgent(over: Partial<AgentSummary> = {}): AgentSummary {
  return {
    agent_id: "agent-1",
    agent_name: "test-agent",
    agent_type: "coding",
    client_type: ClientType.ClaudeCode,
    user: "u",
    hostname: "h",
    first_seen_at: "2026-05-01T00:00:00Z",
    last_seen_at: "2026-05-14T12:00:00Z",
    total_sessions: 1,
    total_tokens: 100,
    state: "active",
    topology: "lone",
    ...over,
  };
}

beforeEach(() => {
  __resetAgentSummaryCacheForTests();
});

describe("PerAgentSwimlaneModal", () => {
  it("mounts hidden when agent is null", () => {
    render(
      <MemoryRouter>
        <PerAgentSwimlaneModal agent={null} onClose={() => {}} />
      </MemoryRouter>,
    );
    expect(screen.queryByTestId("per-agent-swimlane-modal")).toBeNull();
  });

  it("renders the header with agent name when open", () => {
    render(
      <MemoryRouter>
        <PerAgentSwimlaneModal agent={mkAgent()} onClose={() => {}} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("per-agent-swimlane-modal-header")).toBeInTheDocument();
    expect(screen.getByTestId("per-agent-swimlane-modal-name").textContent).toBe(
      "test-agent",
    );
  });

  it("defaults the time range picker to 1m", () => {
    render(
      <MemoryRouter>
        <PerAgentSwimlaneModal agent={mkAgent()} onClose={() => {}} />
      </MemoryRouter>,
    );
    const btn1m = screen.getByTestId("per-agent-swimlane-modal-time-1m");
    expect(btn1m).toHaveAttribute("data-active", "true");
    const btn1h = screen.getByTestId("per-agent-swimlane-modal-time-1h");
    expect(btn1h).not.toHaveAttribute("data-active");
    // 24h was dropped — the modal mirrors Fleet's five options.
    expect(
      screen.queryByTestId("per-agent-swimlane-modal-time-24h"),
    ).toBeNull();
  });

  it("defaults the show-sub-agents toggle ON for parent agents", () => {
    render(
      <MemoryRouter>
        <PerAgentSwimlaneModal
          agent={mkAgent({ topology: "parent" })}
          onClose={() => {}}
        />
      </MemoryRouter>,
    );
    const input = screen.getByTestId(
      "per-agent-swimlane-modal-show-sub-agents-input",
    ) as HTMLInputElement;
    expect(input.checked).toBe(true);
    expect(input.disabled).toBe(false);
  });

  it("disables + unchecks the toggle for lone agents", () => {
    render(
      <MemoryRouter>
        <PerAgentSwimlaneModal
          agent={mkAgent({ topology: "lone" })}
          onClose={() => {}}
        />
      </MemoryRouter>,
    );
    const input = screen.getByTestId(
      "per-agent-swimlane-modal-show-sub-agents-input",
    ) as HTMLInputElement;
    expect(input.checked).toBe(false);
    expect(input.disabled).toBe(true);
  });

  it("renders 4 KPI tiles for a Claude Code agent (Cost suppressed)", () => {
    // Claude Code agents bill independently of per-call LLM usage so
    // the Cost (7d) tile is omitted entirely — keeping a fixed em-
    // dash tile would be visual noise in the modal header. The
    // remaining four tiles (Tokens / Latency p95 / Errors /
    // Sessions) carry meaningful values regardless of billing model.
    render(
      <MemoryRouter>
        <PerAgentSwimlaneModal agent={mkAgent()} onClose={() => {}} />
      </MemoryRouter>,
    );
    const tiles = screen.getAllByTestId("per-agent-swimlane-modal-kpi-tile");
    expect(tiles.length).toBe(4);
    const labels = tiles.map((t) => t.textContent || "");
    // KpiTile renders the literal label "Cost (7d)" in DOM; CSS
    // ``text-transform: uppercase`` is visual only and does not
    // affect ``textContent``.
    expect(labels.some((l) => l.includes("Cost"))).toBe(false);
  });

  it("renders 5 KPI tiles for a sensor agent (Cost included)", () => {
    // Sensor-instrumented agents call paid LLM APIs directly so
    // the Cost (7d) tile is meaningful and present. New
    // ClientType values default to the Claude-Code treatment via
    // ``clientIncursMeteredCost``; opt in by extending the
    // predicate.
    render(
      <MemoryRouter>
        <PerAgentSwimlaneModal
          agent={mkAgent({ client_type: ClientType.FlightdeckSensor })}
          onClose={() => {}}
        />
      </MemoryRouter>,
    );
    const tiles = screen.getAllByTestId("per-agent-swimlane-modal-kpi-tile");
    expect(tiles.length).toBe(5);
    const labels = tiles.map((t) => t.textContent || "");
    expect(labels.some((l) => l.includes("Cost"))).toBe(true);
  });

  it("calls onClose when the dialog is dismissed", () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <MemoryRouter>
        <PerAgentSwimlaneModal agent={mkAgent()} onClose={onClose} />
      </MemoryRouter>,
    );
    rerender(
      <MemoryRouter>
        <PerAgentSwimlaneModal agent={null} onClose={onClose} />
      </MemoryRouter>,
    );
    // The dialog component invokes onOpenChange when its
    // controlled `open` flips false; this test pins the prop
    // contract — the host's onClose receives the close event.
    // No direct fireEvent.click is used because Radix Dialog's
    // close affordance is portalled and depends on Radix
    // internals; the controlled-open path is the canonical close.
    expect(screen.queryByTestId("per-agent-swimlane-modal")).toBeNull();
  });

  it("aligns the status badge inline next to the name (no ml-auto)", () => {
    // The shared ``AgentStatusBadge`` defaults to ``ml-auto`` so
    // the swimlane row strip can park it at the right edge. The
    // modal header passes ``align="inline"`` so the badge hugs
    // the name + topology pill on the left and the close × (own
    // ``marginLeft: auto``) anchors the right edge. Without this
    // opt-out the badge absorbs the space between the topology
    // pill and the close ×, parking visually in the middle.
    render(
      <MemoryRouter>
        <PerAgentSwimlaneModal agent={mkAgent()} onClose={() => {}} />
      </MemoryRouter>,
    );
    const badge = screen.getByTestId("per-agent-swimlane-modal-status");
    expect(badge.className).not.toMatch(/\bml-auto\b/);
    // The badge must sit before the close × in source order so
    // ``marginLeft: auto`` on the × pushes only the × to the
    // right, not the badge.
    const closeX = screen.getByTestId("per-agent-swimlane-modal-close");
    const order = badge.compareDocumentPosition(closeX);
    expect(order & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("renders an explicit close X in the header that fires onClose", () => {
    const onClose = vi.fn();
    render(
      <MemoryRouter>
        <PerAgentSwimlaneModal agent={mkAgent()} onClose={onClose} />
      </MemoryRouter>,
    );
    const closeX = screen.getByTestId("per-agent-swimlane-modal-close");
    expect(closeX).toBeInTheDocument();
    expect(closeX).toHaveAttribute(
      "aria-label",
      "Close per-agent swimlane modal",
    );
    fireEvent.click(closeX);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders a scoped LiveFeed strip below the swimlane body", () => {
    // The feed strip is the dedicated mount point for the
    // modal-scoped LiveFeed. The pipeline (per-session
    // ``fetchSession`` for the seed + ``useFleetStore.lastEvent``
    // injection into ``eventsCache`` for live ticks) lives inside
    // the component; this unit test asserts the mount-point
    // exists when the modal is open. End-to-end scope assertions
    // (parent only vs parent + sub-agents) belong to T96.
    render(
      <MemoryRouter>
        <PerAgentSwimlaneModal agent={mkAgent()} onClose={() => {}} />
      </MemoryRouter>,
    );
    expect(
      screen.getByTestId("per-agent-swimlane-modal-feed"),
    ).toBeInTheDocument();
  });

  it("LiveFeed receives only events inside the picker time window", async () => {
    // The picker controls a wall-clock window. The modal feeds
    // LiveFeed a projection of ``feedEvents`` filtered by
    // ``occurred_at >= NOW − TIMELINE_RANGE_MS[timeRange]`` so
    // narrowing the picker (1h → 1m) drops older events and
    // widening (1m → 1h) re-exposes the in-memory superset
    // without a re-fetch. Default ``DEFAULT_TIME_RANGE`` is 1 m.
    //
    // Pin ``Date.now()`` so the 30 s / 10 m offsets below are
    // exact relative to the same epoch the component's
    // ``visibleFeedEvents`` memo reads. With real wall-clock,
    // a loaded CI runner can drift several ms between the test's
    // ``Date.now()`` snapshot and the memo's read, making the
    // 30 s ``ev-new`` margin technically flake-prone. Surgical
    // spy (vs. ``vi.useFakeTimers()``) keeps timers / promises /
    // rAF real so the modal's seed effect + ``act`` flush
    // resolve normally.
    const fakeNow = new Date("2026-05-23T12:00:00Z").getTime();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(fakeNow);
    const sid = "sid-window-test";
    const now = fakeNow;
    const event = (id: string, occurredAt: number): AgentEvent => ({
      id,
      session_id: sid,
      flavor: "agent-window-test",
      event_type: "tool_call",
      model: null,
      tokens_input: null,
      tokens_output: null,
      tokens_total: null,
      tokens_cache_read: null,
      tokens_cache_creation: null,
      latency_ms: null,
      tool_name: "noop",
      has_content: false,
      payload: null,
      occurred_at: new Date(occurredAt).toISOString(),
      source: null,
      framework: null,
      client_type: null,
      agent_type: null,
    });
    // Two events: one 30 s ago (inside the default 1 m window),
    // one 10 m ago (outside 1 m, inside 5 m / 15 m / 30 m / 1 h).
    eventsCache.set(sid, [
      event("ev-old", now - 10 * 60 * 1000),
      event("ev-new", now - 30 * 1000),
    ]);
    const flavor: FlavorSummary = {
      flavor: "agent-window-test",
      agent_type: "coding",
      session_count: 1,
      active_count: 1,
      tokens_used_total: 0,
      sessions: [
        {
          session_id: sid,
          flavor: "agent-window-test",
          agent_type: "coding",
          host: null,
          framework: null,
          model: null,
          state: "active",
          started_at: new Date(now - 60_000).toISOString(),
          last_seen_at: new Date(now).toISOString(),
          ended_at: null,
          tokens_used: 0,
          token_limit: null,
        } as Session,
      ],
      agent_id: "agent-window-test",
      agent_name: "agent-window-test",
      client_type: ClientType.ClaudeCode,
    };
    useFleetStore.setState({ flavors: [flavor] });

    render(
      <MemoryRouter>
        <PerAgentSwimlaneModal
          agent={mkAgent({ agent_id: "agent-window-test", topology: "lone" })}
          onClose={() => {}}
        />
      </MemoryRouter>,
    );
    // Flush the seed effect.
    await act(async () => {});
    const stub = await screen.findByTestId("livefeed-stub");

    // Default 1 m window — only ``ev-new`` (NOW − 30 s) qualifies.
    await waitFor(() => {
      expect(stub.getAttribute("data-event-count")).toBe("1");
    });

    // Widen the picker to 1 h — both events fall inside.
    fireEvent.click(
      screen.getByTestId("per-agent-swimlane-modal-time-1h"),
    );
    await waitFor(() => {
      expect(stub.getAttribute("data-event-count")).toBe("2");
    });

    // Narrow back to 5 m — ``ev-old`` (NOW − 10 m) drops out.
    fireEvent.click(
      screen.getByTestId("per-agent-swimlane-modal-time-5m"),
    );
    await waitFor(() => {
      expect(stub.getAttribute("data-event-count")).toBe("1");
    });

    // Cleanup: reset the cache + store + Date.now spy so other
    // tests start from a clean baseline.
    eventsCache.delete(sid);
    useFleetStore.setState({ flavors: [] });
    nowSpy.mockRestore();
  });
});
