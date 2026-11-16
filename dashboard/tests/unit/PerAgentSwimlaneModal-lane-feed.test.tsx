import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { PerAgentSwimlaneModal } from "@/components/agents/PerAgentSwimlaneModal";
import { ClientType } from "@/lib/agent-identity";
import { __resetAgentSummaryCacheForTests } from "@/hooks/useAgentSummary";
import { eventsCache, fullHistoryLoaded } from "@/hooks/useSessionEvents";
import { fetchSession } from "@/lib/api";
import { useRunLit, useRunLitEvent } from "@/lib/run-link";
import { useFleetStore } from "@/store/fleet";
import type { AgentEvent, AgentSummary, AgentSummaryResponse, FlavorSummary, Session, SessionDetail } from "@/lib/types";

// The per-agent modal links its run lanes and its Live feed: hovering a
// lane lights its run's feed rows, hovering a feed row lights its run's
// lane and the event's circle, and a lane's label filters the feed to
// its run, with a chip (or Esc) to clear it. A hover re-renders only the
// lanes and feed rows that light or go out.

// Render counters: the KPI cost cell renders with the modal, the time
// axis with the Timeline; each lane reads its lit event once per render
// and each lane and feed row its lit run once per render.
const renders = vi.hoisted(() => ({ cost: 0, axis: 0 }));
vi.mock("@/components/agents/AgentCost", async (orig) => {
  const actual = await orig<typeof import("@/components/agents/AgentCost")>();
  return {
    ...actual,
    AgentCost: (props: React.ComponentProps<typeof actual.AgentCost>) => {
      renders.cost += 1;
      return <actual.AgentCost {...props} />;
    },
  };
});
vi.mock("@/components/timeline/TimeAxis", async (orig) => {
  const actual = await orig<typeof import("@/components/timeline/TimeAxis")>();
  return {
    ...actual,
    TimeAxis: (props: React.ComponentProps<typeof actual.TimeAxis>) => {
      renders.axis += 1;
      return <actual.TimeAxis {...props} />;
    },
  };
});
vi.mock("@/lib/run-link", async (orig) => {
  const actual = await orig<typeof import("@/lib/run-link")>();
  return { ...actual, useRunLit: vi.fn(actual.useRunLit), useRunLitEvent: vi.fn(actual.useRunLitEvent) };
});
/** The server's answer for a run: what the cache holds of it, unless a
 *  test gives the run more. */
const serverEvents = new Map<string, AgentEvent[]>();
vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    // Answered in beforeEach, which can read the events cache.
    fetchSession: vi.fn(),
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
          partial_estimate: false,
          models_unpriced: [],
          billing_modes: [],
        },
        series: [],
      }),
    ),
  };
});

const P1 = "p0000001-0000-4000-8000-000000000000";
const P2 = "p0000002-0000-4000-8000-000000000000";
const C1 = "c0000001-0000-4000-8000-000000000000";
const ID8 = (id: string) => id.slice(0, 8);

let now = 0;

function session(id: string, flavor: string, parent: string | null = null): Session {
  return {
    session_id: id,
    flavor,
    agent_type: "coding",
    host: null,
    framework: null,
    model: "claude-sonnet-4-5",
    state: "active",
    started_at: new Date(now - 40_000).toISOString(),
    last_seen_at: new Date(now).toISOString(),
    ended_at: null,
    tokens_used: 0,
    token_limit: null,
    parent_session_id: parent,
  } as Session;
}

function toolCall(id: string, sessionId: string, agoMs: number): AgentEvent {
  return {
    id,
    session_id: sessionId,
    flavor: "agent-parent",
    event_type: "tool_call",
    model: null,
    tokens_input: null,
    tokens_output: null,
    tokens_total: null,
    tokens_cache_read: null,
    tokens_cache_creation: null,
    latency_ms: null,
    tool_name: "Read",
    has_content: false,
    payload: null,
    occurred_at: new Date(now - agoMs).toISOString(),
    source: null,
    framework: null,
    client_type: null,
    agent_type: null,
  } as AgentEvent;
}

function flavor(agentId: string, name: string, sessions: Session[]): FlavorSummary {
  return {
    flavor: agentId,
    agent_type: "coding",
    session_count: sessions.length,
    active_count: sessions.length,
    tokens_used_total: 0,
    sessions,
    agent_id: agentId,
    agent_name: name,
    client_type: ClientType.ClaudeCode,
  };
}

