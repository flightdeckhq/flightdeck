import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { LiveFeed } from "@/components/fleet/LiveFeed";
import type { AgentEvent, FeedEvent } from "@/lib/types";

function makeEvent(overrides: Partial<AgentEvent> & { id: string }): AgentEvent {
  return {
    session_id: "s1",
    flavor: "research-agent",
    event_type: "post_call",
    model: "claude-sonnet-4-20250514",
    tokens_input: 100,
    tokens_output: 50,
    tokens_total: 150,
    latency_ms: 1200,
    tool_name: null,
    has_content: false,
    occurred_at: "2026-04-07T10:00:00Z",
    ...overrides,
  };
}

function makeFeedEvent(event: Partial<AgentEvent> & { id: string }, arrivedAt?: number): FeedEvent {
  const t = arrivedAt ?? Date.now();
  // Mirror arrivedAt into occurred_at so tests that assert "newest
  // first by arrivedAt" keep their intent after the sort moved to the
  // server-assigned occurred_at (Bug 1 fix in LiveFeed.tsx).
  return {
    arrivedAt: t,
    event: makeEvent({ occurred_at: new Date(t).toISOString(), ...event }),
  };
}

const mockFeedEvents: FeedEvent[] = [
  makeFeedEvent({ id: "e1", event_type: "session_start", model: null, tokens_total: null, latency_ms: null }, 1000),
  makeFeedEvent({ id: "e2", event_type: "post_call" }, 2000),
  makeFeedEvent({ id: "e3", event_type: "tool_call", tool_name: "web_search", model: null, tokens_total: null }, 3000),
];

