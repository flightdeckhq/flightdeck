import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { FleetPanel } from "@/components/fleet/FleetPanel";
import type { CustomDirective, FlavorSummary } from "@/lib/types";

vi.mock("@/lib/api", () => ({
  createDirective: vi.fn(() => Promise.resolve({ id: "dir-1" })),
  triggerCustomDirective: vi.fn(() => Promise.resolve()),
}));

// Mock the fleet store so FleetPanel's new `customDirectives`
// lookup works without spinning up the real Zustand store + API
// fetch. Tests that need a non-empty directive list mutate
// mockCustomDirectives before rendering.
let mockCustomDirectives: CustomDirective[] = [];
vi.mock("@/store/fleet", () => ({
  useFleetStore: (selector: (state: unknown) => unknown) =>
    selector({ customDirectives: mockCustomDirectives }),
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
  beforeEach(() => {
    mockCustomDirectives = [];
  });

  it("Custom Directives sidebar section is gone", () => {
    render(<FleetPanel flavors={mockFlavors} />);
    // The old child panel rendered under a "Custom Directives" card
    // title and included a dev-docs empty state. Both are gone now.
    expect(screen.queryByText("Custom Directives")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/No custom directives registered/),
    ).not.toBeInTheDocument();
  });

  it("Directive Activity header is hidden when directiveEvents is empty", () => {
    // Previously the header rendered with a muted "No directive
    // activity yet" empty state. The cleanup hides both the header
    // and the body when there's nothing to show.
    render(<FleetPanel flavors={mockFlavors} directiveEvents={[]} />);
    expect(
      screen.queryByTestId("directive-activity-header"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Directive Activity")).not.toBeInTheDocument();
  });

  it("Fleet Overview no longer shows a Tokens row", () => {
    render(<FleetPanel flavors={mockFlavors} />);
    expect(screen.queryByText("Tokens")).not.toBeInTheDocument();
  });

  it("renders correct active session count in session states", () => {
    render(<FleetPanel flavors={mockFlavors} />);
    const activeCount = screen.getByTestId("state-count-active");
    expect(activeCount).toHaveTextContent("2");
  });

  it("renders session state counts", () => {
    render(<FleetPanel flavors={mockFlavors} />);
    // State counts shown as numbers with labels below
    const activeCount = screen.getByTestId("state-count-active");
    expect(activeCount).toHaveTextContent("2");
    const closedCount = screen.getByTestId("state-count-closed");
    expect(closedCount).toHaveTextContent("1");
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

  it("calls onFlavorClick when flavor name is clicked", () => {
    const onFlavorClick = vi.fn();
    render(<FleetPanel flavors={mockFlavors} onFlavorClick={onFlavorClick} />);
    fireEvent.click(screen.getByText("research-agent"));
    expect(onFlavorClick).toHaveBeenCalledWith("research-agent");
  });

  it("shows filter indicator when activeFlavorFilter is set", () => {
    render(
      <FleetPanel
        flavors={mockFlavors}
        activeFlavorFilter="research-agent"
      />
    );
    expect(screen.getByText("(filtered)")).toBeInTheDocument();
  });

  it("does not show filter indicator when no filter active", () => {
    render(<FleetPanel flavors={mockFlavors} />);
    expect(screen.queryByText("(filtered)")).not.toBeInTheDocument();
  });

  // FIX 1 -- counts must update live when flavors prop changes
  it("session counts update when flavors prop changes", () => {
    const fiveActive: FlavorSummary[] = [
      {
        flavor: "research-agent",
        agent_type: "autonomous",
        session_count: 5,
        active_count: 5,
        tokens_used_total: 0,
        sessions: Array.from({ length: 5 }).map((_, i) => ({
          session_id: `s${i}`, flavor: "research-agent", agent_type: "autonomous",
          host: null, framework: null, model: null, state: "active" as const,
          started_at: "", last_seen_at: "", ended_at: null, tokens_used: 0, token_limit: null,
        })),
      },
    ];
    const { rerender } = render(<FleetPanel flavors={fiveActive} />);
    expect(screen.getByTestId("state-count-active")).toHaveTextContent("5");
    expect(screen.getByTestId("state-count-idle")).toHaveTextContent("0");

    // Transition 2 of the 5 sessions to idle and re-render with new
    // flavors prop -- counts must reflect 3 active / 2 idle without
    // remounting the component.
    const twoIdle: FlavorSummary[] = [
      {
        ...fiveActive[0],
        active_count: 3,
        sessions: fiveActive[0].sessions.map((s, i) =>
          i < 2 ? { ...s, state: "idle" as const } : s,
        ),
      },
    ];
    rerender(<FleetPanel flavors={twoIdle} />);
    expect(screen.getByTestId("state-count-active")).toHaveTextContent("3");
    expect(screen.getByTestId("state-count-idle")).toHaveTextContent("2");
  });

  // CONTEXT sidebar facet panel
  it("renders CONTEXT section when at least one facet has 2+ values", () => {
    render(
      <FleetPanel
        flavors={mockFlavors}
        contextFacets={{
          orchestration: [
            { value: "kubernetes", count: 3 },
            { value: "docker", count: 1 },
          ],
        }}
      />,
    );
    expect(screen.getByTestId("fleet-panel-context")).toBeInTheDocument();
    expect(screen.getByTestId("context-facet-orchestration")).toBeInTheDocument();
    expect(
      screen.getByTestId("context-value-orchestration-kubernetes"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("context-value-orchestration-docker"),
    ).toBeInTheDocument();
  });

  it("hides CONTEXT section when every facet has only one value", () => {
    // Single-value facets are useless as filters -- the section
    // should be omitted entirely (no header, no rows). This keeps
    // the sidebar clean for deployments where every agent runs in
    // the same orchestration / on the same host.
    render(
      <FleetPanel
        flavors={mockFlavors}
        contextFacets={{
          orchestration: [{ value: "kubernetes", count: 5 }],
          hostname: [{ value: "host-1", count: 5 }],
        }}
      />,
    );
    expect(screen.queryByTestId("fleet-panel-context")).not.toBeInTheDocument();
  });

  it("invokes onContextFilter when a facet value is clicked", () => {
    const onContextFilter = vi.fn();
    render(
      <FleetPanel
        flavors={mockFlavors}
        contextFacets={{
          orchestration: [
            { value: "kubernetes", count: 3 },
            { value: "docker", count: 1 },
          ],
        }}
        onContextFilter={onContextFilter}
      />,
    );
    fireEvent.click(screen.getByTestId("context-value-orchestration-kubernetes"));
    expect(onContextFilter).toHaveBeenCalledWith("orchestration", "kubernetes");
  });

  it("uses sessionStateCounts prop when provided", () => {
    // When the parent passes pre-computed counts, the bar reads them
    // directly rather than re-deriving from flavors. This is the
    // path Fleet.tsx uses to lift the computation up to where the
    // flavors state lives. (FIX 1)
    render(
      <FleetPanel
        flavors={inactiveFlavors}
        sessionStateCounts={{ active: 7, idle: 1, stale: 0, closed: 0, lost: 0 }}
      />,
    );
    expect(screen.getByTestId("state-count-active")).toHaveTextContent("7");
    expect(screen.getByTestId("state-count-idle")).toHaveTextContent("1");
  });
});
