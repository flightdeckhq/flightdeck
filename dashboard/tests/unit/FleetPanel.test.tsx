import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { FleetPanel } from "@/components/fleet/FleetPanel";
import type { FlavorSummary } from "@/lib/types";

vi.mock("@/lib/api", () => ({
  createDirective: vi.fn(() => Promise.resolve({ id: "dir-1" })),
}));

import { createDirective } from "@/lib/api";

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

const inactiveFlavors: FlavorSummary[] = [
  {
    flavor: "batch-agent",
    agent_type: "batch",
    session_count: 1,
    active_count: 0,
    tokens_used_total: 500,
    sessions: [
      { session_id: "s4", flavor: "batch-agent", agent_type: "batch", host: null, framework: null, model: null, state: "closed", started_at: "", last_seen_at: "", ended_at: "", tokens_used: 500, token_limit: null },
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

  it("does not show Stop All when no active sessions", () => {
    render(<FleetPanel flavors={inactiveFlavors} />);
    expect(screen.queryByText("Stop All")).not.toBeInTheDocument();
  });

  it("shows Stop All when flavor has active sessions", () => {
    render(<FleetPanel flavors={mockFlavors} />);
    expect(screen.getByText("Stop All")).toBeInTheDocument();
  });

  it("opens confirmation dialog on Stop All click", () => {
    render(<FleetPanel flavors={mockFlavors} />);
    fireEvent.click(screen.getByText("Stop All"));
    expect(
      screen.getByText("Stop all sessions of research-agent?")
    ).toBeInTheDocument();
    expect(screen.getByText(/2 active agents/)).toBeInTheDocument();
  });

  it("calls createDirective with correct payload on confirm", async () => {
    render(<FleetPanel flavors={mockFlavors} />);
    fireEvent.click(screen.getByText("Stop All"));
    // Click the confirm button in the dialog
    const buttons = screen.getAllByText("Stop All");
    const confirmBtn = buttons[buttons.length - 1];
    fireEvent.click(confirmBtn);
    await waitFor(() => {
      expect(createDirective).toHaveBeenCalledWith({
        action: "shutdown_flavor",
        flavor: "research-agent",
        reason: "manual_fleet_kill",
        grace_period_ms: 5000,
      });
    });
  });
});