describe("LiveFeed", () => {
  it("renders event rows with correct badge text", () => {
    render(<LiveFeed events={mockFeedEvents} onEventClick={() => {}} />);
    expect(screen.getByText("START")).toBeInTheDocument();
    expect(screen.getByText("LLM CALL")).toBeInTheDocument();
    expect(screen.getByText("TOOL")).toBeInTheDocument();
  });

  it("flavor column shows flavor name", () => {
    render(<LiveFeed events={mockFeedEvents} onEventClick={() => {}} />);
    const flavorTexts = screen.getAllByText("research-agent");
    expect(flavorTexts.length).toBeGreaterThanOrEqual(1);
  });

  it("badge matches event type", () => {
    const events = [makeFeedEvent({ id: "e1", event_type: "policy_warn", model: null })];
    render(<LiveFeed events={events} onEventClick={() => {}} />);
    expect(screen.getByText("WARN")).toBeInTheDocument();
  });

  it("new event appends (renders additional row)", () => {
    const { rerender } = render(
      <LiveFeed events={mockFeedEvents.slice(0, 2)} onEventClick={() => {}} />
    );
    expect(screen.getAllByTestId("feed-row")).toHaveLength(2);

    rerender(<LiveFeed events={mockFeedEvents} onEventClick={() => {}} />);
    expect(screen.getAllByTestId("feed-row")).toHaveLength(3);
  });

  it("newest arrival appears at top (reverse of array order)", () => {
    // fe1 arrived first (1000), fe3 arrived last (3000)
    // After reverse, fe3 should be first rendered row
    render(<LiveFeed events={mockFeedEvents} onEventClick={() => {}} />);
    const rows = screen.getAllByTestId("feed-row");
    // First row should be TOOL (e3, arrivedAt=3000, last in array → first after reverse)
    const firstBadge = rows[0].querySelector("[data-testid='feed-badge']");
    expect(firstBadge?.textContent).toBe("TOOL");
    // Last row should be START (e1, arrivedAt=1000, first in array → last after reverse)
    const lastBadge = rows[2].querySelector("[data-testid='feed-badge']");
    expect(lastBadge?.textContent).toBe("START");
  });

  it("timestamp shows arrivedAt time", () => {
    const events = [makeFeedEvent({ id: "e1" }, new Date("2026-04-09T16:20:19Z").getTime())];
    render(<LiveFeed events={events} onEventClick={() => {}} />);
    expect(screen.getByTestId("feed-timestamp")).toBeInTheDocument();
  });

  it("caps at 500 events", () => {
    const manyEvents = Array.from({ length: 501 }, (_, i) =>
      makeFeedEvent({ id: `e${i}` }, i)
    );
    render(<LiveFeed events={manyEvents} onEventClick={() => {}} />);
    expect(screen.getByTestId("feed-count").textContent).toContain("500 events");
  });

  it("row click calls onEventClick with AgentEvent", () => {
    const onEventClick = vi.fn();
    render(<LiveFeed events={mockFeedEvents} onEventClick={onEventClick} />);
    const rows = screen.getAllByTestId("feed-row");
    fireEvent.click(rows[0]); // first visible = last in array (e3) after reverse
    expect(onEventClick).toHaveBeenCalledWith(mockFeedEvents[2].event);
  });

  it("empty state shows waiting message", () => {
    render(<LiveFeed events={[]} onEventClick={() => {}} />);
    expect(screen.getByText("Waiting for events...")).toBeInTheDocument();
  });

  it("resize handle exists", () => {
    render(<LiveFeed events={mockFeedEvents} onEventClick={() => {}} />);
    expect(screen.getByTestId("feed-resize-handle")).toBeInTheDocument();
  });

  it("filter hides non-matching events", () => {
    render(<LiveFeed events={mockFeedEvents} onEventClick={() => {}} activeFilter="Tools" />);
    const rows = screen.getAllByTestId("feed-row");
    expect(rows).toHaveLength(1);
    expect(screen.getByText("TOOL")).toBeInTheDocument();
    expect(screen.queryByText("START")).not.toBeInTheDocument();
    expect(screen.queryByText("LLM CALL")).not.toBeInTheDocument();
  });

  it("column headers render", () => {
    render(<LiveFeed events={mockFeedEvents} onEventClick={() => {}} />);
    const headers = screen.getByTestId("feed-column-headers");
    expect(headers).toBeInTheDocument();
    expect(headers.textContent).toContain("Agent");
    expect(headers.textContent).toContain("Session");
    expect(headers.textContent).toContain("Type");
    expect(headers.textContent).toContain("Detail");
    expect(headers.textContent).toContain("Time");
  });

  it("session ID shows 8 chars", () => {
    const events = [makeFeedEvent({ id: "e1", session_id: "abcdef1234567890" })];
    render(<LiveFeed events={events} onEventClick={() => {}} />);
    expect(screen.getByText("abcdef12")).toBeInTheDocument();
  });

  it("column header is not static positioned", () => {
    render(<LiveFeed events={mockFeedEvents} onEventClick={() => {}} />);
    const headers = screen.getByTestId("feed-column-headers");
    expect(headers.style.position || headers.className).toContain("absolute");
  });

  it("filtered count shows N of M", () => {
    render(<LiveFeed events={mockFeedEvents} onEventClick={() => {}} activeFilter="Tools" />);
    expect(screen.getByTestId("feed-count").textContent).toBe("1 of 3 events");
  });

  it("filter label in header", () => {
    render(<LiveFeed events={mockFeedEvents} onEventClick={() => {}} activeFilter="Policy" />);
    expect(screen.getByTestId("feed-filter-label")).toBeInTheDocument();
  });

  it("filter label click clears filter", () => {
    const onFilterChange = vi.fn();
    render(<LiveFeed events={mockFeedEvents} onEventClick={() => {}} activeFilter="Tools" onFilterChange={onFilterChange} />);
    fireEvent.click(screen.getByTestId("feed-filter-label"));
    expect(onFilterChange).toHaveBeenCalledWith(null);
  });

  it("paused header shows queue count", () => {
    render(<LiveFeed events={mockFeedEvents} onEventClick={() => {}} isPaused={true} queueLength={7} />);
    expect(screen.getByTestId("feed-count").textContent).toContain("7 events waiting");
  });

  it("catching up header shows during drain", () => {
    render(<LiveFeed events={mockFeedEvents} onEventClick={() => {}} catchingUp={true} />);
    expect(screen.getByTestId("feed-catching-up")).toBeInTheDocument();
    expect(screen.getByText("Catching up...")).toBeInTheDocument();
  });

  it("cap indicator shows oldest dropped at 1000", () => {
    render(<LiveFeed events={mockFeedEvents} onEventClick={() => {}} isPaused={true} queueLength={1000} />);
    expect(screen.getByTestId("feed-count").textContent).toContain("oldest dropped");
  });

  it("under cap shows amber waiting text", () => {
    render(<LiveFeed events={mockFeedEvents} onEventClick={() => {}} isPaused={true} queueLength={500} />);
    const count = screen.getByTestId("feed-count");
    expect(count.textContent).toContain("500 events waiting");
    expect(count.textContent).not.toContain("oldest dropped");
  });

  it("default sort is time descending (newest first)", () => {
    render(<LiveFeed events={mockFeedEvents} onEventClick={() => {}} />);
    const rows = screen.getAllByTestId("feed-row");
    const firstBadge = rows[0].querySelector("[data-testid='feed-badge']");
    expect(firstBadge?.textContent).toBe("TOOL"); // arrivedAt=3000, newest
  });

  it("click flavor header sorts by flavor ascending", () => {
    const events = [
      makeFeedEvent({ id: "e1", flavor: "zeta-agent" }, 1000),
      makeFeedEvent({ id: "e2", flavor: "alpha-agent" }, 2000),
    ];
    render(<LiveFeed events={events} onEventClick={() => {}} />);
    fireEvent.click(screen.getByTestId("feed-col-flavor"));
    const rows = screen.getAllByTestId("feed-row");
    expect(rows[0].textContent).toContain("alpha-agent");
  });

  it("sort indicator shows arrow", () => {
    render(<LiveFeed events={mockFeedEvents} onEventClick={() => {}} />);
    // Default: time col has ↓
    const timeCol = screen.getByTestId("feed-col-time");
    expect(timeCol.textContent).toContain("↓");
  });

  it("non-time sort triggers onPause", () => {
    const onPause = vi.fn();
    render(<LiveFeed events={mockFeedEvents} onEventClick={() => {}} onPause={onPause} />);
    fireEvent.click(screen.getByTestId("feed-col-flavor"));
    expect(onPause).toHaveBeenCalled();
  });

  it("return to live resets sort and calls onResume", () => {
    const onResume = vi.fn();
    render(<LiveFeed events={mockFeedEvents} onEventClick={() => {}} onPause={() => {}} onResume={onResume} />);
    fireEvent.click(screen.getByTestId("feed-col-flavor"));
    expect(screen.getByTestId("sort-pause-banner")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Return to live"));
    expect(onResume).toHaveBeenCalled();
  });
});

// --------------------------------------------------------------------
// D122 — MCP discovery events hide-by-default in the live feed.
//
// The feed receives the full upstream event stream and applies the
// discovery filter BEFORE the FEED_MAX_EVENTS cap so that the cap
// reflects "last N visible" rather than "last N raw of which some
// are hidden". The activeFilter ("MCP" pill etc.) composes on top —
// counts shown to the operator are visible-only.
// --------------------------------------------------------------------

describe("LiveFeed — D122 discovery hide", () => {
  const mixedEvents: FeedEvent[] = [
    makeFeedEvent({ id: "e1", event_type: "session_start", model: null, tokens_total: null, latency_ms: null }, 1000),
    makeFeedEvent({ id: "e2", event_type: "mcp_tool_list", model: null, tokens_total: null, latency_ms: null }, 2000),
    makeFeedEvent({ id: "e3", event_type: "mcp_tool_call", tool_name: "echo", model: null, tokens_total: null, latency_ms: null }, 3000),
    makeFeedEvent({ id: "e4", event_type: "mcp_resource_list", model: null, tokens_total: null, latency_ms: null }, 4000),
    makeFeedEvent({ id: "e5", event_type: "mcp_resource_read", model: null, tokens_total: null, latency_ms: null }, 5000),
    makeFeedEvent({ id: "e6", event_type: "mcp_prompt_list", model: null, tokens_total: null, latency_ms: null }, 6000),
    makeFeedEvent({ id: "e7", event_type: "mcp_prompt_get", model: null, tokens_total: null, latency_ms: null }, 7000),
  ];

  beforeEach(() => {
    localStorage.clear();
  });

  it("hides discovery events by default (off)", () => {
    render(<LiveFeed events={mixedEvents} onEventClick={() => {}} />);
    // 7 input events - 3 discovery types = 4 visible:
    // session_start + mcp_tool_call + mcp_resource_read + mcp_prompt_get.
    expect(screen.getAllByTestId("feed-row")).toHaveLength(4);
    expect(screen.queryByText("TOOLS DISCOVERED")).not.toBeInTheDocument();
    expect(screen.queryByText("RESOURCES DISCOVERED")).not.toBeInTheDocument();
    expect(screen.queryByText("PROMPTS DISCOVERED")).not.toBeInTheDocument();
    // Usage events still visible.
    expect(screen.getByText("TOOL CALL")).toBeInTheDocument();
    expect(screen.getByText("RESOURCE READ")).toBeInTheDocument();
    expect(screen.getByText("PROMPT FETCHED")).toBeInTheDocument();
  });

  it("shows discovery events when preference is on", () => {
    localStorage.setItem("flightdeck.feed.showDiscoveryEvents", "true");
    render(<LiveFeed events={mixedEvents} onEventClick={() => {}} />);
    // All 7 visible.
    expect(screen.getAllByTestId("feed-row")).toHaveLength(7);
    expect(screen.getByText("TOOLS DISCOVERED")).toBeInTheDocument();
    expect(screen.getByText("RESOURCES DISCOVERED")).toBeInTheDocument();
    expect(screen.getByText("PROMPTS DISCOVERED")).toBeInTheDocument();
  });

  it("count reflects visible-events rule when MCP filter is active and discovery is off", () => {
    render(
      <LiveFeed
        events={mixedEvents}
        onEventClick={() => {}}
        activeFilter="MCP"
      />,
    );
    // Discovery hidden, MCP filter active → 3 use events visible
    // (call/read/get). Capped count = 6 visible MCP-or-not in feed
    // after discovery hide; "X of Y" reads "3 of 4" because the
    // session_start row is not in the MCP group.
    expect(screen.getByTestId("feed-count").textContent).toBe("3 of 4 events");
  });

  it("count reflects visible-events rule when MCP filter is active and discovery is on", () => {
    localStorage.setItem("flightdeck.feed.showDiscoveryEvents", "true");
    render(
      <LiveFeed
        events={mixedEvents}
        onEventClick={() => {}}
        activeFilter="MCP"
      />,
    );
    // All 7 events; 6 are MCP, 1 is session_start → "6 of 7".
    expect(screen.getByTestId("feed-count").textContent).toBe("6 of 7 events");
  });

  it("discovery filter applies BEFORE the FEED_MAX_EVENTS cap", () => {
    // 600 events: 300 discovery (mcp_tool_list) + 300 usage
    // (mcp_tool_call). Discovery hidden → 300 usage events stay
    // within the 500 cap, so all 300 should render.
    const burst: FeedEvent[] = Array.from({ length: 600 }, (_, i) => {
      const isDiscovery = i % 2 === 0;
      return makeFeedEvent(
        {
          id: `e${i}`,
          event_type: isDiscovery ? "mcp_tool_list" : "mcp_tool_call",
          model: null,
          tokens_total: null,
          latency_ms: null,
          tool_name: isDiscovery ? null : "echo",
        },
        1000 + i,
      );
    });
    render(<LiveFeed events={burst} onEventClick={() => {}} />);
    // 300 visible after discovery hide; cap is 500 so all 300 show.
    expect(screen.getByTestId("feed-count").textContent).toContain("300 events");
    // No discovery rows.
    expect(screen.queryByText("TOOLS DISCOVERED")).not.toBeInTheDocument();
  });
});
