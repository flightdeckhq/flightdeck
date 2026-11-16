import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { scaleTime } from "d3-scale";
import type { AgentEvent, Session, SessionDetail } from "@/lib/types";
import { useFleetStore } from "@/store/fleet";
import { RunLanes } from "@/components/timeline/RunLanes";
import { eventsCache } from "@/hooks/useSessionEvents";
import { createLaneViewport } from "@/lib/lane-viewport";
import { createRunLink, useRunLitEvent, type RunLink } from "@/lib/run-link";
import { truncateSessionId } from "@/lib/events";
import {
  MARKER_TEXT_STACKED_MIN_LANE_PX,
  RUN_LANE_CIRCLE_SIZE_PX,
  RUN_LANE_HEADING_HEIGHT_PX,
  RUN_LANE_MIN_HEIGHT_PX,
} from "@/lib/run-lane-layout";

// The per-agent modal draws an agent's row as run lanes: a heading with
// the row's label strip, then one lane per run in the window, labelled
// with the run's id, state, model and tokens, drawing its circles larger
// with a short text beside those that have room.

const { fetchSession } = vi.hoisted(() => ({
  fetchSession: vi.fn<(id: string) => Promise<SessionDetail>>(),
}));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  fetchSession,
}));
// Each lane reads its lit event once per render: the count of calls is
// the count of lane renders.
vi.mock("@/lib/run-link", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/run-link")>();
  return { ...actual, useRunLitEvent: vi.fn(actual.useRunLitEvent) };
});

const NOW = Date.parse("2026-11-16T10:00:00Z");
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
    model: "claude-sonnet-4-5",
    state: "active",
    started_at: at(-30 * S),
    last_seen_at: at(0),
    ended_at: null,
    tokens_used: 0,
    token_limit: null,
    ...overrides,
  };
}

function mkEvent(
  sessionId: string,
  eventType: string,
  offsetMs: number,
  extra: Partial<AgentEvent> = {},
): AgentEvent {
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
    ...extra,
  };
}

/** The Timeline's scale: a minute window ending ``endMs`` on the
 *  900 px panel, inset 19 px at each end. */
function minuteScale(endMs = NOW) {
  return scaleTime()
    .domain([new Date(endMs - MIN), new Date(endMs)])
    .range([19, 881]);
}

function lanesElement(
  sessions: Session[],
  {
    laneHeight = 100,
    onSessionClick = () => {},
    view,
    topology = "root",
    endMs = NOW,
    runLink,
    runFilter,
    onRunFilter,
  }: {
    laneHeight?: number;
    onSessionClick?: (id: string, eventId?: string, ev?: AgentEvent) => void;
    /** The scroll viewport's width and scroll; none: the whole row shows. */
    view?: { width: number; scrollLeft: number };
    topology?: "root" | "child";
    endMs?: number;
    runLink?: RunLink;
    runFilter?: string | null;
    onRunFilter?: (sessionId: string) => void;
  } = {},
  laneViewport = createLaneViewport(),
) {
  if (view) laneViewport.set(view);
  return (
    <MemoryRouter>
      <RunLanes
        flavor="agent-1"
        agentName="worker"
        agentType="coding"
        sessions={sessions}
        scale={minuteScale(endMs)}
        onSessionClick={onSessionClick}
        timelineWidth={900}
        leftPanelWidth={460}
        laneHeight={laneHeight}
        laneViewport={laneViewport}
        nowX={881}
        topology={topology}
        runLink={runLink}
        runFilter={runFilter}
        onRunFilter={onRunFilter}
      />
    </MemoryRouter>
  );
}

function renderLanes(sessions: Session[], options: Parameters<typeof lanesElement>[1] = {}) {
  return render(lanesElement(sessions, options));
}

function group() {
  return screen.getByTestId("swimlane-agent-row-worker");
}

function lanes(): HTMLElement[] {
  return Array.from(group().querySelectorAll<HTMLElement>("[data-run-lane-row]"));
}

