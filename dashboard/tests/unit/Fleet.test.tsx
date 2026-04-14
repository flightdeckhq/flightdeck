import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { scaleTime } from "d3-scale";
import { sortFlavorsByActivity } from "@/pages/Fleet";
import type { ViewMode } from "@/pages/Fleet";
import { SwimLane } from "@/components/timeline/SwimLane";
import type { FlavorSummary, Session, SessionState } from "@/lib/types";

vi.mock("@/hooks/useSessionEvents", () => ({
  useSessionEvents: () => ({ events: [], loading: false }),
  attachmentsCache: new Map(),
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

  it("recently-closed flavor stays above older-closed during 60s grace", () => {
    // Two fully-closed flavors. "z-recent" closed 10s ago; "a-old"
    // closed 2 minutes ago. Even though "a-old" sorts first
    // alphabetically, the grace period floats "z-recent" above it.
    const now = Date.UTC(2026, 3, 13, 12, 0, 0);
    const recent = makeSession("r", "closed", "z-recent");
    recent.ended_at = new Date(now - 10_000).toISOString();
    const old = makeSession("o", "closed", "a-old");
    old.ended_at = new Date(now - 120_000).toISOString();
    const sorted = sortFlavorsByActivity(
      [makeFlavor("a-old", [old]), makeFlavor("z-recent", [recent])],
      now,
    );
    expect(sorted.map((f) => f.flavor)).toEqual(["z-recent", "a-old"]);
  });

  it("two flavors closed within the grace window order by most-recent first", () => {
    const now = Date.UTC(2026, 3, 13, 12, 0, 0);
    const a = makeSession("a", "closed", "alpha");
    a.ended_at = new Date(now - 5_000).toISOString();
    const b = makeSession("b", "closed", "beta");
    b.ended_at = new Date(now - 40_000).toISOString();
    const sorted = sortFlavorsByActivity(
      [makeFlavor("alpha", [a]), makeFlavor("beta", [b])],
      now,
    );
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

// SwimLane rendering for closed/stale flavors. The previous compact
// 28px branch was removed -- closed sessions still have historical
// events that platform engineers need to see. Every flavor renders
// at full 48px with a chevron and full event circles. The state
// suffix ("(closed)" / "(stale)" / "(lost)") appears next to the
// flavor name when no sessions are active or idle.
describe("SwimLane state suffix", () => {
  const scale = scaleTime()
    .domain([new Date(Date.now() - 60_000), new Date()])
    .range([0, 900]);
  const baseProps = {
    scale,
    onSessionClick: vi.fn(),
    expanded: false,
    onToggleExpand: vi.fn(),
    timelineWidth: 900,
    leftPanelWidth: 320,
    activeFilter: null,
    sessionVersions: {},
  };

  it("never renders the compact inactive row anymore", () => {
    const flavor = "all-stale";
    const sessions = [
      makeSession("s1", "stale", flavor),
      makeSession("s2", "stale", flavor),
    ];
    render(
      <SwimLane
        flavor={flavor}
        sessions={sessions}
        {...baseProps}
      />,
    );
    // The compact 28px placeholder branch is removed.
    expect(screen.queryByTestId("swimlane-inactive")).toBeNull();
  });

  it("shows the (stale) suffix when all sessions are stale", () => {
    const flavor = "all-stale";
    const sessions = [makeSession("s1", "stale", flavor)];
    render(
      <SwimLane
        flavor={flavor}
        sessions={sessions}
        {...baseProps}
      />,
    );
    const suffix = screen.getByTestId("swimlane-state-suffix");
    expect(suffix).toHaveTextContent("(stale)");
  });

  it("shows the (closed) suffix when all sessions are closed", () => {
    const flavor = "all-closed";
    const sessions = [
      makeSession("s1", "closed", flavor),
      makeSession("s2", "closed", flavor),
    ];
    render(
      <SwimLane
        flavor={flavor}
        sessions={sessions}
        {...baseProps}
      />,
    );
    const suffix = screen.getByTestId("swimlane-state-suffix");
    expect(suffix).toHaveTextContent("(closed)");
  });

  it("a closed flavor still has the expand chevron and full row", () => {
    const flavor = "all-closed";
    const sessions = [makeSession("s1", "closed", flavor)];
    const { container } = render(
      <SwimLane
        flavor={flavor}
        sessions={sessions}
        {...baseProps}
      />,
    );
    // Chevron is present (the row is fully rendered, expandable)
    expect(container.querySelector("svg.lucide-chevron-right")).not.toBeNull();
    // The 48px header has its "0 active" count
    expect(screen.getByText("0 active")).toBeInTheDocument();
  });

  it("an idle-only flavor renders without a state suffix and counts as live", () => {
    // Idle agents are alive -- liveCount includes idle, so the
    // display shows "1 active" in green even though the upstream
    // active_count is 0.
    const flavor = "all-idle";
    const sessions = [makeSession("s1", "idle", flavor)];
    render(
      <SwimLane
        flavor={flavor}
        sessions={sessions}
        {...baseProps}
      />,
    );
    expect(screen.queryByTestId("swimlane-state-suffix")).toBeNull();
    const count = screen.getByTestId("swimlane-active-count");
    expect(count).toHaveTextContent("1 active");
    // Green when liveCount > 0
    expect(count).toHaveStyle({ color: "var(--status-active)" });
  });

  it("a closed flavor shows '0 active' in muted gray", () => {
    const flavor = "all-closed";
    const sessions = [makeSession("s1", "closed", flavor)];
    render(
      <SwimLane
        flavor={flavor}
        sessions={sessions}
        {...baseProps}
      />,
    );
    const count = screen.getByTestId("swimlane-active-count");
    expect(count).toHaveTextContent("0 active");
    expect(count).toHaveStyle({ color: "var(--text-muted)" });
  });

  it("an active flavor renders without a state suffix", () => {
    const flavor = "all-active";
    const sessions = [makeSession("s1", "active", flavor)];
    render(
      <SwimLane
        flavor={flavor}
        sessions={sessions}
        {...baseProps}
      />,
    );
    expect(screen.queryByTestId("swimlane-state-suffix")).toBeNull();
  });
});

// Context filter behaviour: non-matching sessions are HIDDEN from
// the expanded swimlane entirely (not dimmed to 0.15 opacity as the
// previous implementation did). The filter status bar in Fleet.tsx
// is the primary signal that filtering is active, so dimming ghost
// rows inside the swimlane no longer pulls its weight.
describe("SwimLane context filter", () => {
  const scale = scaleTime()
    .domain([new Date(Date.now() - 60_000), new Date()])
    .range([0, 900]);
  const baseProps = {
    scale,
    onSessionClick: vi.fn(),
    expanded: true,
    onToggleExpand: vi.fn(),
    timelineWidth: 900,
    leftPanelWidth: 320,
    activeFilter: null,
    sessionVersions: {},
  };

  it("renders every session when matchingSessionIds is null", () => {
    const flavor = "mixed";
    const sessions = [
      makeSession("s1", "active", flavor),
      makeSession("s2", "active", flavor),
      makeSession("s3", "active", flavor),
    ];
    render(
      <SwimLane
        flavor={flavor}
        sessions={sessions}
        {...baseProps}
        matchingSessionIds={null}
      />,
    );
    // All three hash labels appear.
    expect(screen.getAllByTestId("session-row-label").length).toBe(3);
  });

  it("hides sessions not in matchingSessionIds", () => {
    const flavor = "mixed";
    const sessions = [
      makeSession("s1", "active", flavor),
      makeSession("s2", "active", flavor),
      makeSession("s3", "active", flavor),
    ];
    render(
      <SwimLane
        flavor={flavor}
        sessions={sessions}
        {...baseProps}
        matchingSessionIds={new Set(["s1", "s3"])}
      />,
    );
    // Only the two matched sessions render; s2 is omitted entirely.
    const labels = screen.getAllByTestId("session-row-label");
    expect(labels.length).toBe(2);
    // The old dimmed-row testid must not appear anywhere -- the
    // previous dim-to-0.15 behaviour is gone.
    expect(screen.queryAllByTestId("session-row-dimmed").length).toBe(0);
  });

  it("renders nothing in the expanded area when no sessions match", () => {
    const flavor = "mixed";
    const sessions = [
      makeSession("s1", "active", flavor),
      makeSession("s2", "active", flavor),
    ];
    render(
      <SwimLane
        flavor={flavor}
        sessions={sessions}
        {...baseProps}
        matchingSessionIds={new Set(["s-other"])}
      />,
    );
    expect(screen.queryAllByTestId("session-row-label").length).toBe(0);
  });
});

// Bars view mode was removed in the April 2026 cleanup. At the fixed
// 900px canvas the histogram added no information beyond the swimlane
// dots. Lock that in at the type level so anyone re-introducing a
// "bars" variant trips this test immediately.
describe("ViewMode (Bars removal)", () => {
  it("ViewMode only accepts 'swimlane'", () => {
    const valid: ViewMode = "swimlane";
    expect(valid).toBe("swimlane");
    // The ViewMode type is a single-string literal now; any attempt
    // to re-add "bars" would widen the union and make this line
    // compile again without the @ts-expect-error, failing the test.
    // @ts-expect-error -- "bars" must NOT be assignable to ViewMode
    const invalid: ViewMode = "bars";
    // Runtime value is irrelevant; the guarantee is compile-time.
    expect(invalid).toBe("bars");
  });
});
