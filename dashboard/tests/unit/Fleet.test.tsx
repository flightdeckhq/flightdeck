import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { scaleTime } from "d3-scale";
import { sortFlavorsByActivity } from "@/pages/Fleet";
import { SwimLane } from "@/components/timeline/SwimLane";
import type { FlavorSummary, Session, SessionState } from "@/lib/types";

vi.mock("@/hooks/useSessionEvents", () => ({
  useSessionEvents: () => ({ events: [], loading: false }),
}));

function makeSession(id: string, state: SessionState, flavor = "f"): Session {
  return {
    session_id: id,
    flavor,
    agent_type: "autonomous",
    host: null,
    framework: null,
    model: null,
    state,
    started_at: "",
    last_seen_at: "",
    ended_at: state === "closed" ? "" : null,
    tokens_used: 0,
    token_limit: null,
  };
}

function makeFlavor(name: string, sessions: Session[]): FlavorSummary {
  return {
    flavor: name,
    agent_type: "autonomous",
    session_count: sessions.length,
    active_count: sessions.filter((s) => s.state === "active").length,
    tokens_used_total: 0,
    sessions,
  };
}

// FIX 3 -- part A: sortFlavorsByActivity
describe("sortFlavorsByActivity", () => {
  it("active flavors sort before stale flavors regardless of name", () => {
    // Even though "B-stale" sorts before "Z-active" alphabetically,
    // the active flavor must come first because activity priority
    // dominates.
    const stale = makeFlavor("B-stale", [makeSession("s1", "stale", "B-stale")]);
    const active = makeFlavor("Z-active", [makeSession("s2", "active", "Z-active")]);
    const sorted = sortFlavorsByActivity([stale, active]);
    expect(sorted[0].flavor).toBe("Z-active");
    expect(sorted[1].flavor).toBe("B-stale");
  });

  it("orders all five priority buckets correctly", () => {
    const lost = makeFlavor("a-lost", [makeSession("1", "lost", "a-lost")]);
    const closed = makeFlavor("b-closed", [makeSession("2", "closed", "b-closed")]);
    const stale = makeFlavor("c-stale", [makeSession("3", "stale", "c-stale")]);
    const idle = makeFlavor("d-idle", [makeSession("4", "idle", "d-idle")]);
    const active = makeFlavor("e-active", [makeSession("5", "active", "e-active")]);
    const sorted = sortFlavorsByActivity([lost, closed, stale, idle, active]);
    expect(sorted.map((f) => f.flavor)).toEqual([
      "e-active",
      "d-idle",
      "c-stale",
      "a-lost",
      "b-closed",
    ]);
  });

  it("alphabetical secondary order within the same priority bucket", () => {
    const a = makeFlavor("alpha", [makeSession("1", "active", "alpha")]);
    const b = makeFlavor("beta", [makeSession("2", "active", "beta")]);
    const sorted = sortFlavorsByActivity([b, a]);
    expect(sorted.map((f) => f.flavor)).toEqual(["alpha", "beta"]);
  });

  it("an active session anywhere in the flavor wins the priority", () => {
    // Mixed flavor with one active + several closed sessions still
    // counts as an active flavor.
    const mixed = makeFlavor("mixed", [
      makeSession("1", "closed", "mixed"),
      makeSession("2", "closed", "mixed"),
      makeSession("3", "active", "mixed"),
    ]);
    const allStale = makeFlavor("only-stale", [makeSession("4", "stale", "only-stale")]);
    const sorted = sortFlavorsByActivity([allStale, mixed]);
    expect(sorted[0].flavor).toBe("mixed");
  });
});

// FIX 3 -- part B: SwimLane inactive compact rendering
describe("SwimLane inactive collapse", () => {
  const scale = scaleTime()
    .domain([new Date(Date.now() - 60_000), new Date()])
    .range([0, 900]);
  const baseProps = {
    scale,
    onSessionClick: vi.fn(),
    expanded: false,
    onToggleExpand: vi.fn(),
    viewMode: "swimlane" as const,
    start: new Date(Date.now() - 60_000),
    end: new Date(),
    width: 1140,
    activeFilter: null,
    sessionVersions: {},
  };

  it("renders 28px compact row when all sessions are stale", () => {
    const flavor = "all-stale";
    const sessions = [
      makeSession("s1", "stale", flavor),
      makeSession("s2", "stale", flavor),
    ];
    render(
      <SwimLane
        flavor={flavor}
        activeCount={0}
        sessions={sessions}
        {...baseProps}
      />,
    );
    const row = screen.getByTestId("swimlane-inactive");
    expect(row).toBeInTheDocument();
    expect((row as HTMLElement).style.height).toBe("28px");
  });

  it("inactive row shows the (stale) summary", () => {
    const flavor = "all-stale";
    const sessions = [makeSession("s1", "stale", flavor)];
    render(
      <SwimLane
        flavor={flavor}
        activeCount={0}
        sessions={sessions}
        {...baseProps}
      />,
    );
    expect(screen.getByText("(stale)")).toBeInTheDocument();
  });

  it("inactive row shows (closed) when all sessions closed", () => {
    const flavor = "all-closed";
    const sessions = [
      makeSession("s1", "closed", flavor),
      makeSession("s2", "closed", flavor),
    ];
    render(
      <SwimLane
        flavor={flavor}
        activeCount={0}
        sessions={sessions}
        {...baseProps}
      />,
    );
    expect(screen.getByText("(closed)")).toBeInTheDocument();
  });

  it("inactive row has no expand chevron", () => {
    const flavor = "all-stale";
    const sessions = [makeSession("s1", "stale", flavor)];
    const { container } = render(
      <SwimLane
        flavor={flavor}
        activeCount={0}
        sessions={sessions}
        {...baseProps}
      />,
    );
    // Active rows render a lucide ChevronRight; the inactive row
    // must not.
    expect(container.querySelector("svg.lucide-chevron-right")).toBeNull();
  });

  it("an idle-only flavor is NOT inactive (still shows full row)", () => {
    // Idle agents are alive -- they must remain fully visible.
    const flavor = "all-idle";
    const sessions = [makeSession("s1", "idle", flavor)];
    render(
      <SwimLane
        flavor={flavor}
        activeCount={0}
        sessions={sessions}
        {...baseProps}
      />,
    );
    expect(screen.queryByTestId("swimlane-inactive")).toBeNull();
    // The full 48px row is rendered with the chevron
    expect(screen.getByText("0 active")).toBeInTheDocument();
  });
});
