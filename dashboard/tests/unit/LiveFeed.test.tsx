import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { LiveFeed } from "@/components/fleet/LiveFeed";
import type { AgentEvent } from "@/lib/types";

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

const mockEvents: AgentEvent[] = [
  makeEvent({ id: "e1", event_type: "session_start", model: null, tokens_total: null, latency_ms: null }),
  makeEvent({ id: "e2", event_type: "post_call" }),
  makeEvent({ id: "e3", event_type: "tool_call", tool_name: "web_search", model: null, tokens_total: null }),
];

describe("LiveFeed", () => {
  it("renders event rows with correct badge text", () => {
    render(<LiveFeed events={mockEvents} onEventClick={() => {}} />);
    expect(screen.getByText("START")).toBeInTheDocument();
    expect(screen.getByText("LLM CALL")).toBeInTheDocument();
    expect(screen.getByText("TOOL")).toBeInTheDocument();
  });

  it("flavor column shows flavor name", () => {
    render(<LiveFeed events={mockEvents} onEventClick={() => {}} />);
    const flavorTexts = screen.getAllByText("research-agent");
    expect(flavorTexts.length).toBeGreaterThanOrEqual(1);
  });

  it("badge matches event type", () => {
    const events = [makeEvent({ id: "e1", event_type: "policy_warn", model: null })];
    render(<LiveFeed events={events} onEventClick={() => {}} />);
    expect(screen.getByText("WARN")).toBeInTheDocument();
  });

  it("new event appends (renders additional row)", () => {
    const { rerender } = render(
      <LiveFeed events={mockEvents.slice(0, 2)} onEventClick={() => {}} />
    );
    expect(screen.getAllByTestId("feed-row")).toHaveLength(2);

    rerender(<LiveFeed events={mockEvents} onEventClick={() => {}} />);
    expect(screen.getAllByTestId("feed-row")).toHaveLength(3);
  });

  it("pause button shows when live", () => {
    render(<LiveFeed events={mockEvents} onEventClick={() => {}} />);
    expect(screen.getByText("⏸ Pause")).toBeInTheDocument();
  });

  it("resume button shows when paused", () => {
    render(<LiveFeed events={mockEvents} onEventClick={() => {}} />);
    fireEvent.click(screen.getByTestId("feed-pause-btn"));
    expect(screen.getByText("▶ Resume")).toBeInTheDocument();
  });

  it("caps at 500 events", () => {
    const manyEvents = Array.from({ length: 501 }, (_, i) =>
      makeEvent({ id: `e${i}` })
    );
    render(<LiveFeed events={manyEvents} onEventClick={() => {}} />);
    expect(screen.getAllByTestId("feed-row")).toHaveLength(500);
  });

  it("row click calls onEventClick with correct event", () => {
    const onEventClick = vi.fn();
    render(<LiveFeed events={mockEvents} onEventClick={onEventClick} />);
    const rows = screen.getAllByTestId("feed-row");
    fireEvent.click(rows[1]);
    expect(onEventClick).toHaveBeenCalledWith(mockEvents[1]);
  });

  it("empty state shows waiting message", () => {
    render(<LiveFeed events={[]} onEventClick={() => {}} />);
    expect(screen.getByText("Waiting for events...")).toBeInTheDocument();
  });

  it("resize handle exists", () => {
    render(<LiveFeed events={mockEvents} onEventClick={() => {}} />);
    expect(screen.getByTestId("feed-resize-handle")).toBeInTheDocument();
  });

  it("filter hides non-matching events", () => {
    render(<LiveFeed events={mockEvents} onEventClick={() => {}} activeFilter="Tools" />);
    const rows = screen.getAllByTestId("feed-row");
    expect(rows).toHaveLength(1);
    expect(screen.getByText("TOOL")).toBeInTheDocument();
    expect(screen.queryByText("START")).not.toBeInTheDocument();
    expect(screen.queryByText("LLM CALL")).not.toBeInTheDocument();
  });

  it("column headers render", () => {
    render(<LiveFeed events={mockEvents} onEventClick={() => {}} />);
    const headers = screen.getByTestId("feed-column-headers");
    expect(headers).toBeInTheDocument();
    expect(headers.textContent).toContain("Flavor");
    expect(headers.textContent).toContain("Session");
    expect(headers.textContent).toContain("Type");
    expect(headers.textContent).toContain("Detail");
    expect(headers.textContent).toContain("Time");
  });

  it("session ID shows 8 chars", () => {
    const events = [makeEvent({ id: "e1", session_id: "abcdef1234567890" })];
    render(<LiveFeed events={events} onEventClick={() => {}} />);
    expect(screen.getByText("abcdef12")).toBeInTheDocument();
  });

  it("column header is not static positioned", () => {
    render(<LiveFeed events={mockEvents} onEventClick={() => {}} />);
    const headers = screen.getByTestId("feed-column-headers");
    expect(headers.style.position || headers.className).toContain("absolute");
  });

  it("filtered count shows N of M", () => {
    render(<LiveFeed events={mockEvents} onEventClick={() => {}} activeFilter="Tools" />);
    expect(screen.getByTestId("feed-count").textContent).toBe("1 of 3 events");
  });

  it("filter label in header", () => {
    render(<LiveFeed events={mockEvents} onEventClick={() => {}} activeFilter="Policy" />);
    expect(screen.getByTestId("feed-filter-label")).toBeInTheDocument();
  });

  it("filter label click clears filter", () => {
    const onFilterChange = vi.fn();
    render(<LiveFeed events={mockEvents} onEventClick={() => {}} activeFilter="Tools" onFilterChange={onFilterChange} />);
    fireEvent.click(screen.getByTestId("feed-filter-label"));
    expect(onFilterChange).toHaveBeenCalledWith(null);
  });
});
