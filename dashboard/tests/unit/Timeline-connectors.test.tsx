import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { Timeline } from "@/components/timeline/Timeline";
import { useFleetStore } from "@/store/fleet";
import type { AgentEvent, FlavorSummary, Session } from "@/lib/types";

// Timeline's connector pass and its run-hover wiring, end to end
// inside one render. jsdom has no layout, so the rects the pass
// measures are stubbed: each circle (found by ``data-event-id``)
// gets a fixed box and every other element the container's box. The
// spec checks that the path is built from those measured circles,
// not from the time scale and the row's centre, and that hovering or
// focusing a run's mark lights exactly that run's connectors.

const NOW = Date.parse("2026-11-02T10:00:00Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

const { events, unrendered } = vi.hoisted(() => {
  const now = Date.parse("2026-11-02T10:00:00Z");
  const ev = (id: string, sessionId: string, msAgo: number) => ({
    id,
    session_id: sessionId,
    flavor: "e2e",
    event_type: "tool_call",
    occurred_at: new Date(now - msAgo).toISOString(),
    model: null,
    tokens_input: null,
    tokens_output: null,
    tokens_total: null,
    latency_ms: null,
    tool_name: "Agent",
    has_content: false,
    payload: null,
  });
  return {
    events: new Map([
      ["p-1", [ev("pe-1", "p-1", 120_000)]],
      ["c-1", [ev("ce-1", "c-1", 110_000)]],
      ["c-2", [ev("ce-2", "c-2", 105_000)]],
    ]),
    // Runs whose row draws no circles although the cache holds their
    // events (a row that has not re-rendered yet).
    unrendered: new Set<string>(),
  };
});

vi.mock("@/hooks/useSessionEvents", () => ({
  useSessionEvents: (sessionId: string) => ({
    events: unrendered.has(sessionId) ? [] : (events.get(sessionId) ?? []),
    loading: false,
  }),
  attachmentsCache: new Map(),
  eventsCache: events,
}));

function session(id: string, msAgo: number, parent?: string): Session {
  return {
    session_id: id,
    flavor: "e2e",
    agent_type: "coding",
    host: null,
    framework: null,
    model: null,
    state: "active",
    started_at: iso(msAgo),
    last_seen_at: iso(0),
    ended_at: null,
    tokens_used: 0,
    token_limit: null,
    parent_session_id: parent ?? null,
    agent_role: parent ? "worker" : null,
  };
}

const flavors: FlavorSummary[] = [
  {
    flavor: "agent-p",
    agent_id: "agent-p",
    agent_name: "u@h",
    agent_type: "coding",
    session_count: 1,
    active_count: 1,
    tokens_used_total: 0,
    sessions: [session("p-1", 130_000)],
  },
  {
    flavor: "agent-c",
    agent_id: "agent-c",
    agent_name: "u@h/worker",
    agent_type: "coding",
    session_count: 2,
    active_count: 2,
    tokens_used_total: 0,
    sessions: [session("c-1", 115_000, "p-1"), session("c-2", 108_000, "p-1")],
  },
];

type Box = { left: number; top: number; width: number; height: number };

// The parent's spawn circle is drawn hover-scaled (27.5 px box about
// the same centre) to show the radius comes from ``offsetWidth``.
const CIRCLES: Record<string, Box> = {
  "pe-1": { left: 611 - 13.75, top: 141 - 13.75, width: 27.5, height: 27.5 },
  "ce-1": { left: 640, top: 178, width: 22, height: 22 },
  "ce-2": { left: 700, top: 178, width: 22, height: 22 },
};
const CONTAINER: Box = { left: 0, top: 0, width: 1400, height: 600 };
const CIRCLE_SIZE = 22;

function rect(b: Box): DOMRect {
  return {
    ...b,
    x: b.left,
    y: b.top,
    right: b.left + b.width,
    bottom: b.top + b.height,
    toJSON: () => b,
  } as DOMRect;
}

beforeEach(() => {
  useFleetStore.setState({ flavors });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
    this: Element,
  ) {
    const id = this.getAttribute("data-event-id");
    return rect((id && CIRCLES[id]) || CONTAINER);
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.hasAttribute("data-event-id") ? CIRCLE_SIZE : 0;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderTimeline() {
  return render(
    <MemoryRouter>
      <Timeline
        flavors={flavors}
        timeRange="5m"
        onNodeClick={() => {}}
        effectiveNowMs={NOW}
      />
    </MemoryRouter>,
  );
}

function pathPoints(d: string): number[] {
  return d.replace(/[MQ]/g, " ").trim().split(/\s+/).map(Number);
}

function circleIn(agentId: string, eventId: string): HTMLElement {
  const row = document.querySelector(`[data-agent-id="${agentId}"]:not([data-virtualized])`);
  const el = row?.querySelector<HTMLElement>(`[data-event-id="${eventId}"]`);
  if (!el) throw new Error(`no circle ${eventId} in ${agentId}`);
  return el;
}

describe("Timeline sub-agent connectors", () => {
  it("start on the measured parent circle's rim and end on the measured child circle's centre", () => {
    renderTimeline();
    const path = screen.getByTestId("sub-agent-connector-p-1->c-1");
    const [sx, sy, , , ex, ey] = pathPoints(path.getAttribute("d") ?? "");
    // Child end: the centre of ce-1's box.
    expect(ex).toBeCloseTo(651, 6);
    expect(ey).toBeCloseTo(189, 6);
    // Parent start: on a circle of radius offsetWidth / 2 (11) about
    // the scaled box's centre (611, 141), not 13.75 from the scaled
    // box, aimed at the child.
    expect(Math.hypot(sx! - 611, sy! - 141)).toBeCloseTo(CIRCLE_SIZE / 2, 6);
    const dir = { x: 651 - 611, y: 189 - 141 };
    const len = Math.hypot(dir.x, dir.y);
    expect(sx).toBeCloseTo(611 + (dir.x / len) * 11, 6);
    expect(sy).toBeCloseTo(141 + (dir.y / len) * 11, 6);
  });

  it("names both runs and both events on each path", () => {
    renderTimeline();
    const path = screen.getByTestId("sub-agent-connector-p-1->c-2");
    expect(path.getAttribute("data-parent-session-id")).toBe("p-1");
    expect(path.getAttribute("data-child-session-id")).toBe("c-2");
    expect(path.getAttribute("data-parent-event-id")).toBe("pe-1");
    expect(path.getAttribute("data-child-event-id")).toBe("ce-2");
  });

  it("skips a pair whose circle is not mounted", () => {
    // The cache holds ce-2, but its row draws no circle for it: there
    // is nothing to measure, so that pair waits for the next pass.
    unrendered.add("c-2");
    try {
      renderTimeline();
      expect(screen.queryByTestId("sub-agent-connector-p-1->c-2")).toBeNull();
      expect(screen.getByTestId("sub-agent-connector-p-1->c-1")).toBeTruthy();
    } finally {
      unrendered.delete("c-2");
    }
  });

  it("draws nothing for a pair outside the window", () => {
    // At 1m every seeded event is older than the window.
    render(
      <MemoryRouter>
        <Timeline
          flavors={flavors}
          timeRange="1m"
          onNodeClick={() => {}}
          effectiveNowMs={NOW}
        />
      </MemoryRouter>,
    );
    expect(
      screen.getByTestId("sub-agent-connector-overlay").getAttribute("data-connector-count"),
    ).toBe("0");
  });
});

describe("Timeline run hover", () => {
  const lit = () => ({
    c1: screen.getByTestId("sub-agent-connector-p-1->c-1").getAttribute("data-hover"),
    c2: screen.getByTestId("sub-agent-connector-p-1->c-2").getAttribute("data-hover"),
  });

  it("hovering a child run's circle lights only that run's connector", () => {
    renderTimeline();
    expect(lit()).toEqual({ c1: "false", c2: "false" });
    fireEvent.mouseOver(circleIn("agent-c", "ce-1"));
    expect(lit()).toEqual({ c1: "true", c2: "false" });
    fireEvent.mouseOver(circleIn("agent-c", "ce-2"));
    expect(lit()).toEqual({ c1: "false", c2: "true" });
  });

  it("hovering the parent run's circle lights its whole fan-out", () => {
    renderTimeline();
    fireEvent.mouseOver(circleIn("agent-p", "pe-1"));
    expect(lit()).toEqual({ c1: "true", c2: "true" });
  });

  it("moving onto a non-mark or off the timeline clears the highlight", () => {
    const { container } = renderTimeline();
    fireEvent.mouseOver(circleIn("agent-p", "pe-1"));
    expect(lit()).toEqual({ c1: "true", c2: "true" });
    // Row chrome carries no run id.
    fireEvent.mouseOver(screen.getAllByTestId("swimlane-agent-name-link")[0]!);
    expect(lit()).toEqual({ c1: "false", c2: "false" });
    fireEvent.mouseOver(circleIn("agent-c", "ce-1"));
    expect(lit()).toEqual({ c1: "true", c2: "false" });
    const root = container.querySelector('[data-testid="timeline-scroll"] > div') as HTMLElement;
    fireEvent.mouseLeave(root);
    expect(lit()).toEqual({ c1: "false", c2: "false" });
  });

  it("focusing a run glyph lights that run's connector until it blurs", () => {
    renderTimeline();
    const glyph = screen.getByTestId("swimlane-run-bracket-start-c-2");
    act(() => glyph.focus());
    expect(lit()).toEqual({ c1: "false", c2: "true" });
    act(() => glyph.blur());
    expect(lit()).toEqual({ c1: "false", c2: "false" });
  });
});