const agent: AgentSummary = {
  agent_id: "agent-parent",
  agent_name: "parent-agent",
  agent_type: "coding",
  client_type: ClientType.ClaudeCode,
  user: "u",
  hostname: "h",
  first_seen_at: "2026-05-01T00:00:00Z",
  last_seen_at: "2026-05-14T12:00:00Z",
  total_sessions: 3,
  total_tokens: 0,
  state: "active",
  topology: "parent",
};

beforeEach(() => {
  vi.mocked(fetchSession).mockImplementation(
    async (id: string) => ({ events: serverEvents.get(id) ?? eventsCache.get(id) ?? [] }) as SessionDetail,
  );
  // The modal's clock and the Timeline's connector re-measure tick on
  // intervals; frozen, so a render counted is one a hover caused.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  now = Date.now();
  __resetAgentSummaryCacheForTests();
  eventsCache.set(P1, [toolCall("p1-a", P1, 30_000), toolCall("p1-b", P1, 20_000)]);
  eventsCache.set(P2, [toolCall("p2-a", P2, 25_000), toolCall("p2-b", P2, 15_000)]);
  eventsCache.set(C1, [toolCall("c1-a", C1, 10_000)]);
  useFleetStore.setState({
    flavors: [
      flavor("agent-parent", "parent-agent", [session(P1, "agent-parent"), session(P2, "agent-parent")]),
      flavor("agent-child", "parent-agent/worker", [session(C1, "agent-child", P1)]),
    ],
  });
});

afterEach(() => {
  eventsCache.clear();
  fullHistoryLoaded.clear();
  serverEvents.clear();
  vi.mocked(fetchSession).mockClear();
  useFleetStore.setState({ flavors: [] });
  vi.useRealTimers();
});

async function openModal(onClose = () => {}) {
  render(
    <MemoryRouter>
      <PerAgentSwimlaneModal agent={agent} onClose={onClose} />
    </MemoryRouter>,
  );
  await act(async () => {});
  await screen.findAllByTestId("feed-row");
  await act(async () => {});
}

const lane = (id: string) => screen.getByTestId(`swimlane-run-lane-${ID8(id)}`);
const laneLabel = (id: string) =>
  screen.getByRole("button", { name: `Show only run ${ID8(id)} in the Live feed` });
const feedRows = () => screen.getAllByTestId("feed-row");
const feedRow = (eventId: string) => feedRows().find((r) => r.getAttribute("data-feed-event-id") === eventId)!;
const feedRuns = () => [...new Set(feedRows().map((r) => r.getAttribute("data-run-id")))].sort();
const litFeedEvents = () =>
  feedRows()
    .filter((r) => r.getAttribute("data-linked") === "true")
    .map((r) => r.getAttribute("data-feed-event-id"))
    .sort();
const litLanes = () =>
  Array.from(document.querySelectorAll<HTMLElement>('[data-run-lane-row][data-linked="true"]')).map((l) =>
    l.getAttribute("data-run-id"),
  );

function counts() {
  return {
    cost: renders.cost,
    axis: renders.axis,
    lit: vi.mocked(useRunLit).mock.calls.length,
    litEvent: vi.mocked(useRunLitEvent).mock.calls.length,
  };
}

