import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { FleetPanel } from "@/components/fleet/FleetPanel";
import type { FlavorSummary } from "@/lib/types";

const mockFlavors: FlavorSummary[] = [
  {
    flavor: "research-agent",
    agent_type: "autonomous",
    session_count: 3,
    active_count: 2,
    tokens_used_total: 10000,
    sessions: [
      { session_id: "s1", flavor: "research-agent", agent_type: "autonomous", host: null, framework: null, model: null, state: "active", started_at: "", last_seen_at: "", ended_at: null, tokens_used: 5000, token_limit: null },
      { session_id: "s2", flavor: "research-agent", agent_type: "autonomous", host: null, framework: null, model: null, state: "active", started_at: "", last_seen_at: "", ended_at: null, tokens_used: 3000, token_limit: null },
      { session_id: "s3", flavor: "research-agent", agent_type: "autonomous", host: null, framework: null, model: null, state: "closed", started_at: "", last_seen_at: "", ended_at: "", tokens_used: 2000, token_limit: null },
    ],
  },
];

describe("FleetPanel", () => {
  it("renders correct active session count", () => {
    render(<FleetPanel flavors={mockFlavors} />);
    expect(screen.getByText("2")).toBeInTheDocument(); // active count
  });

  it("renders all five state labels in session state bar", () => {
    render(<FleetPanel flavors={mockFlavors} />);
    expect(screen.getByText("2 active")).toBeInTheDocument();
    expect(screen.getByText("0 idle")).toBeInTheDocument();
    expect(screen.getByText("0 stale")).toBeInTheDocument();
    expect(screen.getByText("1 closed")).toBeInTheDocument();
    expect(screen.getByText("0 lost")).toBeInTheDocument();
  });
});
