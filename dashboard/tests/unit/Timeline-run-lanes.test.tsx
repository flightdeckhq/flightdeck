import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { Timeline } from "@/components/timeline/Timeline";
import type { FlavorSummary, Session, SessionDetail } from "@/lib/types";
import { useFleetStore } from "@/store/fleet";
import { eventsCache } from "@/hooks/useSessionEvents";
import { createLaneViewport } from "@/lib/lane-viewport";

/** A lane viewport ``width`` px wide, scrolled to its start. */
function viewportOf(width: number) {
  const viewport = createLaneViewport();
  viewport.set({ width, scrollLeft: 0 });
  return viewport;
}
import {
  RUN_LANE_MAX_HEIGHT_PX,
  RUN_LANE_MIN_HEIGHT_PX,
} from "@/lib/run-lane-layout";

// The Timeline draws the rows it is told to expand as run lanes and
// sizes the lanes to the viewport it scrolls in: what the rest of its
// content leaves of the viewport's height, shared equally between the
// bounds. It reports that space, spans the headings over the visible row
// and keeps marker text to the part of the panels the viewport shows.
// It hands ``onExpandRuns`` to the compact rows, whose runs chip calls it.

const { fetchSession } = vi.hoisted(() => ({
  fetchSession: vi.fn<(id: string) => Promise<SessionDetail>>(),
}));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  fetchSession,
}));

const S = 1000;

let idSeq = 0;
function mkSession(overrides: Partial<Session> = {}): Session {
  idSeq += 1;
  const now = Date.now();
  return {
    session_id: `d${String(idSeq).padStart(7, "0")}-0000-4000-8000-000000000000`,
    flavor: "e2e",
    agent_type: "coding",
    host: null,
    framework: null,
    model: "claude-sonnet-4-5",
    state: "active",
    started_at: new Date(now - 30 * S).toISOString(),
    last_seen_at: new Date(now).toISOString(),
    ended_at: null,
    tokens_used: 0,
    token_limit: null,
    ...overrides,
  };
}

function mkFlavor(agentId: string, name: string, sessions: Session[]): FlavorSummary {
  return {
    flavor: agentId,
    agent_name: name,
    agent_type: "coding",
    session_count: sessions.length,
    active_count: sessions.length,
    tokens_used_total: 0,
    sessions,
  } as FlavorSummary;
}

// jsdom lays nothing out, so offsetHeight is stubbed: a run lane is as
// tall as its style says, and the Timeline's content is its lanes plus
// a fixed REST_PX for everything else (axis, ALL row, headings, rows).
const REST_PX = 150;
const originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");

function laneRows(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-run-lane-row]"));
}

beforeEach(() => {
  useFleetStore.setState({ flavors: [] });
  eventsCache.clear();
  fetchSession.mockReset();
  fetchSession.mockImplementation(() => new Promise<SessionDetail>(() => {}));
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      if (this.hasAttribute("data-run-lane-row")) return parseFloat(this.style.height) || 0;
      if (this.querySelector(":scope > [data-testid='timeline-grid-overlay']")) {
        let lanes = 0;
        for (const lane of this.querySelectorAll<HTMLElement>("[data-run-lane-row]")) {
          lanes += parseFloat(lane.style.height) || 0;
        }
        return REST_PX + lanes;
      }
      return 0;
    },
  });
});

afterEach(() => {
  if (originalOffsetHeight) {
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", originalOffsetHeight);
  }
});

function renderTimeline(
  flavors: FlavorSummary[],
  props: Partial<React.ComponentProps<typeof Timeline>> = {},
) {
  return render(
    <MemoryRouter>
      <Timeline flavors={flavors} timeRange="1m" onNodeClick={() => {}} {...props} />
    </MemoryRouter>,
  );
}