describe("PerAgentSwimlaneModal lanes and Live feed", () => {
  it("lights a hovered lane's feed rows, re-rendering only that lane and those rows", async () => {
    await openModal();
    expect(feedRows()).toHaveLength(5);
    const before = counts();

    fireEvent.mouseOver(within(lane(P1)).getByTestId("swimlane-run-lane-label"));
    expect(litLanes()).toEqual([P1]);
    expect(litFeedEvents()).toEqual(["p1-a", "p1-b"]);

    const after = counts();
    // Neither the modal nor its Timeline rendered.
    expect(after.cost).toBe(before.cost);
    expect(after.axis).toBe(before.axis);
    // One lane rendered, and two feed rows (each lane and row reads its
    // lit run once per render; a feed re-render would render all five).
    expect(after.litEvent - before.litEvent).toBe(1);
    expect(after.lit - before.lit - (after.litEvent - before.litEvent)).toBe(2);

    fireEvent.mouseOut(lane(P1), { relatedTarget: document.body });
    expect(litLanes()).toEqual([]);
    expect(litFeedEvents()).toEqual([]);
  });

  it("lights a hovered feed row's lane and rings its circle; the next row of the run moves the ring only", async () => {
    await openModal();
    fireEvent.mouseOver(feedRow("p1-a"));
    expect(litLanes()).toEqual([P1]);
    const circle = (id: string) => lane(P1).querySelector<HTMLElement>(`[data-event-id="${id}"]`)!;
    expect(circle("p1-a")).toHaveAttribute("data-linked", "true");
    expect(circle("p1-b")).not.toHaveAttribute("data-linked");

    const before = counts();
    fireEvent.mouseOver(feedRow("p1-b"));
    expect(circle("p1-b")).toHaveAttribute("data-linked", "true");
    expect(circle("p1-a")).not.toHaveAttribute("data-linked");
    const after = counts();
    // The lane re-rendered for its ring; no feed row did.
    expect(after.litEvent - before.litEvent).toBe(1);
    expect(after.lit - before.lit).toBe(1);
    expect(after.cost).toBe(before.cost);
    expect(after.axis).toBe(before.axis);

    fireEvent.mouseLeave(screen.getByTestId("feed-body"));
    expect(litLanes()).toEqual([]);
  });

  it("filters the feed to a lane's run, switches on another lane and clears on the filtered one", async () => {
    await openModal();
    expect(laneLabel(P1)).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(laneLabel(P1));
    expect(laneLabel(P1)).toHaveAttribute("aria-pressed", "true");
    expect(feedRuns()).toEqual([P1]);
    const chip = screen.getByTestId("feed-run-filter-chip");
    expect(chip).toHaveTextContent(`Run ${ID8(P1)}`);
    expect(chip).toHaveAccessibleName(`Run ${ID8(P1)}: clear the run filter`);
    expect(chip.tagName).toBe("BUTTON");

    fireEvent.click(laneLabel(P2));
    expect(laneLabel(P1)).toHaveAttribute("aria-pressed", "false");
    expect(laneLabel(P2)).toHaveAttribute("aria-pressed", "true");
    expect(feedRuns()).toEqual([P2]);
    expect(screen.getByTestId("feed-run-filter-chip")).toHaveTextContent(`Run ${ID8(P2)}`);

    fireEvent.click(laneLabel(P2));
    expect(screen.queryByTestId("feed-run-filter-chip")).toBeNull();
    expect(feedRows()).toHaveLength(5);
  });

  it("clears the filter from its chip", async () => {
    await openModal();
    fireEvent.click(laneLabel(P2));
    fireEvent.click(screen.getByTestId("feed-run-filter-chip"));
    expect(screen.queryByTestId("feed-run-filter-chip")).toBeNull();
    expect(laneLabel(P2)).toHaveAttribute("aria-pressed", "false");
    expect(feedRows()).toHaveLength(5);
  });

  it("clears the filter on Esc before closing the modal", async () => {
    const onClose = vi.fn();
    await openModal(onClose);
    fireEvent.click(laneLabel(P1));
    fireEvent.keyDown(laneLabel(P1), { key: "Escape" });
    expect(screen.queryByTestId("feed-run-filter-chip")).toBeNull();
    expect(feedRows()).toHaveLength(5);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(laneLabel(P1), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("filters to a sub-agent's run from its own group, and drops it when Show sub-agents goes off", async () => {
    await openModal();
    const child = screen.getByTestId("swimlane-agent-row-parent-agent/worker");
    expect(child).toHaveAttribute("data-run-lanes", "true");
    fireEvent.click(within(child).getByRole("button", { name: `Show only run ${ID8(C1)} in the Live feed` }));
    expect(feedRuns()).toEqual([C1]);

    fireEvent.click(screen.getByTestId("per-agent-swimlane-modal-show-sub-agents-input"));
    expect(screen.queryByTestId("feed-run-filter-chip")).toBeNull();
    // The feed re-seeds for the narrower scope.
    await act(async () => {});
    expect(feedRuns()).toEqual([P1, P2]);
  });

  it("fetches a run the cache holds only part of, so its older events show", async () => {
    // The Fleet page cached the run's newest call alone (its 1m window).
    serverEvents.set(P1, [toolCall("p1-a", P1, 30_000), toolCall("p1-b", P1, 20_000)]);
    eventsCache.set(P1, [toolCall("p1-b", P1, 20_000)]);
    await openModal();
    expect(fetchSession).toHaveBeenCalledWith(P1);
    expect(
      feedRows()
        .filter((r) => r.getAttribute("data-run-id") === P1)
        .map((r) => r.getAttribute("data-feed-event-id"))
        .sort(),
    ).toEqual(["p1-a", "p1-b"]);
    expect(fullHistoryLoaded.has(P1)).toBe(true);
  });

  it("reads a run the cache holds whole without fetching it", async () => {
    for (const id of [P1, P2, C1]) fullHistoryLoaded.add(id);
    await openModal();
    expect(feedRows()).toHaveLength(5);
    expect(fetchSession).not.toHaveBeenCalled();
  });
});
