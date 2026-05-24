import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { AgentDrawerEventsTab } from "@/components/agents/AgentDrawerEventsTab";
import { fetchBulkEvents, type BulkEventsResponse } from "@/lib/api";
import type { AgentEvent } from "@/lib/types";

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

function mkEvent(id: string, sessionId: string): AgentEvent {
  return {
    id,
    session_id: sessionId,
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

async function renderTab(
  events: AgentEvent[],
  total: number,
  handlers: {
    onEventClick?: (e: AgentEvent) => void;
    onRunClick?: (s: string) => void;
  } = {},
) {
  h.response = {
    events,
    total,
    limit: 50,
    offset: 0,
    has_more: total > events.length,
  };
  const result = render(
    <AgentDrawerEventsTab
      agentId="agent-1"
      onEventClick={handlers.onEventClick ?? (() => {})}
      onRunClick={handlers.onRunClick ?? (() => {})}
    />,
  );
  await act(async () => {});
  return result;
}

describe("AgentDrawerEventsTab", () => {
  beforeEach(() => {
    vi.mocked(fetchBulkEvents).mockClear();
  });

  it("renders a row per fetched event", async () => {
    await renderTab(
      [mkEvent("e1", "sess-aaaaaaaa"), mkEvent("e2", "sess-bbbbbbbb")],
      2,
    );
    expect(screen.getAllByTestId("agent-drawer-event-row")).toHaveLength(2);
  });

  it("shows an empty state when the agent has no events", async () => {
    await renderTab([], 0);
    expect(
      screen.getByTestId("agent-drawer-events-empty"),
    ).toBeInTheDocument();
  });

  it("opens the event detail on a row click", async () => {
    const onEventClick = vi.fn();
    const evt = mkEvent("e1", "sess-aaaaaaaa");
    await renderTab([evt], 1, { onEventClick });
    fireEvent.click(screen.getByTestId("agent-drawer-event-row"));
    expect(onEventClick).toHaveBeenCalledWith(evt);
  });

  it("opens the run drawer on a run-badge click without opening the event", async () => {
    const onEventClick = vi.fn();
    const onRunClick = vi.fn();
    await renderTab([mkEvent("e1", "sess-aaaaaaaa")], 1, {
      onEventClick,
      onRunClick,
    });
    fireEvent.click(screen.getByTestId("agent-drawer-event-run-badge"));
    expect(onRunClick).toHaveBeenCalledWith("sess-aaaaaaaa");
    // The badge click must not bubble to the row's event handler.
    expect(onEventClick).not.toHaveBeenCalled();
  });

  it("shows pagination only when the total exceeds one page", async () => {
    await renderTab([mkEvent("e1", "sess-aaaaaaaa")], 120);
    expect(
      screen.getByTestId("agent-drawer-events-pagination"),
    ).toBeInTheDocument();
  });

  it("shows the error state when the fetch fails", async () => {
    vi.mocked(fetchBulkEvents).mockRejectedValueOnce(new Error("500"));
    render(
      <AgentDrawerEventsTab
        agentId="agent-1"
        onEventClick={() => {}}
        onRunClick={() => {}}
      />,
    );
    await act(async () => {});
    expect(
      screen.getByTestId("agent-drawer-events-error"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("agent-drawer-event-row")).toBeNull();
  });
});
