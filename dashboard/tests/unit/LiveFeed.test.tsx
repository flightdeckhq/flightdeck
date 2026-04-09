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
});
