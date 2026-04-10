import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Timeline } from "@/components/timeline/Timeline";
import { TIMELINE_WIDTH_PX } from "@/lib/constants";
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

  // ---- Fixed timeline width ----

  it("TIMELINE_WIDTH_PX is 900", () => {
    expect(TIMELINE_WIDTH_PX).toBe(900);
  });

  it("scroll container clips both axes without becoming a scroll container", () => {
    render(<Timeline {...defaultProps} timeRange="1h" />);
    const scrollEl = screen.getByTestId("timeline-scroll");
    // overflow-x: hidden clips circles that extend past the right
    // edge of the fixed-width canvas.
    expect(scrollEl.style.overflowX).toBe("hidden");
    // overflow-y: clip (NOT hidden) does not create a scroll
    // container, so the sticky time axis stays pinned against
    // Fleet.tsx's outer vertical scroller as flavor rows scroll past.
    expect(scrollEl.style.overflowY).toBe("clip");
  });

  // ---- Relative time axis labels ----

  it("time axis renders exactly 6 labels at 5m", () => {
    const { container } = render(<Timeline {...defaultProps} timeRange="5m" />);
    // Find labels inside the time axis row (h-7 sibling div with the
    // relative class). Match all the absolute font-mono text spans.
    const labels = container.querySelectorAll(
      ".h-7 span.absolute.font-mono.text-\\[11px\\]",
    );
    expect(labels).toHaveLength(6);
  });

  it("rightmost time axis label is 'now'", () => {
    render(<Timeline {...defaultProps} timeRange="5m" />);
    expect(screen.getByTestId("axis-label-now")).toHaveTextContent("now");
  });

  it("leftmost label at 5m shows '5m'", () => {
    const { container } = render(<Timeline {...defaultProps} timeRange="5m" />);
    const labels = container.querySelectorAll(
      ".h-7 span.absolute.font-mono.text-\\[11px\\]",
    );
    expect(labels[0]).toHaveTextContent("5m");
  });

  it("leftmost label at 1m is '1m' and middle labels use 's' suffix", () => {
    const { container } = render(<Timeline {...defaultProps} timeRange="1m" />);
    const labels = container.querySelectorAll(
      ".h-7 span.absolute.font-mono.text-\\[11px\\]",
    );
    // formatRelativeLabel(60_000) returns "1m" because 60 < 60 is false.
    // Either "60s" or "1m" is acceptable per the spec; we get "1m".
    expect(labels[0].textContent).toMatch(/^(60s|1m)$/);
    // Middle labels (i=1..4) should all be in seconds at 1m (48s, 36s, 24s, 12s)
    for (let i = 1; i < labels.length - 1; i++) {
      expect(labels[i].textContent).toMatch(/^\d+s$/);
    }
  });

  it("paused timeline shows 'paused' instead of 'now'", () => {
    render(
      <Timeline
        {...defaultProps}
        timeRange="5m"
        paused
        pausedAt={new Date()}
      />,
    );
    expect(screen.getByTestId("axis-label-paused")).toHaveTextContent("paused");
    expect(screen.queryByTestId("axis-label-now")).toBeNull();
  });
});
