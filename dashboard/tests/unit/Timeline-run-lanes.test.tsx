import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { Timeline } from "@/components/timeline/Timeline";
import type { FlavorSummary, Session, SessionDetail } from "@/lib/types";
import { useFleetStore } from "@/store/fleet";
import { eventsCache } from "@/hooks/useSessionEvents";
import {
  RUN_LANE_MAX_HEIGHT_PX,
  RUN_LANE_MIN_HEIGHT_PX,
} from "@/lib/run-lane-layout";

// The Timeline draws the rows it is told to expand as run lanes and
// sizes the lanes to the viewport it scrolls in: what the rest of its
// content leaves of ``fillHeight``, shared equally between the bounds.
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
      fillHeight: 600,
    });
    expect(screen.getByTestId("swimlane-agent-row-lanes-agent")).toHaveAttribute("data-run-lanes", "true");
    const compact = screen.getByTestId("swimlane-agent-row-compact-agent");
    expect(compact).not.toHaveAttribute("data-run-lanes");
    expect(compact.style.height).toBe("48px");
    expect(laneRows()).toHaveLength(2);
  });

  it("shares the space the rest of the content leaves equally between the lanes", () => {
    const agent = mkFlavor("agent-a", "lanes-agent", [mkSession(), mkSession(), mkSession()]);
    renderTimeline([agent], { expandedAgentIds: new Set(["agent-a"]), fillHeight: 500 });
    // (500 - 150) / 3 = 116.67: 116 px each, so the lanes end at the feed.
    expect(laneRows().map((l) => l.style.height)).toEqual(["116px", "116px", "116px"]);
  });

  it("stops a single run at the maximum", () => {
    const agent = mkFlavor("agent-a", "lanes-agent", [mkSession()]);
    renderTimeline([agent], { expandedAgentIds: new Set(["agent-a"]), fillHeight: 800 });
    expect(laneRows().map((l) => l.style.height)).toEqual([`${RUN_LANE_MAX_HEIGHT_PX}px`]);
  });

  it("keeps lanes at the minimum when they do not fit, for the viewport to scroll", () => {
    const agent = mkFlavor(
      "agent-a",
      "lanes-agent",
      Array.from({ length: 5 }, () => mkSession()),
    );
    renderTimeline([agent], { expandedAgentIds: new Set(["agent-a"]), fillHeight: 250 });
    expect(laneRows()).toHaveLength(5);
    for (const lane of laneRows()) expect(lane.style.height).toBe(`${RUN_LANE_MIN_HEIGHT_PX}px`);
  });

  it("re-sizes the lanes when the viewport changes", () => {
    const agent = mkFlavor("agent-a", "lanes-agent", [mkSession(), mkSession()]);
    const { rerender } = renderTimeline([agent], {
      expandedAgentIds: new Set(["agent-a"]),
      fillHeight: 350,
    });
    expect(laneRows().map((l) => l.style.height)).toEqual(["100px", "100px"]);
    rerender(
      <MemoryRouter>
        <Timeline
          flavors={[agent]}
          timeRange="1m"
          onNodeClick={() => {}}
          expandedAgentIds={new Set(["agent-a"])}
          fillHeight={250}
        />
      </MemoryRouter>,
    );
    expect(laneRows().map((l) => l.style.height)).toEqual(["50px", "50px"]);
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
      fillHeight: 600,
      onExpandRuns: () => {},
    });
    expect(screen.queryByTestId("swimlane-runs-chip")).toBeNull();
  });
});
