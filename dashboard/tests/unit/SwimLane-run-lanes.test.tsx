import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { scaleTime } from "d3-scale";
import type { AgentEvent, Session, SessionDetail } from "@/lib/types";
import { useFleetStore } from "@/store/fleet";
import { SwimLane } from "@/components/timeline/SwimLane";
import { eventsCache } from "@/hooks/useSessionEvents";
import { LANE_GEOMETRY, laneCentrePct } from "@/lib/swimlane-lanes";

// SwimLane splits a row into run lanes while runs overlap in the window:
// each run's circles move to its lane's centre at the lane count's size,
// its glyphs sit on that centre, and a line joins each run's marks. The
// real events cache feeds the circles.

const { fetchSession } = vi.hoisted(() => ({
  fetchSession: vi.fn<(id: string) => Promise<SessionDetail>>(),
}));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  fetchSession,
}));

const NOW = Date.parse("2026-11-02T10:00:00Z");
const S = 1000;
const MIN = 60 * S;

let idSeq = 0;
function nextId(prefix: string): string {
  idSeq += 1;
  return `${prefix}${String(idSeq).padStart(7, "0")}-0000-4000-8000-000000000000`.slice(0, 36);
}

function at(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

function mkSession(overrides: Partial<Session> & { session_id: string }): Session {
  return {
    flavor: "e2e",
    agent_type: "coding",
    host: null,
    framework: null,
    model: null,
    state: "active",
    started_at: at(-30 * S),
    last_seen_at: at(0),
    ended_at: null,
    tokens_used: 0,
    token_limit: null,
    ...overrides,
  };
}

function mkEvent(sessionId: string, eventType: string, offsetMs: number): AgentEvent {
  idSeq += 1;
  return {
    id: `evt-${idSeq}`,
    session_id: sessionId,
    flavor: "e2e",
    event_type: eventType as AgentEvent["event_type"],
    model: null,
    tokens_input: null,
    tokens_output: null,
    tokens_total: null,
    latency_ms: null,
    tool_name: null,
    has_content: false,
    framework: null,
    client_type: null,
    agent_type: null,
    occurred_at: new Date(NOW + offsetMs).toISOString(),
  };
}

/** ``n`` open runs started together 30 s ago, each with one tool call
 *  20 s ago in the cache. Ids sort in creation order. */
function fanOut(n: number): Session[] {
  return Array.from({ length: n }, () => {
    const session = mkSession({ session_id: nextId("f") });
    eventsCache.set(session.session_id, [mkEvent(session.session_id, "tool_call", -20 * S)]);
    return session;
  });
}

function renderRow(sessions: Session[], rangeMs: number) {
  const scale = scaleTime()
    .domain([new Date(NOW - rangeMs), new Date(NOW)])
    .range([0, 900]);
  return render(
    <MemoryRouter>
      <SwimLane
        flavor="agent-row"
        agentName="row"
        agentType="coding"
        sessions={sessions}
        scale={scale}
        onSessionClick={() => {}}
        timelineWidth={900}
        leftPanelWidth={460}
      />
    </MemoryRouter>,
  );
}

function row() {
  return screen.getByTestId("swimlane-agent-row-row");
}

function circlesOf(sessionId: string): HTMLElement[] {
  return within(row()).queryAllByTestId(`session-circle-${sessionId}`);
}

function lineOf(sessionId: string): HTMLElement | null {
  return within(row()).queryByTestId(`swimlane-run-line-${sessionId.slice(0, 8)}`);
}

beforeEach(() => {
  useFleetStore.setState({ flavors: [] });
  fetchSession.mockReset();
  // A run's own history fetch never lands unless a test resolves it.
  fetchSession.mockImplementation(() => new Promise<SessionDetail>(() => {}));
});

describe("SwimLane run lanes", () => {
  it("counts the lanes on the row: one per run started together", () => {
    renderRow(fanOut(3), 5 * MIN);
    expect(row()).toHaveAttribute("data-lane-count", "3");
    expect(row()).not.toHaveAttribute("data-lane-overflow");
  });

  it("centres each run's circles on its own lane", () => {
    const runs = fanOut(3);
    renderRow(runs, 5 * MIN);
    runs.forEach((run, lane) => {
      const [circle] = circlesOf(run.session_id);
      expect(circle).toHaveAttribute("data-run-lane", String(lane));
      expect(parseFloat(circle!.style.top)).toBeCloseTo(laneCentrePct(lane, 3), 3);
      // The run's glyph sits on the same centre.
      const glyph = within(row()).getByTestId(`swimlane-run-bracket-start-${run.session_id.slice(0, 8)}`);
      const [, pct, half] = /^calc\(([\d.]+)% - ([\d.]+)px\)$/.exec(glyph.style.top) ?? [];
      expect(Number(pct)).toBeCloseTo(laneCentrePct(lane, 3), 3);
      expect(Number(half)).toBe(5);
    });
  });

  it.each([1, 2, 3, 4])("draws circles at the size for %i lanes", (lanes) => {
    const runs = fanOut(lanes);
    renderRow(runs, 5 * MIN);
    expect(row()).toHaveAttribute("data-lane-count", String(lanes));
    const [circle] = circlesOf(runs[0]!.session_id);
    expect(circle!.style.width).toBe(`${LANE_GEOMETRY[lanes - 1]!.circle}px`);
  });

  it("draws a line per run, dashed from where a stale run went quiet", () => {
    const live = mkSession({ session_id: nextId("l"), started_at: at(-4 * MIN) });
    const stale = mkSession({
      session_id: nextId("s"),
      state: "stale",
      started_at: at(-3 * MIN),
      last_seen_at: at(-150 * S),
    });
    renderRow([live, stale], 5 * MIN);
    expect(lineOf(live.session_id)).toHaveAttribute("data-tail", "live");
    expect(lineOf(live.session_id)).toHaveAttribute("data-run-lane", "0");
    expect(lineOf(stale.session_id)).toHaveAttribute("data-tail", "quiet");
    expect(lineOf(stale.session_id)).toHaveAttribute("data-run-lane", "1");
  });

  it("marks the overflow lane on the row when more runs overlap than lanes", () => {
    const runs = fanOut(5);
    renderRow(runs, 5 * MIN);
    expect(row()).toHaveAttribute("data-lane-count", "4");
    expect(row()).toHaveAttribute("data-lane-overflow", "true");
    for (const run of runs.slice(3)) {
      expect(circlesOf(run.session_id)[0]).toHaveAttribute("data-run-lane", "3");
      expect(lineOf(run.session_id)).toHaveAttribute("data-shared", "true");
    }
    expect(lineOf(runs[0]!.session_id)).not.toHaveAttribute("data-shared");
  });

  it("puts a circle outside every segment in view on the top lane", () => {
    const runs = fanOut(2);
    // A lost run last seen an hour ago, with a stray event in the window
    // (after its last signal): its only segment is out of view.
    const lost = mkSession({
      session_id: nextId("z"),
      state: "lost",
      started_at: at(-120 * MIN),
      last_seen_at: at(-60 * MIN),
    });
    eventsCache.set(lost.session_id, [mkEvent(lost.session_id, "tool_call", -10 * S)]);
    renderRow([...runs, lost], 5 * MIN);
    expect(row()).toHaveAttribute("data-lane-count", "2");
    const [stray] = circlesOf(lost.session_id);
    expect(stray).toHaveAttribute("data-run-lane", "0");
    expect(stray!.style.top).toBe(`${laneCentrePct(0, 2)}%`);
  });

  it("draws no lines on a one-line row, and its circles keep the centre line", () => {
    const a = mkSession({
      session_id: nextId("a"),
      state: "closed",
      started_at: at(-4 * MIN),
      ended_at: at(-3 * MIN),
      last_seen_at: at(-3 * MIN),
    });
    eventsCache.set(a.session_id, [mkEvent(a.session_id, "tool_call", -200 * S)]);
    const b = mkSession({ session_id: nextId("b"), started_at: at(-2 * MIN) });
    renderRow([a, b], 5 * MIN);
    expect(row()).toHaveAttribute("data-lane-count", "1");
    expect(within(row()).queryAllByTestId(/^swimlane-run-line-/)).toHaveLength(0);
    const [circle] = circlesOf(a.session_id);
    expect(circle!.style.top).toBe("");
    expect(circle!.style.width).toBe(`${LANE_GEOMETRY[0]!.circle}px`);
  });

  it("lights a run's line while one of its circles is hovered", () => {
    const runs = fanOut(2);
    renderRow(runs, 5 * MIN);
    const [first, second] = runs.map((r) => r.session_id);
    expect(lineOf(first!)).toHaveAttribute("data-highlighted", "false");
    fireEvent.mouseOver(circlesOf(first!)[0]!);
    expect(lineOf(first!)).toHaveAttribute("data-highlighted", "true");
    expect(lineOf(second!)).toHaveAttribute("data-highlighted", "false");
    fireEvent.mouseLeave(within(row()).getByTestId("swimlane-timeline-inset"));
    expect(lineOf(first!)).toHaveAttribute("data-highlighted", "false");
  });
});