beforeEach(() => {
  useFleetStore.setState({ flavors: [] });
  eventsCache.clear();
  fetchSession.mockReset();
  fetchSession.mockImplementation(() => new Promise<SessionDetail>(() => {}));
});

describe("RunLanes", () => {
  it("draws a heading with the agent's label strip, then one lane per run by start", () => {
    const late = mkSession({ session_id: nextId("c"), started_at: at(-10 * S) });
    const early = mkSession({ session_id: nextId("a"), started_at: at(-50 * S) });
    const middle = mkSession({ session_id: nextId("b"), started_at: at(-30 * S) });
    renderLanes([late, early, middle]);

    expect(group()).toHaveAttribute("data-run-lanes", "true");
    expect(group()).toHaveAttribute("data-lane-count", "3");
    const heading = within(group()).getByTestId("swimlane-run-lanes-heading");
    expect(heading.style.height).toBe(`${RUN_LANE_HEADING_HEIGHT_PX}px`);
    expect(within(heading).getByTestId("swimlane-agent-name-link")).toHaveTextContent("worker");
    expect(within(heading).getByTestId("swimlane-agent-status-badge")).toHaveAttribute("data-state", "active");

    expect(lanes().map((l) => l.getAttribute("data-run-id"))).toEqual([
      early.session_id,
      middle.session_id,
      late.session_id,
    ]);
    expect(lanes().map((l) => l.getAttribute("data-lane-index"))).toEqual(["0", "1", "2"]);
  });

  it("sizes every lane to the height it is given", () => {
    renderLanes([mkSession({ session_id: nextId("a") }), mkSession({ session_id: nextId("b") })], {
      laneHeight: 87,
    });
    for (const lane of lanes()) expect(lane.style.height).toBe("87px");
  });

  it("labels each lane with the run's short id, state, model and tokens so far", () => {
    const run = mkSession({
      session_id: nextId("d"),
      state: "stale",
      model: "claude-opus-4-1",
      tokens_used: 12_345,
    });
    renderLanes([run]);
    const label = within(lanes()[0]!).getByTestId("swimlane-run-lane-label");
    expect(within(label).getByTestId("swimlane-run-lane-id")).toHaveTextContent(run.session_id.slice(0, 8));
    expect(within(label).getByTestId("swimlane-run-lane-status")).toHaveAttribute("data-state", "stale");
    expect(within(label).getByTestId("swimlane-run-lane-model")).toHaveTextContent("claude-opus-4-1");
    expect(within(label).getByTestId("swimlane-run-lane-tokens")).toHaveTextContent("12.3k tokens");
  });

  it("labels a run that switches models with the model of most of its calls", () => {
    // The session row carries the latest call's model, haiku; most calls
    // in the window are sonnet.
    const run = mkSession({ session_id: nextId("t"), model: "claude-haiku-4-5" });
    eventsCache.set(run.session_id, [
      mkEvent(run.session_id, "post_call", -50 * S, { model: "claude-sonnet-4-5" }),
      mkEvent(run.session_id, "post_call", -40 * S, { model: "claude-sonnet-4-5" }),
      mkEvent(run.session_id, "post_call", -30 * S, { model: "claude-sonnet-4-5" }),
      mkEvent(run.session_id, "post_call", -20 * S, { model: "claude-haiku-4-5" }),
      mkEvent(run.session_id, "post_call", -5 * S, { model: "claude-haiku-4-5" }),
    ]);
    renderLanes([run], { laneHeight: RUN_LANE_MIN_HEIGHT_PX });
    const lane = lanes()[0]!;
    expect(within(lane).getByTestId("swimlane-run-lane-model")).toHaveTextContent("claude-sonnet-4-5");
    // The sonnet calls carry no text; a haiku call that has room names it.
    const texts = within(lane).queryAllByTestId("swimlane-marker-text").map((t) => t.textContent);
    expect(texts).not.toContain("claude-sonnet-4-5");
    expect(texts).toContain("claude-haiku-4-5");
  });

  it("holds the lane's model and the texts it drops while the window slides over an alternating run", () => {
    // Haiku and sonnet calls alternate every 4 s from 3 minutes ago; the
    // session row carries the latest call's model.
    const run = mkSession({ session_id: nextId("u"), model: "claude-haiku-4-5", started_at: at(-4 * MIN) });
    eventsCache.set(
      run.session_id,
      Array.from({ length: 60 }, (_, i) =>
        mkEvent(run.session_id, "post_call", -180 * S + i * 4 * S, {
          model: i % 2 === 0 ? "claude-sonnet-4-5" : "claude-haiku-4-5",
        }),
      ),
    );
    const viewport = createLaneViewport();
    const options = { laneHeight: RUN_LANE_MIN_HEIGHT_PX };
    const { rerender } = render(lanesElement([run], { ...options, endMs: NOW - 90 * S }, viewport));
    const label = () => within(lanes()[0]!).getByTestId("swimlane-run-lane-model").textContent;
    const first = label();
    expect(["claude-sonnet-4-5", "claude-haiku-4-5"]).toContain(first);
    // Slide a second at a time over a minute and a half.
    for (let end = NOW - 89 * S; end <= NOW; end += S) {
      rerender(lanesElement([run], { ...options, endMs: end }, viewport));
      expect(label()).toBe(first);
      const texts = within(lanes()[0]!).queryAllByTestId("swimlane-marker-text").map((t) => t.textContent);
      expect(texts).not.toContain(first);
    }
  });

  it("shows a dash for a run with no model yet", () => {
    renderLanes([mkSession({ session_id: nextId("e"), model: null })]);
    expect(within(lanes()[0]!).getByTestId("swimlane-run-lane-model")).toHaveTextContent("—");
  });

  it("keeps a finished run's lane while it is in the window, and drops one that ended before it", () => {
    const finished = mkSession({
      session_id: nextId("f"),
      state: "closed",
      started_at: at(-50 * S),
      ended_at: at(-40 * S),
      last_seen_at: at(-40 * S),
    });
    const gone = mkSession({
      session_id: nextId("g"),
      state: "closed",
      started_at: at(-10 * MIN),
      ended_at: at(-5 * MIN),
      last_seen_at: at(-5 * MIN),
    });
    const live = mkSession({ session_id: nextId("h"), started_at: at(-20 * S) });
    renderLanes([live, gone, finished]);
    expect(lanes().map((l) => l.getAttribute("data-run-id"))).toEqual([finished.session_id, live.session_id]);
    // The finished run shows its end square, centred on its lane.
    const end = within(lanes()[0]!).getByTestId(`swimlane-run-bracket-end-${finished.session_id.slice(0, 8)}`);
    expect(end.style.top).toBe("calc(50% - 5.5px)");
  });

  it("says so when no run is in the window", () => {
    renderLanes([
      mkSession({
        session_id: nextId("i"),
        state: "closed",
        started_at: at(-10 * MIN),
        ended_at: at(-9 * MIN),
        last_seen_at: at(-9 * MIN),
      }),
    ]);
    expect(group()).toHaveAttribute("data-lane-count", "0");
    const empty = within(group()).getByTestId("swimlane-run-lanes-empty");
    expect(empty).toHaveTextContent("No runs in this window");
    expect(empty.style.height).toBe(`${RUN_LANE_MIN_HEIGHT_PX}px`);
    expect(lanes()).toHaveLength(0);
  });

  it("draws the run's line and glyphs on the lane's centre", () => {
    const run = mkSession({ session_id: nextId("j"), started_at: at(-30 * S) });
    renderLanes([run]);
    const lane = lanes()[0]!;
    const id8 = run.session_id.slice(0, 8);
    const start = within(lane).getByTestId(`swimlane-run-bracket-start-${id8}`);
    expect(start.style.top).toBe("calc(50% - 5px)");
    const line = within(lane).getByTestId(`swimlane-run-line-${id8}`);
    expect(line.style.top).toBe("calc(50% - 4px)");
    expect(line).toHaveAttribute("data-tail", "live");
  });

  it("draws the run's events as larger circles that open the event", () => {
    const run = mkSession({ session_id: nextId("k") });
    const call = mkEvent(run.session_id, "tool_call", -20 * S, { tool_name: "Bash" });
    eventsCache.set(run.session_id, [call]);
    const onSessionClick = vi.fn();
    renderLanes([run], { onSessionClick });
    const [circle] = within(lanes()[0]!).getAllByTestId(`session-circle-${run.session_id}`);
    expect(circle!.style.width).toBe(`${RUN_LANE_CIRCLE_SIZE_PX}px`);
    expect(circle!.querySelector("svg")).toHaveAttribute("width", "17");
    fireEvent.click(circle!);
    expect(onSessionClick).toHaveBeenCalledWith(run.session_id, call.id, call);
  });

  it("writes a tool call's name beside its circle when it has room, naming it by data-marker-for", () => {
    const run = mkSession({ session_id: nextId("l") });
    const bash = mkEvent(run.session_id, "tool_call", -40 * S, { tool_name: "Bash" });
    const read = mkEvent(run.session_id, "tool_call", -20 * S, { tool_name: "Read" });
    eventsCache.set(run.session_id, [bash, read]);
    renderLanes([run], { laneHeight: RUN_LANE_MIN_HEIGHT_PX });
    const texts = within(lanes()[0]!).getAllByTestId("swimlane-marker-text");
    expect(texts.map((t) => [t.getAttribute("data-marker-for"), t.textContent])).toEqual([
      [bash.id, "Bash"],
      [read.id, "Read"],
    ]);
    expect(texts.every((t) => t.getAttribute("data-marker-row") === "beside")).toBe(true);
    // The text does not carry the circle's attribute: one element per event id.
    expect(texts.some((t) => t.hasAttribute("data-event-id"))).toBe(false);
    expect(document.querySelectorAll(`[data-event-id="${bash.id}"]`)).toHaveLength(1);
    // The text takes no pointer input, so the circle under it keeps it.
    expect(texts[0]!.style.pointerEvents).toBe("none");
  });

  it("gives an LLM call on the run's own model no text: the lane label names it", () => {
    const run = mkSession({ session_id: nextId("n"), model: "claude-sonnet-4-5-20250929" });
    const llm = mkEvent(run.session_id, "post_call", -20 * S, { model: "claude-sonnet-4-5-20250929" });
    eventsCache.set(run.session_id, [llm]);
    renderLanes([run], { laneHeight: RUN_LANE_MIN_HEIGHT_PX });
    expect(within(lanes()[0]!).queryAllByTestId("swimlane-marker-text")).toHaveLength(0);
  });

  it("stacks texts above and below the circles on a tall lane", () => {
    const run = mkSession({ session_id: nextId("o") });
    // Two seconds apart (about 29 px at 1m): no room beside the circles.
    const first = mkEvent(run.session_id, "tool_call", -22 * S, { tool_name: "Read" });
    const second = mkEvent(run.session_id, "tool_call", -20 * S, { tool_name: "Edit" });
    eventsCache.set(run.session_id, [first, second]);
    renderLanes([run], { laneHeight: MARKER_TEXT_STACKED_MIN_LANE_PX });
    const texts = within(lanes()[0]!).getAllByTestId("swimlane-marker-text");
    expect(texts.map((t) => [t.textContent, t.getAttribute("data-marker-row")])).toEqual([
      ["Read", "above"],
      ["Edit", "below"],
    ]);
  });

  it("keeps no text for a circle under the label column or past the visible edge", () => {
    const run = mkSession({ session_id: nextId("p") });
    const early = mkEvent(run.session_id, "tool_call", -55 * S, { tool_name: "Bash" });
    const middle = mkEvent(run.session_id, "tool_call", -30 * S, { tool_name: "Read" });
    const late = mkEvent(run.session_id, "tool_call", -5 * S, { tool_name: "Edit" });
    eventsCache.set(run.session_id, [early, middle, late]);
    // Scrolled 200 px in, 400 px of panel showing beside the 460 px
    // label column: [200, 600].
    renderLanes([run], { laneHeight: RUN_LANE_MIN_HEIGHT_PX, view: { width: 860, scrollLeft: 200 } });
    const texts = within(lanes()[0]!).getAllByTestId("swimlane-marker-text");
    expect(texts.map((t) => t.textContent)).toEqual(["Read"]);
  });

  it("spans the heading over the visible row with the badge after the pills", () => {
    renderLanes([mkSession({ session_id: nextId("q") })], { view: { width: 1024, scrollLeft: 0 } });
    const heading = within(group()).getByTestId("swimlane-run-lanes-heading");
    const strip = heading.querySelector<HTMLElement>(".swimlane-row-label")!;
    expect(strip.style.width).toBe("1024px");
    // In the strip's flow, not pinned in the badge column.
    expect(within(heading).queryByTestId("swimlane-badge-wrapper")).toBeNull();
    expect(strip.lastElementChild).toHaveAttribute("data-testid", "swimlane-agent-status-badge");
    // The spacer keeps the row as wide as the label column and panel.
    expect((strip.nextElementSibling as HTMLElement).style.width).toBe(`${460 + 900 - 1024}px`);
  });

  it("indents each lane's label one step under its heading's text, root and child alike", () => {
    const { unmount } = renderLanes([mkSession({ session_id: nextId("r") })]);
    expect(within(lanes()[0]!).getByTestId("swimlane-run-lane-label").style.paddingLeft).toBe("24px");
    unmount();
    renderLanes([mkSession({ session_id: nextId("s") })], { topology: "child" });
    // The child heading's text starts at 28 px; its lanes 12 px further in.
    expect(within(lanes()[0]!).getByTestId("swimlane-run-lane-label").style.paddingLeft).toBe("40px");
  });

  it("drops the text of a marker that would collide, keeping the marker", () => {
    const run = mkSession({ session_id: nextId("m") });
    // One second apart at 1m is about 14 px: no room for text between.
    const first = mkEvent(run.session_id, "tool_call", -21 * S, { tool_name: "Read" });
    const second = mkEvent(run.session_id, "tool_call", -20 * S, { tool_name: "Edit" });
    eventsCache.set(run.session_id, [first, second]);
    renderLanes([run], { laneHeight: RUN_LANE_MIN_HEIGHT_PX });
    const lane = lanes()[0]!;
    expect(within(lane).getAllByTestId(`session-circle-${run.session_id}`)).toHaveLength(2);
    const texts = within(lane).queryAllByTestId("swimlane-marker-text");
    expect(texts.map((t) => t.textContent)).toEqual(["Edit"]);
  });
});