describe("Timeline run lanes", () => {
  it("draws the expanded agent as run lanes and every other agent as a compact row", () => {
    const lanesAgent = mkFlavor("agent-a", "lanes-agent", [mkSession(), mkSession()]);
    const compactAgent = mkFlavor("agent-b", "compact-agent", [mkSession(), mkSession()]);
    renderTimeline([lanesAgent, compactAgent], {
      expandedAgentIds: new Set(["agent-a"]),
      viewportHeight: 600, laneViewport: viewportOf(1536),
    });
    expect(screen.getByTestId("swimlane-agent-row-lanes-agent")).toHaveAttribute("data-run-lanes", "true");
    const compact = screen.getByTestId("swimlane-agent-row-compact-agent");
    expect(compact).not.toHaveAttribute("data-run-lanes");
    expect(compact.style.height).toBe("48px");
    expect(laneRows()).toHaveLength(2);
  });

  it("shares the space the rest of the content leaves equally between the lanes", () => {
    const agent = mkFlavor("agent-a", "lanes-agent", [mkSession(), mkSession(), mkSession()]);
    renderTimeline([agent], { expandedAgentIds: new Set(["agent-a"]), viewportHeight: 500, laneViewport: viewportOf(1536) });
    // (500 - 150) / 3 = 116.67: 116 px each, so the lanes end at the feed.
    expect(laneRows().map((l) => l.style.height)).toEqual(["116px", "116px", "116px"]);
  });

  it("stops a single run at the maximum", () => {
    const agent = mkFlavor("agent-a", "lanes-agent", [mkSession()]);
    renderTimeline([agent], { expandedAgentIds: new Set(["agent-a"]), viewportHeight: 800, laneViewport: viewportOf(1536) });
    expect(laneRows().map((l) => l.style.height)).toEqual([`${RUN_LANE_MAX_HEIGHT_PX}px`]);
  });

  it("keeps lanes at the minimum when they do not fit, for the viewport to scroll", () => {
    const agent = mkFlavor(
      "agent-a",
      "lanes-agent",
      Array.from({ length: 5 }, () => mkSession()),
    );
    renderTimeline([agent], { expandedAgentIds: new Set(["agent-a"]), viewportHeight: 250, laneViewport: viewportOf(1536) });
    expect(laneRows()).toHaveLength(5);
    for (const lane of laneRows()) expect(lane.style.height).toBe(`${RUN_LANE_MIN_HEIGHT_PX}px`);
  });

  it("re-sizes the lanes when the viewport changes", () => {
    const agent = mkFlavor("agent-a", "lanes-agent", [mkSession(), mkSession()]);
    const { rerender } = renderTimeline([agent], {
      expandedAgentIds: new Set(["agent-a"]),
      viewportHeight: 350, laneViewport: viewportOf(1536),
    });
    expect(laneRows().map((l) => l.style.height)).toEqual(["100px", "100px"]);
    rerender(
      <MemoryRouter>
        <Timeline
          flavors={[agent]}
          timeRange="1m"
          onNodeClick={() => {}}
          expandedAgentIds={new Set(["agent-a"])}
          viewportHeight={250}
          laneViewport={viewportOf(1536)}
        />
      </MemoryRouter>,
    );
    expect(laneRows().map((l) => l.style.height)).toEqual(["50px", "50px"]);
  });

  it("reports the first group's lanes and where its first lane starts", () => {
    // jsdom lays nothing out: the first lane starts 90 px below the
    // content's top, every other box at 0.
    const FIRST_LANE_TOP_PX = 90;
    const rect = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        const top =
          this.hasAttribute("data-run-lane-row") && this.getAttribute("data-lane-index") === "0"
            ? FIRST_LANE_TOP_PX
            : 0;
        return { top, bottom: top, left: 0, right: 0, width: 0, height: 0, x: 0, y: top, toJSON: () => ({}) };
      });
    const onRunLaneSpace = vi.fn();
    const agent = mkFlavor("agent-a", "lanes-agent", [mkSession(), mkSession(), mkSession()]);
    // A second group (a sub-agent's) below: its lanes scroll, so they are
    // not counted.
    const other = mkFlavor("agent-b", "other-agent", [mkSession(), mkSession()]);
    renderTimeline([agent, other], {
      expandedAgentIds: new Set(["agent-a", "agent-b"]),
      viewportHeight: 260, laneViewport: viewportOf(1024),
      onRunLaneSpace,
    });
    expect(laneRows()).toHaveLength(5);
    const firstGroup = document.querySelector('[data-run-lanes="true"]')!;
    expect(onRunLaneSpace).toHaveBeenLastCalledWith({
      laneCount: Number(firstGroup.getAttribute("data-lane-count")),
      topPx: FIRST_LANE_TOP_PX,
    });
    expect(Number(firstGroup.getAttribute("data-lane-count"))).toBeGreaterThan(1);
    rect.mockRestore();
  });

  it("draws every agent it is told to expand as its own group of lanes, sharing the space", () => {
    const parent = mkFlavor("agent-a", "lanes-agent", [mkSession(), mkSession()]);
    const child = mkFlavor("agent-b", "lanes-agent/worker", [mkSession()]);
    renderTimeline([parent, child], {
      expandedAgentIds: new Set(["agent-a", "agent-b"]),
      viewportHeight: 450, laneViewport: viewportOf(1536),
    });
    const groups = Array.from(document.querySelectorAll<HTMLElement>('[data-run-lanes="true"]'));
    expect(groups.map((g) => g.getAttribute("data-lane-count")).sort()).toEqual(["1", "2"]);
    // (450 - 150) / 3 lanes: 100 px each, whichever group a lane is in.
    expect(laneRows().map((l) => l.style.height)).toEqual(["100px", "100px", "100px"]);
  });

  it("spans the lane heading over the visible row", () => {
    const agent = mkFlavor("agent-a", "lanes-agent", [mkSession()]);
    const { rerender } = renderTimeline([agent], {
      expandedAgentIds: new Set(["agent-a"]),
      viewportHeight: 600, laneViewport: viewportOf(1024),
    });
    const strip = () =>
      screen.getByTestId("swimlane-run-lanes-heading").querySelector<HTMLElement>(".swimlane-row-label")!;
    expect(strip().style.width).toBe("1024px");
    // A viewport wider than the row: the heading is the row's width.
    rerender(
      <MemoryRouter>
        <Timeline
          flavors={[agent]}
          timeRange="1m"
          onNodeClick={() => {}}
          expandedAgentIds={new Set(["agent-a"])}
          viewportHeight={600}
          laneViewport={viewportOf(2000)}
        />
      </MemoryRouter>,
    );
    expect(strip().style.width).toBe(`${460 + 900}px`);
  });

  it("hands the runs chip of a compact row the agent to open", () => {
    const onExpandRuns = vi.fn();
    const agent = mkFlavor("agent-b", "busy-agent", [mkSession(), mkSession(), mkSession()]);
    renderTimeline([agent], { onExpandRuns });
    const chip = within(screen.getByTestId("swimlane-agent-row-busy-agent")).getByTestId(
      "swimlane-runs-chip",
    );
    expect(chip).toHaveTextContent("3 runs");
    fireEvent.click(chip);
    expect(onExpandRuns).toHaveBeenCalledWith("agent-b");
  });

  it("gives an expanded row no runs chip", () => {
    const agent = mkFlavor("agent-a", "lanes-agent", [mkSession(), mkSession(), mkSession()]);
    renderTimeline([agent], {
      expandedAgentIds: new Set(["agent-a"]),
      viewportHeight: 600, laneViewport: viewportOf(1536),
      onExpandRuns: () => {},
    });
    expect(screen.queryByTestId("swimlane-runs-chip")).toBeNull();
  });
});
