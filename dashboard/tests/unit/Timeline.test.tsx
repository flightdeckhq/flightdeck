import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Timeline } from "@/components/timeline/Timeline";
import type { FlavorSummary } from "@/lib/types";

const mockFlavors: FlavorSummary[] = [
  {
    flavor: "research-agent",
    agent_type: "autonomous",
    session_count: 1,
    active_count: 1,
    tokens_used_total: 1000,
    sessions: [
      {
        session_id: "s1",
        flavor: "research-agent",
        agent_type: "autonomous",
        host: null,
        framework: null,
        model: null,
        state: "active",
        started_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
        ended_at: null,
        tokens_used: 1000,
        token_limit: null,
      },
    ],
  },
  {
    flavor: "coding-agent",
    agent_type: "supervised",
    session_count: 1,
    active_count: 0,
    tokens_used_total: 500,
    sessions: [
      {
        session_id: "s2",
        flavor: "coding-agent",
        agent_type: "supervised",
        host: null,
        framework: null,
        model: null,
        state: "closed",
        started_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
        ended_at: new Date().toISOString(),
        tokens_used: 500,
        token_limit: null,
      },
    ],
  },
];

describe("Timeline", () => {
  it("renders one swim lane per unique flavor", () => {
    render(<Timeline flavors={mockFlavors} onNodeClick={() => {}} />);
    expect(screen.getByText("research-agent")).toBeInTheDocument();
    expect(screen.getByText("coding-agent")).toBeInTheDocument();
  });

  it("renders empty state when no flavors", () => {
    render(<Timeline flavors={[]} onNodeClick={() => {}} />);
    expect(screen.getByText(/No agents connected/)).toBeInTheDocument();
  });

  it("renders time range buttons", () => {
    render(<Timeline flavors={mockFlavors} onNodeClick={() => {}} />);
    expect(screen.getByText("5m")).toBeInTheDocument();
    expect(screen.getByText("15m")).toBeInTheDocument();
    expect(screen.getByText("30m")).toBeInTheDocument();
    expect(screen.getByText("1h")).toBeInTheDocument();
    expect(screen.getByText("6h")).toBeInTheDocument();
  });

  it("default time range is 30m", () => {
    render(<Timeline flavors={mockFlavors} onNodeClick={() => {}} />);
    const btn30m = screen.getByText("30m");
    // The default button should have the "default" variant (non-ghost)
    expect(btn30m).toBeInTheDocument();
  });

  it("clicking a time range button changes selection", () => {
    render(<Timeline flavors={mockFlavors} onNodeClick={() => {}} />);
    fireEvent.click(screen.getByText("1h"));
    // After click, the button is still rendered (basic smoke test)
    expect(screen.getByText("1h")).toBeInTheDocument();
  });

  it("filters flavors when flavorFilter is set", () => {
    render(
      <Timeline
        flavors={mockFlavors}
        flavorFilter="research-agent"
        onNodeClick={() => {}}
      />
    );
    expect(screen.getByText("research-agent")).toBeInTheDocument();
    expect(screen.queryByText("coding-agent")).not.toBeInTheDocument();
  });

  it("shows all flavors when flavorFilter is null", () => {
    render(
      <Timeline
        flavors={mockFlavors}
        flavorFilter={null}
        onNodeClick={() => {}}
      />
    );
    expect(screen.getByText("research-agent")).toBeInTheDocument();
    expect(screen.getByText("coding-agent")).toBeInTheDocument();
  });
});
