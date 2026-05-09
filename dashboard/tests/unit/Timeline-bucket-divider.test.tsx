// Bucket-divider behaviour in the SwimLane parent-child stack. Two
// regressions surfaced together on PR #33:
//
// 1. **Spurious dividers within parent-child clusters.** A LIVE parent
//    with a RECENT-bucket child (closed sub-agent) had a horizontal
//    divider inserted between them by Timeline's bucket-transition
//    loop. The divider should mark cluster boundaries, not split a
//    parent off from its sub-agents.
//
// 2. **Duplicate React keys** when the same (prev → next) bucket
//    transition recurred across the list. Keys like
//    `bucket-live-to-recent` collided whenever multiple parent-child
//    clusters straddled the same boundary, producing the "dividers
//    accumulate, only clear on full page refresh" symptom on the
//    Fleet swimlane.
//
// Both fixes live in Timeline.tsx's bucket-divider IIFE: skip the
// divider on `topology === "child"` rows, don't update `prevBucket`
// on children, and pin the divider's key to the flavor it precedes
// so duplicate transitions can't collide.

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Timeline } from "@/components/timeline/Timeline";
import type { FlavorSummary } from "@/lib/types";

vi.mock("@/hooks/useSessionEvents", () => ({
  useSessionEvents: () => ({ events: [], loading: false }),
  attachmentsCache: new Map(),
  eventsCache: new Map(),
}));

