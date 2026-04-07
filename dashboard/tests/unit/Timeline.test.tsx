import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
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
});
