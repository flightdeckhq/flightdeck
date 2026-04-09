import { describe, it, expect, vi } from "vitest";
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
  return { arrivedAt: arrivedAt ?? Date.now(), event: makeEvent(event) };
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
    expect(headers.textContent).toContain("Flavor");
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