describe("RunLanes linked to the Live feed", () => {
  function twoRuns() {
    const a = mkSession({ session_id: nextId("a"), started_at: at(-50 * S) });
    const b = mkSession({ session_id: nextId("b"), started_at: at(-30 * S) });
    return [a, b] as const;
  }
  const laneOf = (sessionId: string) =>
    lanes().find((l) => l.getAttribute("data-run-id") === sessionId)!;

  it("keeps the label a plain cell without a filter handler", () => {
    const [a] = twoRuns();
    renderLanes([a]);
    expect(within(lanes()[0]!).getByTestId("swimlane-run-lane-label").tagName).toBe("DIV");
    expect(screen.queryByRole("button", { name: /Show only run/ })).toBeNull();
  });

  it("makes the label a button that filters the feed to its run, pressed while filtered", () => {
    const [a, b] = twoRuns();
    const onRunFilter = vi.fn();
    renderLanes([a, b], { onRunFilter, runFilter: b.session_id });
    const label = (sessionId: string) =>
      screen.getByRole("button", { name: `Show only run ${truncateSessionId(sessionId)} in the Live feed` });
    expect(label(a.session_id)).toHaveAttribute("aria-pressed", "false");
    expect(label(b.session_id)).toHaveAttribute("aria-pressed", "true");
    // The filtered run's id reads in the accent.
    expect(within(label(b.session_id)).getByTestId("swimlane-run-lane-id").style.color).toBe("var(--accent)");
    expect(within(label(a.session_id)).getByTestId("swimlane-run-lane-id").style.color).toBe("var(--text)");
    fireEvent.click(label(a.session_id));
    expect(onRunFilter).toHaveBeenCalledWith(a.session_id);
    // The label still reads as the run's id, state, model and tokens.
    expect(within(label(a.session_id)).getByTestId("swimlane-run-lane-id")).toHaveTextContent(
      truncateSessionId(a.session_id),
    );
  });

  it("puts a hovered lane's run on the link, and takes it off on leaving", () => {
    const [a, b] = twoRuns();
    const runLink = createRunLink();
    renderLanes([a, b], { runLink });
    fireEvent.mouseOver(within(laneOf(a.session_id)).getByTestId("swimlane-run-lane-label"));
    expect(runLink.get().run).toBe(a.session_id);
    expect(laneOf(a.session_id)).toHaveAttribute("data-linked", "true");
    expect(laneOf(b.session_id)).not.toHaveAttribute("data-linked");
    fireEvent.mouseOut(laneOf(a.session_id), { relatedTarget: document.body });
    expect(runLink.get().run).toBeNull();
    expect(laneOf(a.session_id)).not.toHaveAttribute("data-linked");
  });

  it("lights its run's lane from the feed, ringing the hovered event's circle", () => {
    const [a, b] = twoRuns();
    const first = mkEvent(a.session_id, "tool_call", -40 * S, { tool_name: "Read" });
    const second = mkEvent(a.session_id, "tool_call", -20 * S, { tool_name: "Edit" });
    eventsCache.set(a.session_id, [first, second]);
    const runLink = createRunLink();
    renderLanes([a, b], { runLink });
    act(() => runLink.set(a.session_id, second.id));
    const lane = laneOf(a.session_id);
    expect(lane).toHaveAttribute("data-linked", "true");
    const circle = (id: string) => lane.querySelector<HTMLElement>(`[data-event-id="${id}"]`)!;
    expect(circle(second.id)).toHaveAttribute("data-linked", "true");
    expect(circle(second.id).style.boxShadow).toContain("var(--accent)");
    expect(circle(first.id)).not.toHaveAttribute("data-linked");
    act(() => runLink.set(a.session_id, first.id));
    expect(circle(first.id)).toHaveAttribute("data-linked", "true");
    expect(circle(second.id)).not.toHaveAttribute("data-linked");
  });

  it("re-renders only the lanes whose light changes", () => {
    const [a, b] = twoRuns();
    const c = mkSession({ session_id: nextId("c"), started_at: at(-20 * S) });
    const runLink = createRunLink();
    renderLanes([a, b, c], { runLink });
    const laneRenders = vi.mocked(useRunLitEvent);
    const rendered = (from: number) =>
      laneRenders.mock.calls
        .slice(from)
        .map(([, run]) => run)
        .sort();
    // Lane a lights: lane a alone renders.
    const before = laneRenders.mock.calls.length;
    act(() => runLink.set(a.session_id));
    expect(rendered(before)).toEqual([a.session_id]);
    // From a to b: a goes out and b lights; c renders not at all.
    const moved = laneRenders.mock.calls.length;
    act(() => runLink.set(b.session_id));
    expect(rendered(moved)).toEqual([a.session_id, b.session_id].sort());
  });

  it("lights its run while its label has the keyboard focus", () => {
    const [a] = twoRuns();
    const runLink = createRunLink();
    renderLanes([a], { runLink, onRunFilter: () => {} });
    const label = screen.getByRole("button", { name: /Show only run/ });
    fireEvent.focus(label);
    expect(runLink.get().run).toBe(a.session_id);
    fireEvent.blur(label);
    expect(runLink.get().run).toBeNull();
  });
});
