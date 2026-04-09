import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Timeline } from "@/components/timeline/Timeline";
import type { FlavorSummary } from "@/lib/types";

// Mock useSessionEvents to avoid real API calls
vi.mock("@/hooks/useSessionEvents", () => ({
  useSessionEvents: () => ({ events: [], loading: false }),
}));

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

const defaultProps = {
  flavors: mockFlavors,
  viewMode: "swimlane" as const,
  timeRange: "5m" as const,
  expandedFlavor: null as string | null,
  onExpandFlavor: vi.fn(),
  onNodeClick: vi.fn(),
};

describe("Timeline", () => {
  it("renders one flavor row per unique flavor", () => {
    render(<Timeline {...defaultProps} />);
    expect(screen.getByText("research-agent")).toBeInTheDocument();
    expect(screen.getByText("coding-agent")).toBeInTheDocument();
  });

  it("renders empty state when no flavors", () => {
    render(<Timeline {...defaultProps} flavors={[]} />);
    expect(screen.getByText(/No agents connected/)).toBeInTheDocument();
  });

  it("filters flavors when flavorFilter is set", () => {
    render(<Timeline {...defaultProps} flavorFilter="research-agent" />);
    expect(screen.getByText("research-agent")).toBeInTheDocument();
    expect(screen.queryByText("coding-agent")).not.toBeInTheDocument();
  });

  it("shows all flavors when flavorFilter is null", () => {
    render(<Timeline {...defaultProps} flavorFilter={null} />);
    expect(screen.getByText("research-agent")).toBeInTheDocument();
    expect(screen.getByText("coding-agent")).toBeInTheDocument();
  });

  it("flavor row click calls onExpandFlavor", () => {
    const onExpandFlavor = vi.fn();
    render(<Timeline {...defaultProps} onExpandFlavor={onExpandFlavor} />);
    // Click the flavor header row (contains flavor name)
    fireEvent.click(screen.getByText("research-agent").closest("[class*='cursor-pointer']")!);
    expect(onExpandFlavor).toHaveBeenCalledWith("research-agent");
  });

  it("expanded flavor shows session sub-rows", () => {
    render(
      <Timeline {...defaultProps} expandedFlavor="research-agent" />
    );
    // Session ID truncated to 8 chars should be visible
    expect(screen.getByText("s1")).toBeInTheDocument();
  });

  it("shows active count in flavor row", () => {
    render(<Timeline {...defaultProps} />);
    expect(screen.getByText("1 active")).toBeInTheDocument();
  });
});