function renderWithRouter(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

const NOW = Date.now();
const seconds = (n: number) => new Date(NOW - n * 1000).toISOString();
const minutes = (n: number) => seconds(n * 60);

// Build a parent flavor with one root session, plus N child flavors
// whose sessions point at the parent's session via parent_session_id.
// `childAge` controls how long ago each child's last_seen_at was so
// the bucket placement of children differs from the parent.
function buildClusteredFleet(
  parentLastSeen: string,
  childCount: number,
  childAge: string,
): FlavorSummary[] {
  const parentSessionId = "parent-session-uuid";
  const parent: FlavorSummary = {
    flavor: "parent-agent",
    agent_id: "parent-agent",
    agent_name: "parent-agent",
    agent_type: "production",
    session_count: 1,
    active_count: 1,
    tokens_used_total: 1000,
    last_seen_at: parentLastSeen,
    sessions: [
      {
        session_id: parentSessionId,
        flavor: "parent-agent",
        agent_type: "production",
        host: null,
        framework: null,
        model: null,
        state: "active",
        started_at: parentLastSeen,
        last_seen_at: parentLastSeen,
        ended_at: null,
        tokens_used: 1000,
        token_limit: null,
      },
    ],
  };
  const children: FlavorSummary[] = [];
  for (let i = 0; i < childCount; i++) {
    children.push({
      flavor: `child-agent-${i}`,
      agent_id: `child-agent-${i}`,
      agent_name: `child-agent-${i}`,
      agent_type: "production",
      session_count: 1,
      active_count: 0,
      tokens_used_total: 100,
      last_seen_at: childAge,
      sessions: [
        {
          session_id: `child-session-${i}`,
          flavor: `child-agent-${i}`,
          agent_type: "production",
          host: null,
          framework: null,
          model: null,
          state: "closed",
          started_at: childAge,
          last_seen_at: childAge,
          ended_at: childAge,
          tokens_used: 100,
          token_limit: null,
          parent_session_id: parentSessionId,
        },
      ],
    });
  }
  return [parent, ...children];
}

const defaultProps = {
  timeRange: "5m" as const,
  expandedFlavors: new Set<string>(),
  onExpandFlavor: vi.fn(),
  onNodeClick: vi.fn(),
};

describe("Timeline bucket dividers — parent-child cluster integrity", () => {
  it("renders no bucket-divider between a LIVE parent and its RECENT-bucket sub-agent", () => {
    // Parent in LIVE bucket (5s ago); child in RECENT bucket (2 min ago).
    // Pre-fix the loop saw the bucket transition mid-cluster and
    // injected a horizontal line. Post-fix children inherit their
    // parent's cluster scope so no divider appears.
    const flavors = buildClusteredFleet(seconds(5), 1, minutes(2));

    renderWithRouter(<Timeline {...defaultProps} flavors={flavors} />);

    // The divider is the cross-bucket transition. With one parent
    // and one child in different buckets, the pre-fix loop would
    // have rendered exactly one divider. Asserting zero confirms
    // the cluster reads as a single visual unit.
    const dividers = screen.queryAllByTestId(/bucket-divider-/);
    expect(dividers).toHaveLength(0);
  });

  it("renders no bucket-divider between a LIVE parent and FIVE RECENT-bucket sub-agents", () => {
    // Mirrors the supervisor's reported scenario: omria@Omri-PC with
    // 5 named sub-agents (qa-engineer, architect, python-principal,
    // go-principal, ts-principal) where the parent is active and
    // every child closed. Pre-fix this rendered five spurious
    // dividers (one between each parent-child boundary plus
    // between consecutive children if they crossed bucket lines).
    const flavors = buildClusteredFleet(seconds(5), 5, minutes(2));

    renderWithRouter(<Timeline {...defaultProps} flavors={flavors} />);

    const dividers = screen.queryAllByTestId(/bucket-divider-/);
    expect(dividers).toHaveLength(0);
  });

  it("still renders a bucket-divider between two unrelated root flavors crossing a bucket boundary", () => {
    // Counterpart: two LONE flavors (no parent_session_id linkage)
    // straddling the LIVE→RECENT boundary should still get the
    // divider — the fix narrows the suppression to
    // topology="child", not all rows.
    const live: FlavorSummary = {
      flavor: "live-lone",
      agent_id: "live-lone",
      agent_name: "live-lone",
      agent_type: "production",
      session_count: 1,
      active_count: 1,
      tokens_used_total: 0,
      last_seen_at: seconds(5),
      sessions: [
        {
          session_id: "live-session",
          flavor: "live-lone",
          agent_type: "production",
          host: null,
          framework: null,
          model: null,
          state: "active",
          started_at: seconds(5),
          last_seen_at: seconds(5),
          ended_at: null,
          tokens_used: 0,
          token_limit: null,
        },
      ],
    };
    const recent: FlavorSummary = {
      flavor: "recent-lone",
      agent_id: "recent-lone",
      agent_name: "recent-lone",
      agent_type: "production",
      session_count: 1,
      active_count: 0,
      tokens_used_total: 0,
      last_seen_at: minutes(2),
      sessions: [
        {
          session_id: "recent-session",
          flavor: "recent-lone",
          agent_type: "production",
          host: null,
          framework: null,
          model: null,
          state: "closed",
          started_at: minutes(2),
          last_seen_at: minutes(2),
          ended_at: minutes(2),
          tokens_used: 0,
          token_limit: null,
        },
      ],
    };

    renderWithRouter(<Timeline {...defaultProps} flavors={[live, recent]} />);

    const dividers = screen.queryAllByTestId(/bucket-divider-/);
    expect(dividers).toHaveLength(1);
  });

  it("emits unique React keys for repeated (prev → next) bucket transitions across the list", () => {
    // The legacy key `bucket-${prev}-to-${next}` collided whenever
    // the same transition pair recurred. The post-fix key uses
    // `bucket-divider-before-${flavor}` which is globally unique
    // by the flavor name being a fleet-wide unique identifier.
    //
    // Build a list with TWO independent live→recent transitions:
    //   liveA, recentA, liveB, recentB
    // Each transition emits its own divider; both must coexist in
    // the rendered DOM (pre-fix React deduped by colliding keys).
    const liveA: FlavorSummary = {
      flavor: "live-A",
      agent_id: "live-A",
      agent_name: "live-A",
      agent_type: "production",
      session_count: 1,
      active_count: 1,
      tokens_used_total: 0,
      last_seen_at: seconds(5),
      sessions: [
        {
          session_id: "live-A-s",
          flavor: "live-A",
          agent_type: "production",
          host: null,
          framework: null,
          model: null,
          state: "active",
          started_at: seconds(5),
          last_seen_at: seconds(5),
          ended_at: null,
          tokens_used: 0,
          token_limit: null,
        },
      ],
    };
    const recentA: FlavorSummary = { ...liveA, flavor: "recent-A", agent_id: "recent-A", agent_name: "recent-A", last_seen_at: minutes(2), sessions: [{ ...liveA.sessions[0], session_id: "recent-A-s", flavor: "recent-A", state: "closed", last_seen_at: minutes(2), ended_at: minutes(2) }] };
    const liveB: FlavorSummary = { ...liveA, flavor: "live-B", agent_id: "live-B", agent_name: "live-B", last_seen_at: seconds(8), sessions: [{ ...liveA.sessions[0], session_id: "live-B-s", flavor: "live-B", last_seen_at: seconds(8), started_at: seconds(8) }] };
    const recentB: FlavorSummary = { ...liveA, flavor: "recent-B", agent_id: "recent-B", agent_name: "recent-B", last_seen_at: minutes(3), sessions: [{ ...liveA.sessions[0], session_id: "recent-B-s", flavor: "recent-B", state: "closed", last_seen_at: minutes(3), ended_at: minutes(3) }] };

    renderWithRouter(
      <Timeline {...defaultProps} flavors={[liveA, recentA, liveB, recentB]} />,
    );

    // Two separate live→recent transitions plus one recent→live in
    // between (recentA → liveB). Three dividers in total. Pre-fix
    // the two live→recent dividers shared a key and React dropped
    // one silently; post-fix all three coexist.
    const dividers = screen.queryAllByTestId(/bucket-divider-/);
    expect(dividers).toHaveLength(3);
  });
});
